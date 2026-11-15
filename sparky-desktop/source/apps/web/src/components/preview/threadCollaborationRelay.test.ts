import { UNSCOPED_CHAT_PROJECT_ID } from "@sparky/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  ClientOrchestrationCommand,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ServerConfig,
  VcsListRefsResult,
  VcsStatusResult,
} from "@sparky/contracts";

import {
  runThreadCollaboration,
  type ThreadCollaborationTransport,
} from "./threadCollaborationRelay";

const source = {
  environmentId: "source-env",
  threadId: "origin-thread",
  runtimeMode: "approval-required",
  interactionMode: "default",
  modelSelection: { instanceId: "codex", model: "gpt-6" },
} as const;

function makeTransport(options?: {
  readonly targetMode?: "approval-required" | "full-access";
  readonly running?: boolean;
  readonly nonGit?: boolean;
  readonly environments?: ReadonlyArray<string>;
  readonly projectDefaultModelSelection?: { readonly instanceId: string; readonly model: string };
}) {
  const dispatch = vi.fn(async (_environment: string, _command: ClientOrchestrationCommand) => ({ sequence: 1 }));
  const shell = {
    projects: [{ id: "remote-project", title: "Another repo", workspaceRoot: "/remote/project", defaultModelSelection: options?.projectDefaultModelSelection ?? null }],
    threads: [{ id: "remote-thread", projectId: "remote-project", title: "Remote peer", runtimeMode: "approval-required", interactionMode: "default", modelSelection: source.modelSelection }],
  } as unknown as OrchestrationShellSnapshot;
  const thread = {
    id: "remote-thread",
    projectId: "remote-project",
    title: "Remote peer",
    branch: "feature",
    worktreePath: "/remote/project/.worktrees/feature",
    modelSelection: source.modelSelection,
    runtimeMode: options?.targetMode ?? "approval-required",
    interactionMode: "default",
    deletedAt: null,
    archivedAt: null,
    latestTurn: options?.running ? { state: "running" } : null,
    messages: [
      { id: "one", role: "user", text: "Hi", createdAt: "2026-11-11T00:00:00.000Z" },
      { id: "two", role: "assistant", text: "Ready", createdAt: "2026-11-11T00:00:00.000Z" },
    ],
    activities: [],
  } as unknown as OrchestrationThread;
  const transport: ThreadCollaborationTransport = {
    environmentIds: options?.environments ?? ["source-env", "remote-env"],
    shell: async () => shell,
    thread: async () => thread,
    serverConfig: async () => ({ providers: [] }) as unknown as ServerConfig,
    refs: async () => ({
      isRepo: !options?.nonGit,
      totalCount: options?.nonGit ? 0 : 2,
      nextCursor: null,
      refs: [
        { name: "main", worktreePath: "/remote/project" },
        { name: "feature", worktreePath: "/remote/project/.worktrees/feature" },
      ],
    }) as unknown as VcsListRefsResult,
    status: async () => ({ isRepo: !options?.nonGit, refName: options?.nonGit ? null : "main" }) as unknown as VcsStatusResult,
    createWorktree: async () => ({
      worktree: { refName: "agent/new", path: "/remote/project/.worktrees/agent-new" },
    }),
    removeWorktree: async () => undefined,
    dispatch,
  };
  return { transport, dispatch, shell, thread };
}

describe("cross-environment agent thread collaboration", () => {
  it("discovers projects in another connected backend using its live snapshot", async () => {
    const { transport } = makeTransport();
    const result = await runThreadCollaboration({
      operation: "discover",
      payload: { excludeEnvironmentId: "source-env" },
      source,
    }, transport);
    expect(result).toMatchObject({
      environments: [{
        environmentId: "remote-env",
        projects: [{ projectId: "remote-project" }],
        threads: [{ threadId: "remote-thread" }],
      }],
    });
  });

  it("requires an explicitly connected target and never takes model-supplied URLs", async () => {
    const { transport, dispatch } = makeTransport();
    await expect(runThreadCollaboration({
      operation: "read",
      payload: { environmentId: "unregistered", threadId: "remote-thread" },
      source,
    }, transport)).rejects.toThrow("not connected");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("paginates remote persisted messages without treating them as privileged instructions", async () => {
    const { transport } = makeTransport();
    const result = await runThreadCollaboration({
      operation: "read",
      payload: { environmentId: "remote-env", threadId: "remote-thread", limit: 1 },
      source,
    }, transport);
    expect(result).toMatchObject({
      environmentId: "remote-env",
      totalMessages: 2,
      returnedMessages: 1,
      nextOffsetFromLatest: 1,
      messages: [{ text: "Ready" }],
    });
  });

  it("blocks plan-mode agents from sending instructions across environments", async () => {
    const { transport, dispatch } = makeTransport();
    await expect(runThreadCollaboration({
      operation: "message",
      payload: { environmentId: "remote-env", threadId: "remote-thread", message: "Do work" },
      source: { ...source, interactionMode: "plan" },
    }, transport)).rejects.toThrow("Plan-mode");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects messaging a more privileged destination even when user has access to it", async () => {
    const { transport, dispatch } = makeTransport({ targetMode: "full-access" });
    await expect(runThreadCollaboration({
      operation: "message",
      payload: { environmentId: "remote-env", threadId: "remote-thread", message: "Run privileged task" },
      source,
    }, transport)).rejects.toThrow("more privileged");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("steers a running agent with durable source environment attribution", async () => {
    const { transport, dispatch } = makeTransport({ running: true });
    const result = await runThreadCollaboration({
      operation: "steer",
      payload: { environmentId: "remote-env", threadId: "remote-thread", message: "Focus on tests" },
      source,
    }, transport);
    expect(result).toMatchObject({ environmentId: "remote-env", delivery: "steer", status: "accepted" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const command = dispatch.mock.calls[0]?.[1];
    expect(command).toMatchObject({
      type: "thread.turn.start",
      threadId: "remote-thread",
      runtimeMode: "approval-required",
    });
    if (command?.type === "thread.turn.start") {
      expect(command.message.text).toContain("origin-thread (environment source-env)");
      expect(command.message.text).toContain(
        'sparky_thread_message(threadId="origin-thread", environmentId="source-env")',
      );
      expect(command.message.text).toContain("Focus on tests");
    }
  });

  it("includes the sender's reply address in ordinary remote messages", async () => {
    const { transport, dispatch } = makeTransport();
    const result = await runThreadCollaboration({
      operation: "message",
      payload: { environmentId: "remote-env", threadId: "remote-thread", message: "Can you review?" },
      source,
    }, transport);
    expect(result).toMatchObject({
      fromThreadId: "origin-thread",
      fromEnvironmentId: "source-env",
      status: "accepted",
    });
    const command = dispatch.mock.calls[0]?.[1];
    if (command?.type !== "thread.turn.start") throw new Error("Expected a start command");
    expect(command.message.text).toContain(
      'sparky_thread_message(threadId="origin-thread", environmentId="source-env")',
    );
    expect(command.message.text.endsWith("\n\nCan you review?")).toBe(true);
  });

  it("does not claim steering succeeds for an idle remote thread", async () => {
    const { transport, dispatch } = makeTransport();
    await expect(runThreadCollaboration({
      operation: "steer",
      payload: { environmentId: "remote-env", threadId: "remote-thread", message: "Stop" },
      source,
    }, transport)).rejects.toThrow("not running");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("creates a thread on a second backend and starts its agent with inherited access", async () => {
    const { transport, dispatch } = makeTransport();
    const result = await runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env",
        projectId: "remote-project",
        title: "Remote implementation",
        workspaceMode: "current",
        initialMessage: "Please fix the remote tests",
        modelSelection: source.modelSelection,
      },
      source,
    }, {
      ...transport,
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6", capabilities: { optionDescriptors: [] } }],
        }],
      }) as unknown as ServerConfig,
    });
    expect(result).toMatchObject({
      environmentId: "remote-env",
      projectId: "remote-project",
      turnRequested: true,
      runtimeMode: "approval-required",
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      type: "thread.create",
      projectId: "remote-project",
      runtimeMode: "approval-required",
    });
    const start = dispatch.mock.calls[1]?.[1];
    expect(start).toMatchObject({
      type: "thread.turn.start",
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    if (start?.type === "thread.turn.start") {
      expect(start.message.text).toContain(
        "[Message from Sparky agent in thread origin-thread (environment source-env)]",
      );
      expect(start.message.text).toContain(
        'sparky_thread_message(threadId="origin-thread", environmentId="source-env")',
      );
      expect(start.message.text.endsWith("\n\nPlease fix the remote tests")).toBe(true);
    }
  });

  it("keeps Codex OAuth when a remote project defaults to an API-key model", async () => {
    const { transport, dispatch } = makeTransport({
      projectDefaultModelSelection: { instanceId: "sparky", model: "openai/gpt-4o-mini" },
    });
    await runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env",
        projectId: "remote-project",
        title: "OAuth-inherited thread",
        workspaceMode: "current",
        initialMessage: "Continue with Codex OAuth",
      },
      source,
    }, {
      ...transport,
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6", capabilities: { optionDescriptors: [] } }],
        }],
      }) as unknown as ServerConfig,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      type: "thread.create",
      modelSelection: source.modelSelection,
    });
    expect(dispatch.mock.calls[1]?.[1]).toMatchObject({
      type: "thread.turn.start",
      modelSelection: source.modelSelection,
    });
  });

  it("creates and starts remote threads in non-Git folders without workspace flags", async () => {
    const { transport, dispatch } = makeTransport({ nonGit: true });
    const createWorktree = vi.fn(async () => { throw new Error("worktrees must not be used"); });
    const result = await runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env", projectId: "remote-project",
        title: "Plain folder", initialMessage: "Inspect files in this folder",
      },
      source,
    }, {
      ...transport,
      createWorktree,
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6", capabilities: { optionDescriptors: [] } }],
        }],
      }) as unknown as ServerConfig,
    });
    expect(result).toMatchObject({
      environmentId: "remote-env", projectId: "remote-project",
      branch: null, worktreePath: null, turnRequested: true,
      runtimeMode: "approval-required",
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      type: "thread.create", branch: null, worktreePath: null,
      projectId: "remote-project",
    });
    expect(dispatch.mock.calls[1]?.[1]).toMatchObject({ type: "thread.turn.start" });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("does not require the Git executable to spawn a normal remote thread", async () => {
    const { transport, dispatch } = makeTransport();
    const result = await runThreadCollaboration({
      operation: "create",
      payload: { environmentId: "remote-env", projectId: "remote-project", title: "No Git" },
      source,
    }, {
      ...transport,
      status: async () => { throw new Error("Git executable not found"); },
      refs: async () => { throw new Error("Git refs must not be requested"); },
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6", capabilities: { optionDescriptors: [] } }],
        }],
      }) as unknown as ServerConfig,
    });
    expect(result).toMatchObject({ branch: null, worktreePath: null, turnRequested: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      type: "thread.create", branch: null, worktreePath: null,
    });
  });

  it("preserves the current branch of a Git project", async () => {
    const { transport, dispatch } = makeTransport();
    await runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env", projectId: "remote-project",
        title: "Git project", workspaceMode: "current", branch: "main",
      },
      source,
    }, {
      ...transport,
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6", capabilities: { optionDescriptors: [] } }],
        }],
      }) as unknown as ServerConfig,
    });
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      type: "thread.create", branch: "main", worktreePath: null,
    });
  });

  it("keeps explicit branch/worktree modes Git-only", async () => {
    const { transport, dispatch } = makeTransport({ nonGit: true });
    const providerTransport = {
      ...transport,
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6", capabilities: { optionDescriptors: [] } }],
        }],
      }) as unknown as ServerConfig,
    };
    await expect(runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env", projectId: "remote-project",
        title: "Invalid branch", workspaceMode: "current", branch: "main",
      },
      source,
    }, providerTransport)).rejects.toThrow("Omit branch");
    await expect(runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env", projectId: "remote-project",
        title: "Invalid worktree", workspaceMode: "new", baseBranch: "main",
      },
      source,
    }, providerTransport)).rejects.toThrow("Git worktree modes require a Git repository");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("can create project-free remote threads without calling Git", async () => {
    const { transport, dispatch } = makeTransport();
    const result = await runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env", projectId: UNSCOPED_CHAT_PROJECT_ID,
        title: "Project-free peer",
      },
      source,
    }, {
      ...transport,
      status: async () => { throw new Error("project-free thread must not check Git"); },
      refs: async () => { throw new Error("project-free thread must not list Git branches"); },
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6", capabilities: { optionDescriptors: [] } }],
        }],
      }) as unknown as ServerConfig,
    });
    expect(result).toMatchObject({ projectId: UNSCOPED_CHAT_PROJECT_ID, branch: null });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects worktree spoofing rather than checking out an arbitrary path", async () => {
    const { transport, dispatch } = makeTransport();
    await expect(runThreadCollaboration({
      operation: "create",
      payload: {
        environmentId: "remote-env",
        projectId: "remote-project",
        title: "Other thread",
        workspaceMode: "existing",
        branch: "feature",
        worktreePath: "/tmp/hostile",
      },
      source,
    }, {
      ...transport,
      serverConfig: async () => ({
        providers: [{
          instanceId: "codex", enabled: true, availability: "available",
          models: [{ slug: "gpt-6" }],
        }],
      }) as unknown as ServerConfig,
    })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
