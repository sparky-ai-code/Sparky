// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs/promises";
import * as NodeNet from "node:net";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProvider,
  type ProviderInstanceId,
  type ThreadId,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { TextGenerationError } from "@sparky/contracts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { currentAuthSessionId } from "../ProviderExecutionContext.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { resolveAttachmentPath, parseThreadSegmentFromAttachmentId, toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { spawnOpenCodeAcp, type JsonRpcMessage } from "./OpenCodeAcpTransport.ts";
import { SPARKY_MCP_STDIO_BRIDGE } from "./SparkyMcpStdioBridge.ts";

const DRIVER = ProviderDriverKind.make("opencode");
const SETTINGS = Schema.Struct({ binaryPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))) });
type Settings = typeof SETTINGS.Type;
type PendingPermission = {
  readonly rpcId: string | number;
  readonly requestType: "command_execution_approval" | "file_read_approval" | "file_change_approval" | "dynamic_tool_call";
  readonly options: ReadonlyArray<{ optionId: string; kind?: string }>;
};
type PendingUserInput = {
  readonly rpcId: string | number;
  readonly questions: ReadonlyArray<import("@sparky/contracts").UserInputQuestion>;
};
type ActiveSession = {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  transport: ReturnType<typeof spawnOpenCodeAcp>;
  acpSessionId: string;
  readonly cwd: string;
  readonly mcpServers: ReturnType<typeof mapMcpServer>;
  readonly model?: string;
  readonly pendingPermissions: Map<ApprovalRequestId, PendingPermission>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  status: ProviderSession["status"];
  activeTurnId?: TurnId;
  lastError?: string;
  costUsd: number;
  turnCostAtStart: number;
  cancelRequested?: boolean;
  usage?: Readonly<Record<string, unknown>>;
};
const isoNow = () => new Date().toISOString();
const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const selectedModel = (selection: ModelSelection | undefined) => selection?.model.trim() || undefined;
const modelIdForAcp = (model: string | undefined) => model;

function mapMcpServer(input: { threadId: ThreadId; instanceId: ProviderInstanceId; authSessionId: string | null }) {
  const mcp = readMcpProviderSession(input.threadId, input.instanceId, input.authSessionId ?? undefined);
  if (!mcp) return [];
  return [{ name: "sparky", command: process.execPath, args: ["-e", SPARKY_MCP_STDIO_BRIDGE], env: [
    { name: "SPARKY_MCP_ENDPOINT", value: mcp.endpoint },
    { name: "SPARKY_MCP_TOKEN", value: mcp.authorizationHeader.replace(/^Bearer\s+/iu, "") },
  ] }];
}
function runtimeEvent(input: {
  threadId: ThreadId;
  instanceId: ProviderInstanceId;
  type: string;
  payload: Record<string, unknown>;
  turnId?: TurnId;
  itemId?: RuntimeItemId;
  requestId?: RuntimeRequestId;
}): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(NodeCrypto.randomUUID()),
    provider: DRIVER,
    providerInstanceId: input.instanceId,
    threadId: input.threadId,
    createdAt: isoNow(),
    type: input.type,
    payload: input.payload,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    raw: { source: "acp.jsonrpc", payload: input.payload },
  } as ProviderRuntimeEvent;
}
function publishAcpMessage(input: {
  message: JsonRpcMessage;
  session: ActiveSession;
  events: PubSub.PubSub<ProviderRuntimeEvent>;
}) {
  if (input.message.method !== "session/update") return;
  const update = asRecord(asRecord(input.message.params)?.update);
  if (!update) return;
  const kind = update.sessionUpdate;
  const content = asRecord(update.content);
  const turnId = input.session.activeTurnId;
  const emit = (event: ProviderRuntimeEvent) => {
    void Effect.runPromise(PubSub.publish(input.events, event));
  };

  if (kind === "agent_message_chunk" && typeof content?.text === "string") {
    emit(runtimeEvent({
      threadId: input.session.threadId,
      instanceId: input.session.instanceId,
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: content.text },
      ...(turnId ? { turnId } : {}),
      itemId: RuntimeItemId.make(String(update.messageId ?? "assistant")),
    }));
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    const itemId = RuntimeItemId.make(typeof update.toolCallId === "string" ? update.toolCallId : NodeCrypto.randomUUID());
    const status = update.status === "completed" ? "completed" : update.status === "failed" ? "failed" : "inProgress";
    const payload = {
      itemType: "dynamic_tool_call", status,
      ...(typeof update.title === "string" ? { title: update.title } : {}),
      ...(update.rawInput !== undefined ? { data: { toolName: update.title ?? "OpenCode tool", item: update.rawInput } } : {}),
      ...(typeof update.rawOutput === "string" ? { detail: update.rawOutput.slice(0, 2000) } : {}),
    };
    emit(runtimeEvent({
      threadId: input.session.threadId,
      instanceId: input.session.instanceId,
      type: kind === "tool_call" ? "item.started" : status === "inProgress" ? "item.updated" : "item.completed",
      payload,
      ...(turnId ? { turnId } : {}),
      itemId,
    }));
  } else if (kind === "plan" && Array.isArray(update.entries)) {
    const plan = update.entries.flatMap((entry) => {
      const record = asRecord(entry);
      if (typeof record?.content !== "string") return [];
      return [{ step: record.content, status: record.status === "completed" ? "completed" : record.status === "in_progress" ? "inProgress" : "pending" }];
    });
    emit(runtimeEvent({ threadId: input.session.threadId, instanceId: input.session.instanceId, type: "turn.plan.updated", payload: { plan }, ...(turnId ? { turnId } : {}) }));
  } else if (kind === "usage_update") {
    const cost = asRecord(update.cost);
    const amount = typeof cost?.amount === "number" && Number.isFinite(cost.amount) ? cost.amount : undefined;
    if (amount !== undefined && amount >= 0) input.session.costUsd = amount;
    const usedTokens = Number.isInteger(update.used) && (update.used as number) >= 0 ? update.used as number : undefined;
    const maxTokens = Number.isInteger(update.size) && (update.size as number) > 0 ? update.size as number : undefined;
    if (usedTokens !== undefined) {
      input.session.usage = {
        ...(input.session.usage ?? {}),
        usedTokens,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      };
      emit(runtimeEvent({
        threadId: input.session.threadId,
        instanceId: input.session.instanceId,
        type: "thread.token-usage.updated",
        payload: { usage: input.session.usage },
        ...(turnId ? { turnId } : {}),
      }));
    }
  }
}

function cancelPendingRequests(session: ActiveSession, events: PubSub.PubSub<ProviderRuntimeEvent>) {
  const pendingPermissions = Array.from(session.pendingPermissions, ([requestId, pending]) => ({ requestId, pending }));
  const pendingInputs = Array.from(session.pendingUserInputs, ([requestId, pending]) => ({ requestId, pending }));
  session.pendingPermissions.clear();
  session.pendingUserInputs.clear();
  for (const { requestId, pending } of pendingPermissions) {
    try { session.transport.respond(pending.rpcId, { outcome: "cancelled" }); } catch { /* The session may already be closed. */ }
    void Effect.runPromise(PubSub.publish(events, runtimeEvent({
      threadId: session.threadId,
      instanceId: session.instanceId,
      type: "request.resolved",
      requestId: RuntimeRequestId.make(requestId),
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      payload: { requestType: pending.requestType, decision: "cancel" },
    })));
  }
  for (const { requestId, pending } of pendingInputs) {
    try { session.transport.respond(pending.rpcId, { action: "cancel" }); } catch { /* The session may already be closed. */ }
    void Effect.runPromise(PubSub.publish(events, runtimeEvent({
      threadId: session.threadId,
      instanceId: session.instanceId,
      type: "user-input.resolved",
      requestId: RuntimeRequestId.make(requestId),
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      payload: { answers: {} },
    })));
  }
}

function handleAcpMessage(input: {
  message: JsonRpcMessage;
  session: ActiveSession;
  events: PubSub.PubSub<ProviderRuntimeEvent>;
}) {
  const { message, session, events } = input;
  if (message.method === "elicitation/create" && message.id !== undefined) {
    const params = asRecord(message.params);
    const schema = asRecord(params?.requestedSchema);
    const properties = asRecord(schema?.properties);
    const messageText = typeof params?.message === "string" ? params.message : "Please provide the requested information.";
    const questions = Object.entries(properties ?? {}).map(([id, rawProperty]) => {
      const property = asRecord(rawProperty) ?? {};
      const itemSchema = asRecord(property.items);
      const enumValues = Array.isArray(property.enum) ? property.enum : Array.isArray(itemSchema?.enum) ? itemSchema.enum : [];
      const options = enumValues.flatMap((value) => typeof value === "string" ? [{ label: value, description: value }] : []);
      return {
        id,
        header: typeof property.title === "string" && property.title.trim() ? property.title : id,
        question: typeof property.description === "string" && property.description.trim() ? property.description : messageText,
        options,
        multiSelect: property.type === "array",
      };
    });
    const requestId = ApprovalRequestId.make(NodeCrypto.randomUUID());
    const pending: PendingUserInput = { rpcId: message.id, questions };
    session.pendingUserInputs.set(requestId, pending);
    void Effect.runPromise(PubSub.publish(events, runtimeEvent({
      threadId: session.threadId,
      instanceId: session.instanceId,
      type: "user-input.requested",
      requestId: RuntimeRequestId.make(requestId),
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      payload: { questions },
    })));
    return;
  }
  if (message.method !== "session/request_permission" || message.id === undefined) {
    publishAcpMessage(input);
    return;
  }

  const params = asRecord(message.params);
  const toolCall = asRecord(params?.toolCall);
  const fields = asRecord(toolCall?.fields);
  const kind = typeof toolCall?.kind === "string" ? toolCall.kind : "";
  const title = typeof toolCall?.title === "string" ? toolCall.title : "OpenCode tool";
  const normalizedTitle = title.toLowerCase();
  const requestType = kind === "execute" || normalizedTitle.includes("command") || normalizedTitle.includes("terminal")
    ? "command_execution_approval"
    : kind === "read" || normalizedTitle.includes("read") || normalizedTitle.includes("search")
      ? "file_read_approval"
      : kind === "edit" || kind === "delete" || kind === "move" || normalizedTitle.includes("edit") || normalizedTitle.includes("write") || normalizedTitle.includes("patch")
        ? "file_change_approval"
        : "dynamic_tool_call";
  const options = Array.isArray(params?.options)
    ? params.options.flatMap((option) => {
        const item = asRecord(option);
        return typeof item?.optionId === "string"
          ? [{ optionId: item.optionId, ...(typeof item.kind === "string" ? { kind: item.kind } : {}) }]
          : [];
      })
    : [];
  const requestId = ApprovalRequestId.make(NodeCrypto.randomUUID());
  session.pendingPermissions.set(requestId, { rpcId: message.id, requestType, options });
  const args = toolCall?.rawInput ?? fields?.rawInput ?? fields ?? toolCall;
  const detail = typeof fields?.description === "string"
    ? fields.description
    : Array.isArray(toolCall?.content)
      ? toolCall.content.flatMap((entry) => {
          const item = asRecord(entry);
          return item?.type === "content" && typeof item.text === "string" ? [item.text] : [];
        }).join("\n") || title
      : title;
  void Effect.runPromise(PubSub.publish(events, runtimeEvent({
    threadId: session.threadId,
    instanceId: session.instanceId,
    type: "request.opened",
    requestId: RuntimeRequestId.make(requestId),
    ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    payload: { requestType, detail, args },
  })));
}
function spawnAndInitialize(input: { binaryPath: string; cwd: string; env: NodeJS.ProcessEnv; sessionId?: string; mcpServers: ReturnType<typeof mapMcpServer>; model?: string; threadId: ThreadId }) {
  return Effect.tryPromise({
    try: async () => {
      const transport = spawnOpenCodeAcp({ binaryPath: input.binaryPath, cwd: input.cwd, env: input.env });
      try {
        await transport.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "Sparky", version: "1.1" },
          // OpenCode executes workspace tools itself; we only advertise the
          // client capability Sparky implements for its form elicitation flow.
          clientCapabilities: { elicitation: { form: true, url: false } },
        });
        transport.notify("initialized");
        const result = await transport.request(input.sessionId ? "session/load" : "session/new", {
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          cwd: input.cwd,
          mcpServers: input.mcpServers,
        });
        const record = asRecord(result);
        if (typeof record?.sessionId !== "string") throw new Error("OpenCode ACP did not return a session ID.");
        if (input.model) {
          await transport.request("session/set_config_option", {
            sessionId: record.sessionId,
            configId: "model",
            value: input.model,
          });
        }
        return { transport, sessionId: record.sessionId };
      } catch (cause) { transport.close(); throw cause; }
    },
    catch: (cause) => new ProviderAdapterProcessError({ provider: "opencode", threadId: input.threadId, detail: cause instanceof Error ? cause.message : String(cause), cause }),
  });
}

function exportSession(input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly sessionId: string;
}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      input.binaryPath,
      ["session", "export", input.sessionId],
      { cwd: input.cwd, env: input.env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          const exported = asRecord(parsed);
          if (!exported || !Array.isArray(exported.messages)) {
            throw new Error("OpenCode returned an invalid session export.");
          }
          resolve(exported);
        } catch (cause) {
          reject(cause);
        }
      },
    );
  });
}

function snapshotFromExport(threadId: ThreadId, exported: Record<string, unknown>): ProviderThreadSnapshot {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  for (const rawMessage of exported.messages as ReadonlyArray<unknown>) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    if (!message || !info || !Array.isArray(message.parts)) continue;
    const role = info.role;
    const parts = message.parts.flatMap((part) => {
      const record = asRecord(part);
      return record ? [record] : [];
    });
    if (role === "user") {
      const messageId = typeof info.id === "string" ? info.id : NodeCrypto.randomUUID();
      const content = parts.flatMap((part) => {
        if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
        return [];
      });
      turns.push({
        id: TurnId.make(messageId),
        items: [{ type: "userMessage", content }],
      });
      continue;
    }
    if (role !== "assistant") continue;
    let turn = turns[turns.length - 1];
    if (!turn) {
      turn = { id: TurnId.make(typeof info.id === "string" ? info.id : NodeCrypto.randomUUID()), items: [] };
      turns.push(turn);
    }
    const text = parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
    if (text.length > 0) turn.items.push({ type: "agentMessage", text });
    for (const part of parts) {
      if (part.type === "tool") turn.items.push({ type: "toolCall", ...part });
    }
  }
  return { threadId, turns };
}

async function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local OpenCode API port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForOpenCodeApi(input: {
  readonly child: ReturnType<typeof NodeChildProcess.spawn>;
  readonly baseUrl: string;
  readonly authorization?: string;
}): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (input.child.exitCode !== null) throw new Error(`OpenCode API server exited with code ${String(input.child.exitCode)}.`);
    try {
      const response = await fetch(`${input.baseUrl}/global/health`, {
        ...(input.authorization ? { headers: { authorization: input.authorization } } : {}),
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The server may still be binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode API server did not become ready.");
}

function opencodeServerAuthorization(env: NodeJS.ProcessEnv): string | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  const username = env.OPENCODE_SERVER_USERNAME || "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function startOpenCodeApi(input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Promise<{ readonly child: ReturnType<typeof NodeChildProcess.spawn>; readonly baseUrl: string }> {
  return (async () => {
    const port = await reserveLocalPort();
    const child = NodeChildProcess.spawn(input.binaryPath, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: input.cwd,
      env: input.env,
      stdio: "ignore",
      windowsHide: true,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForOpenCodeApi({ child, baseUrl, authorization: opencodeServerAuthorization(input.env) });
      return { child, baseUrl };
    } catch (cause) {
      child.kill();
      throw cause;
    }
  })();
}

function exportUserMessageIds(exported: Record<string, unknown>): string[] {
  return (exported.messages as ReadonlyArray<unknown>).flatMap((rawMessage) => {
    const info = asRecord(asRecord(rawMessage)?.info);
    return info?.role === "user" && typeof info.id === "string" ? [info.id] : [];
  });
}

export function makeOpenCodeAcpAdapter(input: { instanceId: ProviderInstanceId; binaryPath: string; attachmentsDir: string; environment: NodeJS.ProcessEnv }): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const sessions = new Map<ThreadId, ActiveSession>(); const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    let apiServer: { readonly child: ReturnType<typeof NodeChildProcess.spawn>; readonly baseUrl: string } | undefined;
    let apiServerStartup: Promise<{ readonly child: ReturnType<typeof NodeChildProcess.spawn>; readonly baseUrl: string }> | undefined;
    const ensureApiServer = (cwd: string) => {
      apiServerStartup ??= startOpenCodeApi({ binaryPath: input.binaryPath, env: input.environment, cwd });
      return apiServerStartup.then((server) => { apiServer = server; return server; });
    };
    const apiRequest = async (method: string, path: string, cwd: string, body?: unknown) => {
      const server = await ensureApiServer(cwd);
      const url = new URL(path, server.baseUrl);
      url.searchParams.set("directory", cwd);
      const headers: Record<string, string> = { accept: "application/json" };
      const authorization = opencodeServerAuthorization(input.environment);
      if (authorization) headers.authorization = authorization;
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      return response;
    };
    const getSession = (threadId: ThreadId) => { const session = sessions.get(threadId); if (!session) throw new Error(`No active OpenCode ACP session for ${threadId}.`); return session; };
    const attachTransportHandlers = (session: ActiveSession) => {
      const transport = session.transport;
      transport.onMessage((message) => handleAcpMessage({ message, session, events }));
      transport.onExit((code, signal) => {
        if (session.transport !== transport) return;
        session.status = "error";
        session.lastError = `OpenCode ACP exited (code=${String(code)}, signal=${String(signal)}).`;
      });
    };
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: DRIVER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession: (start) => Effect.gen(function* () {
        const cwd = start.cwd ?? process.cwd(); const authSessionId = yield* currentAuthSessionId; const resume = asRecord(start.resumeCursor);
        const restoredId = typeof resume?.sessionId === "string" ? resume.sessionId : undefined;
        const mcpServers = mapMcpServer({ threadId: start.threadId, instanceId: input.instanceId, authSessionId });
        const { transport, sessionId } = yield* spawnAndInitialize({ binaryPath: input.binaryPath, cwd, env: input.environment, threadId: start.threadId, ...(restoredId ? { sessionId: restoredId } : {}), mcpServers, ...(modelIdForAcp(selectedModel(start.modelSelection)) ? { model: modelIdForAcp(selectedModel(start.modelSelection)) } : {}) });
        const session: ActiveSession = {
          threadId: start.threadId,
          instanceId: input.instanceId,
          transport,
          acpSessionId: sessionId,
          cwd,
          mcpServers,
          ...(selectedModel(start.modelSelection) ? { model: selectedModel(start.modelSelection) } : {}),
          pendingPermissions: new Map(),
          pendingUserInputs: new Map(),
          status: "ready",
          costUsd: typeof resume?.costUsd === "number" && Number.isFinite(resume.costUsd) ? resume.costUsd : 0,
          turnCostAtStart: 0,
        };
        const previous = sessions.get(start.threadId);
        if (previous) {
          cancelPendingRequests(previous, events);
          previous.transport.close();
        }
        sessions.set(start.threadId, session);
        attachTransportHandlers(session);
        const resumeCursor = { sessionId, costUsd: session.costUsd };
        yield* PubSub.publish(events, runtimeEvent({
          threadId: start.threadId,
          instanceId: input.instanceId,
          type: "session.started",
          payload: { resume: resumeCursor },
        }));
        const now = isoNow();
        return {
          provider: DRIVER,
          providerInstanceId: input.instanceId,
          status: "ready",
          runtimeMode: start.runtimeMode,
          ...(start.workspaceContext ? { workspaceContext: start.workspaceContext } : {}),
          ...(start.cwd ? { cwd: start.cwd } : {}),
          ...(session.model ? { model: session.model } : {}),
          threadId: start.threadId,
          resumeCursor,
          createdAt: now,
          updatedAt: now,
        } satisfies ProviderSession;
      }),
      sendTurn: (turn) => Effect.gen(function* () {
        const session = getSession(turn.threadId);
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        session.activeTurnId = turnId;
        session.cancelRequested = false;
        session.status = "running";
        session.turnCostAtStart = session.costUsd;
        yield* PubSub.publish(events, runtimeEvent({
          threadId: turn.threadId,
          instanceId: input.instanceId,
          type: "turn.started",
          payload: { ...(session.model ? { model: session.model } : {}) },
          turnId,
        }));
        const text = turn.input ?? "";
        const prompt = Effect.tryPromise({
          try: async () => {
            const images = await Promise.all((turn.attachments ?? []).map(async (attachment: ChatAttachment) => {
              const attachmentThread = parseThreadSegmentFromAttachmentId(attachment.id);
              if (!attachmentThread || attachmentThread !== toSafeThreadAttachmentSegment(String(turn.threadId))) {
                throw new Error(`Attachment '${attachment.name}' does not belong to this thread.`);
              }
              const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
              if (!path) throw new Error(`Attachment '${attachment.name}' is unavailable.`);
              const stat = await NodeFS.stat(path);
              if (!stat.isFile() || stat.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
                throw new Error(`Attachment '${attachment.name}' exceeds the supported image size.`);
              }
              const data = await NodeFS.readFile(path);
              if (data.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
                throw new Error(`Attachment '${attachment.name}' exceeds the supported image size.`);
              }
              return { type: "image", mimeType: attachment.mimeType, data: data.toString("base64") };
            }));
            const promptBlocks = [
              ...(text.length > 0 ? [{ type: "text", text }] : []),
              ...images,
            ];
            if (promptBlocks.length === 0) promptBlocks.push({ type: "text", text: " " });
            return session.transport.request("session/prompt", {
              sessionId: session.acpSessionId,
              prompt: promptBlocks,
            });
          },
          catch: (cause) => new ProviderAdapterProcessError({
            provider: "opencode",
            threadId: turn.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        }).pipe(
          Effect.flatMap((response) => {
            const result = asRecord(response);
            const interrupted = session.cancelRequested === true || result?.stopReason === "cancelled";
            session.cancelRequested = false;
            const resumeCursor = { sessionId: session.acpSessionId, costUsd: session.costUsd };
            const completedEvent = runtimeEvent({
              threadId: turn.threadId,
              instanceId: input.instanceId,
              type: "turn.completed",
              payload: {
                state: interrupted ? "interrupted" : "completed",
                ...(typeof result?.stopReason === "string" ? { stopReason: result.stopReason } : {}),
                ...(session.usage ? { usage: session.usage } : {}),
                ...(session.costUsd > session.turnCostAtStart
                  ? { totalCostUsd: session.costUsd - session.turnCostAtStart }
                  : {}),
                resumeCursor,
              },
              turnId,
            });
            return PubSub.publish(events, completedEvent).pipe(Effect.asVoid);
          }),
          Effect.catch((error) => {
            const interrupted = session.cancelRequested === true;
            session.cancelRequested = false;
            const completedEvent = runtimeEvent({
              threadId: turn.threadId,
              instanceId: input.instanceId,
              type: "turn.completed",
              payload: {
                state: interrupted ? "interrupted" : "failed",
                ...(!interrupted ? { errorMessage: error.message } : {}),
                resumeCursor: { sessionId: session.acpSessionId, costUsd: session.costUsd },
              },
              turnId,
            });
            return (interrupted
              ? PubSub.publish(events, completedEvent)
              : Effect.all([
                  PubSub.publish(events, runtimeEvent({ threadId: turn.threadId, instanceId: input.instanceId, type: "runtime.error", payload: { message: error.message, class: "provider_error" }, turnId })),
                  PubSub.publish(events, completedEvent),
                ], { concurrency: 1 })).pipe(Effect.asVoid);
          }),
          Effect.ensuring(Effect.sync(() => {
            session.activeTurnId = undefined;
            session.status = session.transport.isRunning() ? "ready" : "error";
          })),
        );
        yield* Effect.forkScoped(prompt);
        return { threadId: turn.threadId, turnId, resumeCursor: { sessionId: session.acpSessionId, costUsd: session.costUsd } };
      }),
      interruptTurn: (threadId) => Effect.try({
        try: () => {
          const session = getSession(threadId);
          session.cancelRequested = true;
          session.transport.notify("session/cancel", { sessionId: session.acpSessionId });
          cancelPendingRequests(session, events);
        },
        catch: (cause) => new ProviderAdapterProcessError({ provider: "opencode", threadId, detail: cause instanceof Error ? cause.message : String(cause), cause }),
      }),
      respondToRequest: (threadId, requestId, decision) => {
        const session = sessions.get(threadId);
        if (!session) {
          return Effect.fail(new ProviderAdapterValidationError({
            provider: "opencode",
            operation: "respondToRequest",
            issue: `No active session for ${threadId}.`,
          }));
        }
        const pending = session.pendingPermissions.get(requestId);
        if (!pending) {
          return Effect.fail(new ProviderAdapterValidationError({
            provider: "opencode",
            operation: "respondToRequest",
            issue: `Permission request ${requestId} is not pending.`,
          }));
        }
        const allowOptions = pending.options.filter((option) => option.kind === "allow_once" || option.kind === "allow_always");
        const rejectOptions = pending.options.filter((option) => option.kind === "reject_once" || option.kind === "reject_always");
        const accepted = decision === "accept" || decision === "acceptForSession";
        const preferredKind = decision === "acceptForSession" ? "allow_always" : "allow_once";
        const rejectKind = decision === "decline" ? "reject_once" : "reject_always";
        const option = accepted
          ? allowOptions.find((item) => item.kind === preferredKind) ?? allowOptions.find((item) => item.kind === "allow_once") ?? allowOptions[0]
          : decision === "cancel" ? undefined : rejectOptions.find((item) => item.kind === rejectKind) ?? rejectOptions.find((item) => item.kind === "reject_once") ?? rejectOptions[0];
        const outcome = option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
        return Effect.tryPromise({
          try: async () => {
            await session.transport.respond(pending.rpcId, { outcome });
            session.pendingPermissions.delete(requestId);
            await Effect.runPromise(PubSub.publish(events, runtimeEvent({
              threadId,
              instanceId: input.instanceId,
              type: "request.resolved",
              requestId: RuntimeRequestId.make(requestId),
              ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
              payload: {
                requestType: pending.requestType,
                decision: option ? decision : accepted || decision === "cancel" ? "cancel" : "decline",
              },
            })));
          },
          catch: (cause) => new ProviderAdapterProcessError({
            provider: "opencode",
            threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        });
      },
      respondToUserInput: (threadId, requestId, answers) => {
        const session = sessions.get(threadId);
        const pending = session?.pendingUserInputs.get(requestId);
        if (!session || !pending) {
          return Effect.fail(new ProviderAdapterValidationError({
            provider: "opencode",
            operation: "respondToUserInput",
            issue: `User-input request ${requestId} is not pending.`,
          }));
        }
        const normalizedAnswers: Record<string, string | string[]> = {};
        for (const question of pending.questions) {
          const answer = answers[question.id];
          if (typeof answer === "string" || (Array.isArray(answer) && answer.every((entry) => typeof entry === "string"))) {
            normalizedAnswers[question.id] = answer;
          } else {
            return Effect.fail(new ProviderAdapterValidationError({
              provider: "opencode",
              operation: "respondToUserInput",
              issue: `A valid answer for '${question.id}' is required.`,
            }));
          }
        }
        return Effect.tryPromise({
          try: async () => {
            await session.transport.respond(pending.rpcId, { action: "accept", content: normalizedAnswers });
            session.pendingUserInputs.delete(requestId);
            await Effect.runPromise(PubSub.publish(events, runtimeEvent({
              threadId,
              instanceId: input.instanceId,
              type: "user-input.resolved",
              requestId: RuntimeRequestId.make(requestId),
              ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
              payload: { answers: normalizedAnswers },
            })));
          },
          catch: (cause) => new ProviderAdapterProcessError({
            provider: "opencode",
            threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        });
      },
      stopSession: (threadId) => Effect.sync(() => {
        const session = sessions.get(threadId);
        if (!session) return;
        cancelPendingRequests(session, events);
        session.transport.close();
        sessions.delete(threadId);
      }),
      listSessions: () => Effect.sync(() => Array.from(sessions.values(), (s) => ({ provider: DRIVER, providerInstanceId: input.instanceId, status: s.status, runtimeMode: "full-access" as const, cwd: s.cwd, ...(s.model ? { model: s.model } : {}), threadId: s.threadId, resumeCursor: { sessionId: s.acpSessionId }, ...(s.activeTurnId ? { activeTurnId: s.activeTurnId } : {}), ...(s.lastError ? { lastError: s.lastError } : {}), createdAt: isoNow(), updatedAt: isoNow() }))),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) => {
        const session = sessions.get(threadId);
        if (!session) return Effect.fail(new ProviderAdapterValidationError({ provider: "opencode", operation: "readThread", issue: `No active OpenCode session for ${threadId}.` }));
        return Effect.tryPromise({
          try: async () => snapshotFromExport(threadId, await exportSession({ binaryPath: input.binaryPath, env: input.environment, cwd: session.cwd, sessionId: session.acpSessionId })),
          catch: (cause) => new ProviderAdapterProcessError({ provider: "opencode", threadId, detail: cause instanceof Error ? cause.message : String(cause), cause }),
        });
      },
      rollbackThread: (threadId, numTurns) => {
        const session = sessions.get(threadId);
        if (!session) return Effect.fail(new ProviderAdapterValidationError({ provider: "opencode", operation: "rollbackThread", issue: `No active OpenCode session for ${threadId}.` }));
        if (session.activeTurnId) return Effect.fail(new ProviderAdapterValidationError({ provider: "opencode", operation: "rollbackThread", issue: "Cannot roll back while an OpenCode turn is running." }));
        return Effect.gen(function* () {
          const exported = yield* Effect.tryPromise({
            try: () => exportSession({ binaryPath: input.binaryPath, env: input.environment, cwd: session.cwd, sessionId: session.acpSessionId }),
            catch: (cause) => new ProviderAdapterProcessError({ provider: "opencode", threadId, detail: cause instanceof Error ? cause.message : String(cause), cause }),
          });
          const userMessageIds = exportUserMessageIds(exported);
          if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > userMessageIds.length) {
            return yield* Effect.fail(new ProviderAdapterValidationError({ provider: "opencode", operation: "rollbackThread", issue: "numTurns must be within the current OpenCode transcript." }));
          }
          if (numTurns === 0) return snapshotFromExport(threadId, exported);
          const targetMessageId = userMessageIds[userMessageIds.length - numTurns];
          if (!targetMessageId) {
            return yield* Effect.fail(new ProviderAdapterValidationError({ provider: "opencode", operation: "rollbackThread", issue: "Could not identify the OpenCode message boundary to revert." }));
          }
          yield* Effect.tryPromise({
            try: async () => {
              const sessionPath = `/session/${encodeURIComponent(session.acpSessionId)}/revert`;
              const legacy = await apiRequest("POST", sessionPath, session.cwd, { messageID: targetMessageId });
              if (legacy.ok) return;
              if (legacy.status !== 404 && legacy.status !== 405) {
                throw new Error(`OpenCode rejected the session rollback (HTTP ${legacy.status}).`);
              }
              const staged = await apiRequest("POST", `/api/session/${encodeURIComponent(session.acpSessionId)}/revert/stage`, session.cwd, { messageID: targetMessageId, files: true });
              if (!staged.ok) throw new Error(`OpenCode could not stage the session rollback (HTTP ${staged.status}).`);
              const committed = await apiRequest("POST", `/api/session/${encodeURIComponent(session.acpSessionId)}/revert/commit`, session.cwd);
              if (!committed.ok) throw new Error(`OpenCode could not commit the session rollback (HTTP ${committed.status}).`);
            },
            catch: (cause) => new ProviderAdapterProcessError({ provider: "opencode", threadId, detail: cause instanceof Error ? cause.message : String(cause), cause }),
          });
          session.transport.close();
          const restored = yield* spawnAndInitialize({
            binaryPath: input.binaryPath,
            cwd: session.cwd,
            env: input.environment,
            sessionId: session.acpSessionId,
            mcpServers: session.mcpServers,
            threadId,
            ...(session.model ? { model: session.model } : {}),
          });
          session.transport = restored.transport;
          session.acpSessionId = restored.sessionId;
          session.pendingPermissions.clear();
          session.pendingUserInputs.clear();
          session.status = "ready";
          session.lastError = undefined;
          attachTransportHandlers(session);
          const updatedExport = yield* Effect.tryPromise({
            try: () => exportSession({ binaryPath: input.binaryPath, env: input.environment, cwd: session.cwd, sessionId: session.acpSessionId }),
            catch: (cause) => new ProviderAdapterProcessError({ provider: "opencode", threadId, detail: cause instanceof Error ? cause.message : String(cause), cause }),
          });
          return snapshotFromExport(threadId, updatedExport);
        });
      },
      stopAll: () => Effect.sync(() => {
        for (const session of sessions.values()) {
          cancelPendingRequests(session, events);
          session.transport.close();
        }
        sessions.clear();
        apiServer?.child.kill();
        void apiServerStartup?.then((server) => server.child.kill(), () => undefined);
      }),
      streamEvents: Stream.fromPubSub(events), subscribeEvents: PubSub.subscribe(events),
    };
    yield* Effect.addFinalizer(adapter.stopAll); return adapter;
  });
}

function queryModels(binaryPath: string, env: NodeJS.ProcessEnv): Promise<ReadonlyArray<ServerProvider["models"][number]>> {
  return new Promise((resolve) => NodeChildProcess.execFile(binaryPath, ["models"], { env, timeout: 15_000, windowsHide: true }, (error, stdout) => {
    if (error) { resolve([]); return; } const models = new Map<string, ServerProvider["models"][number]>();
    for (const line of stdout.split(/\r?\n/u)) {
      const slug = line.trim().replace(/\u001b\[[0-9;]*m/gu, ""); if (!/^[\w.-]+\/[\w./:+-]+$/u.test(slug)) continue;
      const [vendor, ...parts] = slug.split("/"); const name = parts.join("/"); if (!name) continue;
      const modelSlug = slug; models.set(modelSlug, { slug: modelSlug, name, shortName: name, subProvider: vendor, isCustom: false, capabilities: null });
    }
    resolve([...models.values()]);
  }));
}
function makeTextGeneration(binaryPath: string, env: NodeJS.ProcessEnv): TextGeneration.TextGeneration["Service"] {
  const run = (operation: string, cwd: string, selection: ModelSelection, prompt: string) => Effect.tryPromise({
    try: () => new Promise<string>((resolve, reject) => NodeChildProcess.execFile(binaryPath, ["run", "--model", selection.model, prompt], { cwd, env, timeout: 120_000, maxBuffer: 2_000_000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))),
    catch: (cause) => new TextGenerationError({ operation, detail: cause instanceof Error ? cause.message : String(cause), cause }),
  });
  return {
    generateCommitMessage: (r) => run("generateCommitMessage", r.cwd, r.modelSelection, `Return JSON with subject and body.\n${r.stagedSummary}\n${r.stagedPatch}`).pipe(Effect.map((response) => ({ subject: response, body: "" }))),
    generatePrContent: (r) => run("generatePrContent", r.cwd, r.modelSelection, `Return JSON with title and body.\n${r.commitSummary}\n${r.diffSummary}\n${r.diffPatch}`).pipe(Effect.map((response) => ({ title: "Pull request", body: response }))),
    generatePullRequestReview: (r) => run("generatePullRequestReview", r.cwd, r.modelSelection, r.prompt).pipe(Effect.map((response) => ({ response }))),
    generateBranchName: (r) => run("generateBranchName", r.cwd, r.modelSelection, `Return only a short kebab-case branch name for: ${r.message}`).pipe(Effect.map((response) => ({ branch: response.split(/\s/u)[0] || "sparky-change" }))),
    generateThreadTitle: (r) => run("generateThreadTitle", r.cwd, r.modelSelection, `Return a concise conversation title for: ${r.message}`).pipe(Effect.map((response) => ({ title: response.replace(/["\n]/gu, "").slice(0, 80) }))),
  };
}
export const OpenCodeAcpDriver: ProviderDriver<Settings, ServerConfig> = {
  driverKind: DRIVER, metadata: { displayName: "OpenCode" }, configSchema: SETTINGS, defaultConfig: () => ({ binaryPath: "" }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) => Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const binaryPath = config.binaryPath.trim() || "opencode";
    const env = mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER, instanceId });
    const models = yield* Effect.promise(() => queryModels(binaryPath, env));
    const installed = NodePath.isAbsolute(binaryPath) ? NodePath.resolve(binaryPath) === binaryPath : true;
    const snapshot: ServerProvider = {
      instanceId, driver: DRIVER, displayName: displayName ?? "OpenCode", ...(accentColor ? { accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey }, showInteractionModeToggle: true, requiresNewThreadForModelChange: true,
      enabled, installed, version: null, status: !enabled ? "disabled" : models.length ? "ready" : "warning",
      auth: { status: "unknown", type: "opencode", label: "OpenCode authentication" }, checkedAt: isoNow(), availability: "available",
      ...(!models.length ? { message: "No OpenCode models were found. Run `opencode auth login` and verify the OpenCode installation." } : {}),
      models, slashCommands: [], skills: [],
    };
    const snapshotChanges = yield* PubSub.sliding<ServerProvider>(1);
    const adapter = yield* makeOpenCodeAcpAdapter({ instanceId, binaryPath, attachmentsDir: serverConfig.attachmentsDir, environment: env });
    return { instanceId, driverKind: DRIVER, continuationIdentity, displayName, accentColor, enabled,
      snapshot: { maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: "opencode-ai" }), getSnapshot: Effect.succeed(snapshot), refresh: Effect.succeed(snapshot), streamChanges: Stream.fromPubSub(snapshotChanges) },
      adapter, textGeneration: makeTextGeneration(binaryPath, env) };
  }),
};
