/** Extract a spoken answer without reading URLs or fenced source code aloud. */
export function textForSpeech(markdown: string): string {
  return markdown
    .replace(/^\s*<think>[\s\S]*?<\/think>\s*/gim, "")
    .replace(/```[\s\S]*?```/g, " Code example. ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VoiceMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly streaming?: boolean;
}

export function latestAssistantId(messages: ReadonlyArray<VoiceMessage>): string | null {
  return [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null;
}

/** Read only a completed assistant answer created after the spoken user turn. */
export function completedVoiceReply(
  messages: ReadonlyArray<VoiceMessage>,
  previousAssistantId: string | null,
): VoiceMessage | null {
  const anchor = previousAssistantId === null
    ? -1
    : messages.findIndex((message) => message.id === previousAssistantId);
  if (previousAssistantId !== null && anchor < 0) return null;
  const next = messages.slice(anchor + 1).filter(
    (message) => message.role === "assistant" && !message.streaming && Boolean(message.text.trim()),
  );
  return next.at(-1) ?? null;
}
