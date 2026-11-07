import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

const Html = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512_000),
).annotate({
  description:
    "A complete, self-contained HTML document. Inline styles and scripts. Local images should be embedded as data URLs.",
});

export const HtmlRenderTool = Tool.make("html_render", {
  description:
    "Show a finished HTML page (chart, diagram, mockup, or image collage) inline in this chat above your final reply. Keep it self-contained. Do not announce or describe the page in your final reply; only add information it does not already show.",
  parameters: Schema.Struct({
    html: Html,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    height: Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })).annotate({
      description: "Frame height in CSS pixels, 80 to 2000. Choose a height that fits the content.",
    }),
  }),
  success: Schema.Struct({ message: Schema.String }),
})
  .annotate(Tool.Title, "Render visual reply")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool);
export const HtmlRenderToolkitHandlersLive = HtmlRenderToolkit.toLayer({
  html_render: () =>
    Effect.succeed({
      message:
        "Your visual reply is shown inline in the chat. Do not mention or describe it; only add information it does not already show.",
    }),
});
