---
name: visual-replies
description: Create polished, self-contained inline HTML visual replies with Sparky's html_render tool. Use when a chart, diagram, comparison, table, dashboard, mockup, or other visual would communicate an answer more clearly than prose; when the user asks for a visualization; or when revising a prior visual's design.
---

# Visual replies

Use Sparky's `html_render` tool to deliver the visual directly in the conversation. Always follow the layout and theme rules embedded in the tool description; this skill adds design guidance for choosing and composing a strong visual. Treat a visual reply as a small designed artifact, not a default HTML page: decide what the viewer should understand first, then make hierarchy, spacing, typography, and color reinforce that point.

## Design the visual

1. **Choose a clear visual concept before writing HTML.** Identify the audience, the key takeaway, and the best form for the data or idea. Prefer a focused chart, comparison, annotated diagram, or compact dashboard over generic cards and decorative filler.
2. **Make the result feel intentional and complete.** Use a strong title, concise supporting labels, consistent spacing, meaningful grouping, and a restrained palette. Use differentiated weight and scale to establish hierarchy; reserve accent colors for important distinctions.
3. **Keep information honest and legible.** Preserve source values, units, and relationships. Label axes, series, and categories; include a legend when color alone is ambiguous. Do not invent data or imply precision the input does not support. Make labels readable at the conversation's narrow column width.
4. **Use HTML, CSS, and inline SVG for self-contained visuals.** Build charts and diagrams with native HTML/CSS/SVG. Do not depend on CDNs, external fonts, network images, or remote scripts: the visual frame may block external requests. Embed any necessary small image as a data URL.
5. **Support the actual frame.** Use fluid widths and responsive layout, avoid viewport-dependent sizing, and let content determine height. Set the tool's height to a sensible estimate in its supported range; the frame can grow to fit content. Keep mobile and desktop readable.

## Match Sparky's theme

The frame provides theme CSS custom properties. Use them rather than hardcoded page-wide light/dark colors:

- Surfaces and text: `--background`, `--foreground`, `--card`, `--card-foreground`, `--muted`, `--muted-foreground`, `--popover`, `--popover-foreground`, `--secondary`, `--secondary-foreground`, `--border`, `--input`, `--ring`.
- Accents and status: `--primary`, `--primary-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--warning`, `--success`, `--info`.
- Charts and typography: `--chart-1` through `--chart-6`, `--radius`, `--font-sans`, `--font-mono`, `--code-background`, `--code-foreground`.

Leave the document canvas transparent: do not set a page-wide background or text color on `html`, `body`, or the outermost wrapper. Keep the visual integrated with the surrounding conversation. When an individual chart, callout, or comparison needs a surface, use a contained panel with theme variables, modest padding, and rounded corners. Do not add a second page banner or outer card around the whole composition.

## Deliver it

- Call `html_render` with a descriptive, concise title, the complete HTML, and a reasonable height.
- Do not create a local server or open the shared browser just to display the visual; `html_render` is the inline delivery path.
- After a successful render, the visual itself is the answer. The final message should be brief and add only context, caveats, or conclusions that are not already visible in the visual. Do not announce or restate it.
- If `html_render` fails, explain the failure briefly and give the answer in text instead of claiming that a visual was delivered.

## Quality check before rendering

Review the HTML mentally before calling the tool: does the visual make its main point at a glance; are all values and labels correct; does it use Sparky's theme tokens; is it self-contained and readable at narrow widths; and is there any decoration that does not help the viewer? Simplify or fix problems before publishing.

## Attribution

This independently written skill is informed by the visual-reply workflow and theme-aware layout guidance in [T3 Code](https://github.com/pingdotgg/t3code). No upstream skill text or code is copied here. T3 Code's MIT license and attribution notice are reproduced below for this adaptation.

> MIT License
>
> Copyright (c) 2026 T3 Tools Inc.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
