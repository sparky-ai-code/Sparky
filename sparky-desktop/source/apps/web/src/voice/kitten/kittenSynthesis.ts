/**
 * Pure helpers around the Kitten TTS ONNX graph: token ids, voice style rows, and
 * per-chunk audio trimming. Ported from `kittentts2_tiny/model.py` (Apache-2.0).
 *
 * The graph takes `input_ids [1, T] int64`, `style [1, 256] float32` and
 * `speed [1] float32`, and returns `waveform` and per-phoneme `durations`.
 */

export const KITTEN_SAMPLE_RATE = 24_000;
export const KITTEN_END_TOKEN = 10;
export const KITTEN_STYLE_DIM = 256;
/** Silence between chunks of one long text, in seconds. */
export const KITTEN_CHUNK_GAP_SECONDS = 0.15;

/** Phoneme string -> token ids, wrapped in the boundary tokens the model was trained with. */
export function phonemeTokens(phonemes: string, vocab: Readonly<Record<string, number>>): number[] {
  const ids: number[] = [];
  for (const char of phonemes) {
    const id = vocab[char];
    if (id !== undefined) ids.push(id);
    else if (char === "(" || char === ")") ids.push(vocab[","] ?? 0);
  }
  return [0, ...ids, KITTEN_END_TOKEN, 0];
}

/** The style row of a voice pack for a sequence length (one row per token count, clamped). */
export function styleRow(pack: Float32Array, rowCount: number, tokenCount: number): Float32Array {
  const row = Math.min(tokenCount - 1, rowCount - 1);
  const start = row * KITTEN_STYLE_DIM;
  return pack.slice(start, start + KITTEN_STYLE_DIM);
}

/**
 * Remove the leading and trailing silence the model predicts for the boundary tokens,
 * then apply short fades. `durations` are per-token frame counts from the graph.
 */
export function trimChunkAudio(
  waveform: Float32Array,
  durations: ArrayLike<number | bigint>,
  keepStart: boolean,
): Float32Array {
  const frames = Array.from(durations, (value) => Number(value));
  const total = frames.reduce((sum, value) => sum + value, 0);
  const samplesPerFrame = Math.max(1, Math.round(waveform.length / Math.max(total, 1)));
  const first = frames[0] ?? 0;
  const last = frames[frames.length - 1] ?? 0;
  const lead = keepStart ? 0 : Math.max(0, first - 1) * samplesPerFrame;
  const trail = Math.max(0, last - 1) * samplesPerFrame;
  let audio = waveform;
  if (lead + trail + samplesPerFrame < audio.length) {
    audio = trail ? audio.slice(lead, audio.length - trail) : audio.slice(lead);
  }
  const clipped = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) clipped[i] = Math.min(1, Math.max(-1, audio[i]!));
  const fade = Math.min(120, Math.floor(clipped.length / 8));
  for (let i = 0; fade > 1 && i < fade; i++) {
    const ramp = i / (fade - 1);
    clipped[i]! *= ramp;
    clipped[clipped.length - 1 - i]! *= ramp;
  }
  return clipped;
}

/** A silent gap of `seconds` at the sample rate. */
export function silence(seconds: number, sampleRate = KITTEN_SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate));
}
