import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UNSCOPED_CHAT_PROJECT_ID,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";

const project = {
  id: ProjectId.make("project-123"),
  title: "Sparky-pb",
  workspaceRoot: "/project",
};
const input = {
  prompt: "hello",
  instanceId: ProviderInstanceId.make("openai"),
  model: "gpt-6-luna",
};

async function invoke(
  projectId: string | null | undefined,
  workspaceMode?: "new_worktree",
  projects = [project],
) {
  const dispatch = vi.fn((_command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
    Effect.succeed({ sequence: 1 }),
  );
  const result = await Effect.runPromise(
    handlers.sparky_spawn_thread({ ...input, projectId, workspaceMode }).pipe(
      Effect.provideService(OrchestrationEngineService, {
        dispatch,
      } as unknown as OrchestrationEngineShape),
      Effect.provideService(ProjectionSnapshotQuery, {
        getShellSnapshot: () => Effect.succeed({ projects, threads: [] }),
      } as unknown as ProjectionSnapshotQueryShape),
      Effect.provideService(GitWorkflowService.GitWorkflowService, {} as never),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("parent"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("openai"),
        capabilities: new Set<"preview">(),
        issuedAt: 0,
        expiresAt: 1,
      }),
    ),
  );
  return { result, dispatch };
}

it("resolves an exact project name and starts the requested model and prompt", async () => {
  const { result, dispatch } = await invoke("Sparky-pb");
  expect(result).toMatchObject({ projectId: project.id });
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
    type: "thread.create",
    projectId: project.id,
    modelSelection: { instanceId: "openai", model: "gpt-6-luna" },
  });
  expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
    type: "thread.turn.start",
    message: { text: "hello" },
  });
});

it.each([undefined, null, "", "  "])(
  "starts a project-free thread for projectId %s",
  async (projectId) => {
    const { result, dispatch } = await invoke(projectId);
    expect(result).toMatchObject({
      projectId: UNSCOPED_CHAT_PROJECT_ID,
      branch: null,
      worktreePath: null,
    });
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.create",
      projectId: UNSCOPED_CHAT_PROJECT_ID,
    });
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      type: "thread.turn.start",
      message: { text: "hello" },
    });
  },
);

it("rejects ambiguous or unknown project names without creating a thread", async () => {
  const ambiguous = await invoke("Sparky-pb", undefined, [
    project,
    { ...project, id: ProjectId.make("another") },
  ]);
  expect(ambiguous.result).toMatchObject({ error: expect.stringContaining("Multiple projects") });
  expect(ambiguous.dispatch).not.toHaveBeenCalled();
  const missing = await invoke("missing");
  expect(missing.result).toMatchObject({ error: expect.stringContaining("not found") });
  expect(missing.dispatch).not.toHaveBeenCalled();
});

it("rejects worktree modes for project-free chats", async () => {
  const { result, dispatch } = await invoke(null, "new_worktree");
  expect(result).toMatchObject({
    error: expect.stringContaining("Worktree modes require a project"),
  });
  expect(dispatch).not.toHaveBeenCalled();
});
