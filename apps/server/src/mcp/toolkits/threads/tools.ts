import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
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
  runtimeMode: Schema.optional(
    Schema.Literals(["approval-required", "auto-accept-edits", "full-access"]),
  ),
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
  idempotencyKey: Schema.optional(Schema.String),
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
    "Create a new thread in an existing Sparky project and send its initial prompt. First call sparky_list_projects. Pass an exact projectId, or a projectTitle only when it uniquely identifies one project; if the title is ambiguous, stop and ask the user instead of guessing. Use idempotencyKey when retrying so a network retry cannot create a duplicate thread. The result includes a target-thread deep link.",
  parameters: CreateThreadInput,
  success: ToolResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "Create thread")
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
  CreateThreadTool,
  SendMessageTool,
);
