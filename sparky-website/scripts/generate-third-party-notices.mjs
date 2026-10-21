import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [licenseJsonPath] = process.argv.slice(2);
if (!licenseJsonPath) {
  throw new Error("Usage: node scripts/generate-third-party-notices.mjs <pnpm-licenses-json|->");
}

const websiteRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(websiteRoot, "..");
let raw = licenseJsonPath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(licenseJsonPath, "utf8");
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
const grouped = JSON.parse(raw);

const packageHomepageFallbacks = [
  [/^@ff-labs\/fff(?:-|$)/u, "https://github.com/dmtrKovalenko/fff"],
  [/^@msgpackr-extract\/msgpackr-extract-/u, "https://github.com/kriszyp/msgpackr-extract"],
  [/^@opencode-ai\/sdk$/u, "https://www.npmjs.com/package/@opencode-ai/sdk"],
  [/^@pierre\/theming$/u, "https://www.npmjs.com/package/@pierre/theming"],
  [/^@yuuang\/ffi-rs-/u, "https://github.com/zhangyuang/node-ffi-rs"],
];

function packageHomepage(pkg) {
  if (pkg.homepage) return pkg.homepage;
  const fallback = packageHomepageFallbacks.find(([pattern]) => pattern.test(pkg.name));
  return fallback?.[1] || null;
}

const additionalNotices = [
  {
    name: "T3 Composer Editor native module (Expo-derived)",
    versions: ["checked-in source"],
    license: "MIT",
    author: "650 Industries, Inc. (Expo)",
    homepage: "https://github.com/expo/expo",
    scope: "mobile/native source",
    sourcePath: path.join(workspaceRoot, "sparky-desktop", "source", "apps", "mobile", "modules", "t3-composer-editor", "LICENSE"),
  },
  {
    name: "React Native UITextView code in T3 Markdown Text",
    versions: ["checked-in source"],
    license: "MIT",
    author: "Bluesky PBC",
    homepage: "https://github.com/bluesky-social/react-native-uitextview",
    scope: "mobile/native source",
    sourcePath: path.join(workspaceRoot, "sparky-desktop", "source", "apps", "mobile", "modules", "t3-markdown-text", "LICENSE"),
  },
  {
    name: "Ghostty/libghostty mobile terminal renderer",
    versions: ["pinned vendored revisions"],
    license: "MIT",
    author: "Mitchell Hashimoto and Ghostty contributors",
    homepage: "https://github.com/ghostty-org/ghostty",
    scope: "mobile/native source",
    sourcePath: path.join(workspaceRoot, "sparky-desktop", "source", "apps", "mobile", "modules", "t3-terminal", "Vendor", "libghostty-vt", "LICENSE"),
    contextPath: path.join(workspaceRoot, "sparky-desktop", "source", "apps", "mobile", "modules", "t3-terminal", "THIRD_PARTY_NOTICES.md"),
  },
  {
    name: "MesloLGS NF terminal font",
    versions: ["checked-in assets"],
    license: "Apache-2.0",
    author: "André Berg and Nerd Fonts contributors",
    homepage: "https://github.com/romkatv/powerlevel10k-media",
    scope: "mobile/native assets",
    notice: [
      "Copyright 2009, 2010, 2013 André Berg",
      "",
      "Licensed under the Apache License, Version 2.0 (the \"License\");",
      "you may not use this file except in compliance with the License.",
      "You may obtain a copy of the License at",
      "http://www.apache.org/licenses/LICENSE-2.0",
      "Unless required by applicable law or agreed to in writing, software",
      "distributed under the License is distributed on an \"AS IS\" BASIS,",
      "WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.",
      "See the License for the specific language governing permissions and",
      "limitations under the License.",
    ].join("\n"),
  },
];

function normalizeLicense(value, packageName = "") {
  if (!value) return "Unknown";
  if (/^see license in /iu.test(value)) return `Vendor terms (${value})`;
  if (value === "Unknown" && /^@anthropic-ai\/claude-agent-sdk(?:-|$)/u.test(packageName)) {
    return "Vendor terms (see LICENSE.md)";
  }
  return value;
}

const entries = Object.entries(grouped)
  .flatMap(([license, packages]) =>
    packages.map((pkg) => ({
      name: pkg.name,
      versions: pkg.versions,
      license: normalizeLicense(pkg.license || license, pkg.name),
      author: pkg.author || null,
      homepage: packageHomepage(pkg),
    })),
  )
  .sort((left, right) => left.name.localeCompare(right.name) || left.license.localeCompare(right.license));

fs.mkdirSync(path.join(websiteRoot, "public"), { recursive: true });
fs.writeFileSync(
  path.join(websiteRoot, "public", "third-party-licenses.json"),
  `${JSON.stringify({
    generatedFrom: "Sparky desktop/server production dependency graph",
    packageCount: entries.length,
    entries,
    additionalNotices: additionalNotices.map(({ sourcePath, contextPath, notice, ...entry }) => entry),
  }, null, 2)}\n`,
);

const notices = [
  "Sparky third-party notices",
  "",
  "This inventory was generated from the production dependency graph used by Sparky's desktop and server bundles.",
  "Checked-in mobile/native source and asset notices are included in the additional section below and are outside the runtime package count.",
  "",
  "Sparky is derived from T3 Code. The upstream MIT notice is included below.",
  "",
  fs.readFileSync(path.join(workspaceRoot, "sparky-desktop", "source", "LICENSE"), "utf8").trim(),
  "",
];
const seen = new Set();

for (const packages of Object.values(grouped)) {
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.versions.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notices.push("=".repeat(80), `${pkg.name} ${pkg.versions.join(", ")} — ${normalizeLicense(pkg.license || "Unknown", pkg.name)}`);
    const homepage = packageHomepage(pkg);
    if (homepage) notices.push(`Upstream: ${homepage}`);

    let includedLicense = false;
    for (const root of [...new Set(pkg.paths || [])]) {
      let names = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names.filter((candidate) => /^(?:license|licence|copying|notice)(?:[._-].*)?$/iu.test(candidate))) {
        const filePath = path.join(root, name);
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        let text;
        try {
          text = fs.readFileSync(filePath, "utf8").trim();
        } catch {
          continue;
        }
        if (!text || text.length > 250_000) continue;
        notices.push(`\n--- ${name} ---\n${text}`);
        includedLicense = true;
      }
    }
    if (!includedLicense) notices.push("License text was not present as a package-root file; consult the upstream link above.");
    notices.push("");
  }
}

notices.push("=".repeat(80), "ADDITIONAL CHECKED-IN MOBILE/NATIVE SOURCE AND ASSET NOTICES", "");
for (const entry of additionalNotices) {
  notices.push(`${entry.name} — ${entry.license}`);
  if (entry.author) notices.push(`Copyright/author: ${entry.author}`);
  if (entry.homepage) notices.push(`Upstream: ${entry.homepage}`);
  if (entry.contextPath) {
    notices.push("\n--- upstream context ---\n", fs.readFileSync(entry.contextPath, "utf8").trim());
  }
  if (entry.sourcePath) {
    notices.push("\n--- license text ---\n", fs.readFileSync(entry.sourcePath, "utf8").trim());
  }
  if (entry.notice) notices.push("\n--- license notice ---\n", entry.notice);
  notices.push("\n");
}

fs.writeFileSync(
  path.join(websiteRoot, "public", "third-party-notices.txt"),
  `${notices.join("\n").replace(/\n{3,}/gu, "\n\n")}\n`,
);
console.log(JSON.stringify({ packageCount: entries.length, noticesBytes: Buffer.byteLength(notices.join("\n"), "utf8") }));
