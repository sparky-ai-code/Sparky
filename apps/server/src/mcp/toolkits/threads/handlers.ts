import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadToolkit } from "./tools.ts";

type ToolResult = {
  readonly status: string;
  readonly message: string;
  readonly data?: unknown;
};

const ok = (message: string, data?: unknown): ToolResult => ({
  status: "ok",
  message,
  ...(data === undefined ? {} : { data }),
});

const errorResult = (code: string, message: string, data?: unknown): ToolResult => ({
  status: "error",
  message,
  data: { code, ...(data === undefined ? {} : { details: data }) },
});

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return String(error);
}

function stableIdentifier(prefix: string, input: string): string {
  return `${prefix}-${NodeCrypto.createHash("sha256").update(input).digest("hex")}`;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function matchesQuery(value: string, query: string | undefined): boolean {
  const normalizedQuery = normalizeOptional(query)?.toLocaleLowerCase();
  return normalizedQuery === undefined || value.toLocaleLowerCase().includes(normalizedQuery);
}

export function resolveProjectTarget(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  input: { readonly projectId?: string | undefined; readonly projectTitle?: string | undefined },
): { readonly project: OrchestrationProjectShell } | { readonly error: ToolResult } {
  const projectId = normalizeOptional(input.projectId);
  const projectTitle = normalizeOptional(input.projectTitle);

  if (projectId) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return {
        error: errorResult(
          "project_not_found",
          `No active project exists with id '${projectId}'.`,
          {
            availableProjects: projects.map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
            })),
          },
        ),
      };
    }
    if (projectTitle && project.title.toLocaleLowerCase() !== projectTitle.toLocaleLowerCase()) {
      return {
        error: errorResult(
          "project_target_mismatch",
          `Project id '${projectId}' does not match project title '${projectTitle}'.`,
        ),
      };
    }
    return { project };
  }

  if (!projectTitle) {
    return {
      error: errorResult(
        "project_target_required",
        "Choose a project with an exact projectId from sparky_list_projects, or provide a unique projectTitle.",
      ),
    };
  }

  const matches = projects.filter(
    (candidate) => candidate.title.toLocaleLowerCase() === projectTitle.toLocaleLowerCase(),
  );
  if (matches.length === 1 && matches[0]) return { project: matches[0] };
  if (matches.length > 1) {
    return {
      error: errorResult(
        "ambiguous_project",
        `More than one active project is titled '${projectTitle}'. Ask the user to choose one by id.`,
        matches.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          workspaceRoot: candidate.workspaceRoot,
        })),
      ),
    };
  }
  return {
    error: errorResult("project_not_found", `No active project is titled '${projectTitle}'.`, {
      availableProjects: projects.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
      })),
    }),
  };
}

const projectSummary = (project: OrchestrationProjectShell, threadCount: number) => ({
  id: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  threadCount,
  updatedAt: project.updatedAt,
});

const threadSummary = (thread: OrchestrationThreadShell, projectTitle: string) => ({
  id: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  projectTitle,
  status: thread.latestTurn?.state ?? "idle",
  updatedAt: thread.updatedAt,
  archived: thread.archivedAt !== null,
});

function deepLink(environmentId: string, threadId: ThreadId): string {
  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

const handlers = {
  sparky_list_projects: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const query = yield* ProjectionSnapshotQuery;
      const shell = yield* query.getShellSnapshot();
      const filteredProjects = shell.projects.filter((project) =>
        matchesQuery(project.title, input.query),
      );
      const threadsByProject = new Map<string, number>();
      for (const thread of shell.threads) {
        threadsByProject.set(thread.projectId, (threadsByProject.get(thread.projectId) ?? 0) + 1);
      }
      return ok("Active projects are ready to target.", {
        currentThreadId: invocation.threadId,
        projects: filteredProjects.map((project) =>
          projectSummary(project, threadsByProject.get(project.id) ?? 0),
        ),
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(errorResult("project_list_failed", errorMessage(error))),
      ),
    ),

  sparky_list_threads: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const query = yield* ProjectionSnapshotQuery;
      const shell = yield* query.getShellSnapshot();
      const hasProjectTarget =
        normalizeOptional(input.projectId) !== undefined ||
        normalizeOptional(input.projectTitle) !== undefined;
      const target = hasProjectTarget ? resolveProjectTarget(shell.projects, input) : null;
      if (target !== null && "error" in target) return target.error;
      const projectById = new Map(shell.projects.map((project) => [project.id, project] as const));
      const threads = shell.threads
        .filter(
          (thread) =>
            (target === null || thread.projectId === target.project.id) &&
            matchesQuery(thread.title, input.query),
        )
        .map((thread) =>
          threadSummary(thread, projectById.get(thread.projectId)?.title ?? "Unknown project"),
        );
      return ok("Active threads are ready to target.", {
        currentThreadId: invocation.threadId,
        project: target === null ? null : projectSummary(target.project, threads.length),
        threads,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(errorResult("thread_list_failed", errorMessage(error))),
      ),
    ),

  sparky_create_thread: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const initialPrompt = input.initialPrompt.trim();
      if (initialPrompt.length === 0)
        return errorResult("initial_prompt_required", "Initial prompt cannot be empty.");
      const shell = yield* query.getShellSnapshot();
      const target = resolveProjectTarget(shell.projects, input);
      if ("error" in target) return target.error;
      const sourceThreadOption = yield* query.getThreadShellById(invocation.threadId);
      const sourceThread = Option.getOrUndefined(sourceThreadOption);
      const modelSelection: ModelSelection | null =
        target.project.defaultModelSelection ?? sourceThread?.modelSelection ?? null;
      if (modelSelection === null) {
        return errorResult(
          "model_required",
          "The target project has no default model and the current thread has no model to inherit.",
        );
      }

      const title =
        normalizeOptional(input.title) ??
        initialPrompt.split(/\r?\n/u)[0]?.slice(0, 96) ??
        "New thread";
      const idempotencyKey = normalizeOptional(input.idempotencyKey);
      const operationKey = idempotencyKey
        ? `create:${invocation.threadId}:${target.project.id}:${idempotencyKey}`
        : `create:${invocation.threadId}:${target.project.id}:${NodeCrypto.randomUUID()}`;
      const threadId = ThreadId.make(stableIdentifier("thread", operationKey));
      const messageId = MessageId.make(stableIdentifier("message", operationKey));
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const createCommandId = CommandId.make(stableIdentifier("command", `${operationKey}:create`));
      const turnCommandId = CommandId.make(stableIdentifier("command", `${operationKey}:turn`));

      yield* engine.dispatch({
        type: "thread.create",
        commandId: createCommandId,
        threadId,
        projectId: target.project.id,
        title,
        modelSelection,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: turnCommandId,
          threadId,
          message: { messageId, role: "user", text: initialPrompt, attachments: [] },
          modelSelection,
          workspaceContext: "project",
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          createdAt,
        })
        .pipe(
          Effect.catch((error) =>
            engine
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(stableIdentifier("command", `${operationKey}:cleanup`)),
                threadId,
              })
              .pipe(
                Effect.ignore,
                Effect.flatMap(() => Effect.fail(error)),
              ),
          ),
        );

      return ok(`Created a thread in ${target.project.title} and sent its initial prompt.`, {
        projectId: target.project.id,
        projectTitle: target.project.title,
        threadId,
        title,
        deepLink: deepLink(invocation.environmentId, threadId),
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(errorResult("thread_create_failed", errorMessage(error))),
      ),
    ),

  sparky_send_message: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const message = input.message.trim();
      if (message.length === 0) return errorResult("message_required", "Message cannot be empty.");
      const targetThreadId = ThreadId.make(input.threadId.trim());
      const targetThreadOption = yield* query.getThreadShellById(targetThreadId);
      const targetThread = Option.getOrUndefined(targetThreadOption);
      if (!targetThread)
        return errorResult(
          "thread_not_found",
          `No active thread exists with id '${input.threadId}'.`,
        );

      const shell = yield* query.getShellSnapshot();
      const targetProject = shell.projects.find((project) => project.id === targetThread.projectId);
      if (!targetProject)
        return errorResult("project_not_found", "The target thread's project is no longer active.");
      const requestedProjectId = normalizeOptional(input.projectId);
      if (requestedProjectId && requestedProjectId !== targetThread.projectId) {
        return errorResult(
          "thread_project_mismatch",
          "The target thread does not belong to the requested project.",
          {
            threadId: targetThread.id,
            actualProjectId: targetThread.projectId,
          },
        );
      }

      const idempotencyKey = normalizeOptional(input.idempotencyKey);
      const operationKey = idempotencyKey
        ? `message:${targetThread.id}:${idempotencyKey}`
        : `message:${targetThread.id}:${NodeCrypto.randomUUID()}`;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const commandId = CommandId.make(stableIdentifier("command", operationKey));
      const messageId = MessageId.make(stableIdentifier("message", operationKey));
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: targetThread.id,
        message: { messageId, role: "user", text: message, attachments: [] },
        modelSelection: targetThread.modelSelection,
        workspaceContext: "project",
        runtimeMode: targetThread.runtimeMode,
        interactionMode: targetThread.interactionMode,
        createdAt,
      });
      return ok(`Sent a follow-up message to ${targetThread.title}.`, {
        projectId: targetProject.id,
        projectTitle: targetProject.title,
        threadId: targetThread.id,
        title: targetThread.title,
        deepLink: deepLink(invocation.environmentId, targetThread.id),
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(errorResult("thread_message_failed", errorMessage(error))),
      ),
    ),
} satisfies Parameters<typeof ThreadToolkit.toLayer>[0];

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer(handlers);
