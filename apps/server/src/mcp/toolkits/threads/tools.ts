import { ProviderOptionSelections } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
  ProviderRegistry,
];

const ToolResult = Schema.Struct({
  status: Schema.String,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

const ProjectListInput = Schema.Struct({
  query: Schema.optional(Schema.String),
});

const ThreadListInput = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  projectTitle: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
});

const CreateThreadInput = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  projectTitle: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  initialPrompt: Schema.String,
  providerInstanceId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  options: Schema.optional(ProviderOptionSelections),
  reasoningEffort: Schema.optional(Schema.String),
  fastMode: Schema.optional(Schema.Boolean),
  runtimeMode: Schema.optional(
    Schema.Literals(["approval-required", "auto-accept-edits", "full-access"]),
  ),
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
  idempotencyKey: Schema.optional(Schema.String),
});

const ListModelsInput = Schema.Struct({
  query: Schema.optional(Schema.String),
});

const SetModelInput = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  providerInstanceId: Schema.optional(Schema.String),
  model: Schema.String,
  options: Schema.optional(ProviderOptionSelections),
  reasoningEffort: Schema.optional(Schema.String),
  fastMode: Schema.optional(Schema.Boolean),
});

const SendMessageInput = Schema.Struct({
  threadId: Schema.String,
  projectId: Schema.optional(Schema.String),
  message: Schema.String,
  idempotencyKey: Schema.optional(Schema.String),
});

export const ListProjectsTool = Tool.make("sparky_list_projects", {
  description:
    "List active Sparky projects available to this agent session. Use this before creating a thread in another project. The result contains stable projectId values and readable titles; use the exact projectId for subsequent actions instead of guessing from a path.",
  parameters: ProjectListInput,
  success: ToolResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const ListThreadsTool = Tool.make("sparky_list_threads", {
  description:
    "List active threads, optionally scoped to one project. Provide projectId from sparky_list_projects when targeting another project. Use the exact returned threadId for follow-up messages; do not infer a thread from its title when multiple threads match.",
  parameters: ThreadListInput,
  success: ToolResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CreateThreadTool = Tool.make("sparky_create_thread", {
  description:
    "Create a new thread in an existing Sparky project and send its initial prompt. By default, inherit the current thread's exact provider instance, model, and model options, including OAuth-backed selections; do not replace them with the target project's API-key default. To choose explicitly, pass providerInstanceId and model from sparky_list_models, plus an exact reasoningEffort or fastMode only when that model advertises support. First call sparky_list_projects. Pass an exact projectId, or a projectTitle only when it uniquely identifies one project; if the title is ambiguous, stop and ask the user instead of guessing. Use idempotencyKey when retrying so a network retry cannot create a duplicate thread. The result includes a target-thread deep link.",
  parameters: CreateThreadInput,
  success: ToolResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "Create thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ListModelsTool = Tool.make("sparky_list_models", {
  description:
    "List the live configured provider instances, their authentication status, selectable model slugs, display names, and exact supported model option choices. Use this before explicit model selection. Pass the returned providerInstanceId and exact slug to sparky_set_model or sparky_create_thread. A model's subProvider is catalog metadata, not a second provider instance; do not infer a provider or fall back to another one. OAuth-backed Codex models are labeled with the openai-codex/ prefix; do not substitute openai/ models because those require OPENAI_API_KEY.",
  parameters: ListModelsInput,
  success: ToolResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "List models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const SetModelTool = Tool.make("sparky_set_model", {
  description:
    "Set the model for the current thread or an exact target thread. Pass the providerInstanceId returned by sparky_list_models and either its exact slug or an exact display name such as the listed GPT model name; the server canonicalizes display names and rejects ambiguous matches. Pass exact reasoningEffort or fastMode values supported by that model. The server validates the configured connection, model availability, option values, and auth state, persists the selection, and the next turn uses that persisted selection; it never falls back to another provider or model.",
  parameters: SetModelInput,
  success: ToolResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "Set model")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const SendMessageTool = Tool.make("sparky_send_message", {
  description:
    "Send a follow-up message to an existing Sparky thread, including a thread in another project. Use sparky_list_threads when the target is not already known, pass the exact threadId, and optionally pass projectId so the server verifies the project boundary. Use idempotencyKey when retrying. The result includes the target-thread deep link.",
  parameters: SendMessageInput,
  success: ToolResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "Send thread message")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ThreadToolkit = Toolkit.make(
  ListProjectsTool,
  ListThreadsTool,
  ListModelsTool,
  SetModelTool,
  CreateThreadTool,
  SendMessageTool,
);
