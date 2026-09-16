// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { AccountAuthenticationError, createAccountAuthenticator } from "./auth.ts";
import { readAccountApiConfig } from "./config.ts";
import { createAccountDatabase, type AccountDeviceInput, type UsageEventInput } from "./database.ts";

const localEnvFile = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(localEnvFile)) {
  loadEnvFile(localEnvFile);
}

const config = readAccountApiConfig();
const database = createAccountDatabase(config);
const authenticate = createAccountAuthenticator(config);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const corsHeaders = {
    "access-control-allow-origin": config.corsOrigin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, PATCH, POST, OPTIONS",
    "cache-control": "no-store",
  };

  if (request.method === "OPTIONS") {
    writeJson(response, 204, null, corsHeaders);
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, { ok: true }, corsHeaders);
    return;
  }

  try {
    const body = await readBody(request);
    const principal = await authenticate(toWebRequest(request, body, url));
    await database.touchSession(principal);

    if (request.method === "GET" && url.pathname === "/v1/account") {
      writeJson(response, 200, await database.getAccount(principal.userId), corsHeaders);
      return;
    }

    if (request.method === "PATCH" && url.pathname === "/v1/account/profile") {
      const input = parseProfileInput(body);
      await database.updateProfile(principal.userId, input);
      writeJson(response, 200, await database.getAccount(principal.userId), corsHeaders);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/account/devices") {
      await database.upsertDevice(principal.userId, parseDeviceInput(body));
      writeJson(response, 200, await database.getAccount(principal.userId), corsHeaders);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/account/usage-events") {
      const inserted = await database.recordUsageEvent(
        principal.userId,
        parseUsageEventInput(body),
      );
      writeJson(response, inserted ? 201 : 200, { accepted: inserted }, corsHeaders);
      return;
    }

    writeJson(response, 404, { error: "not_found" }, corsHeaders);
  } catch (error) {
    if (error instanceof AccountAuthenticationError) {
      writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
      return;
    }

    if (error instanceof RequestValidationError) {
      writeJson(response, 400, { error: error.message }, corsHeaders);
      return;
    }

    // Do not serialize the caught error: database errors can contain connection
    // details, and account credentials must never reach logs or responses.
    console.error("Account API request failed", {
      method: request.method,
      path: url.pathname,
    });
    writeJson(response, 500, { error: "internal_error" }, corsHeaders);
  }
});

await database.migrate();
server.listen(config.port, config.host, () => {
  console.log(`Sparky account API listening on ${config.host}:${config.port}`);
});

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function toWebRequest(request: IncomingMessage, body: string, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return new Request(url, {
    method: request.method ?? "GET",
    headers,
    ...(body.length > 0 ? { body } : {}),
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 256 * 1024) {
      throw new RequestValidationError("Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new RequestValidationError("Request body must be a JSON object.");
  }
}

function parseProfileInput(body: string) {
  const input = parseJson(body);
  const displayName = optionalText(input.displayName, "displayName", 160);
  const avatarUrl = optionalUrl(input.avatarUrl, "avatarUrl");
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  };
}

function parseDeviceInput(body: string): AccountDeviceInput {
  const input = parseJson(body);
  const label = optionalText(input.label, "label", 160);
  const deviceType = optionalText(input.deviceType, "deviceType", 32);
  const platform = optionalText(input.platform, "platform", 64);
  const osVersion = optionalText(input.osVersion, "osVersion", 64);
  const appVersion = optionalText(input.appVersion, "appVersion", 64);
  const browser = optionalText(input.browser, "browser", 128);
  return {
    deviceId: requiredText(input.deviceId, "deviceId", 160),
    ...(label === undefined ? {} : { label }),
    ...(deviceType === undefined ? {} : { deviceType }),
    ...(platform === undefined ? {} : { platform }),
    ...(osVersion === undefined ? {} : { osVersion }),
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(browser === undefined ? {} : { browser }),
  };
}

function parseUsageEventInput(body: string): UsageEventInput {
  const input = parseJson(body);
  const numeric = (key: string): number | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RequestValidationError(`${key} must be a non-negative number.`);
    }
    return value;
  };

  const occurredAt = requiredText(input.occurredAt, "occurredAt", 64);
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new RequestValidationError("occurredAt must be an ISO timestamp.");
  }

  const deviceId = optionalText(input.deviceId, "deviceId", 160);
  const environmentId = optionalText(input.environmentId, "environmentId", 200);
  const threadId = optionalText(input.threadId, "threadId", 200);
  const turnId = optionalText(input.turnId, "turnId", 200);
  const provider = optionalText(input.provider, "provider", 100);
  const providerInstanceId = optionalText(input.providerInstanceId, "providerInstanceId", 160);
  const inputTokens = numeric("inputTokens");
  const cachedInputTokens = numeric("cachedInputTokens");
  const outputTokens = numeric("outputTokens");
  const reasoningOutputTokens = numeric("reasoningOutputTokens");
  const totalTokens = numeric("totalTokens");
  const toolUses = numeric("toolUses");
  const costUsd = numeric("costUsd");

  return {
    eventId: requiredText(input.eventId, "eventId", 200),
    model: requiredText(input.model, "model", 200),
    occurredAt,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(provider === undefined ? {} : { provider }),
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function requiredText(value: unknown, key: string, maxLength: number): string {
  const text = optionalText(value, key, maxLength);
  if (!text) throw new RequestValidationError(`${key} is required.`);
  return text;
}

function optionalText(value: unknown, key: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RequestValidationError(`${key} must be text.`);
  const text = value.trim();
  if (text.length > maxLength) throw new RequestValidationError(`${key} is too long.`);
  return text || undefined;
}

function optionalUrl(value: unknown, key: string): string | undefined {
  const text = optionalText(value, key, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new RequestValidationError(`${key} must be an HTTPS URL.`);
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>>,
): void {
  const body = value === null ? "" : JSON.stringify(value);
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}
