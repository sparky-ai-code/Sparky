// @effect-diagnostics nodeBuiltinImport:off
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeAgentPlanSteps,
  makeClaudeAgentMapper,
} from "../../claudeAgent/ClaudeAgentEvents.ts";
import {
  makeClaudeAgentAdapter,
  resolveClaudeAgentEffort,
  type ClaudeAgentQueryFn,
} from "./ClaudeAgentAdapter.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread-claude-agent-plan-test");
const environment = { ANTHROPIC_API_KEY: "sk-ant-api-test", PATH: "/bin" };
const provider = ProviderDriverKind.make("claudeAgent");

const wrap = (generator: AsyncGenerator<SDKMessage>) =>
  Object.assign(generator, {
    interrupt: async () => undefined,
    close: () => undefined,
  }) as unknown as Query;

const collectUntil = (
  subscription: PubSub.Subscription<ProviderRuntimeEvent>,
  done: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    for (let attempt = 0; attempt < 200 && !done(events); attempt++) {
      events.push(yield* PubSub.take(subscription).pipe(Effect.timeout("2 seconds")));
    }
    return events;
  });

describe("Claude Code plan steps", () => {
  it("maps TodoWrite statuses to Sparky plan steps", () => {
    expect(
      claudeAgentPlanSteps([
        { content: "Read the code", status: "completed", activeForm: "Reading" },
        { content: "Write the fix", status: "in_progress", activeForm: "Writing" },
        { content: "Run tests", status: "pending", activeForm: "Running" },
        { content: "   ", status: "pending" },
      ]),
    ).toEqual([
      { step: "Read the code", status: "completed" },
      { step: "Write the fix", status: "inProgress" },
      { step: "Run tests", status: "pending" },
    ]);
  });

  it("publishes a plan update when Claude Code writes its todo list", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-plan" });
    const drafts = mapper.map({
      type: "assistant",
      message: {
        id: "msg-plan",
        content: [
          {
            type: "tool_use",
            id: "toolu_todo",
            name: "TodoWrite",
            input: { todos: [{ content: "Ship it", status: "in_progress" }] },
          },
        ],
      },
    } as unknown as SDKMessage);
    const update = drafts.find((draft) => draft.type === "turn.plan.updated");
    expect(update?.payload).toEqual({ plan: [{ step: "Ship it", status: "inProgress" }] });
  });
});

describe("Claude Code plan mode and effort", () => {
  it("maps Sparky's reasoning effort to Claude Code effort levels only", () => {
    const selection = (value: string) =>
      ({
        instanceId: "claudeAgent",
        model: "claude-sonnet-5",
        options: [{ id: "reasoningEffort", value }],
      }) as never;
    expect(resolveClaudeAgentEffort(selection("high"))).toBe("high");
    expect(resolveClaudeAgentEffort(selection("turbo"))).toBeUndefined();
    expect(resolveClaudeAgentEffort(undefined)).toBeUndefined();
  });

  it("runs Claude Code in plan permission mode with the requested effort", async () => {
    const calls: Array<Options> = [];
    const queryFn: ClaudeAgentQueryFn = (input) => {
      calls.push(input.options);
      return wrap(
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-plan",
            apiKeySource: "ANTHROPIC_API_KEY",
          } as unknown as SDKMessage;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sess-plan",
            stop_reason: "end_turn",
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            result: "ok",
          } as unknown as SDKMessage;
        })(),
      );
    };
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn,
      });
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan the change",
        interactionMode: "plan",
        modelSelection: {
          instanceId,
          model: "claude-sonnet-5",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as never,
      });
      yield* collectUntil(events, (list) => list.some((event) => event.type === "turn.completed"));
    });
    await Effect.runPromise(Effect.scoped(program));
    expect(calls[0]?.permissionMode).toBe("plan");
    expect(calls[0]?.effort).toBe("high");
  });

  it("asks the user to approve a finished plan even in full-access mode", async () => {
    let decision: unknown;
    const queryFn: ClaudeAgentQueryFn = (input) =>
      wrap(
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-exit",
            apiKeySource: "ANTHROPIC_API_KEY",
          } as unknown as SDKMessage;
          decision = await input.options.canUseTool!(
            "ExitPlanMode",
            { plan: "1. Read the code\n2. Fix the bug" },
            { signal: new AbortController().signal, toolUseID: "toolu_exit" } as never,
          );
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sess-exit",
            stop_reason: "end_turn",
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            result: "ok",
          } as unknown as SDKMessage;
        })(),
      );
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn,
      });
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Plan it", interactionMode: "plan" });
      const received = yield* collectUntil(events, (list) =>
        list.some((event) => event.type === "request.opened"),
      );
      const proposed = received.find((event) => event.type === "turn.proposed.completed");
      expect(proposed?.payload).toEqual({ planMarkdown: "1. Read the code\n2. Fix the bug" });
      const opened = received.find((event) => event.type === "request.opened");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened?.requestId)),
        "accept",
      );
      yield* collectUntil(events, (list) => list.some((event) => event.type === "turn.completed"));
    });
    await Effect.runPromise(Effect.scoped(program));
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: { plan: "1. Read the code\n2. Fix the bug" },
    });
  });
});
