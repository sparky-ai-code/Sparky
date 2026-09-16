import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const sharp = require(
  "C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp",
);

const outputDir = import.meta.dirname;
const source = "C:/Users/Lenovo/AppData/Local/Temp/codex-clipboard-21c80120-b115-4ef8-af91-007c2fb61229.png";
const background = await readFile(source);
const backgroundUri = `data:image/png;base64,${background.toString("base64")}`;

// This is the exact Lucide PencilRulerIcon used by ChatComposer.tsx
// when interactionMode === "plan" (lucide-react 0.564.0).
const planIcon = `
  <svg x="1034" y="408" width="56" height="56" viewBox="0 0 24 24"
    fill="none" stroke="#000000" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"
    aria-label="Plan Mode icon">
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
    <path d="m15 5 4 4"/>
  </svg>`;

const artwork = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <image href="${backgroundUri}" x="0" y="0" width="1600" height="900" preserveAspectRatio="none"/>
  ${planIcon}
  <text x="1106" y="458" fill="#000000" font-family="Inter, Segoe UI, Arial, sans-serif"
    font-size="48" font-weight="600" letter-spacing="-0.7">Plan Mode</text>
</svg>`;

await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "plan-mode-announcement.svg"), artwork, "utf8");
await sharp(Buffer.from(artwork))
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(path.join(outputDir, "plan-mode-announcement.png"));

console.log(`Wrote ${path.join(outputDir, "plan-mode-announcement.png")}`);
