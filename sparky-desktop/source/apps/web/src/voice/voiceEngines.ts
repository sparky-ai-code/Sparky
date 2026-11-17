export type VoiceStatusCallback = (message: string) => void;

type PendingSpeech = {
  id: number;
  sources: Set<AudioBufferSourceNode>;
  nextStart: number;
  done: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

function asError(message: unknown): Error {
  return new Error(typeof message === "string" ? message : "Voice engine failed.");
}

/**
 * The language model is not involved in audio generation: Tiny Voca synthesizes
 * completed assistant text locally, sentence by sentence, on a worker.
 */
export class TinyVocaSpeaker {
  private readonly worker = new Worker(new URL("./tinyVoca.worker.js", import.meta.url));
  private readonly context: AudioContext;
  private readonly onStatus: VoiceStatusCallback;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private ready = false;
  private nextId = 0;
  private active: PendingSpeech | null = null;
  private disposed = false;

  constructor(context: AudioContext, onStatus: VoiceStatusCallback) {
    this.context = context;
    this.onStatus = onStatus;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        type: string;
        id?: number;
        text?: string;
        message?: string;
        audio?: Float32Array;
        sampleRate?: number;
      };
      if (data.type === "status") {
        if (!this.disposed) this.onStatus(data.text || "Preparing Tiny Voca…");
        return;
      }
      if (data.type === "ready") {
        this.ready = true;
        this.resolveReady();
        return;
      }
      if (data.type === "error") {
        const error = asError(data.message);
        if (!this.ready) this.rejectReady(error);
        if (this.active && this.active.id === data.id) {
          const active = this.active;
          this.stop();
          active.reject(error);
        }
        return;
      }
      const active = this.active;
      if (!active || active.id !== data.id) return;
      if (data.type === "sentence" && data.audio && data.sampleRate) {
        const buffer = this.context.createBuffer(1, data.audio.length, data.sampleRate);
        buffer.getChannelData(0).set(data.audio);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        source.onended = () => {
          active.sources.delete(source);
          if (active.done && active.sources.size === 0 && this.active === active) {
            this.active = null;
            active.resolve();
          }
        };
        const at = Math.max(active.nextStart, this.context.currentTime + 0.05);
        active.nextStart = at + buffer.duration;
        active.sources.add(source);
        source.start(at);
      } else if (data.type === "done") {
        active.done = true;
        if (active.sources.size === 0) {
          this.active = null;
          active.resolve();
        }
      }
    };
    this.worker.onerror = () => {
      const error = new Error("Tiny Voca could not load. Check your internet connection.");
      if (!this.ready) this.rejectReady(error);
      const active = this.active;
      if (active) {
        this.stop();
        active.reject(error);
      }
    };
    this.worker.postMessage({ type: "load" });
  }

  load(): Promise<void> {
    return this.readyPromise;
  }

  async speak(text: string, voice: "F2" | "M2", speed: number): Promise<void> {
    await this.load();
    if (this.disposed) return;
    this.stop();
    return new Promise<void>((resolve, reject) => {
      const id = ++this.nextId;
      this.active = {
        id,
        sources: new Set(),
        nextStart: 0,
        done: false,
        resolve,
        reject,
      };
      this.worker.postMessage({ type: "speak", id, text, voice: voice === "F2" ? 0 : 1, speed });
    });
  }

  stop(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    for (const source of active.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    active.sources.clear();
    active.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.worker.terminate();
  }
}

/** Whisper is a local speech-to-text model; only its weights are downloaded. */
export class LocalSpeechTranscriber {
  private readonly worker = new Worker(new URL("./whisper.worker.js", import.meta.url), {
    type: "module",
  });
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private ready = false;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  private disposed = false;

  constructor(onStatus: VoiceStatusCallback) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; id?: number; text?: string; message?: string };
      if (data.type === "status") {
        if (!this.disposed) onStatus(data.text || "Preparing speech recognition…");
        return;
      }
      if (data.type === "ready") {
        this.ready = true;
        this.resolveReady();
        return;
      }
      if (data.type === "error") {
        const error = asError(data.message);
        if (!this.ready) this.rejectReady(error);
        if (data.id !== undefined) {
          this.pending.get(data.id)?.reject(error);
          this.pending.delete(data.id);
        }
        return;
      }
      if (data.type === "transcript" && data.id !== undefined) {
        this.pending.get(data.id)?.resolve(data.text || "");
        this.pending.delete(data.id);
      }
    };
    this.worker.onerror = () => {
      const error = new Error("Local speech recognition could not start.");
      if (!this.ready) this.rejectReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.worker.postMessage({ type: "load" });
  }

  load(): Promise<void> {
    return this.readyPromise;
  }

  async transcribe(samples: Float32Array): Promise<string> {
    await this.load();
    if (this.disposed) return "";
    const id = ++this.nextId;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "transcribe", id, audio: samples }, [samples.buffer]);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Call ended."));
    this.pending.clear();
  }
}

/** Decoder and OfflineAudioContext resample the local microphone recording to Whisper's 16 kHz mono PCM. */
export async function decodeRecordedSpeech(blob: Blob): Promise<Float32Array> {
  const decoder = new AudioContext();
  try {
    const input = await decoder.decodeAudioData(await blob.arrayBuffer());
    const targetLength = Math.max(1, Math.ceil(input.duration * 16_000));
    const offline = new OfflineAudioContext(1, targetLength, 16_000);
    const source = offline.createBufferSource();
    source.buffer = input;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    await decoder.close();
  }
}
