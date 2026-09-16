import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

const PluginId = Schema.Literals([
  "github",
  "jira",
  "notion",
  "gmail",
  "outlook",
  "slack",
  "sentry",
  "figma",
]);

export const RequestPluginAuthorizationTool = Tool.make("sparky_request_plugin_authorization", {
  description:
    "Ask the Sparky user to authorize one supported plugin. Use this only when the user's current prompt explicitly asks to use that plugin and it is not connected. This is a system-prompt/tool-contract behavior rule rather than a code-level prompt parser or explicit-intent flag. Cancellation is a normal result and must not stop the rest of the turn.",
  parameters: Schema.Struct({
    pluginId: PluginId,
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Authorize plugin")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

export const PluginCallTool = Tool.make("sparky_plugin_call", {
  description:
    "Use one of the user's connected Sparky integrations. Plugin references in the prompt are optional and do not grant access. Available integrations are GitHub, Jira, Notion, Gmail, Outlook, Slack, Sentry, and Figma; the worker rejects any integration that has not been connected. Supported actions: github=list_repositories,list_pull_requests,get_pull_request,create_issue,create_comment; jira=search_issues,get_issue,create_issue,update_issue; notion=search,get_page,create_page,update_page; gmail=search_messages,get_message,send_email,create_draft; outlook=list_messages,get_message,send_email,create_draft; slack=list_channels,read_channel,send_message; sentry=list_issues,get_issue,update_issue; figma=get_file,get_comments,post_comment.",
  parameters: Schema.Struct({
    pluginId: PluginId,
    action: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Use plugin")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const PluginToolkit = Toolkit.make(RequestPluginAuthorizationTool, PluginCallTool);
