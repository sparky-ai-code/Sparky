import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "sparky-session-resume-"));
const binary = process.argv[2]
  ? resolve(process.argv[2])
  : resolve("target", "release", process.platform === "win32" ? "sparky.exe" : "sparky");
const requests = [];

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  const content = requests.length === 1 ? "I will remember cobalt." : "The color is cobalt.";
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
});

function runPrompt(prompt, sessionId) {
  return new Promise((resolveRun, rejectRun) => {
    const args = [
      "--json-stream",
      "--provider",
      "openai",
      "--model",
      "mock-session-model",
      "--base-url",
      `http://127.0.0.1:${server.address().port}/v1`,
      "--cwd",
      workspace,
      "--prompt",
      prompt,
    ];
    if (sessionId) args.push("--session", sessionId);
    const child = spawn(binary, args, {
      env: { ...process.env, OPENAI_API_KEY: "session-smoke-key" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => {
      if (code !== 0) {
        rejectRun(new Error(stderr || `Sparky exited with code ${code}`));
        return;
      }
      const events = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resolveRun(events.find((event) => event.type === "result"));
    });
  });
}

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
try {
  const first = await runPrompt("Remember that the project color is cobalt.");
  if (!first?.sessionId) throw new Error("The first run did not return a session id");
  const second = await runPrompt("What project color did I give you?", first.sessionId);
  if (second?.response !== "The color is cobalt.") {
    throw new Error(`Unexpected resumed response: ${JSON.stringify(second)}`);
  }

  const resumedMessages = requests[1]?.messages ?? [];
  const conversation = resumedMessages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  const expected = [
    { role: "user", content: "Remember that the project color is cobalt." },
    { role: "assistant", content: "I will remember cobalt." },
    { role: "user", content: "What project color did I give you?" },
  ];
  if (JSON.stringify(conversation) !== JSON.stringify(expected)) {
    throw new Error(`Resumed provider context was incorrect: ${JSON.stringify(conversation)}`);
  }

  console.log(`Session resume smoke passed for ${first.sessionId}.`);
} finally {
  server.close();
  await rm(workspace, { recursive: true, force: true });
}
