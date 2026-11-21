import { describe, expect, it } from "vite-plus/test";
import fixtures from "./testdata/numbers-and-normalization.json" with { type: "json" };
import { cardinal, ordinal, year } from "./kittenNumbers";
import { normalizeSpokenText } from "./kittenNormalize";

describe("Kitten TTS number words", () => {
  it("matches the Python num2words English output", () => {
    for (const [value, words] of Object.entries(fixtures.cardinal)) {
      expect(cardinal(Number(value)), value).toBe(words);
    }
  });

  it("matches ordinals", () => {
    for (const [value, words] of Object.entries(fixtures.ordinal)) {
      expect(ordinal(Number(value)), value).toBe(words);
    }
  });

  it("matches year readings", () => {
    for (const [value, words] of Object.entries(fixtures.year)) {
      expect(year(Number(value)), value).toBe(words);
    }
  });
});

describe("Kitten TTS text normalisation", () => {
  it("matches the Python tts_norm output", () => {
    for (const [input, expected] of Object.entries(fixtures.normalize)) {
      expect(normalizeSpokenText(input), input).toBe(expected);
    }
  });
});
