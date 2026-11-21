/*
 * Local Kitten TTS synthesis (KittenML/kitten-tts-2-nano, English, int8 ONNX).
 *
 * Everything runs on the device, and every file is bundled into the app at build
 * time (see scripts/fetch-voice-assets.mjs). Nothing is downloaded at runtime.
 *
 * Messages in:  { type: "load", assetBase } | { type: "speak", id, text, voice, speed }
 *               { type: "cancel", below } (drops queued jobs with id < below)
 * Messages out: ready | chunk { id, audio, sampleRate } | done { id, skipped } | error
 */
import * as ortRuntime from "onnxruntime-web";
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
  | { type: "load"; assetBase: string }
  | { type: "speak"; id: number; text: string; voice: string; speed: number }
  | { type: "cancel"; below: number };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
  crossOriginIsolated?: boolean;
};

let ready: Promise<void> | undefined;
let assetBase = "";
let ort: OrtModule | undefined;
let session: OrtSession | undefined;
let frontend: EnglishFrontend | undefined;
let vocab: Record<string, number> = {};
let voices = new Map<string, VoicePack>();
let cancelBelow = 0;
let queue: Promise<void> = Promise.resolve();

function assetUrl(path: string): string {
  return new URL(path, assetBase).href;
}

async function readAsset(path: string): Promise<Uint8Array> {
  const response = await fetch(assetUrl(path));
  if (!response.ok) throw new Error(`Kitten TTS files are missing from this install (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function initialize(): Promise<void> {
  const [vocabBytes, voiceBytes, lexiconBytes, modelBytes] = await Promise.all([
    readAsset("voice/kitten/vocab.json"),
    readAsset("voice/kitten/voices_en.npz"),
    readAsset("voice/kitten/cmu_misaki_us.json"),
    readAsset("voice/kitten/model.onnx"),
  ]);
  vocab = JSON.parse(new TextDecoder().decode(vocabBytes)) as Record<string, number>;
  voices = await parseVoicePacks(voiceBytes);
  frontend = new EnglishFrontend(
    new KittenLexicon(JSON.parse(new TextDecoder().decode(lexiconBytes)) as Record<string, string>),
  );
  const runtime = ortRuntime as unknown as OrtModule;
  runtime.env.wasm.wasmPaths = assetUrl("voice/ort/");
  runtime.env.wasm.numThreads = scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort = runtime;
  session = await runtime.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
  scope.postMessage({ type: "ready" });
}

function load(base: string): Promise<void> {
  assetBase = base;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Kitten TTS could not run.";
}

scope.onmessage = (event: MessageEvent<InMessage>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelBelow = Math.max(cancelBelow, message.below);
    return;
  }
  if (message.type === "load") {
    load(message.assetBase).catch((error: unknown) => scope.postMessage({ type: "error", message: errorText(error) }));
    return;
  }
  // Speak jobs run one at a time, in order, so sentences play back in sequence.
  const job: SpeakJob = { id: message.id, text: message.text, voice: message.voice, speed: message.speed };
  queue = queue
    .then(() => load(assetBase))
    .then(() => {
      if (job.id < cancelBelow) return;
      return synthesize(job);
    })
    .catch((error: unknown) => {
      scope.postMessage({ type: "error", id: job.id, message: errorText(error) });
    });
};
