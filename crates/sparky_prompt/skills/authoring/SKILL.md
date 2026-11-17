---
name: document-presentation-authoring
description: Create and revise editable workspace documents and slide presentations when asked for reports, memos, proposals, handouts, decks, or presentations.
---

# Documents and presentations in Sparky

These are editable workspace files, not ephemeral inline visual replies. Use the existing read, write, edit, and bash tools with their normal safety rules. Do not substitute html_render for saving a requested document or deck.

## Documents

- Create Markdown documents in `sparky-artifacts/documents/<descriptive-slug>.md`. Sparky displays them as rendered documents in the file sidebar, with a switch to editable source.
- Use clear headings, short paragraphs, practical tables, and honest source attribution. Before updating an existing file, read it and make focused edits; do not overwrite unrelated content.
- If a native `.docx` file is explicitly requested, use a verified local DOCX-capable toolchain (such as python-docx if available). Verify the output is a valid file. Never rename Markdown to `.docx` or claim native export if it was not produced.

## Presentations

- Create decks in `sparky-artifacts/presentations/<descriptive-slug>.slides.html`. Write a complete, self-contained HTML file with embedded CSS and a `<main>` containing one `<section class="slide">` per slide.
- Use clear slide titles, useful visual hierarchy, concise content, accessible text, responsive CSS, and CSS scroll-snap for navigation. Avoid oversized prose and repetitive layouts.
- The file panel uses a script-disabled, network-restricted iframe. Do not depend on JavaScript, remote fonts, CDNs, external images, forms, or network requests. Embed necessary visuals as inline SVG or data URLs.
- If a native `.pptx` file is explicitly requested, use an available, verified PPTX-capable toolchain (such as python-pptx if installed) and check the actual output. Do not claim HTML is a PowerPoint file.

## Delivery and references

- Use descriptive, unique filenames and save inside the current workspace. The workspace write operation creates necessary parent directories.
- Include a normal Markdown link with the exact relative file path in the response, such as `[Project proposal](sparky-artifacts/documents/project-proposal.md)` or `[Pitch slides](sparky-artifacts/presentations/pitch.slides.html)`. File links open the file panel.
- Files can be referenced again through the existing chat file picker, drag into chat, or the Reference in chat action in the file panel. Refer to the saved file rather than dumping its full contents into chat.
- If a requested native format cannot be generated in the current environment, retain the editable workspace source and accurately report the limitation.
