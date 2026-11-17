import { describe, expect, it } from "vite-plus/test";
import {
  audioRms,
  joinAudioChunks,
  toWhisperSampleRate,
} from "./voiceCapture";

describe("local microphone audio", () => {
  it("treats silence as no speech", () => {
    expect(audioRms(new Float32Array(100))).toBe(0);
    expect(audioRms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
  it("converts microphone samples to Whisper's expected 16kHz", () => {
    const input = new Float32Array(48_000);
    input.fill(0.25);
    const output = toWhisperSampleRate(input, 48_000);
    expect(output.length).toBe(16_000);
    expect(output[100]).toBeCloseTo(0.25);
    expect(toWhisperSampleRate(output, 16_000)).toBe(output);
    expect(() => toWhisperSampleRate(input, 0)).toThrow();
  });
  it("joins audio slices without gaps", () => {
    expect([...joinAudioChunks([new Float32Array([1, 2]), new Float32Array([3])])])
      .toEqual([1, 2, 3]);
  });
});
