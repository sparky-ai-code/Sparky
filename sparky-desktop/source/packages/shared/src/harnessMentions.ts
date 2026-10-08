export const ACP_DRIVER_KINDS = new Set(["codexHarness", "claudeHarness", "acp"]);

export function serializeHarnessToken(instanceId: string): string {
  return `@agent:${instanceId}`;
}

function findCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < text.length; ) {
    if (text[start] !== "`") {
      start += 1;
      continue;
    }
    let delimiterLength = 1;
    while (text[start + delimiterLength] === "`") delimiterLength += 1;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const isFence = delimiterLength >= 3 && text.slice(lineStart, start).trim() === "";
    let cursor = start + delimiterLength;
    let closingStart = -1;
    while (cursor < text.length) {
      const candidate = text.indexOf("`", cursor);
      if (candidate < 0) break;
      let candidateLength = 1;
      while (text[candidate + candidateLength] === "`") candidateLength += 1;
      if (isFence) {
        const candidateLineStart = text.lastIndexOf("\n", candidate - 1) + 1;
        const afterRun = candidate + candidateLength;
        const lineEnd = text.indexOf("\n", afterRun);
        const trailingText = text.slice(afterRun, lineEnd < 0 ? text.length : lineEnd);
        if (
          candidateLength >= delimiterLength &&
          text.slice(candidateLineStart, candidate).trim() === "" &&
          trailingText.trim() === ""
        ) {
          closingStart = candidate;
          break;
        }
      } else if (candidateLength === delimiterLength) {
        closingStart = candidate;
        break;
      }
      cursor = candidate + candidateLength;
    }
    if (closingStart >= 0) {
      let closingLength = 1;
      while (text[closingStart + closingLength] === "`") closingLength += 1;
      ranges.push({ start, end: closingStart + closingLength });
      start = closingStart + closingLength;
    } else if (isFence) {
      ranges.push({ start, end: text.length });
      break;
    } else {
      start += delimiterLength;
    }
  }
  return ranges;
}

/** Only explicit agent tokens route messages; file/plugin names never select a harness. */
export function parseHarnessMentions(prompt: string): {
  instanceId: string | null;
  prompt: string;
  error: string | null;
} {
  const codeRanges = findCodeRanges(prompt);
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
