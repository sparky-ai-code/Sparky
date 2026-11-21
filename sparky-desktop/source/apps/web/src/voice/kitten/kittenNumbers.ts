/**
 * English number words for Kitten TTS text normalisation.
 *
 * Mirrors the `num2words` English output that KittenTTS 2 was served with
 * (`to_cardinal`, `to_ordinal`, `to_year`), so spoken numbers match the
 * training front end. Covered by a differential test against the Python library.
 */

const ONES = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];
const MAX_SAFE_WORDS = 1e15;

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) {
    const words =
      rest < 20 ? ONES[rest]! : TENS[Math.floor(rest / 10)]! + (rest % 10 ? `-${ONES[rest % 10]}` : "");
    parts.push(hundreds ? `and ${words}` : words);
  }
  return parts.join(" ");
}

/** 0 -> "zero", 1234 -> "one thousand, two hundred and thirty-four". */
export function cardinal(value: number): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) >= MAX_SAFE_WORDS) return String(value);
  if (value < 0) return `minus ${cardinal(-value)}`;
  if (value === 0) return "zero";
  const groups: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  let text = "";
  for (let scale = groups.length - 1; scale >= 0; scale--) {
    const group = groups[scale]!;
    if (!group) continue;
    const words = belowThousand(group);
    const piece = SCALES[scale] ? `${words} ${SCALES[scale]}` : words;
    if (!text) {
      text = piece;
    } else if (scale === 0 && group < 100) {
      // "two thousand and five", "one million and one".
      text += ` and ${words}`;
    } else {
      text += `, ${piece}`;
    }
  }
  return text;
}

/** 21 -> "twenty-first", 100 -> "hundredth". */
export function ordinal(value: number): string {
  const words = cardinal(value);
  const match = /^(.*?)([a-z]+)$/.exec(words);
  if (!match) return words;
  const [, head, last] = match;
  const replacements: Record<string, string> = {
    one: "first",
    two: "second",
    three: "third",
    five: "fifth",
    eight: "eighth",
    nine: "ninth",
    twelve: "twelfth",
  };
  const ordinalLast = replacements[last!] ?? (last!.endsWith("y") ? `${last!.slice(0, -1)}ieth` : `${last}th`);
  return `${head}${ordinalLast}`;
}

/** Years 1100-2099 read as pairs: 1999 -> "nineteen ninety-nine", 2026 -> "twenty twenty-six". */
export function year(value: number): string {
  if (value < 0) return cardinal(value);
  const high = Math.floor(value / 100);
  const low = value % 100;
  if (high === 0 || (high % 10 === 0 && low < 10) || high >= 100) return cardinal(value);
  const highText = cardinal(high);
  const lowText = low === 0 ? "hundred" : low < 10 ? `oh-${cardinal(low)}` : cardinal(low);
  return `${highText} ${lowText}`;
}
