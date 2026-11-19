import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@sparky/contracts";
import * as Schema from "effect/Schema";

import {
  canAgentSendThreadMessage,
  formatAgentThreadMessage,
  formatInitialThreadMessage,
  formatSubagentTaskMessage,
  resolveAgentThreadModelSelection,
  resolveCurrentWorkspaceBranch,
  resolveExistingWorktreeRef,
} from "./handlers.ts";
import {
  CreateThreadTool,
  ProjectBranchesTool,
  ReadThreadTool,
  SpawnSubagentTool,
  StopSubagentTool,
  ListSubagentsTool,
  ThreadTools,
} from "./tools.ts";

describe("agent-managed thread collaboration tools", () => {
  it("exposes each operation to MCP with a stable name", () => {
    expect(ThreadTools.map((tool) => tool.name)).toEqual([
      "sparky_threads_list",
      "sparky_project_branches",
      "sparky_thread_models",
      "sparky_thread_read",
      "sparky_thread_create",
      "sparky_thread_message",
      "sparky_thread_steer",
      "sparky_subagent_spawn",
      "sparky_subagents_list",
      "sparky_subagent_stop",
    ]);
  });

  it("includes the authenticated source address and reply instructions in first turns and peer messages", () => {
    const message = formatAgentThreadMessage("parent-thread", "local-env", "Review tests.  ");
    expect(message).toContain("[Message from Sparky agent in thread parent-thread (environment local-env)]");
    expect(message).toContain(
      'sparky_thread_message(threadId="parent-thread", environmentId="local-env")',
    );
    expect(message.endsWith("\n\nReview tests.")).toBe(true);
    expect(formatInitialThreadMessage("parent-thread", "local-env", "Review tests.  ")).toBe(message);
  });

  it("gives independent subagents a parent reply address and team collaboration instructions", () => {
    const prompt = formatSubagentTaskMessage("parent-123", "environment-1", "Review the patch.  ");
    expect(prompt).toContain("parent-123");
    expect(prompt).toContain("sparky_thread_message");
    expect(prompt).toContain("sparky_thread_steer");
    expect(prompt).toContain("sparky_subagents_list");
    expect(prompt.endsWith("Task:\\nReview the patch.")).toBe(false);
    expect(prompt.endsWith("Task:\nReview the patch.")).toBe(true);
  });

  it("accepts any advertised provider/model and forbids blank or invalid task parameters", () => {
    const input = Schema.decodeUnknownSync(SpawnSubagentTool.parametersSchema)({
      title: "Implement API",
      task: "Implement and test the API.",
      modelSelection: {
        instanceId: "any-connected-provider",
        model: "provider/any-model",
        options: [{ id: "effort", value: "max" }],
      },
    });
    expect(input.modelSelection?.model).toBe("provider/any-model");
    expect(Schema.decodeUnknownSync(ListSubagentsTool.parametersSchema)({})).toEqual({});
    expect(Schema.decodeUnknownSync(StopSubagentTool.parametersSchema)({ threadId: "child-1" }).threadId)
      .toBe("child-1");
    expect(() => Schema.decodeUnknownSync(SpawnSubagentTool.parametersSchema)({
      title: " ",
      task: "Work",
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(SpawnSubagentTool.parametersSchema)({
      title: "Work",
      task: "  \n",
    })).toThrow();
  });

  it("inherits the caller's Codex OAuth model instead of an API-key project default", () => {
    const oauthModel = {
      instanceId: ProviderInstanceId.make("sparky"),
      model: "openai-codex/gpt-5.6",
    };
    const projectDefault = {
      instanceId: ProviderInstanceId.make("sparky"),
      model: "openai/gpt-4o-mini",
    };
    // An omitted explicit selection must not cause the caller's OAuth
    // provider to be replaced with a project default needing OPENAI_API_KEY.
    expect(resolveAgentThreadModelSelection(undefined, oauthModel)).toEqual(oauthModel);
    // When the agent deliberately selects a model, preserve that choice.
    expect(resolveAgentThreadModelSelection(projectDefault, oauthModel)).toEqual(projectDefault);
  });

  it("does not allow a plan agent to delegate mutations", () => {
    expect(
      canAgentSendThreadMessage(
        { runtimeMode: "full-access", interactionMode: "plan" },
        { runtimeMode: "approval-required" },
      ),
    ).toBe(false);
  });

  it("does not let a restricted agent steer a more privileged thread", () => {
    expect(
      canAgentSendThreadMessage(
        { runtimeMode: "approval-required", interactionMode: "default" },
        { runtimeMode: "full-access" },
      ),
    ).toBe(false);
    expect(
      canAgentSendThreadMessage(
        { runtimeMode: "full-access", interactionMode: "default" },
        { runtimeMode: "approval-required" },
      ),
    ).toBe(true);
  });

  it("validates explicit branch, base branch, and model options on thread creation", () => {
    const input = Schema.decodeUnknownSync(CreateThreadTool.parametersSchema)({
      projectId: "project-1",
      title: "Review implementation",
      workspaceMode: "new",
      baseBranch: "main",
      branch: "sparky/review",
      initialMessage: "Review the implementation.",
      modelSelection: {
        instanceId: "sparky",
        model: "gpt-6",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "contextWindow", value: "128000" },
        ],
      },
    });
    expect(input.workspaceMode).toBe("new");
    expect(input.baseBranch).toBe("main");
    expect(input.modelSelection?.options).toHaveLength(2);
  });

  it("accepts ordinary folder and project-free thread creation without a Git selection", () => {
    const input = Schema.decodeUnknownSync(CreateThreadTool.parametersSchema)({
      title: "Inspect files",
      initialMessage: "Review this folder",
    });
    // Project ID is inferred from the calling thread and current is the default mode.
    expect(input.projectId).toBeUndefined();
    expect(input.workspaceMode).toBeUndefined();
    expect(input.branch).toBeUndefined();
    expect(resolveCurrentWorkspaceBranch(null)).toBeNull();
    expect(resolveCurrentWorkspaceBranch({ isRepo: false, refName: null })).toBeNull();
    expect(resolveCurrentWorkspaceBranch({ isRepo: true, refName: "main" })).toBe("main");
  });

  it("reuses only a worktree registered for exactly the selected branch", () => {
    const refs = [
      { name: "main", worktreePath: "/repo" },
      { name: "feature/a", worktreePath: "/repo/.worktrees/a" },
      { name: "feature/b", worktreePath: "/repo/.worktrees/b" },
    ];
    expect(resolveExistingWorktreeRef(refs, "feature/a", "/repo/.worktrees/a", "/repo")).toEqual(
      refs[1],
    );
    expect(resolveExistingWorktreeRef(refs, "feature/a", "/repo/.worktrees/b", "/repo")).toBeNull();
    expect(resolveExistingWorktreeRef(refs, "main", "/repo", "/repo")).toBeNull();
    expect(resolveExistingWorktreeRef(refs, "feature/a", "/tmp/unlisted", "/repo")).toBeNull();
  });

  it("rejects unknown workspace modes and empty message IDs", () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadTool.parametersSchema)({
        projectId: "project-1",
        title: "Review",
        workspaceMode: "unsafe",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ReadThreadTool.parametersSchema)({
        threadId: "",
      }),
    ).toThrow();
  });

  it("rejects whitespace-only initial thread messages", () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadTool.parametersSchema)({
        projectId: "project-1",
        title: "Review",
        workspaceMode: "current",
        initialMessage: " \n\t ",
      }),
    ).toThrow();
  });

  it("accepts branch pagination cursors and rejects negative ones", () => {
    expect(
      Schema.decodeUnknownSync(ProjectBranchesTool.parametersSchema)({
        projectId: "project-1",
        cursor: 100,
      }).cursor,
    ).toBe(100);
    expect(() =>
      Schema.decodeUnknownSync(ProjectBranchesTool.parametersSchema)({
        projectId: "project-1",
        cursor: -1,
      }),
    ).toThrow();
  });
});
