// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import type { PermissionOption } from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { describe, expect, it } from "vite-plus/test";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  autoApproveResponse,
  makeClaudeAgentAdapter,
  permissionResponseFor,
  turnOutcome,
} from "./ClaudeAgentAdapter.ts";

const fakeAgent = fileURLToPath(
  new URL("../../claudeAcp/testing/fakeClaudeAcpAgent.mjs", import.meta.url),
);
const instanceId = ProviderInstanceId.make("claudeAgent");
const provider = ProviderDriverKind.make("claudeAgent");

function stateFileIn(dir: string): string {
  return NodePath.join(dir, "sessions.json");
}

function adapterOptions(input: {
  readonly scenario: string;
  readonly stateDir: string;
  readonly attachmentsDir?: string;
}) {
  return {
    instanceId,
    command: process.execPath,
    args: [fakeAgent],
    ambientEnvironment: process.env,
    instanceEnvironment: [
      { name: "FAKE_ACP_SCENARIO", value: input.scenario },
      { name: "FAKE_ACP_STATE_FILE", value: stateFileIn(input.stateDir) },
    ],
    attachmentsDir: input.attachmentsDir ?? input.stateDir,
  };
}

/** Collect runtime events until a turn completes or the wait times out. */
function collectUntilCompleted(subscription: PubSub.Subscription<ProviderRuntimeEvent>) {
  return Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    for (let attempt = 0; attempt < 400; attempt++) {
      const event = yield* PubSub.take(subscription).pipe(Effect.timeout("20 seconds"));
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    return events;
  });
}

const textOf = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events
    .filter((event) => event.type === "content.delta")
    .map((event) => String((event.payload as { delta?: string }).delta ?? ""))
    .join("");

const newThread = (suffix: string) => ThreadId.make(`thread-claude-acp-${suffix}-${Date.now()}`);

describe("Claude Code adapter over ACP", () => {
  it("runs a turn, streams text, tool, plan, and usage, and completes", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const threadId = newThread("basic");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(
        adapterOptions({ scenario: "basic", stateDir }),
      );
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Say hello" });
      return yield* collectUntilCompleted(events);
    });
    const received = await Effect.runPromise(Effect.scoped(program));

    expect(textOf(received)).toContain("Hello (new mcp=0 images=0).");
    expect(received.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn.started",
        "item.started",
        "item.completed",
        "turn.plan.updated",
        "thread.token-usage.updated",
        "turn.completed",
      ]),
    );
    expect(received.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
      state: "completed",
    });
    // The tool call from the fake adapter is the one with the id tool-read-1.
    expect(received.some((event) => String(event.itemId) === "tool-read-1")).toBe(true);
  }, 60_000);

  it("resumes the same ACP session on the next turn, after a fresh adapter process", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const threadId = newThread("resume");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(
        adapterOptions({ scenario: "basic", stateDir }),
      );
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "First" });
      yield* collectUntilCompleted(events);
      yield* adapter.sendTurn({ threadId, input: "Second" });
      return yield* collectUntilCompleted(events);
    });
    const second = await Effect.runPromise(Effect.scoped(program));
    expect(textOf(second)).toContain("resumed");
  }, 60_000);

  it("passes the Sparky MCP bridge to the adapter with the turn's credential", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const threadId = newThread("mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("env-claude-acp-test"),
      threadId,
      providerSessionId: "provider-session-test",
      providerInstanceId: instanceId,
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer test-token",
    });
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(
        adapterOptions({ scenario: "basic", stateDir }),
      );
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Use Sparky" });
      return yield* collectUntilCompleted(events);
    });
    const received = await Effect.runPromise(Effect.scoped(program));
    expect(textOf(received)).toContain("mcp=1");
    McpProviderSession.clearMcpProviderSession(threadId);
  }, 60_000);

  it("sends an image attachment to the adapter as an image block", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const attachmentId = "claude-acp-img-1";
    NodeFS.writeFileSync(
      NodePath.join(stateDir, `${attachmentId}.png`),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const threadId = newThread("image");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(
        adapterOptions({ scenario: "basic", stateDir, attachmentsDir: stateDir }),
      );
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "What is this?",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 4,
          } as never,
        ],
      });
      return yield* collectUntilCompleted(events);
    });
    const received = await Effect.runPromise(Effect.scoped(program));
    expect(textOf(received)).toContain("images=1");
  }, 60_000);

  it("asks the user to decide a tool permission and sends the decision back to the adapter", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const threadId = newThread("permission");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(
        adapterOptions({ scenario: "permission", stateDir }),
      );
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "Run a command" });
      const opened = yield* Effect.gen(function* () {
        const seen: ProviderRuntimeEvent[] = [];
        for (let attempt = 0; attempt < 400; attempt++) {
          const event = yield* PubSub.take(events).pipe(Effect.timeout("20 seconds"));
          seen.push(event);
          if (event.type === "request.opened") break;
        }
        return seen;
      });
      const request = opened.find((event) => event.type === "request.opened");
      expect(request?.payload).toMatchObject({ requestType: "command_execution_approval" });
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(request?.requestId)),
        "accept",
      );
      return yield* collectUntilCompleted(events);
    });
    const received = await Effect.runPromise(Effect.scoped(program));
    expect(textOf(received)).toContain("approved");
    expect(received.find((event) => event.type === "request.resolved")).toBeDefined();
  }, 60_000);

  it("interrupts a running turn and reports it as interrupted", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const threadId = newThread("cancel");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(
        adapterOptions({ scenario: "cancel", stateDir }),
      );
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Long task" });
      yield* Effect.sleep("1 second");
      yield* adapter.interruptTurn(threadId);
      return yield* collectUntilCompleted(events);
    });
    const received = await Effect.runPromise(Effect.scoped(program));
    expect(received.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
      state: "interrupted",
    });
  }, 60_000);

  it("fails the turn with the sign-in step when Claude Code is not signed in", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const threadId = newThread("auth");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(adapterOptions({ scenario: "auth", stateDir }));
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Hello" });
      return yield* collectUntilCompleted(events);
    });
    const received = await Effect.runPromise(Effect.scoped(program));
    const completed = received.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({ state: "failed" });
    expect(String((completed?.payload as { errorMessage?: string }).errorMessage)).toContain(
      "not signed in",
    );
  }, 60_000);

  it("refuses rollback with an explicit error", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sparky-claude-acp-"));
    const threadId = newThread("rollback");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter(
        adapterOptions({ scenario: "basic", stateDir }),
      );
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      return yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
    });
    const exit = await Effect.runPromise(Effect.scoped(program));
    expect(exit._tag).toBe("Failure");
  });
});

describe("ACP permission and stop-reason mapping", () => {
  const options: PermissionOption[] = [
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "allow-always", name: "Always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  it("maps Sparky decisions to the matching ACP option", () => {
    expect(permissionResponseFor("accept", options)).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(permissionResponseFor("acceptForSession", options)).toEqual({
      outcome: { outcome: "selected", optionId: "allow-always" },
    });
    expect(permissionResponseFor("decline", options)).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(permissionResponseFor("cancel", options)).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels when the adapter offered no matching option", () => {
    expect(permissionResponseFor("accept", [])).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("auto-approves in full-access mode with the first allow option", () => {
    expect(autoApproveResponse(options)).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("maps ACP stop reasons to turn outcomes", () => {
    expect(turnOutcome("end_turn")).toEqual(["completed", undefined]);
    expect(turnOutcome("cancelled")).toEqual(["interrupted", undefined]);
    expect(turnOutcome("refusal")[0]).toBe("failed");
    expect(turnOutcome("max_tokens")[1]).toContain("output limit");
  });
});
