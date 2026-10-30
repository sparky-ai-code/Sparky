import { CommandId, MessageId, ProjectId, ThreadId } from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SpawnThreadToolkit } from "./tools.ts";

const handlers = {
  sparky_spawn_thread: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const engine = yield* OrchestrationEngineService;
      const projections = yield* ProjectionSnapshotQuery;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const projectId = ProjectId.make(input.projectId);
      const project = yield* projections.getProjectShellById(projectId);
      if (Option.isNone(project)) return { error: `Project '${input.projectId}' was not found.` };
      const shell = yield* projections.getShellSnapshot();
      let worktreePath: string | null = null;
      let branch: string | null = null;
      if (input.workspaceMode === "existing_worktree") {
        if (!input.worktreePath) return { error: "existing_worktree requires worktreePath." };
        const existing = shell.threads.find(
          (thread) => thread.projectId === projectId && thread.worktreePath === input.worktreePath,
        );
        if (!existing) return { error: "worktreePath is not an active worktree for this project." };
        worktreePath = existing.worktreePath;
        branch = existing.branch;
      } else if (input.workspaceMode === "latest_worktree") {
        const latest = shell.threads
          .filter((thread) => thread.projectId === projectId && thread.worktreePath !== null)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        if (!latest?.worktreePath) return { error: "The project has no existing worktree to reuse." };
        worktreePath = latest.worktreePath;
        branch = latest.branch;
      }
      if (input.workspaceMode === "new_worktree") {
        if (!input.branch || !input.baseBranch) {
          return { error: "new_worktree requires both branch and baseBranch." };
        }
        const createdWorktree = yield* gitWorkflow.createWorktree({
          cwd: project.value.workspaceRoot,
          refName: input.baseBranch,
          newRefName: input.branch,
          baseRefName: input.baseBranch,
          path: null,
        });
        worktreePath = createdWorktree.worktree.path;
        branch = createdWorktree.worktree.refName;
      }
      const threadId = ThreadId.make(crypto.randomUUID());
      const createdAt = new Date().toISOString();
      const modelSelection = {
        instanceId: input.instanceId,
        model: input.model,
        ...(input.modelOptions ? { options: input.modelOptions } : {}),
      };
      const title = input.title?.trim() || "New thread";
      const runtimeMode = input.runtimeMode ?? "full-access";
      const interactionMode = input.interactionMode ?? "default";
      yield* engine.dispatch(
        {
          type: "thread.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          projectId,
          title,
          modelSelection,
          runtimeMode,
          interactionMode,
          branch,
          worktreePath,
          createdAt,
        },
        { ...(invocation.authSessionId ? { authSessionId: invocation.authSessionId } : {}) },
      );
      yield* engine.dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          createdAt,
        },
        { ...(invocation.authSessionId ? { authSessionId: invocation.authSessionId } : {}) },
      );
      return { threadId, projectId, worktreePath, branch };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ error: error instanceof Error ? error.message : String(error) }),
      ),
    ),
} satisfies Parameters<typeof SpawnThreadToolkit.toLayer>[0];

export const SpawnThreadToolkitHandlersLive = SpawnThreadToolkit.toLayer(handlers);
