export function textForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " Code example omitted. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^[>|*+-]\s+/gm, "")
    .replace(/\*\*|__|[\`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

export function latestNewAssistant(
  messages: ReadonlyArray<{ id: string; role: string; text: string; streaming?: boolean }>,
  previousAssistantId: string | null,
): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (String(message.id) === previousAssistantId) return null;
    if (message.streaming) return null;
    return { id: String(message.id), text: message.text };
  }
  return null;
}

export function shouldShowInlineVoiceAction(input: {
  isRunning: boolean;
  pendingAction: boolean;
  showPlanFollowUpPrompt: boolean;
  hasSendableContent: boolean;
}): boolean {
  return !input.isRunning && !input.pendingAction && !input.showPlanFollowUpPrompt && !input.hasSendableContent;
}

export function microphoneRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.sqrt(squares / samples.length);
}

export function shouldFinishUtterance(
  durationMs: number,
  silenceMs: number,
  speechDetected: boolean,
): boolean {
  return (speechDetected && durationMs >= 450 && silenceMs >= 950) || durationMs >= 30_000;
}
