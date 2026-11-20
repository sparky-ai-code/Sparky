// @effect-diagnostics nodeBuiltinImport:off
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { describe, expect, it } from "vite-plus/test";

import { makeClaudeAgentAdapter, type ClaudeAgentQueryFn } from "./ClaudeAgentAdapter.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const provider = ProviderDriverKind.make("claudeAgent");

const wrap = (generator: AsyncGenerator<SDKMessage>) =>
  Object.assign(generator, {
    interrupt: async () => undefined,
    close: () => undefined,
  }) as unknown as Query;

/** Scripted query for one turn that reports the given credential source. */
const scriptedQuery =
  (apiKeySource: string, calls: Array<Options>): ClaudeAgentQueryFn =>
  (input) => {
    calls.push(input.options);
    return wrap(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-account",
          apiKeySource,
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sess-account",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          result: "ok",
        } as unknown as SDKMessage;
      })(),
    );
  };

const collectUntilCompleted = (subscription: PubSub.Subscription<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      const event = yield* PubSub.take(subscription).pipe(Effect.timeout("2 seconds"));
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    return events;
  });

describe("claudeAccount auth mode in the adapter", () => {
  it("starts and completes a turn with no API key, on the CLI's own sign-in", async () => {
    const calls: Array<Options> = [];
    const threadId = ThreadId.make("thread-account-mode-ok");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment: { PATH: "/bin" },
        attachmentsDir: "/tmp/sparky-attachments",
        authMode: "claudeAccount",
        queryFn: scriptedQuery("none", calls),
      });
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Hello" });
      return yield* collectUntilCompleted(events);
    });
    const events = await Effect.runPromise(Effect.scoped(program));
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({ state: "completed" });
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("fails the turn if the CLI reports an API key in account mode", async () => {
    const calls: Array<Options> = [];
    const threadId = ThreadId.make("thread-account-mode-key");
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment: { PATH: "/bin" },
        attachmentsDir: "/tmp/sparky-attachments",
        authMode: "claudeAccount",
        queryFn: scriptedQuery("ANTHROPIC_API_KEY", calls),
      });
      const events = yield* adapter.subscribeEvents!;
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Hello" });
      return yield* collectUntilCompleted(events);
    });
    const events = await Effect.runPromise(Effect.scoped(program));
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({ state: "failed" });
    expect(String((completed?.payload as { errorMessage?: string }).errorMessage)).toContain(
      "signed in with a Claude account",
    );
  });
});
