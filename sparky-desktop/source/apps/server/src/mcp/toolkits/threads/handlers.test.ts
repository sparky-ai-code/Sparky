import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  canAgentSendThreadMessage,
  formatAgentThreadMessage,
  resolveExistingWorktreeRef,
} from "./handlers.ts";
import {
  CreateThreadTool,
  ProjectBranchesTool,
  ReadThreadTool,
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
    ]);
  });

  it("attributes a peer message to its source and preserves the actual instruction", () => {
    expect(formatAgentThreadMessage("parent-thread", "Review tests.  ")).toBe(
      "[Message from Sparky agent in thread parent-thread]\nReview tests.",
    );
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

  it("reuses only a worktree registered for exactly the selected branch", () => {
    const refs = [
      { name: "main", worktreePath: "/repo" },
      { name: "feature/a", worktreePath: "/repo/.worktrees/a" },
      { name: "feature/b", worktreePath: "/repo/.worktrees/b" },
    ];
    expect(
      resolveExistingWorktreeRef(refs, "feature/a", "/repo/.worktrees/a", "/repo"),
    ).toEqual(refs[1]);
    expect(
      resolveExistingWorktreeRef(refs, "feature/a", "/repo/.worktrees/b", "/repo"),
    ).toBeNull();
    expect(
      resolveExistingWorktreeRef(refs, "main", "/repo", "/repo"),
    ).toBeNull();
    expect(
      resolveExistingWorktreeRef(refs, "feature/a", "/tmp/unlisted", "/repo"),
    ).toBeNull();
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
