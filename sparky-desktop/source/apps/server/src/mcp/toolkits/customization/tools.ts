import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

export const ReadCustomizationTool = Tool.make("sparky_customization_read", {
  description:
    "Read Sparky's current live UI mod, design tokens, CSS, custom panels, the file path and revision. Use before modifying the app so you preserve the user's existing choices. UI mods are declarative and persist across app restarts.",
  parameters: Schema.Struct({}),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Read Sparky customization")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ApplyCustomizationTool = Tool.make("sparky_customization_apply", {
  description:
    "Apply a persistent Sparky UI mod immediately. Requires Full access mode. Supply a COMPLETE version=1 customization with name, tokens (allowed colors and --radius), css (layout, backgrounds, animations, data-slot selectors), and panels (id/title/description/actions). Actions may open HTTPS URLs or Sparky routes, or copy text on click. Call sparky_customization_read first and pass its revision as expectedRevision to avoid overwriting changes. Rejects CSS network loads and arbitrary JavaScript. Use this tool when the user asks to retheme, restyle or add a small UI panel or quick actions. Explain that changing application logic requires ordinary code changes and tests.",
  parameters: Schema.Struct({
    customization: Schema.Unknown,
    expectedRevision: Schema.String,
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Customize Sparky")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, true);

export const CustomizationToolkit = Toolkit.make(ReadCustomizationTool, ApplyCustomizationTool);
