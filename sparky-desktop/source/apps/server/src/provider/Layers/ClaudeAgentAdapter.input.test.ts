// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
const threadId = ThreadId.make("thread-claude-agent-input-test");
const environment = { ANTHROPIC_API_KEY: "sk-ant-api-test", PATH: "/bin" };
const provider = ProviderDriverKind.make("claudeAgent");

const initMessage = (sessionId: string) =>
  ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    apiKeySource: "ANTHROPIC_API_KEY",
  }) as unknown as SDKMessage;

const resultMessage = (sessionId: string, usage: Record<string, number> = {}) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    result: "ok",
  }) as unknown as SDKMessage;

/** Wait for runtime events until `done` is true or the wait times out. */
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

const wrapQuery = (generator: AsyncGenerator<SDKMessage>) =>
  Object.assign(generator, {
    interrupt: async () => undefined,
    close: () => undefined,
  }) as unknown as Query;

describe("Claude Code image attachments", () => {
  it("sends each image as a base64 content block alongside the text", async () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOs.tmpdir(), "sparky-claude-attach-"),
    );
    const attachmentId = "claude-agent-img-1";
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), bytes);

    const streamedPrompts: SDKUserMessage[] = [];
    const queryFn: ClaudeAgentQueryFn = (input) =>
      wrapQuery(
        (async function* () {
          if (typeof input.prompt !== "string") {
            for await (const message of input.prompt) streamedPrompts.push(message);
          }
          yield initMessage("sess-image");
          yield resultMessage("sess-image");
        })(),
      );

    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir,
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
        input: "What is in this screenshot?",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: bytes.length,
          } as never,
        ],
      });
      yield* collectUntil(events, (received) => received.some((e) => e.type === "turn.completed"));
    });
    await Effect.runPromise(Effect.scoped(program));

    expect(streamedPrompts).toHaveLength(1);
    const content = streamedPrompts[0]?.message.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(content[0]).toEqual({ type: "text", text: "What is in this screenshot?" });
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
    });
  });
});

describe("Claude Code AskUserQuestion", () => {
  it("asks the user through Sparky and returns the answer to Claude as the tool's answers", async () => {
    let toolResult: unknown;
    const queryFn: ClaudeAgentQueryFn = (input) =>
      wrapQuery(
        (async function* () {
          yield initMessage("sess-ask");
          const decision = await input.options.canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  question: "Which validation library?",
                  header: "Library",
                  options: [
                    { label: "Zod", description: "Schema-first validation" },
                    { label: "Valibot", description: "Smaller bundle" },
                  ],
                  multiSelect: false,
                },
              ],
            },
            { signal: new AbortController().signal, toolUseID: "toolu_ask" } as never,
          );
          toolResult = decision;
          yield resultMessage("sess-ask");
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
      yield* adapter.sendTurn({ threadId, input: "Pick one" });
      const received = yield* collectUntil(events, (list) =>
        list.some((event) => event.type === "user-input.requested"),
      );
      const requested = received.find((event) => event.type === "user-input.requested");
      const questions = (requested?.payload as unknown as { questions: Array<{ id: string }> })
        .questions;
      expect(questions).toHaveLength(1);
      yield* adapter.respondToUserInput(threadId, requested!.requestId! as never, {
        [questions[0]!.id]: "Zod",
      });
      yield* collectUntil(events, (list) => list.some((event) => event.type === "turn.completed"));
    });
    await Effect.runPromise(Effect.scoped(program));

    expect(toolResult).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: expect.any(Array),
        answers: { "Which validation library?": "Zod" },
      },
    });
  });

  it("rejects an answer that leaves a question unanswered", async () => {
    const queryFn: ClaudeAgentQueryFn = () =>
      wrapQuery(
        (async function* () {
          yield initMessage("sess-empty");
          yield resultMessage("sess-empty");
        })(),
      );
    const program = Effect.gen(function* () {
      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment,
        attachmentsDir: "/tmp/sparky-attachments",
        queryFn,
      });
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      return yield* adapter
        .respondToUserInput(threadId, "missing-request" as never, {})
        .pipe(Effect.exit);
    });
    const exit = await Effect.runPromise(Effect.scoped(program));
    expect(exit._tag).toBe("Failure");
  });
});
