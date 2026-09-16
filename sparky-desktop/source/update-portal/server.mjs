import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const portalRoot = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const publicRoot = NodePath.join(portalRoot, "public");
const releaseRoot =
  process.env.SPARKY_UPDATE_RELEASE_DIR?.trim() || NodePath.join(portalRoot, "releases");
const host = process.env.SPARKY_UPDATE_PORTAL_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.SPARKY_UPDATE_PORTAL_PORT || "4178");
const founderToken = process.env.SPARKY_FOUNDER_TOKEN?.trim();
const sessions = new Map();
const MAX_INSTALLER_BYTES = 500 * 1024 * 1024;

if (!founderToken || founderToken.length < 24) {
  throw new Error("SPARKY_FOUNDER_TOKEN must be set to a private value of at least 24 characters.");
}

await NodeFSP.mkdir(releaseRoot, { recursive: true });

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}

function sessionId(request) {
  const cookie = request.headers.cookie || "";
  return cookie.match(/(?:^|;\s*)sparky_founder=([^;]+)/)?.[1] ?? null;
}

function isFounder(request) {
  const id = sessionId(request);
  const expiresAt = id ? sessions.get(id) : undefined;
  if (!id || !expiresAt || expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return false;
  }
  return true;
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeInstallerName(value) {
  const name = (Array.isArray(value) ? value[0] : value)?.trim() || "";
  return /^Sparky-[0-9A-Za-z._-]+\.exe$/u.test(name) ? name : null;
}

function safeVersion(value) {
  const version = (Array.isArray(value) ? value[0] : value)?.trim() || "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ? version : null;
}

function serveFile(response, path, contentType, cacheControl = "no-store") {
  if (!NodeFS.existsSync(path)) {
    json(response, 404, { error: "Not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  });
  NodeFS.createReadStream(path).pipe(response);
}

const server = NodeHttp.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || host}`);

    if (request.method === "GET" && url.pathname === "/") {
      serveFile(response, NodePath.join(publicRoot, "index.html"), "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/session") {
      json(response, 200, { authenticated: isFounder(request) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = JSON.parse((await readBody(request, 16 * 1024)).toString("utf8"));
      if (typeof body.token !== "string" || !secureEqual(body.token, founderToken)) {
        json(response, 401, { error: "Invalid founder token." });
        return;
      }
      const id = NodeCrypto.randomBytes(32).toString("base64url");
      sessions.set(id, Date.now() + 8 * 60 * 60 * 1000);
      json(response, 200, { ok: true }, {
        "set-cookie": `sparky_founder=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      const id = sessionId(request);
      if (id) sessions.delete(id);
      json(response, 200, { ok: true }, {
        "set-cookie": "sparky_founder=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/releases") {
      if (!isFounder(request)) {
        json(response, 401, { error: "Founder access required." });
        return;
      }
      const version = safeVersion(request.headers["x-sparky-version"]);
      const name = safeInstallerName(request.headers["x-sparky-filename"]);
      if (!version || !name) {
        json(response, 400, { error: "A valid version and Sparky-*.exe filename are required." });
        return;
      }
      const installer = await readBody(request, MAX_INSTALLER_BYTES);
      if (installer.length === 0) {
        json(response, 400, { error: "Installer is empty." });
        return;
      }
      const digest = NodeCrypto.createHash("sha512").update(installer).digest("base64");
      const temporaryPath = NodePath.join(
        releaseRoot,
        `${name}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
      );
      const installerPath = NodePath.join(releaseRoot, name);
      await NodeFSP.writeFile(temporaryPath, installer, { flag: "wx" });
      await NodeFSP.rename(temporaryPath, installerPath);
      const manifest = [
        `version: ${version}`,
        `files:`,
        `  - url: ${name}`,
        `    sha512: ${digest}`,
        `    size: ${installer.length}`,
        `path: ${name}`,
        `sha512: ${digest}`,
        `releaseDate: ${new Date().toISOString()}`,
        "",
      ].join("\n");
      await NodeFSP.writeFile(NodePath.join(releaseRoot, "latest.yml"), manifest, "utf8");
      json(response, 201, { version, name, size: installer.length, sha512: digest });
      return;
    }
    if (request.method === "GET" && url.pathname === "/updates/latest.yml") {
      serveFile(
        response,
        NodePath.join(releaseRoot, "latest.yml"),
        "text/yaml; charset=utf-8",
      );
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/updates/")) {
      const name = safeInstallerName(url.pathname.slice("/updates/".length));
      if (!name) {
        json(response, 404, { error: "Not found" });
        return;
      }
      serveFile(
        response,
        NodePath.join(releaseRoot, name),
        "application/vnd.microsoft.portable-executable",
        "public, max-age=31536000, immutable",
      );
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
  }
});

server.listen(port, host, () => {
  console.log(`Sparky founder update portal: http://${host}:${port}`);
  console.log(`Electron update feed: http://${host}:${port}/updates`);
});
