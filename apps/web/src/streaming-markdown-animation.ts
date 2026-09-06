import type { StreamingTextAnimation } from "@sparky/contracts/settings";

export const STREAMING_TAIL_LIFT_CLASS = "chat-streaming-tail-lift";
export const STREAMING_TAIL_WORD_CLASS = "chat-streaming-tail-word";
export const STREAMING_TAIL_CLASS_NAME_PATTERN = /^chat-streaming-tail-(?:lift|word|delay-\d+)$/;
const STREAMING_TAIL_WORD_DELAY_CLASS_COUNT = 6;

interface MarkdownPosition {
  readonly start?: { readonly offset?: number | undefined } | undefined;
  readonly end?: { readonly offset?: number | undefined } | undefined;
}

export interface StreamingMarkdownNode {
  type: string;
  value?: string | undefined;
  position?: MarkdownPosition | undefined;
  data?:
    | {
        hName?: string | undefined;
        hProperties?: Record<string, unknown> | undefined;
      }
    | undefined;
  children?: StreamingMarkdownNode[] | undefined;
}

export interface StreamingMarkdownAnimationOptions {
  readonly animation: StreamingTextAnimation;
  readonly tailStart: number;
}

function makeAnimatedSpan(value: string, classNames: ReadonlyArray<string>): StreamingMarkdownNode {
  return {
    type: "emphasis",
    data: {
      hName: "span",
      hProperties: { className: [...classNames] },
    },
    children: [{ type: "text", value }],
  };
}

function splitAnimatedWords(
  value: string,
  animation: StreamingTextAnimation,
  wordIndex: { value: number },
): StreamingMarkdownNode[] {
  const parts = value.match(/\S+\s*|\s+/g) ?? [value];
  return parts.map((part) => {
    if (part.trim().length === 0) {
      return { type: "text", value: part };
    }
    if (animation === "lift") {
      return makeAnimatedSpan(part, [STREAMING_TAIL_LIFT_CLASS]);
    }
    const delayClass = `chat-streaming-tail-delay-${
      wordIndex.value % STREAMING_TAIL_WORD_DELAY_CLASS_COUNT
    }`;
    wordIndex.value += 1;
    return makeAnimatedSpan(part, [STREAMING_TAIL_WORD_CLASS, delayClass]);
  });
}

export function applyStreamingMarkdownAnimation(
  tree: StreamingMarkdownNode,
  options: StreamingMarkdownAnimationOptions,
): void {
  if (!Number.isFinite(options.tailStart) || options.tailStart < 0) {
    return;
  }
  const wordIndex = { value: 0 };

  const visit = (node: StreamingMarkdownNode) => {
    if (!node.children) {
      return;
    }
    const nextChildren: StreamingMarkdownNode[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || typeof child.value !== "string") {
        visit(child);
        nextChildren.push(child);
        continue;
      }

      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (start === undefined || end === undefined || end <= options.tailStart) {
        nextChildren.push(child);
        continue;
      }

      const localTailStart = Math.max(0, Math.min(child.value.length, options.tailStart - start));
      const stableValue = child.value.slice(0, localTailStart);
      const animatedValue = child.value.slice(localTailStart);
      if (stableValue.length > 0) {
        nextChildren.push({ ...child, value: stableValue });
      }
      nextChildren.push(...splitAnimatedWords(animatedValue, options.animation, wordIndex));
    }
    node.children = nextChildren;
  };

  visit(tree);
}

export function remarkStreamingMarkdownAnimation(options: StreamingMarkdownAnimationOptions) {
  return (tree: StreamingMarkdownNode) => applyStreamingMarkdownAnimation(tree, options);
}
