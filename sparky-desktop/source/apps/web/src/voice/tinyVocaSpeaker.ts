/**
 * Browser-only local TTS adapter for tiny-voca's ONNX/Pyodide worker.
 * AI reasoning and tool execution remain in the normal Sparky thread.
 */
export type TinyVocaChoice = "F2" | "M2";

type VoiceWorkerMessage =
  | { type: "status"; text: string }
  | { type: "ready"; voices: string[]; sampleRate: number }
  | { type: "sentence"; id: number; audio: Float32Array; sampleRate: number }
  | { type: "done"; id: number }
  | { type: "error"; id?: number; message: string };

interface ActiveSpeech {
  readonly id: number;
  readonly sources: Set<AudioBufferSourceNode>;
  resolve: () => void;
  reject: (error: Error) => void;
  done: boolean;
  nextTime: number;
}

export class TinyVocaSpeaker {
  private worker: Worker | null = null;
  private context: AudioContext | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private onLoaded: (() => void) | null = null;
  private onLoadFailed: ((error: Error) => void) | null = null;
  private speech: ActiveSpeech | null = null;
  private nextId = 0;
  private closed = false;

  constructor(private readonly onStatus: (message: string) => void) {}

  async load(): Promise<void> {
    if (this.closed) throw new Error("Voice call ended");
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = new Promise<void>((resolve, reject) => {
      this.onLoaded = resolve;
      this.onLoadFailed = reject;
      try {
        this.worker = new Worker(new URL("./tinyVoca.worker.js", import.meta.url), {
          type: "classic",
        });
        this.worker.onmessage = (event: MessageEvent<VoiceWorkerMessage>) => {
          this.handleMessage(event.data);
        };
        this.worker.onerror = (event) => {
          this.fail(new Error(event.message || "Could not start Tiny Voca"));
        };
        this.worker.postMessage({ type: "load" });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.loading;
  }

  private fail(error: Error): void {
    this.onLoadFailed?.(error);
    this.onLoadFailed = null;
    this.onLoaded = null;
    if (this.speech) {
      const current = this.speech;
      this.speech = null;
      current.reject(error);
    }
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    this.loaded = false;
  }

  private finishIfPlayed(): void {
    const current = this.speech;
    if (!current || !current.done || current.sources.size !== 0) return;
    this.speech = null;
    current.resolve();
  }

  private handleMessage(data: VoiceWorkerMessage): void {
    if (this.closed) return;
    if (data.type === "status") {
      if (!this.speech) this.onStatus(data.text);
      return;
    }
    if (data.type === "ready") {
      this.loaded = true;
      this.onLoaded?.();
      this.onLoaded = null;
      this.onLoadFailed = null;
      return;
    }
    if (data.type === "error") {
      const current = this.speech;
      if (current && data.id === current.id) {
        this.speech = null;
        for (const source of current.sources) {
          source.onended = null;
          try { source.stop(); } catch { /* already finished */ }
        }
        current.reject(new Error(data.message));
      } else if (!this.loaded) {
        this.fail(new Error(data.message));
      }
      return;
    }
    const current = this.speech;
    if (!current || current.id !== data.id) return;
    if (data.type === "done") {
      current.done = true;
      this.finishIfPlayed();
      return;
    }
    if (!this.context || data.audio.length === 0) return;
    try {
      const buffer = this.context.createBuffer(1, data.audio.length, data.sampleRate);
      buffer.getChannelData(0).set(data.audio);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      current.sources.add(source);
      source.onended = () => {
        current.sources.delete(source);
        this.finishIfPlayed();
      };
      const when = Math.max(current.nextTime, this.context.currentTime + 0.05);
      source.start(when);
      current.nextTime = when + data.audio.length / data.sampleRate;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async speak(text: string, choice: TinyVocaChoice, speed: number): Promise<void> {
    await this.load();
    if (this.closed) return;
    this.stop();
    const Context = window.AudioContext;
    if (!Context) throw new Error("Audio playback is unavailable");
    this.context ??= new Context();
    await this.context.resume();
    if (this.closed) return;
    const id = ++this.nextId;
    return new Promise<void>((resolve, reject) => {
      this.speech = {
        id,
        sources: new Set(),
        resolve,
        reject,
        done: false,
        nextTime: 0,
      };
      this.worker?.postMessage({
        type: "speak",
        id,
        text,
        voice: choice === "F2" ? 0 : 1,
        speed: Math.min(1.4, Math.max(0.7, speed)),
      });
    });
  }

  stop(): void {
    const current = this.speech;
    if (!current) return;
    this.speech = null;
    this.worker?.postMessage({ type: "cancel", id: current.id });
    for (const source of current.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
    }
    current.sources.clear();
    current.resolve();
  }

  close(): void {
    this.closed = true;
    this.stop();
    if (!this.loaded) this.onLoadFailed?.(new Error("Voice call ended"));
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    this.onLoaded = null;
    this.onLoadFailed = null;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }
}
