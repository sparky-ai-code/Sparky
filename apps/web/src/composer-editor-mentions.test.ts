import { describe, expect, it } from "vite-plus/test";

import {
  selectionTouchesMentionBoundary,
  splitPromptIntoComposerSegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";
import { replacePluginTokensWithNames, searchPlugins } from "./components/plugins/pluginCatalog";

describe("splitPromptIntoComposerSegments", () => {
  it("splits plugin tokens into plugin segments", () => {
    expect(splitPromptIntoComposerSegments("Use @plugin:github please")).toEqual([
      { type: "text", text: "Use " },
      { type: "plugin", pluginId: "github" },
      { type: "text", text: " please" },
    ]);
  });

  it("keeps unknown plugin tokens as file mentions", () => {
    expect(splitPromptIntoComposerSegments("Use @plugin:unknown please")).toEqual([
      { type: "text", text: "Use " },
      {
        type: "mention",
        path: "plugin:unknown",
        source: "@plugin:unknown",
      },
      { type: "text", text: " please" },
    ]);
  });

  it("splits plugin tokens followed directly by punctuation", () => {
    expect(splitPromptIntoComposerSegments("What is available through @plugin:gmail?")).toEqual([
      { type: "text", text: "What is available through " },
      { type: "plugin", pluginId: "gmail" },
      { type: "text", text: "?" },
    ]);
  });

  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md", source: "@AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "mention", path: "src/index.ts", source: "@src/index.ts" },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("splits quoted mention tokens containing whitespace", () => {
    expect(splitPromptIntoComposerSegments('Inspect @"My File.md" please')).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "My File.md", source: '@"My File.md"' },
      { type: "text", text: " please" },
    ]);
  });

  it("unescapes quoted mention token content", () => {
    expect(splitPromptIntoComposerSegments('Inspect @"docs/My \\"File\\".md" please')).toEqual([
      { type: "text", text: "Inspect " },
      {
        type: "mention",
        path: 'docs/My "File".md',
        source: '@"docs/My \\"File\\".md"',
      },
      { type: "text", text: " please" },
    ]);
  });

  it("splits generated markdown file links into mention segments", () => {
    expect(
      splitPromptIntoComposerSegments(
        "Inspect [package.json](path/to/package.json) before continuing",
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      {
        type: "mention",
        path: "path/to/package.json",
        source: "[package.json](path/to/package.json)",
      },
      { type: "text", text: " before continuing" },
    ]);
  });

  it("does not turn normal web links into file mention segments", () => {
    expect(
      splitPromptIntoComposerSegments("Read [the docs](https://example.com/docs) first"),
    ).toEqual([{ type: "text", text: "Read [the docs](https://example.com/docs) first" }]);
  });

  it("decodes reserved path characters from generated links", () => {
    expect(
      splitPromptIntoComposerSegments(
        "Inspect [config#draft?.json](config%23draft%3F.json) before continuing",
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      {
        type: "mention",
        path: "config#draft?.json",
        source: "[config#draft?.json](config%23draft%3F.json)",
      },
      { type: "text", text: " before continuing" },
    ]);
  });

  it("splits skill tokens followed by whitespace into skill segments", () => {
    expect(splitPromptIntoComposerSegments("Use $review-follow-up please")).toEqual([
      { type: "text", text: "Use " },
      { type: "skill", name: "review-follow-up" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing skill token", () => {
    expect(splitPromptIntoComposerSegments("Use $review-follow-up")).toEqual([
      { type: "text", text: "Use $review-follow-up" },
    ]);
  });

  it("keeps inline terminal context placeholders at their prompt positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "mention", path: "AGENTS.md", source: "@AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("preserves consecutive terminal context placeholders without dropping positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}tail`,
      ),
    ).toEqual([
      { type: "terminal-context", context: null },
      { type: "terminal-context", context: null },
      { type: "text", text: "tail" },
    ]);
  });

  it("keeps skill parsing alongside mentions and terminal placeholders", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}$review-follow-up after @AGENTS.md `,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "skill", name: "review-follow-up" },
      { type: "text", text: " after " },
      { type: "mention", path: "AGENTS.md", source: "@AGENTS.md" },
      { type: "text", text: " " },
    ]);
  });
});

describe("searchPlugins", () => {
  it("filters plugin autocomplete results by the typed query", () => {
    expect(searchPlugins("notio").map((plugin) => plugin.id)).toEqual(["notion"]);
  });

  it("ranks name matches ahead of keyword matches", () => {
    expect(searchPlugins("mail").map((plugin) => plugin.id)).toEqual(["gmail", "outlook"]);
  });

  it("ignores sentence punctuation while searching", () => {
    expect(searchPlugins("gmail?").map((plugin) => plugin.id)).toEqual(["gmail"]);
  });
});

describe("replacePluginTokensWithNames", () => {
  it("converts known plugin tokens into display labels", () => {
    expect(replacePluginTokensWithNames("Inspect @plugin:github and @plugin:slack ")).toBe(
      "Inspect GitHub and Slack ",
    );
  });

  it("converts known plugin tokens before punctuation", () => {
    expect(replacePluginTokensWithNames("What is available through @plugin:gmail?")).toBe(
      "What is available through Gmail?",
    );
  });

  it("leaves unknown plugin tokens unchanged", () => {
    expect(replacePluginTokensWithNames("Use @plugin:unknown ")).toBe("Use @plugin:unknown ");
  });
});

describe("selectionTouchesMentionBoundary", () => {
  it("returns true when selection includes the whitespace after a mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi @package.json there",
        "hi @package.json".length,
        "hi @package.json there".length,
      ),
    ).toBe(true);
  });

  it("returns true when selection includes the whitespace before a mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi there @package.json later",
        "hi there".length,
        "hi there ".length,
      ),
    ).toBe(true);
  });

  it("returns false when selection starts after the mention boundary whitespace", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi @package.json there",
        "hi @package.json ".length,
        "hi @package.json there".length,
      ),
    ).toBe(false);
  });

  it("returns true when selection includes whitespace after a mention following a terminal placeholder", () => {
    const prompt = `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md there`;
    expect(
      selectionTouchesMentionBoundary(
        prompt,
        `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md`.length,
        prompt.length,
      ),
    ).toBe(true);
  });

  it("returns true when selection includes whitespace after a quoted mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        'hi @"My File.md" there',
        'hi @"My File.md"'.length,
        'hi @"My File.md" there'.length,
      ),
    ).toBe(true);
  });

  it("returns true when selection includes whitespace after a markdown file link", () => {
    const prompt = "hi [package.json](path/to/package.json) there";
    expect(
      selectionTouchesMentionBoundary(
        prompt,
        "hi [package.json](path/to/package.json)".length,
        prompt.length,
      ),
    ).toBe(true);
  });
});
