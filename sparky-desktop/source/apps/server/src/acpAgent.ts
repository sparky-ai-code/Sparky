import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { ThreadId, TurnId } from "@sparky/contracts";
import type { ProviderRuntimeEvent } from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ProviderService } from "./provider/Services/ProviderService.ts";

type JsonRpcRequest = {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type AcpSession = {
  readonly threadId: ThreadId;
  activeTurnId?: string;
  promptInFlight?: boolean;
};

type EventListener = (event: ProviderRuntimeEvent) => void;
type ListenForEvents = (threadId: ThreadId, listener: EventListener) => () => void;

const writeMessage = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const textFromPrompt = (prompt: unknown): string => {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
};

async function serveAcp(
  provider: ProviderService["Service"],
  listenForEvents: ListenForEvents,
): Promise<void> {
  const sessions = new Map<string, AcpSession>();
  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handle = async (request: JsonRpcRequest): Promise<void> => {
    const id = request.id;
    try {
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
            agentInfo: { name: "Sparky", version: "1.1" },
          };
          break;
        case "session/new": {
          const cwd = request.params?.cwd;
          if (typeof cwd !== "string" || !NodePath.isAbsolute(cwd)) {
            throw new Error("session/new requires an absolute cwd.");
          }
          const sessionId = crypto.randomUUID();
          const threadId = ThreadId.make(sessionId);
          await Effect.runPromise(
            provider.startSession(threadId, {
              threadId,
              cwd,
              workspaceContext: "project",
              runtimeMode: "full-access",
            }),
          );
          sessions.set(sessionId, { threadId });
          result = { sessionId };
          break;
        }
        case "session/prompt": {
          const sessionId = request.params?.sessionId;
          const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
          if (!session) throw new Error("Unknown ACP session.");
          if (session.promptInFlight) throw new Error("An ACP turn is already active for this session.");
          const prompt = textFromPrompt(request.params?.prompt);
          if (!prompt.trim()) throw new Error("session/prompt requires a text prompt.");
          let turnId: string | undefined;
          let completed: ((event: ProviderRuntimeEvent) => void) | undefined;
          const bufferedEvents: ProviderRuntimeEvent[] = [];
          const completion = new Promise<ProviderRuntimeEvent>((resolve) => {
            completed = resolve;
          });
          const processEvent: EventListener = (event) => {
            if (turnId === undefined) {
              bufferedEvents.push(event);
              return;
            }
            if (event.turnId !== turnId) return;
            if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
              writeMessage({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: event.payload.delta },
                  },
                },
              });
            }
            if (event.type === "turn.completed" || event.type === "turn.aborted") {
              completed?.(event);
              completed = undefined;
            }
          };
          session.promptInFlight = true;
          const unsubscribe = listenForEvents(session.threadId, processEvent);
          let terminalEvent: ProviderRuntimeEvent;
          try {
            const turn = await Effect.runPromise(
              provider.sendTurn({ threadId: session.threadId, input: prompt }),
            );
            turnId = turn.turnId;
            session.activeTurnId = turn.turnId;
            for (const event of bufferedEvents.splice(0)) processEvent(event);
            terminalEvent = await completion;
          } finally {
            unsubscribe();
            delete session.activeTurnId;
            delete session.promptInFlight;
          }
          result = {
            stopReason: terminalEvent.type === "turn.aborted" ? "cancelled" : "end_turn",
          };
          break;
        }
        case "session/cancel": {
          const sessionId = request.params?.sessionId;
          const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
          if (session?.activeTurnId) {
            await Effect.runPromise(
              provider.interruptTurn({
                threadId: session.threadId,
                turnId: TurnId.make(session.activeTurnId),
              }),
            );
          }
          result = {};
          break;
        }
        default:
          throw new Error(`Unsupported ACP method: ${request.method}`);
      }
      if (id !== undefined) writeMessage({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (id !== undefined) {
        writeMessage({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  };

  for await (const line of input) {
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      void handle(request);
    } catch {
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } });
    }
  }
  for (const session of sessions.values()) {
    await Effect.runPromise(provider.stopSession({ threadId: session.threadId })).catch((error: unknown) => {
      process.stderr.write(
        `[acp] failed to stop provider session: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const provider = yield* ProviderService;
    const listeners = new Map<ThreadId, Set<EventListener>>();
    const subscription = provider.subscribeEvents ? yield* provider.subscribeEvents : undefined;
    const events = subscription ? Stream.fromSubscription(subscription) : provider.streamEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        Effect.sync(() => {
          for (const listener of listeners.get(event.threadId) ?? []) listener(event);
        }),
      ),
    );
    const listen: ListenForEvents = (threadId, listener) => {
      const existing = listeners.get(threadId) ?? new Set<EventListener>();
      existing.add(listener);
      listeners.set(threadId, existing);
      return () => {
        existing.delete(listener);
        if (existing.size === 0) listeners.delete(threadId);
      };
    };
    yield* Effect.promise(() => serveAcp(provider, listen));
  }),
);
