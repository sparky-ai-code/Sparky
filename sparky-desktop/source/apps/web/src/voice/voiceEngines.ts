function asError(message: unknown): Error {
  return new Error(typeof message === "string" ? message : "Speech recognition failed.");
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

  /** `assetBase` is the absolute URL the app's voice files are served from. */
  constructor(assetBase: string) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; id?: number; text?: string; message?: string };
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
    this.worker.postMessage({ type: "load", assetBase });
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
