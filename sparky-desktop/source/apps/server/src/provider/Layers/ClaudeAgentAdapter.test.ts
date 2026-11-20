import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import { describe, expect, it } from "vite-plus/test";

import {
  makeClaudeAgentAdapter,
  readClaudeAgentResumeCursor,
  type ClaudeAgentQueryFn,
} from "./ClaudeAgentAdapter.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread-claude-agent-test");

type Script = (options: Options) => ReadonlyArray<SDKMessage> | AsyncGenerator<SDKMessage>;

/** Fake SDK query: yields scripted messages and records the options it was given. */
function makeFakeQuery(script: Script, calls: Array<Options>): ClaudeAgentQueryFn {
  return (input) => {
    calls.push(input.options);
    const scripted = script(input.options);
    const generator = (async function* () {
      if (Symbol.asyncIterator in (scripted as object)) {
        for await (const message of scripted as AsyncGenerator<SDKMessage>) yield message;
      } else {
        for (const message of scripted as ReadonlyArray<SDKMessage>) yield message;
      }
    })();
    return Object.assign(generator, {
      interrupt: async () => undefined,
      close: () => undefined,
    }) as unknown as Query;
  };
}

const initMessage = (sessionId: string, apiKeySource = "ANTHROPIC_API_KEY") =>
  ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    apiKeySource,
  }) as unknown as SDKMessage;

const successResult = (sessionId: string) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    result: "ok",
  }) as unknown as SDKMessage;

const assistantText = (id: string, text: string) =>
  ({
    type: "assistant",
    message: { id, content: [{ type: "text", text }] },
  }) as unknown as SDKMessage;

const environment = { ANTHROPIC_API_KEY: "sk-ant-api-test", PATH: "/bin" };

/** Waits for the runtime event stream until `done` returns true. */
const collectUntil = (
  queue: PubSub.Subscription<ProviderRuntimeEvent>,
  done: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    for (let attempt = 0; attempt < 200 && !done(events); attempt++) {
      const next = yield* PubSub.take(queue).pipe(Effect.timeout("2 seconds"));
      events.push(next);
    }
    return events;
  });

describe("readClaudeAgentResumeCursor", () => {
  it("parses only the adapter-owned cursor shape", () => {
    expect(readClaudeAgentResumeCursor({ version: 1, sessionId: "sess-1" })).toEqual({
      version: 1,
      sessionId: "sess-1",
    });
    expect(readClaudeAgentResumeCursor({ version: 2, sessionId: "sess-1" })).toBeUndefined();
    expect(readClaudeAgentResumeCursor({ version: 1, sessionId: "  " })).toBeUndefined();
    expect(readClaudeAgentResumeCursor("sess-1")).toBeUndefined();
  });
});

describe("makeClaudeAgentAdapter", () => {
  it("fails to start without an Anthropic API key", async () => {
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment: { PATH: "/bin" },
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn: makeFakeQuery(() => [], []),
      });
      return yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
    });
    const result = await Effect.runPromise(Effect.scoped(program));
    expect(Exit.isFailure(result)).toBe(true);
  });

  it("runs a turn, streams canonical events, and resumes the same Claude session next turn", async () => {
    const calls: Array<Options> = [];
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn: makeFakeQuery(
          () => [initMessage("sess-1"), assistantText("msg-1", "Hi"), successResult("sess-1")],
          calls,
        ),
      });
      const queue = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "Say hi" });
      const firstEvents = yield* collectUntil(queue, (events) =>
        events.some((event) => event.type === "turn.completed"),
      );
      const second = yield* adapter.sendTurn({ threadId, input: "Again" });
      yield* collectUntil(
        queue,
        (events) => events.filter((e) => e.type === "turn.completed").length >= 1,
      );
      return { first, second, firstEvents };
    });
    const result = await Effect.runPromise(Effect.scoped(program));

    const types = result.firstEvents.map((event) => event.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("content.delta");
    expect(types).toContain("turn.completed");
    const completed = result.firstEvents.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({ state: "completed" });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.resume).toBeUndefined();
    expect(calls[1]?.resume).toBe("sess-1");
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBe("sk-ant-api-test");
    expect(calls[0]?.settingSources).toEqual([]);
    expect(result.second.turnId).not.toBe(result.first.turnId);
  });

  it("fails the turn when Claude Code reports a non-API-key credential source", async () => {
    const calls: Array<Options> = [];
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn: makeFakeQuery(
          () => [initMessage("sess-oauth", "oauth"), successResult("sess-oauth")],
          calls,
        ),
      });
      const queue = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Hello" });
      return yield* collectUntil(queue, (events) =>
        events.some((event) => event.type === "turn.completed"),
      );
    });
    const events = await Effect.runPromise(Effect.scoped(program));
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({ state: "failed" });
    expect(String((completed?.payload as { errorMessage?: string }).errorMessage)).toContain(
      "API key",
    );
  });

  it("routes an approval request through respondToRequest before the tool runs", async () => {
    const calls: Array<Options> = [];
    let toolDecision: string | undefined;
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn: makeFakeQuery((options) => {
          // Simulate Claude Code asking for permission to run a shell command.
          const messagesPromise = (async function* () {
            yield initMessage("sess-approval") as SDKMessage;
            const decision = await options.canUseTool!("Bash", { command: "echo hi" }, {
              signal: new AbortController().signal,
              toolUseID: "toolu_approval",
            } as never);
            toolDecision = decision?.behavior;
            yield successResult("sess-approval") as SDKMessage;
          })();
          return messagesPromise as unknown as ReadonlyArray<SDKMessage>;
        }, calls),
      });
      const queue = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "Run a command" });
      const opened = yield* collectUntil(queue, (events) =>
        events.some((event) => event.type === "request.opened"),
      );
      const request = opened.find((event) => event.type === "request.opened");
      expect(request?.payload).toMatchObject({ requestType: "command_execution_approval" });
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(request?.requestId)),
        "accept",
      );
      yield* collectUntil(queue, (events) =>
        events.some((event) => event.type === "turn.completed"),
      );
    });
    await Effect.runPromise(Effect.scoped(program));
    expect(toolDecision).toBe("allow");
  });

  it("refuses rollback with an explicit error rather than silently succeeding", async () => {
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn: makeFakeQuery(() => [], []),
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      return yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
    });
    const result = await Effect.runPromise(Effect.scoped(program));
    expect(Exit.isFailure(result)).toBe(true);
  });
});
