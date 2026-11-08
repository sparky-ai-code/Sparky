import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

const Html = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512_000),
).annotate({
  description:
    "A complete, self-contained HTML document. Keep styles and scripts inline, embed local images as data URLs, and follow the html_render layout and theme guidance.",
});

const HTML_RENDER_LAYOUT_GUIDE = [
  "The frame fills the conversation column (about 720px on desktop and 360px on phones) on the thread background.",
  "Keep html, body, and the outermost wrapper transparent; do not add page-wide background colors, outer cards, borders, banner titles, or side padding.",
  "Sparky provides an 8px document gutter for selection outlines and shadows. Use fluid widths and content-driven height; avoid viewport units and fixed heights on html or body.",
  "For an individual chart or callout that needs a surface, use a contained panel with about 16px padding and var(--radius) corners. Keep charts legible at narrow widths.",
].join(" ");

const HTML_RENDER_THEME_GUIDE = [
  "Use the injected theme CSS variables instead of hardcoded page-wide colors:",
  "surfaces/text: --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring;",
  "accents/status: --primary, --primary-foreground, --accent, --accent-foreground, --destructive, --destructive-foreground, --warning, --success, --info;",
  "charts/type: --chart-1 through --chart-6, --radius, --font-sans, --font-mono, --code-background, --code-foreground.",
  "The frame supplies the canvas, foreground color, and base typography.",
].join(" ");

export const HtmlRenderTool = Tool.make("html_render", {
  description: [
    "Render a finished chart, diagram, comparison, mockup, or other visual inline beneath your final reply. Design it as a polished, focused artifact: choose a clear takeaway, establish hierarchy with purposeful typography and spacing, and use a restrained palette. Preserve the provided facts and label units, axes, series, and categories; never invent data.",
    "Keep the document self-contained. Use HTML, CSS, and inline SVG; do not depend on remote scripts, stylesheets, fonts, or images because network access is blocked in the frame. Embed required images as data URLs.",
    HTML_RENDER_LAYOUT_GUIDE,
    HTML_RENDER_THEME_GUIDE,
    "Call this tool only after the HTML is complete. The visual is the answer: do not announce or restate it in your final reply; add only useful context not already shown.",
  ].join(" "),
  parameters: Schema.Struct({
    html: Html,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "A concise, descriptive title for the visual.",
    }),
    height: Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })).annotate({
      description:
        "Initial frame height in CSS pixels (80 to 2000). Choose a reasonable estimate; the frame expands to fit rendered content.",
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
