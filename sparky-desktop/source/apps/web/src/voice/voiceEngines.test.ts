import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TinyVocaSpeaker } from "./voiceEngines";

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: Array<{ type: string; [key: string]: unknown }> = [];
  readonly postMessage = vi.fn((message: { type: string }) => {
    this.sent.push(message);
  });
  readonly terminate = vi.fn();

  emit(data: Record<string, unknown>) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe("Tiny Voca playback worker", () => {
  const workers: MockWorker[] = [];
  const sources: Array<{ onended: (() => void) | null; stop: ReturnType<typeof vi.fn> }> = [];
  const context = {
    currentTime: 2,
    createBuffer: (_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    },
  } as unknown as AudioContext;

  beforeEach(() => {
    workers.length = 0;
    sources.length = 0;
    vi.stubGlobal("Worker", class extends MockWorker {
      constructor() {
        super();
        workers.push(this);
      }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the selected voice and speed and resolves after the final PCM block finishes", async () => {
    const speaker = new TinyVocaSpeaker(context, () => {});
    const worker = workers[0]!;
    expect(worker.sent[0]?.type).toBe("load");
    worker.emit({ type: "ready" });
    const playback = speaker.speak("Hello", "M2", 1.2);
    await Promise.resolve();
    const message = worker.sent.find((item) => item.type === "speak");
    expect(message).toMatchObject({ voice: 1, speed: 1.2, text: "Hello" });
    const id = message!.id;
    worker.emit({ type: "sentence", id, audio: new Float32Array([0.5, -0.5]), sampleRate: 24_000 });
    worker.emit({ type: "done", id });
    expect(sources).toHaveLength(1);
    sources[0]!.onended?.();
    await playback;
    speaker.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels queued speech on interruption without replaying stale chunks", async () => {
    const speaker = new TinyVocaSpeaker(context, () => {});
    const worker = workers[0]!;
    worker.emit({ type: "ready" });
    const playback = speaker.speak("Interrupted", "F2", 1);
    await Promise.resolve();
    const id = worker.sent.find((item) => item.type === "speak")!.id;
    speaker.stop();
    worker.emit({ type: "sentence", id, audio: new Float32Array([1]), sampleRate: 24_000 });
    expect(sources).toHaveLength(0);
    expect(worker.sent).toContainEqual({ type: "cancel", id });
    await playback;
    speaker.dispose();
  });
});
