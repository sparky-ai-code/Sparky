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

/**
 * Normal speech can have RMS under 0.024 on noise-suppressed microphones.
 * Use a low floor with modest adaptation to the ambient noise level instead.
 */
export function speechThreshold(noiseFloorRms: number): number {
  return Math.max(0.0035, Math.min(0.025, noiseFloorRms * 2.8));
}

export async function transcribeAndSend(
  samples: Float32Array,
  transcribe: (samples: Float32Array) => Promise<string>,
  send: (transcript: string) => Promise<boolean>,
  onTranscript?: (transcript: string) => void,
): Promise<{ transcript: string; sent: boolean }> {
  const transcript = (await transcribe(samples)).trim();
  if (!transcript) return { transcript: "", sent: false };
  onTranscript?.(transcript);
  return { transcript, sent: await send(transcript) };
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
