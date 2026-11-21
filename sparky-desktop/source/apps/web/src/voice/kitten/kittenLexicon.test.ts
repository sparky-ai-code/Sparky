import { describe, expect, it } from "vite-plus/test";
import reference from "./testdata/lexicon-misaki-reference.json" with { type: "json" };
import { applyStress, KittenLexicon, NO_CONTEXT } from "./kittenLexicon";
import { EnglishFrontend } from "./kittenFrontend";

const lexicon = new KittenLexicon(reference.dictionary);

describe("Kitten TTS lexicon", () => {
  it("matches misaki's Lexicon for dictionary words, plurals, past and -ing forms", () => {
    const mismatches: string[] = [];
    for (const [word, expected] of Object.entries(reference.cases)) {
      // Digit tokens go through number words, which the reference leaves to the caller.
      if (/\d/.test(word)) continue;
      const actual = lexicon.lookupToken(word, NO_CONTEXT);
      if (actual !== expected) mismatches.push(`${word}: ${String(actual)} != ${String(expected)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("applies stress like misaki's apply_stress", () => {
    expect(applyStress("kˈæt", null)).toBe("kˈæt");
    expect(applyStress("kˈæt", -2)).toBe("kæt");
    expect(applyStress("ˈæpəl", 0.5)).toBe("ˈæpəl");
  });

  it("reads the article 'a' as a schwa and the pronoun 'I' stressed", () => {
    expect(lexicon.lookupToken("a")).toBe("ɐ");
    expect(lexicon.lookupToken("I")).toBe("ˌI");
  });

  it("spells unknown all-caps acronyms with letter names", () => {
    expect(lexicon.lookupToken("USA")).toContain("ɛs");
  });
});

describe("Kitten TTS front end", () => {
  const frontend = new EnglishFrontend(
    new KittenLexicon({ hello: "həlˈO", world: "wˈɜɹld", apple: "ˈæpəl", cat: "kˈæt", quick: "kwˈɪk", brown: "bɹˈWn" }),
  );

  it("keeps punctuation and word spacing from the source text", () => {
    expect(frontend.phonemes("Hello, world.")).toBe("həlˈO, wˈɜɹld.");
  });

  it("chooses the article before a vowel from the following word", () => {
    expect(frontend.phonemes("the apple")).toBe("ði ˈæpəl");
    expect(frontend.phonemes("the cat")).toBe("ðə kˈæt");
  });

  it("reports words it cannot pronounce instead of guessing", () => {
    const skipped: string[] = [];
    frontend.phonemes("zzqxv hello", skipped);
    expect(skipped).toEqual(["zzqxv"]);
  });

  it("cuts long text into chunks of at most 350 phonemes at sentence ends", () => {
    const sentence = "Quick brown hello world apple cat. ";
    const chunks = frontend.phonemizeChunks(sentence.repeat(40));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(350);
  });
});
