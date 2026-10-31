import { ProviderInstanceId, ProviderOptionSelections } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const SpawnThreadTool = Tool.make("sparky_spawn_thread", {
  description:
    "Create and start a new Sparky thread. Set projectId to a project ID or exact project name; omit it, use null, or use an empty string for a project-free chat. Specify the initial prompt and provider instance ID/model. workspaceMode defaults to 'project'; worktree modes require a project. For an existing worktree provide its path; for a new worktree provide the target branch and base branch. 'latest_worktree' selects the most recently updated worktree in that project.",
  parameters: Schema.Struct({
    projectId: Schema.optional(Schema.NullOr(Schema.String)),
    prompt: Schema.String,
    instanceId: ProviderInstanceId,
    model: Schema.String,
    modelOptions: Schema.optional(ProviderOptionSelections),
    workspaceMode: Schema.optional(
      Schema.Literals(["new_worktree", "existing_worktree", "latest_worktree", "project"]),
    ),
    branch: Schema.optional(Schema.String),
    baseBranch: Schema.optional(Schema.String),
    worktreePath: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    runtimeMode: Schema.optional(
      Schema.Literals(["approval-required", "auto-accept-edits", "full-access"]),
    ),
    interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestrationEngineService,
    ProjectionSnapshotQuery,
    GitWorkflowService.GitWorkflowService,
  ],
})
  .annotate(Tool.Title, "Spawn Sparky thread")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const SpawnThreadToolkit = Toolkit.make(SpawnThreadTool);
