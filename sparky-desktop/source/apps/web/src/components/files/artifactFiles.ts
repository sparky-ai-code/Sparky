/** Editable workspace documents and self-contained slide decks. */
export type AuthoredArtifactKind = "document" | "presentation";

export function isAuthoredDocumentFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /(?:^|\/)sparky-artifacts\/documents\/[^/]+\.md$/.test(normalized)
    || /\.document\.md$/.test(normalized);
}

export function isAuthoredPresentationFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /\.slides\.html$/.test(normalized);
}

const STARTER_PRESENTATION = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>Untitled presentation</title>",
  "<style>",
  "*{box-sizing:border-box}html{scroll-snap-type:y mandatory}",
  "body{margin:0;background:#f4f5f9;color:#1b2432;font-family:system-ui,sans-serif}",
  ".slide{min-height:100vh;padding:clamp(24px,7vw,88px);display:flex;flex-direction:column;justify-content:center;gap:20px;scroll-snap-align:start}",
  ".slide:nth-child(2){background:#15263f;color:white}",
  "h1{margin:0;font-size:clamp(34px,6vw,78px);line-height:1.1}",
  "h2{margin:0;font-size:clamp(28px,5vw,56px)}",
  "p{max-width:60ch;font-size:clamp(16px,2vw,24px);line-height:1.5}",
  "</style></head><body>",
  '<main aria-label="Presentation slides">',
  '<section class="slide" aria-label="Slide 1"><h1>Untitled presentation</h1><p>Add your subtitle here.</p></section>',
  '<section class="slide" aria-label="Slide 2"><h2>Key idea</h2><p>Replace this text with your main point.</p></section>',
  "</main></body></html>",
  "",
].join("\n");

export function makeArtifactDraft(kind: AuthoredArtifactKind, identifier: string): {
  readonly relativePath: string;
  readonly contents: string;
} {
  const safeId = identifier.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64) || "untitled";
  if (kind === "document") {
    return {
      relativePath: "sparky-artifacts/documents/" + safeId + ".md",
      contents: "# Untitled document\n\nStart writing here.\n",
    };
  }
  return {
    relativePath: "sparky-artifacts/presentations/" + safeId + ".slides.html",
    contents: STARTER_PRESENTATION,
  };
}

/** The caller must also set sandbox="" on the iframe. */
export function buildSandboxedPresentationHtml(source: string): string {
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta http-equiv="Content-Security-Policy" content="' + policy + '">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<style>html,body{margin:0;min-height:100%}body{overflow-y:auto}</style>",
    "</head><body>",
    source,
    "</body></html>",
  ].join("\n");
}
