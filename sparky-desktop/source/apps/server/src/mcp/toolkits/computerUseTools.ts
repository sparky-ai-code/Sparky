import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

export const ComputerUseListTools = Tool.make("sparky_computer_use_list_tools", {
  description:
    "List the computer-use tools (screenshots, clicking, typing, window control) available on the user's computer. Only works when the user has enabled computer use in Sparky settings. Call this before sparky_computer_use_call_tool.",
  parameters: Schema.Struct({}),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "List computer-use tools")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

export const ComputerUseCallTool = Tool.make("sparky_computer_use_call_tool", {
  description:
    "Call a computer-use tool to interact with the user's computer. Use sparky_computer_use_list_tools first for exact tool names and arguments. Ask the user before irreversible actions such as sending messages or submitting forms.",
  parameters: Schema.Struct({
    toolName: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Call computer-use tool")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const ComputerUseToolkit = Toolkit.make(ComputerUseListTools, ComputerUseCallTool);
