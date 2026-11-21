// Test double for the Claude ACP adapter. It speaks real ACP over stdio, so the
// Sparky client and adapter tests exercise the protocol without a model or a login.
//
// Scenarios (FAKE_ACP_SCENARIO):
//   basic       text, a tool call, a plan, and usage, then end_turn
//   permission  asks for permission before a Bash tool call
//   cancel      waits for session/cancel, then answers cancelled
//   auth        fails session/new as if Claude Code were not signed in
//
// FAKE_ACP_STATE_FILE holds the session ids across processes, so session/resume
// works the way it does for the real adapter, which Sparky starts once per turn.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const scenario = process.env.FAKE_ACP_SCENARIO ?? "basic";
const stateFile = process.env.FAKE_ACP_STATE_FILE ?? "";

function readSessions() {
  if (!stateFile || !existsSync(stateFile)) return [];
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function rememberSession(sessionId) {
  if (!stateFile) return;
  writeFileSync(stateFile, JSON.stringify([...readSessions(), sessionId]));
}

let resumedThisProcess = false;
const cancelWaiters = new Map();
const mcpCounts = new Map();
let sessionCounter = 0;

const app = agent({ name: "fake-claude-acp" })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentInfo: { name: "fake-claude-acp", title: "Fake Claude", version: "0.0.0" },
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
    },
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (scenario === "auth") {
      throw new Error("Authentication required: run claude and use /login");
    }
    sessionCounter += 1;
    const sessionId = `fake-session-${process.pid}-${sessionCounter}`;
    rememberSession(sessionId);
    mcpCounts.set(sessionId, params.mcpServers?.length ?? 0);
    return { sessionId };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    if (!readSessions().includes(params.sessionId)) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    resumedThisProcess = true;
    mcpCounts.set(params.sessionId, params.mcpServers?.length ?? 0);
    return { sessionId: params.sessionId };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    const waiter = cancelWaiters.get(params.sessionId);
    if (waiter) waiter();
  })
  .onRequest(methods.agent.session.prompt, async ({ params }) => {
    const sessionId = params.sessionId;
    const mcpCount = mcpCounts.get(sessionId) ?? 0;
    const send = (update) =>
      connection.client.notify(methods.client.session.update, { sessionId, update });
    const text = (value) => ({ type: "text", text: value });
    const promptText = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const imageCount = params.prompt.filter((block) => block.type === "image").length;
    const marker = `${resumedThisProcess ? "resumed" : "new"} mcp=${mcpCount} images=${imageCount}`;

    if (scenario === "cancel") {
      await new Promise((resolve) => cancelWaiters.set(sessionId, resolve));
      cancelWaiters.delete(sessionId);
      return { stopReason: "cancelled" };
    }

    await send({ sessionUpdate: "agent_message_chunk", content: text(`Hello (${marker}). `) });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "tool-read-1",
      title: "Read a.ts",
      kind: "read",
      status: "in_progress",
      rawInput: { file_path: "a.ts" },
      _meta: { claudeCode: { toolName: "Read" } },
    });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-read-1",
      status: "completed",
      content: [{ type: "content", content: text("file body") }],
    });
    await send({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", priority: "high", status: "completed" },
        { content: "Fix the bug", priority: "high", status: "in_progress" },
      ],
    });
    await send({ sessionUpdate: "usage_update", used: 1200, size: 200000 });

    if (scenario === "permission") {
      const response = await connection.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: "tool-bash-1",
          title: "Bash",
          kind: "execute",
          status: "pending",
          rawInput: { command: "echo hi" },
          _meta: { claudeCode: { toolName: "Bash" } },
        },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const allowed =
        response.outcome.outcome === "selected" && response.outcome.optionId === "allow-once";
      if (allowed) {
        await send({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-bash-1",
          status: "completed",
        });
      }
      await send({
        sessionUpdate: "agent_message_chunk",
        content: text(allowed ? "approved" : "denied"),
      });
    }

    return { stopReason: "end_turn" };
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
