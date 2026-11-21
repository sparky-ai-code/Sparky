import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { KittenSpeaker } from "./kittenSpeaker";

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: Array<{ type: string; [key: string]: unknown }> = [];
  readonly postMessage = vi.fn((message: { type: string; [key: string]: unknown }) => {
    this.sent.push(message);
  });
  readonly terminate = vi.fn();

  emit(data: Record<string, unknown>) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

/** speak() waits for the model to load before posting, so let that continuation run. */
const ASSET_BASE = "https://app.test/";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("KittenSpeaker", () => {
  const workers: MockWorker[] = [];
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  let now = 10;
  const context = {
    get currentTime() {
      return now;
    },
    destination: {},
    createBuffer: (_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn(),
    }),
    createBufferSource: () => {
      const source = {
        buffer: null as unknown,
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
    now = 10;
    vi.stubGlobal(
      "Worker",
      class extends MockWorker {
        constructor() {
          super();
          workers.push(this);
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the selected voice and speed, and plays each returned chunk back to back", async () => {
    const speaker = new KittenSpeaker(context, ASSET_BASE);
    const worker = workers[0]!;
    expect(worker.sent[0]).toEqual({ type: "load", assetBase: ASSET_BASE });
    worker.emit({ type: "ready" });
    await speaker.load();

    const first = speaker.speak("First sentence.", "serena", 1.2);
    const second = speaker.speak("Second sentence.", "serena", 1.2);
    await flush();
    const speak = worker.sent.filter((message) => message.type === "speak");
    expect(speak[0]).toMatchObject({ voice: "serena", speed: 1.2, text: "First sentence." });
    expect(speak[1]).toMatchObject({ text: "Second sentence." });

    const idOne = speak[0]!.id as number;
    worker.emit({ type: "chunk", id: idOne, audio: new Float32Array(24_000), sampleRate: 24_000 });
    worker.emit({ type: "chunk", id: idOne, audio: new Float32Array(12_000), sampleRate: 24_000 });
    worker.emit({ type: "done", id: idOne });
    await first;
    expect(sources[0]!.start).toHaveBeenCalledWith(10.05);
    expect(sources[1]!.start).toHaveBeenCalledWith(11.05);
    expect(speaker.busy).toBe(true);

    worker.emit({ type: "done", id: speak[1]!.id as number });
    await second;
    sources.forEach((source) => source.onended?.());
    expect(speaker.busy).toBe(false);
  });

  it("stops playback and drops late audio for cancelled sentences (barge-in)", async () => {
    const speaker = new KittenSpeaker(context, ASSET_BASE);
    const worker = workers[0]!;
    worker.emit({ type: "ready" });
    await speaker.load();

    const pending = speaker.speak("Long answer.", "serena", 1);
    await flush();
    const id = worker.sent.find((message) => message.type === "speak")!.id as number;
    worker.emit({ type: "chunk", id, audio: new Float32Array(24_000), sampleRate: 24_000 });
    speaker.stop();
    expect(sources[0]!.stop).toHaveBeenCalled();
    expect(worker.sent.at(-1)).toEqual({ type: "cancel", below: id + 1 });
    await pending;

    worker.emit({ type: "chunk", id, audio: new Float32Array(24_000), sampleRate: 24_000 });
    expect(sources).toHaveLength(1);
    expect(speaker.busy).toBe(false);
  });

  it("reports worker errors for the sentence that failed", async () => {
    const speaker = new KittenSpeaker(context, ASSET_BASE);
    const worker = workers[0]!;
    worker.emit({ type: "ready" });
    await speaker.load();
    const failed = speaker.speak("Broken.", "serena", 1);
    await flush();
    const id = worker.sent.find((message) => message.type === "speak")!.id as number;
    worker.emit({ type: "error", id, message: "Kitten TTS voice is unavailable." });
    await expect(failed).rejects.toThrow("Kitten TTS voice is unavailable.");
  });
});
