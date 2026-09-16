import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { describe, expect, it } from "vite-plus/test";

import {
  applyStreamingMarkdownAnimation,
  remarkStreamingMarkdownAnimation,
  STREAMING_TAIL_CLASS_NAME_PATTERN,
  type StreamingMarkdownNode,
} from "./streaming-markdown-animation";

describe("remarkStreamingMarkdownAnimation", () => {
  it("wraps only text appended after the raw markdown cutoff", () => {
    const markup = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[[remarkStreamingMarkdownAnimation, { animation: "lift", tailStart: 6 }]]}
      >
        {"Hello fresh text"}
      </ReactMarkdown>,
    );

    expect(markup).toContain('Hello <span class="chat-streaming-tail-lift">fresh </span>');
    expect(markup).toContain('<span class="chat-streaming-tail-lift">text</span>');
  });

  it("preserves only the allowed animation classes through sanitization", () => {
    const schema = {
      ...defaultSchema,
      attributes: {
        ...defaultSchema.attributes,
        span: [
          ...(defaultSchema.attributes?.span ?? []),
          ["className", STREAMING_TAIL_CLASS_NAME_PATTERN],
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[[remarkStreamingMarkdownAnimation, { animation: "words", tailStart: 6 }]]}
        rehypePlugins={[[rehypeSanitize, schema]]}
      >
        {"Hello fresh words"}
      </ReactMarkdown>,
    );

    expect(markup).toContain(
      '<span class="chat-streaming-tail-word chat-streaming-tail-delay-0">fresh </span>',
    );
    expect(markup).toContain(
      '<span class="chat-streaming-tail-word chat-streaming-tail-delay-1">words</span>',
    );
  });

  it("stagger-wraps appended words and leaves the stable prefix untouched", () => {
    const tree: StreamingMarkdownNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Stable new words",
              position: { start: { offset: 0 }, end: { offset: 16 } },
            },
          ],
        },
      ],
    };

    applyStreamingMarkdownAnimation(tree, { animation: "words", tailStart: 7 });

    const children = tree.children?.[0]?.children ?? [];
    expect(children[0]).toMatchObject({ type: "text", value: "Stable " });
    expect(children[1]?.data?.hProperties).toEqual({
      className: ["chat-streaming-tail-word", "chat-streaming-tail-delay-0"],
    });
    expect(children[2]?.data?.hProperties).toEqual({
      className: ["chat-streaming-tail-word", "chat-streaming-tail-delay-1"],
    });
  });

  it("does not animate text without source offsets", () => {
    const tree: StreamingMarkdownNode = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Generated" }] }],
    };

    applyStreamingMarkdownAnimation(tree, { animation: "lift", tailStart: 0 });

    expect(tree.children?.[0]?.children).toEqual([{ type: "text", value: "Generated" }]);
  });
});
