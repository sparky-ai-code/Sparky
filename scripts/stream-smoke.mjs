import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "sparky-stream-smoke-"));
await writeFile(join(workspace, "README.md"), "Sparky tool streaming works.\n", "utf8");
const binary = process.argv[2]
  ? resolve(process.argv[2])
  : resolve("target", "release", process.platform === "win32" ? "sparky.exe" : "sparky");
let requestCount = 0;
const server = createServer((_request, response) => {
  requestCount += 1;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (requestCount === 1) {
    setTimeout(() => {
      response.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"path\\":\\""}}]}}]}\n\n',
      );
    }, 100);
    setTimeout(() => {
      response.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"README.md\\"}"}}]}}]}\n\n',
      );
    }, 250);
    setTimeout(() => response.end("data: [DONE]\n\n"), 350);
    return;
  }

  setTimeout(() => {
    response.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
  }, 100);
  setTimeout(() => {
    response.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
  }, 350);
  setTimeout(() => response.end("data: [DONE]\n\n"), 600);
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port");

const startedAt = Date.now();
const events = [];
let stdoutBuffer = "";
let stderr = "";
const child = spawn(
  binary,
  [
    "--json-stream",
    "--provider",
    "openai",
    "--model",
    "mock-stream-model",
    "--base-url",
    `http://127.0.0.1:${address.port}/v1`,
    "--cwd",
    workspace,
    "--prompt",
    "Say hello",
  ],
  {
    env: { ...process.env, OPENAI_API_KEY: "stream-smoke-key" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let lineEnd = stdoutBuffer.indexOf("\n");
  while (lineEnd >= 0) {
    const line = stdoutBuffer.slice(0, lineEnd).trim();
    stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
    if (line) events.push({ at: Date.now() - startedAt, value: JSON.parse(line) });
    lineEnd = stdoutBuffer.indexOf("\n");
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const exitCode = await new Promise((resolveExit) => child.once("close", resolveExit));
server.close();
await rm(workspace, { recursive: true, force: true });
if (exitCode !== 0) throw new Error(stderr || `Sparky exited with code ${exitCode}`);

const deltas = events.filter((event) => event.value.type === "delta");
const result = events.find((event) => event.value.type === "result");
const toolStarted = events.find((event) => event.value.type === "tool.started");
const toolCompleted = events.find((event) => event.value.type === "tool.completed");
if (
  !toolStarted ||
  toolStarted.value.toolCallId !== "call-1" ||
  toolStarted.value.toolName !== "read" ||
  toolStarted.value.arguments?.path !== "README.md"
) {
  throw new Error(`Expected a streamed tool start event, received ${JSON.stringify(events)}`);
}
if (
  !toolCompleted ||
  toolCompleted.value.toolCallId !== "call-1" ||
  toolCompleted.value.toolName !== "read" ||
  toolCompleted.value.isError !== false ||
  !toolCompleted.value.output.includes("Sparky tool streaming works.") ||
  toolCompleted.at < toolStarted.at
) {
  throw new Error(`Expected a streamed tool completion event, received ${JSON.stringify(events)}`);
}
if (deltas.map((event) => event.value.delta).join("") !== "Hello") {
  throw new Error(`Expected two streamed deltas, received ${JSON.stringify(events)}`);
}
if (!result || result.value.response !== "Hello" || result.at <= deltas.at(-1).at) {
  throw new Error(`Expected the final result after the deltas, received ${JSON.stringify(events)}`);
}
if (deltas.length < 2 || deltas[1].at - deltas[0].at < 150) {
  throw new Error(`Deltas were buffered instead of streamed: ${JSON.stringify(events)}`);
}

console.log(
  `Streaming smoke test passed: live tool lifecycle and ${deltas.length} text deltas before result (${result.at}ms).`,
);
