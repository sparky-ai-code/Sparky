/**
 * English word-to-phoneme lookup for Kitten TTS, ported from misaki's `en.Lexicon`
 * (Apache-2.0, https://github.com/hexgrad/misaki). The dictionary is the CMUdict
 * lexicon that KittenTTS ships in its model repository (`g2p/cmu_misaki_us.json`),
 * already written in misaki's phoneme alphabet.
 *
 * Deliberate differences from misaki with spaCy part-of-speech tags:
 * - No tagger runs here, so homographs use their most common reading: a lowercase
 *   "a" is the article, "in" is unstressed, "I" is the pronoun.
 * - Acronyms are spelled with letter names, since the lexicon has no single-letter
 *   entries. Words the lexicon lacks are skipped and reported, not guessed.
 */

export interface TokenContext {
  /** Whether the next token starts with a vowel: true, false, or unknown. */
  readonly futureVowel: boolean | null;
  readonly futureTo: boolean;
}

export const NO_CONTEXT: TokenContext = { futureVowel: null, futureTo: false };

const PRIMARY_STRESS = "ˈ";
const SECONDARY_STRESS = "ˌ";
const VOWELS = new Set([..."AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ"]);
const CONSONANTS = new Set([..."bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ"]);
const US_TAUS = new Set([..."AIOWYiuæɑəɛɪɹʊʌ"]);
const SYMBOLS = new Set(["%", "&", "+", "@"]);

/** Spelled-out letter names for acronyms (misaki's gold dictionary has no single-letter entries). */
const LETTER_NAMES: Record<string, string> = {
  A: "ˈA", B: "bˈi", C: "sˈi", D: "dˈi", E: "ˈi", F: "ɛf", G: "ʤˈi", H: "ˈAʧ",
  I: "ˈI", J: "ʤˈA", K: "kˈA", L: "ɛl", M: "ɛm", N: "ɛn", O: "ˈO", P: "pˈi",
  Q: "kjˈu", R: "ɑɹ", S: "ɛs", T: "tˈi", U: "jˈu", V: "vˈi", W: "dˈʌbəlju",
  X: "ɛks", Y: "wˈI", Z: "zˈi",
};

const ASCII_LETTERS = /^[A-Za-z]+$/;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/** Build the dictionary: add capitalised forms of lowercase entries, as misaki does. */
export function growDictionary(entries: Record<string, string>): Map<string, string> {
  const grown = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) {
    if (key.length < 2) continue;
    if (key === key.toLowerCase()) {
      if (key !== capitalize(key)) grown.set(capitalize(key), value);
    } else if (key === key.toLowerCase().charAt(0).toUpperCase() + key.toLowerCase().slice(1)) {
      grown.set(key.toLowerCase(), value);
    }
  }
  for (const [key, value] of Object.entries(entries)) grown.set(key, value);
  return grown;
}

/** misaki's `apply_stress`: move, add or drop primary (ˈ) and secondary (ˌ) stress marks. */
export function applyStress(ps: string, stress: number | null): string {
  if (stress === null) return ps;
  const hasStress = (text: string) => text.includes(PRIMARY_STRESS) || text.includes(SECONDARY_STRESS);
  if (stress < -1) return ps.replaceAll(PRIMARY_STRESS, "").replaceAll(SECONDARY_STRESS, "");
  if (stress === -1 || ((stress === 0 || stress === -0.5) && ps.includes(PRIMARY_STRESS))) {
    return ps.replaceAll(SECONDARY_STRESS, "").replaceAll(PRIMARY_STRESS, SECONDARY_STRESS);
  }
  if ((stress === 0 || stress === 0.5 || stress === 1) && !hasStress(ps)) {
    return restress(SECONDARY_STRESS + ps);
  }
  if (stress >= 1 && !ps.includes(PRIMARY_STRESS) && ps.includes(SECONDARY_STRESS)) {
    return ps.replaceAll(SECONDARY_STRESS, PRIMARY_STRESS);
  }
  if (stress > 1 && !hasStress(ps)) return restress(PRIMARY_STRESS + ps);
  return ps;
}

/** Place each stress mark directly before the vowel it applies to. */
function restress(ps: string): string {
  const chars = [...ps];
  if (!chars.some((char) => VOWELS.has(char))) return ps;
  const positioned: Array<{ position: number; char: string }> = chars.map((char, index) => ({
    position: index,
    char,
  }));
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char !== PRIMARY_STRESS && char !== SECONDARY_STRESS) continue;
    const vowelIndex = chars.findIndex((candidate, j) => j >= i && VOWELS.has(candidate));
    if (vowelIndex >= 0) positioned[i]!.position = vowelIndex - 0.5;
  }
  return positioned
    .sort((a, b) => a.position - b.position || (a.char < b.char ? -1 : a.char > b.char ? 1 : 0))
    .map((entry) => entry.char)
    .join("");
}

function pluralEnding(stem: string): string | null {
  if (!stem) return null;
  const last = stem.charAt(stem.length - 1);
  if ("ptkfθ".includes(last)) return `${stem}s`;
  if ("szʃʒʧʤ".includes(last)) return `${stem}ᵻz`;
  return `${stem}z`;
}

function pastEnding(stem: string): string | null {
  if (!stem) return null;
  const last = stem.charAt(stem.length - 1);
  if ("pkfθʃsʧ".includes(last)) return `${stem}t`;
  if (last === "d") return `${stem}ᵻd`;
  if (last !== "t") return `${stem}d`;
  if (stem.length < 2) return `${stem}ɪd`;
  if (US_TAUS.has(stem.charAt(stem.length - 2))) return `${stem.slice(0, -1)}ɾᵻd`;
  return `${stem}ᵻd`;
}

function ingEnding(stem: string): string | null {
  if (!stem) return null;
  if (stem.length > 1 && stem.endsWith("t") && US_TAUS.has(stem.charAt(stem.length - 2))) {
    return `${stem.slice(0, -1)}ɾɪŋ`;
  }
  return `${stem}ɪŋ`;
}

export class KittenLexicon {
  private readonly dictionary: Map<string, string>;

  constructor(entries: Record<string, string>) {
    this.dictionary = growDictionary(entries);
  }

  get size(): number {
    return this.dictionary.size;
  }

  /** Phonemes of one token (already NFKC-normalised), or null when nothing in the lexicon fits. */
  lookupToken(text: string, context: TokenContext = NO_CONTEXT): string | null {
    let word = text.replace(/[‘’]/g, "'");
    word = word.normalize("NFKC");
    if (!word) return null;
    const stress = word === word.toLowerCase() ? null : word === word.toUpperCase() ? 2 : 0.5;
    const ps = this.getWord(word, stress, context);
    if (ps !== null) return ps;
    if (/^\d[\d,]*$/.test(word)) return this.getNumber(word);
    return null;
  }

  private getWord(word: string, stress: number | null, context: TokenContext): string | null {
    const special = this.getSpecialCase(word, stress, context);
    if (special !== null) return special;
    const lower = word.toLowerCase();
    const stripped = word.replaceAll("'", "");
    if (
      word.length > 1 &&
      /^\p{L}+$/u.test(stripped) &&
      word !== lower &&
      !this.dictionary.has(word) &&
      (word === word.toUpperCase() || word.slice(1) === word.slice(1).toLowerCase()) &&
      (this.dictionary.has(lower) ||
        this.stemS(lower, stress) !== null ||
        this.stemEd(lower, stress) !== null ||
        this.stemIng(lower, stress) !== null)
    ) {
      word = lower;
    }
    if (this.isKnown(word)) return this.lookup(word, stress);
    if (word.endsWith("s'") && this.isKnown(`${word.slice(0, -2)}'s`)) {
      return this.lookup(`${word.slice(0, -2)}'s`, stress);
    }
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1))) return this.lookup(word.slice(0, -1), stress);
    return (
      this.stemS(word, stress) ??
      this.stemEd(word, stress) ??
      this.stemIng(word, stress === null ? 0.5 : stress)
    );
  }

  private getSpecialCase(word: string, stress: number | null, context: TokenContext): string | null {
    if (SYMBOLS.has(word)) return null;
    if (word.includes(".") && /^[A-Za-z.]+$/.test(word)) {
      const longest = Math.max(...word.split(".").map((part) => part.length));
      if (word.replaceAll(".", "").length && longest < 3) return this.getNNP(word);
    }
    switch (word) {
      case "a":
        return "ɐ";
      case "A":
        return "ˈA";
      case "am":
        return context.futureVowel === null || (stress !== null && stress > 0)
          ? this.dictionary.get("am") ?? null
          : "ɐm";
      case "an":
      case "An":
        return "ɐn";
      case "I":
        return `${SECONDARY_STRESS}I`;
      case "to":
      case "To":
        return context.futureVowel === true ? "tʊ" : "tə";
      case "in":
      case "In":
        return "ɪn";
      case "the":
      case "The":
        return context.futureVowel === true ? "ði" : "ðə";
      default:
        return null;
    }
  }

  private getNNP(word: string): string | null {
    const parts: string[] = [];
    for (const char of word) {
      if (!/\p{L}/u.test(char)) continue;
      const name = LETTER_NAMES[char.toUpperCase()];
      if (name === undefined) return null;
      parts.push(name);
    }
    const spelled = applyStress(parts.join(""), 0);
    const cut = spelled.lastIndexOf(SECONDARY_STRESS);
    if (cut < 0) return spelled;
    return `${spelled.slice(0, cut)}${PRIMARY_STRESS}${spelled.slice(cut + 1)}`;
  }

  private isKnown(word: string): boolean {
    if (this.dictionary.has(word) || SYMBOLS.has(word)) return true;
    if (!ASCII_LETTERS.test(word)) return false;
    if (word.length === 1) return true;
    if (word === word.toUpperCase() && this.dictionary.has(word.toLowerCase())) return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  }

  private lookup(word: string, stress: number | null): string | null {
    let key = word;
    if (word === word.toUpperCase() && !this.dictionary.has(word)) key = word.toLowerCase();
    const ps = this.dictionary.get(key);
    if (ps === undefined) return this.getNNP(key);
    return applyStress(ps, stress);
  }

  private stemS(word: string, stress: number | null): string | null {
    if (word.length < 3 || !word.endsWith("s")) return null;
    let stem: string;
    if (!word.endsWith("ss") && this.isKnown(word.slice(0, -1))) {
      stem = word.slice(0, -1);
    } else if (
      (word.endsWith("'s") || (word.length > 4 && word.endsWith("es") && !word.endsWith("ies"))) &&
      this.isKnown(word.slice(0, -2))
    ) {
      stem = word.slice(0, -2);
    } else if (word.length > 4 && word.endsWith("ies") && this.isKnown(`${word.slice(0, -3)}y`)) {
      stem = `${word.slice(0, -3)}y`;
    } else {
      return null;
    }
    const base = this.lookup(stem, stress);
    return base === null ? null : pluralEnding(base);
  }

  private stemEd(word: string, stress: number | null): string | null {
    if (word.length < 4 || !word.endsWith("d")) return null;
    let stem: string;
    if (!word.endsWith("dd") && this.isKnown(word.slice(0, -1))) {
      stem = word.slice(0, -1);
    } else if (word.length > 4 && word.endsWith("ed") && !word.endsWith("eed") && this.isKnown(word.slice(0, -2))) {
      stem = word.slice(0, -2);
    } else {
      return null;
    }
    const base = this.lookup(stem, stress);
    return base === null ? null : pastEnding(base);
  }

  private stemIng(word: string, stress: number | null): string | null {
    if (word.length < 5 || !word.endsWith("ing")) return null;
    let stem: string;
    if (word.length > 5 && this.isKnown(word.slice(0, -3))) {
      stem = word.slice(0, -3);
    } else if (this.isKnown(`${word.slice(0, -3)}e`)) {
      stem = `${word.slice(0, -3)}e`;
    } else if (word.length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(word) && this.isKnown(word.slice(0, -4))) {
      stem = word.slice(0, -4);
    } else {
      return null;
    }
    const base = this.lookup(stem, stress);
    return base === null ? null : ingEnding(base);
  }

  /** Spoken integers such as "2026": cardinal words, each looked up. */
  private getNumber(word: string): string | null {
    const value = Number(word.replaceAll(",", ""));
    if (!Number.isSafeInteger(value)) return null;
    const pieces: string[] = [];
    for (const piece of numberWords(value)) {
      const ps = this.lookupToken(piece);
      if (ps === null) return null;
      pieces.push(ps);
    }
    return pieces.join(" ");
  }
}

/** Simple cardinal words for digit tokens that survived text normalisation. */
function numberWords(value: number): string[] {
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (value < 20) return [ones[value]!];
  if (value < 100) {
    const rest = value % 10;
    return rest ? [tens[Math.floor(value / 10)]!, ones[rest]!] : [tens[Math.floor(value / 10)]!];
  }
  if (value < 1000) {
    const rest = value % 100;
    const head = [ones[Math.floor(value / 100)]!, "hundred"];
    return rest ? [...head, ...numberWords(rest)] : head;
  }
  const thousand = Math.floor(value / 1000);
  const rest = value % 1000;
  return [...numberWords(thousand), "thousand", ...(rest ? numberWords(rest) : [])];
}
