/**
 * Text to phoneme chunks for English Kitten TTS (nano / mini, phonemizer v1).
 *
 * Mirrors `frontend/english.py` of the KittenTTS training code: spoken-form
 * normalisation, then the word lexicon, then the model's phoneme vocabulary.
 * Tokens are resolved right to left, so "the" and "a" see the sound that follows.
 * Long text is cut at sentence ends into chunks of at most MAX_PHONEMES.
 */
import { KittenLexicon, NO_CONTEXT, type TokenContext } from "./kittenLexicon";
import { normalizeSpokenText } from "./kittenNormalize";

export const MAX_PHONEMES = 350;

const VOWEL_CHARS = new Set([..."AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ"]);
const CONSONANT_CHARS = new Set([..."bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ"]);
const NON_QUOTE_PUNCTUATION = new Set([";", ":", ",", ".", "!", "?", "—", "…"]);
const PUNCTUATION_PHONEMES = new Set([...'";:,.!?—…()“”']);
// Splits the text into single-sentence pieces, as the training front end does.
const SENTENCE_BREAK = /(?<=[.!?…।])\s+|(?<=[。！？])/;
// Words, digit runs, or any other single character; the whitespace after each is kept.
const TOKEN = /\p{L}+(?:['’-]\p{L}+)*|\d+(?:[.,]\d+)*|\S/gu;

export interface Token {
  readonly text: string;
  readonly spaceAfter: boolean;
}

/** One source token, as the text chunks are split on. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const end = (match.index ?? 0) + match[0].length;
    tokens.push({ text: match[0], spaceAfter: /^\s/.test(text.slice(end)) });
  }
  return tokens;
}

function contextFor(previous: TokenContext, phonemes: string): TokenContext {
  let futureVowel: boolean | null = previous.futureVowel;
  for (const char of phonemes) {
    if (NON_QUOTE_PUNCTUATION.has(char)) {
      futureVowel = null;
      break;
    }
    if (VOWEL_CHARS.has(char)) {
      futureVowel = true;
      break;
    }
    if (CONSONANT_CHARS.has(char)) {
      futureVowel = false;
      break;
    }
  }
  return { futureVowel, futureTo: false };
}

export interface PhonemizedText {
  /** Phoneme strings, one per chunk the model synthesises separately. */
  readonly chunks: string[];
  /** Words the lexicon could not pronounce. */
  readonly skipped: string[];
}

export class EnglishFrontend {
  constructor(private readonly lexicon: KittenLexicon) {}

  /** Phonemes of one piece of text (already spoken-form normalised). */
  phonemes(text: string, skipped: string[] = []): string {
    const tokens = tokenize(text);
    const pieces: string[] = new Array<string>(tokens.length).fill("");
    let context: TokenContext = NO_CONTEXT;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i]!;
      let ps: string | null = null;
      if (PUNCTUATION_PHONEMES.has(token.text) || /^[.,!?;:—…]+$/.test(token.text)) {
        ps = token.text;
      } else if (/\p{L}|\d/u.test(token.text)) {
        ps = this.wordPhonemes(token.text, context);
        if (ps === null) skipped.push(token.text);
      }
      const space = token.spaceAfter ? " " : "";
      if (ps === null) {
        pieces[i] = space;
        continue;
      }
      pieces[i] = ps + space;
      context = contextFor(context, ps);
    }
    return pieces.join("").replace(/ɾ/g, "T").replace(/ʔ/g, "t").trim();
  }

  /** A word, or a hyphenated word read as its parts. */
  private wordPhonemes(text: string, context: TokenContext): string | null {
    const folded = text.normalize("NFKD").replace(/\p{M}/gu, "");
    const direct = this.lexicon.lookupToken(folded, context);
    if (direct !== null) return direct;
    if (folded.includes("-")) {
      const parts = folded.split("-").filter(Boolean).map((part) => this.lexicon.lookupToken(part, context));
      if (parts.every((part) => part !== null)) return parts.join(" ");
    }
    return null;
  }

  /** Split long text into chunks of at most MAX_PHONEMES phonemes, at sentence ends where possible. */
  phonemizeChunks(input: string, skipped: string[] = []): string[] {
    const text = normalizeSpokenText(input);
    if (!text) return [];
    const whole = this.phonemes(text, skipped);
    if (whole.length <= MAX_PHONEMES) return whole ? [whole] : [];
    const chunks: string[] = [];
    let current = "";
    for (const sentence of text.split(SENTENCE_BREAK)) {
      if (!sentence.trim()) continue;
      for (const piece of wrap(this.phonemes(sentence, skipped))) {
        if (current && current.length + 1 + piece.length > MAX_PHONEMES) {
          chunks.push(current);
          current = piece;
        } else {
          current = `${current} ${piece}`.trim();
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }
}

/** Cut one over-long phoneme string at spaces. */
function wrap(phonemes: string): string[] {
  const pieces: string[] = [];
  let rest = phonemes;
  while (rest.length > MAX_PHONEMES) {
    let cut = rest.lastIndexOf(" ", MAX_PHONEMES);
    if (cut <= 0) cut = MAX_PHONEMES;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
