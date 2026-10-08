export const ACP_DRIVER_KINDS = new Set(["codexHarness", "claudeHarness", "acp"]);

export function serializeHarnessToken(instanceId: string): string {
  return `@agent:${instanceId}`;
}

/** Only explicit agent tokens route messages; file/plugin names never select a harness. */
export function parseHarnessMentions(prompt: string): {
  instanceId: string | null;
  prompt: string;
  error: string | null;
} {
  const codeRanges = [...prompt.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const tokens = [
    ...prompt.matchAll(/(^|\s)@agent:([a-zA-Z][a-zA-Z0-9_-]{0,63})(?=$|[\s.,!?;:)\]}])/g),
  ].filter(
    (match) => !codeRanges.some((range) => match.index >= range.start && match.index < range.end),
  );
  const ids = [...new Set(tokens.map((match) => match[2]!))];
  if (ids.length > 1)
    return { instanceId: null, prompt, error: "Mention only one harness per message." };
  let text = prompt;
  for (const token of tokens.toReversed()) {
    const start = token.index + token[1]!.length;
    text = text.slice(0, start) + text.slice(token.index + token[0].length);
  }
  return { instanceId: ids[0] ?? null, prompt: text.trim(), error: null };
}
