/*
 * Local Kitten TTS synthesis (KittenML/kitten-tts-2-nano, English, int8 ONNX).
 *
 * Text is phonemised and run through the ONNX graph here; no text or audio leaves the
 * device. The model files come from one pinned Hugging Face revision and are cached
 * by the browser. ONNX Runtime Web is loaded from a pinned jsDelivr build.
 *
 * Messages in:  { type: "load" } | { type: "speak", id, text, voice, speed }
 *               { type: "cancel", below } (drops queued jobs with id < below)
 * Messages out: status | ready | chunk { id, audio, sampleRate } | done { id, skipped } | error
 */
import { KittenLexicon } from "./kittenLexicon";
import { EnglishFrontend } from "./kittenFrontend";
import { parseVoicePacks, type VoicePack } from "./kittenArchive";
import {
  KITTEN_CHUNK_GAP_SECONDS,
  KITTEN_SAMPLE_RATE,
  phonemeTokens,
  styleRow,
  trimChunkAudio,
} from "./kittenSynthesis";

const MODEL_REVISION = "0843ae614780b04e4260c91b601e374c4b81250d";
const MODEL_BASE = `https://huggingface.co/KittenML/kitten-tts-2-nano/resolve/${MODEL_REVISION}/`;
const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const CACHE_NAME = "sparky-kitten-tts-nano-en-r1";

interface OrtTensor {
  readonly data: ArrayLike<number | bigint>;
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  InferenceSession: { create(bytes: Uint8Array, options: { executionProviders: string[] }): Promise<OrtSession> };
  Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => unknown;
}

interface SpeakJob {
  readonly id: number;
  readonly text: string;
  readonly voice: string;
  readonly speed: number;
}

type InMessage =
  | { type: "load" }
  | { type: "speak"; id: number; text: string; voice: string; speed: number }
  | { type: "cancel"; below: number };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
  crossOriginIsolated?: boolean;
};

let ready: Promise<void> | undefined;
let ort: OrtModule | undefined;
let session: OrtSession | undefined;
let frontend: EnglishFrontend | undefined;
let vocab: Record<string, number> = {};
let voices = new Map<string, VoicePack>();
let cancelBelow = 0;
let queue: Promise<void> = Promise.resolve();

const status = (text: string) => scope.postMessage({ type: "status", text });

async function fetchCached(path: string): Promise<Uint8Array> {
  const url = MODEL_BASE + path;
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    // Cache Storage can be unavailable in restricted renderer profiles; fetch instead.
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Kitten TTS download failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (cache) void cache.put(url, new Response(bytes.slice())).catch(() => {});
  return bytes;
}

async function initialize(): Promise<void> {
  status("Preparing Kitten TTS voice…");
  const [vocabBytes, voiceBytes, lexiconBytes] = await Promise.all([
    fetchCached("vocab.json"),
    fetchCached("voices_en.npz"),
    fetchCached("g2p/cmu_misaki_us.json"),
  ]);
  vocab = JSON.parse(new TextDecoder().decode(vocabBytes)) as Record<string, number>;
  voices = await parseVoicePacks(voiceBytes);
  frontend = new EnglishFrontend(
    new KittenLexicon(JSON.parse(new TextDecoder().decode(lexiconBytes)) as Record<string, string>),
  );
  status("Loading Kitten TTS speech model…");
  const modelBytes = await fetchCached("kitten_tts_2_nano_en.onnx");
  ort = (await import(/* @vite-ignore */ `${ORT_DIST}ort.wasm.min.mjs`)) as OrtModule;
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.wasm.numThreads = scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
  scope.postMessage({ type: "ready" });
}

function load(): Promise<void> {
  ready ??= initialize().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

async function synthesize(job: SpeakJob): Promise<void> {
  const pack = voices.get(job.voice);
  if (!pack || !session || !ort || !frontend) throw new Error("Kitten TTS voice is unavailable.");
  const skipped: string[] = [];
  const chunks = frontend.phonemizeChunks(job.text, skipped);
  const ortModule = ort;
  for (const [index, phonemes] of chunks.entries()) {
    if (job.id < cancelBelow) return;
    const tokens = phonemeTokens(phonemes, vocab);
    const outputs = await session.run({
      input_ids: new ortModule.Tensor("int64", BigInt64Array.from(tokens, BigInt), [1, tokens.length]),
      style: new ortModule.Tensor("float32", styleRow(pack.data, pack.rows, tokens.length), [1, 256]),
      speed: new ortModule.Tensor("float32", Float32Array.from([job.speed]), [1]),
    });
    if (job.id < cancelBelow) return;
    const waveform = outputs.waveform!.data as Float32Array;
    const durations = outputs.durations!.data as BigInt64Array;
    let audio = trimChunkAudio(waveform, durations, index === 0);
    if (index < chunks.length - 1) {
      const padded = new Float32Array(audio.length + Math.round(KITTEN_CHUNK_GAP_SECONDS * KITTEN_SAMPLE_RATE));
      padded.set(audio, 0);
      audio = padded;
    }
    scope.postMessage({ type: "chunk", id: job.id, audio, sampleRate: KITTEN_SAMPLE_RATE }, [audio.buffer]);
  }
  scope.postMessage({ type: "done", id: job.id, skipped });
}

scope.onmessage = (event: MessageEvent<InMessage>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelBelow = Math.max(cancelBelow, message.below);
    return;
  }
  if (message.type === "load") {
    load().catch((error: unknown) => scope.postMessage({ type: "error", message: errorText(error) }));
    return;
  }
  // Speak jobs run one at a time, in order, so sentences play back in sequence.
  const job: SpeakJob = { id: message.id, text: message.text, voice: message.voice, speed: message.speed };
  queue = queue
    .then(() => load())
    .then(() => {
      if (job.id < cancelBelow) return;
      return synthesize(job);
    })
    .catch((error: unknown) => {
      scope.postMessage({ type: "error", id: job.id, message: errorText(error) });
    });
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Kitten TTS could not run.";
}
