/**
 * Main-thread side of Kitten TTS: sends sentences to the synthesis worker and plays
 * the returned audio back to back on the call's AudioContext.
 *
 * Sentences can be queued while earlier ones are still playing, so a reply is read
 * out as it streams. `stop()` cancels everything queued or playing (barge-in).
 */

interface PendingJob {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function toError(message: unknown): Error {
  return new Error(typeof message === "string" ? message : "Kitten TTS could not speak.");
}

export class KittenSpeaker {
  private readonly worker: Worker;
  private readonly context: AudioContext;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private isReady = false;
  private nextId = 0;
  private nextStart = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly jobs = new Map<number, PendingJob>();
  private disposed = false;

  /** `assetBase` is the absolute URL the app's voice files are served from. */
  constructor(context: AudioContext, assetBase: string) {
    this.context = context;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(new URL("./kittenTts.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent) => this.handle(event.data as WorkerMessage);
    this.worker.onerror = () => {
      const error = new Error("Kitten TTS could not start.");
      if (!this.isReady) this.rejectReady(error);
      this.failAll(error);
    };
    this.worker.postMessage({ type: "load", assetBase });
  }

  /** Resolves once the voice model and pronunciation data are loaded. */
  load(): Promise<void> {
    return this.readyPromise;
  }

  /** Whether any speech is queued or still playing. */
  get busy(): boolean {
    return this.jobs.size > 0 || this.sources.size > 0;
  }

  /**
   * Queue `text` to be spoken after everything already queued. Resolves when this text
   * has been synthesised; playback of its audio may still be running.
   */
  async speak(text: string, voice: string, speed: number): Promise<void> {
    await this.load();
    if (this.disposed || !text.trim()) return;
    const id = ++this.nextId;
    return new Promise<void>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ type: "speak", id, text, voice, speed });
    });
  }

  /** Stop playback and drop every queued sentence. */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.sources.clear();
    this.nextStart = 0;
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    if (!this.disposed) this.worker.postMessage({ type: "cancel", below: this.nextId + 1 });
    for (const job of jobs) job.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.worker.terminate();
  }

  private handle(message: WorkerMessage): void {
    if (this.disposed) return;
    if (message.type === "ready") {
      this.isReady = true;
      this.resolveReady();
      return;
    }
    if (message.type === "error") {
      const error = toError(message.message);
      if (!this.isReady) this.rejectReady(error);
      if (message.id !== undefined) this.jobs.get(message.id)?.reject(error);
      if (message.id !== undefined) this.jobs.delete(message.id);
      return;
    }
    if (message.type === "chunk") {
      // Audio for a job that was stopped or finished is late; drop it rather than play it.
      if (!this.jobs.has(message.id) || !message.audio || !message.sampleRate) return;
      this.schedule(message.audio, message.sampleRate);
      return;
    }
    if (message.type === "done") {
      const job = this.jobs.get(message.id);
      this.jobs.delete(message.id);
      job?.resolve();
    }
  }

  private schedule(samples: Float32Array<ArrayBuffer>, sampleRate: number): void {
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
    };
    const at = Math.max(this.nextStart, this.context.currentTime + 0.05);
    this.nextStart = at + buffer.duration;
    this.sources.add(source);
    source.start(at);
  }

  private failAll(error: Error): void {
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
  }
}

type WorkerMessage =
  | { type: "ready" }
  | { type: "chunk"; id: number; audio?: Float32Array<ArrayBuffer>; sampleRate?: number }
  | { type: "done"; id: number; skipped?: string[] }
  | { type: "error"; id?: number; message?: string };
