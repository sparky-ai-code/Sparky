import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-11-17T00:00:00.000Z";
const parentId = ThreadId.make("parent");
const projectId = ProjectId.make("project");
const selection = { instanceId: ProviderInstanceId.make("sparky"), model: "openai-codex/gpt-5.6" };

const event = (
  sequence: number,
  type: OrchestrationEvent["type"],
  aggregateId: string,
  payload: unknown,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make("subagent-event-" + sequence),
  aggregateKind: type.startsWith("project.") ? "project" : "thread",
  aggregateId,
  type,
  occurredAt: NOW,
  commandId: CommandId.make("seed-" + sequence),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload,
}) as OrchestrationEvent;

const createdPayload = (id: string, parentThreadId?: string) => ({
  threadId: ThreadId.make(id),
  projectId,
  ...(parentThreadId ? { parentThreadId: ThreadId.make(parentThreadId) } : {}),
  title: "Agent " + id,
  modelSelection: selection,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: "main",
  worktreePath: "/workspace",
  createdAt: NOW,
  updatedAt: NOW,
});

const seeded = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(NOW), event(
    1, "project.created", projectId, {
      projectId,
      title: "Project",
      workspaceRoot: "/workspace",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ));
  return yield* projectEvent(withProject, event(
    2, "thread.created", parentId, createdPayload("parent"),
  ));
});

const create = (
  parentThreadId: ThreadId,
  overrides: Record<string, unknown> = {},
) => ({
  type: "thread.create" as const,
  commandId: CommandId.make("new-subagent"),
  threadId: ThreadId.make("child"),
  projectId,
  parentThreadId,
  title: "Child",
  modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "other-model" },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: "main" as string | null,
  worktreePath: "/workspace" as string | null,
  createdAt: NOW,
  ...overrides,
}) as Extract<OrchestrationCommand, { type: "thread.create" }>;

it.layer(NodeServices.layer)("native Sparky subagent hierarchy", (it) => {
  it.effect("persists a child relationship and supports another model", () =>
    Effect.gen(function* () {
      const model = yield* seeded;
      const result = yield* decideOrchestrationCommand({
        command: create(parentId),
        readModel: model,
      });
      const entries = Array.isArray(result) ? result : [result];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.type).toBe("thread.created");
      const next = yield* projectEvent(
        model, { ...entries[0]!, sequence: 3 } as OrchestrationEvent,
      );
      const child = next.threads.find((thread) => thread.id === ThreadId.make("child"));
      expect(child?.parentThreadId).toBe(parentId);
      expect(child?.modelSelection.model).toBe("other-model");
      expect(child?.runtimeMode).toBe("approval-required");
    }),
  );

  it.effect("rejects privilege, interaction, and workspace escalation", () =>
    Effect.gen(function* () {
      const model = yield* seeded;
      for (const overrides of [
        { runtimeMode: "full-access" },
        { interactionMode: "plan" },
        { worktreePath: "/different-worktree" },
        { projectId: ProjectId.make("different-project") },
      ]) {
        const failure = yield* Effect.flip(decideOrchestrationCommand({
          command: create(parentId, overrides),
          readModel: model,
        }));
        expect(failure.message.length).toBeGreaterThan(0);
      }
      const missing = yield* Effect.flip(decideOrchestrationCommand({
        command: create(ThreadId.make("missing-parent")),
        readModel: model,
      }));
      expect(missing.message).toContain("does not exist");
    }),
  );

  it.effect("deletes nested subagents child-first, including force project deletion", () =>
    Effect.gen(function* () {
      const model = yield* seeded;
      const withChild = yield* projectEvent(model, event(
        3, "thread.created", "child", createdPayload("child", "parent"),
      ));
      const withGrandchild = yield* projectEvent(withChild, event(
        4, "thread.created", "grandchild", createdPayload("grandchild", "child"),
      ));

      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete", commandId: CommandId.make("delete-parent"), threadId: parentId,
        },
        readModel: withGrandchild,
      });
      const deletedEvents = Array.isArray(deleted) ? deleted : [deleted];
      expect(deletedEvents.map((entry) => entry.type)).toEqual([
        "thread.deleted", "thread.deleted", "thread.deleted",
      ]);
      expect(deletedEvents.map((entry) => entry.aggregateId)).toEqual([
        ThreadId.make("grandchild"), ThreadId.make("child"), parentId,
      ]);

      const forced = yield* decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: CommandId.make("force-delete-project"),
          projectId,
          force: true,
        },
        readModel: withGrandchild,
      });
      const forcedEvents = Array.isArray(forced) ? forced : [forced];
      expect(forcedEvents.map((entry) => entry.type)).toEqual([
        "thread.deleted", "thread.deleted", "thread.deleted", "project.deleted",
      ]);
    }),
  );
});
