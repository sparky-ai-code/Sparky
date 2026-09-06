import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
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
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
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

type ModelSelectionRequest = {
  readonly inherited?: ModelSelection | null;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
};

type ModelSelectionResolution =
  | { readonly selection: ModelSelection; readonly provider: ServerProvider }
  | { readonly error: ToolResult };

function providerIsSelectable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated"
  );
}

function availableModelSummary(provider: ServerProvider) {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName,
    auth: provider.auth,
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      subProvider: model.subProvider,
      isDefault: model.isDefault,
      contextWindowSource: model.contextWindowSource,
    })),
  };
}

export function resolveModelSelectionForProviders(
  providers: ReadonlyArray<ServerProvider>,
  input: ModelSelectionRequest,
): ModelSelectionResolution {
  const requestedInstanceId = normalizeOptional(input.providerInstanceId);
  const inherited = input.inherited ?? null;
  const inheritedInstanceId = inherited ? String(inherited.instanceId) : undefined;
  const instanceId = requestedInstanceId ?? inheritedInstanceId;
  const requestedProvider = instanceId
    ? providers.find((candidate) => String(candidate.instanceId) === instanceId)
    : undefined;
  if (instanceId && !requestedProvider) {
    return {
      error: errorResult(
        "provider_not_found",
        `Provider instance '${instanceId}' is not configured. Use sparky_list_models to choose an exact provider instance id.`,
        { providerInstanceId: instanceId },
      ),
    };
  }
  const provider =
    requestedProvider ??
    providers
      .filter(providerIsSelectable)
      .toSorted((left, right) => {
        const authDelta =
          Number(right.auth.status === "authenticated") -
          Number(left.auth.status === "authenticated");
        return authDelta || Number(right.models.length > 0) - Number(left.models.length > 0);
      })
      .find((candidate) => candidate.models.length > 0);

  if (!provider) {
    return {
      error: errorResult(
        "provider_unavailable",
        "No configured authenticated provider instance with selectable models is available.",
        { providers: providers.map(availableModelSummary) },
      ),
    };
  }
  if (!providerIsSelectable(provider)) {
    return {
      error: errorResult(
        "provider_not_authenticated",
        `Provider instance '${provider.instanceId}' is not available with its configured authentication.`,
        { provider: availableModelSummary(provider) },
      ),
    };
  }

  const requestedModel = normalizeOptional(input.model);
  const inheritedModel =
    inherited && String(inherited.instanceId) === String(provider.instanceId)
      ? inherited.model
      : undefined;
  const model =
    requestedModel ??
    inheritedModel ??
    provider.models.find((candidate) => candidate.isDefault)?.slug ??
    provider.models[0]?.slug;
  if (!model) {
    return {
      error: errorResult(
        "model_unavailable",
        `Provider instance '${provider.instanceId}' has no selectable models.`,
        { provider: availableModelSummary(provider) },
      ),
    };
  }
  const modelEntry = provider.models.find((candidate) => candidate.slug === model);
  if (!modelEntry) {
    return {
      error: errorResult(
        "model_unavailable",
        `Model '${model}' is not available on provider instance '${provider.instanceId}'. Use sparky_list_models and choose an exact model slug.`,
        { provider: availableModelSummary(provider) },
      ),
    };
  }

  const sameSelection = inherited?.instanceId === provider.instanceId && inherited.model === model;
  const options = input.options ?? (sameSelection ? inherited?.options : undefined);
  return {
    provider,
    selection: {
      instanceId: ProviderInstanceId.make(provider.instanceId),
      model,
      ...(options ? { options } : {}),
      ...(modelEntry.contextWindowSource
        ? { contextWindowSource: modelEntry.contextWindowSource }
        : {}),
    },
  };
}

function modelSelectionResult(selection: ModelSelection, provider: ServerProvider) {
  return {
    instanceId: selection.instanceId,
    driver: provider.driver,
    model: selection.model,
    options: selection.options ?? [],
    auth: provider.auth,
    contextWindowSource: selection.contextWindowSource,
  };
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

  sparky_list_models: (input) =>
    Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      const providers = yield* registry.getProviders;
      const query = normalizeOptional(input.query)?.toLocaleLowerCase();
      const visibleProviders = providers
        .map((provider) => ({
          ...availableModelSummary(provider),
          status: provider.status,
          enabled: provider.enabled,
          installed: provider.installed,
          availability: provider.availability ?? "available",
          models: provider.models
            .filter(
              (model) =>
                query === undefined ||
                model.slug.toLocaleLowerCase().includes(query) ||
                model.name.toLocaleLowerCase().includes(query) ||
                model.subProvider?.toLocaleLowerCase().includes(query),
            )
            .map((model) => ({
              slug: model.slug,
              name: model.name,
              subProvider: model.subProvider,
              isDefault: model.isDefault,
              contextWindowSource: model.contextWindowSource,
              capabilities: model.capabilities,
            })),
        }))
        .filter((provider) => query === undefined || provider.models.length > 0);
      return ok("Configured provider instances and models are ready to select.", {
        providers: visibleProviders,
      });
    }),

  sparky_set_model: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const registry = yield* ProviderRegistry;
      const threadId = ThreadId.make(
        normalizeOptional(input.threadId) ?? String(invocation.threadId),
      );
      const threadOption = yield* query.getThreadShellById(threadId);
      const thread = Option.getOrUndefined(threadOption);
      if (!thread)
        return errorResult("thread_not_found", `No active thread exists with id '${threadId}'.`);
      if (
        thread.latestTurn?.state === "running" ||
        (thread.session !== null && thread.session.activeTurnId !== null)
      ) {
        return errorResult(
          "thread_busy",
          `Thread '${threadId}' is currently running a turn. Set the model after it completes, then send the next turn.`,
        );
      }
      const providers = yield* registry.getProviders;
      const resolved = resolveModelSelectionForProviders(providers, {
        inherited: thread.modelSelection,
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        options: input.options,
      });
      if ("error" in resolved) return resolved.error;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(
          stableIdentifier("command", `set-model:${threadId}:${createdAt}`),
        ),
        threadId,
        modelSelection: resolved.selection,
      });
      return ok(`Selected ${resolved.selection.model} for ${thread.title}.`, {
        threadId,
        title: thread.title,
        deepLink: deepLink(invocation.environmentId, threadId),
        selection: modelSelectionResult(resolved.selection, resolved.provider),
      });
    }).pipe(
      Effect.catch((error) => Effect.succeed(errorResult("model_set_failed", errorMessage(error)))),
    ),

  sparky_create_thread: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const registry = yield* ProviderRegistry;
      const initialPrompt = input.initialPrompt.trim();
      if (initialPrompt.length === 0)
        return errorResult("initial_prompt_required", "Initial prompt cannot be empty.");
      const shell = yield* query.getShellSnapshot();
      const target = resolveProjectTarget(shell.projects, input);
      if ("error" in target) return target.error;
      const sourceThreadOption = yield* query.getThreadShellById(invocation.threadId);
      const sourceThread = Option.getOrUndefined(sourceThreadOption);
      const providers = yield* registry.getProviders;
      const resolved = resolveModelSelectionForProviders(providers, {
        // The source thread is the authority for cross-project inheritance.
        // A target project's default may be an API-key model even when the
        // current agent is running on an authenticated OAuth connection.
        inherited: sourceThread?.modelSelection ?? target.project.defaultModelSelection,
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        options: input.options,
      });
      if ("error" in resolved) return resolved.error;
      const modelSelection = resolved.selection;

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
        selection: modelSelectionResult(modelSelection, resolved.provider),
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
