import { ProjectId, ProviderInstanceId } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

export const SpawnThreadTool = Tool.make("sparky_spawn_thread", {
  description:
    "Create and start a new Sparky thread. Specify project, initial prompt, provider/model, and workspace selection. For an existing worktree provide its path; for a new worktree provide the target branch and base branch. 'latest_worktree' selects the most recently updated worktree in that project.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    prompt: Schema.String,
    instanceId: ProviderInstanceId,
    model: Schema.String,
    modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    workspaceMode: Schema.Literals([
      "new_worktree",
      "existing_worktree",
      "latest_worktree",
      "project",
    ]),
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
})
  .annotate(Tool.Title, "Spawn Sparky thread")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const SpawnThreadToolkit = Toolkit.make(SpawnThreadTool);
