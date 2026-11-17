/** Pure audio helpers for the local Whisper microphone pipeline. */
export function audioRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let power = 0;
  for (const sample of samples) power += sample * sample;
  return Math.sqrt(power / samples.length);
}

/** Whisper expects mono PCM at 16 kHz. */
export function toWhisperSampleRate(
  samples: Float32Array,
  sourceSampleRate: number,
): Float32Array {
  const targetSampleRate = 16_000;
  if (sourceSampleRate === targetSampleRate) return samples;
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new Error("Invalid microphone sample rate");
  }
  const ratio = sourceSampleRate / targetSampleRate;
  const resampled = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < resampled.length; index++) {
    const at = index * ratio;
    const left = Math.floor(at);
    const fraction = at - left;
    const a = samples[left] ?? 0;
    const b = samples[Math.min(left + 1, samples.length - 1)] ?? a;
    resampled[index] = a * (1 - fraction) + b * fraction;
  }
  return resampled;
}

export function joinAudioChunks(chunks: ReadonlyArray<Float32Array>): Float32Array {
  const length = chunks.reduce((sum, next) => sum + next.length, 0);
  const combined = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) {
    combined.set(chunk, at);
    at += chunk.length;
  }
  return combined;
}

export const SPEECH_ACTIVITY_RMS = 0.018;
export const MAX_UTTERANCE_SECONDS = 20;
export const END_SILENCE_SECONDS = 0.8;
