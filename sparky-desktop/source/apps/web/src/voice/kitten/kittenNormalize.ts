/**
 * Spoken-form text normalisation before phonemisation, ported from the KittenTTS
 * training front end (`kittenml/kittentts2_tiny/frontend/tts_norm.py`, Apache-2.0).
 *
 * Expands numbers, money, dates, times, units and common abbreviations into words.
 * Sentence punctuation (. , ! ? ;) and dashes are kept: the model uses them for
 * prosody. A differential test checks the output against the Python original.
 */
import { cardinal, ordinal, year as yearWords } from "./kittenNumbers";

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];

const UNITS: Record<string, string> = {
  km: "kilometres", mi: "miles", cm: "centimetres", mm: "millimetres",
  kg: "kilograms", lb: "pounds", lbs: "pounds", oz: "ounces",
  ml: "millilitres", l: "litres", ft: "feet", in: "inches",
  hr: "hours", hrs: "hours", min: "minutes", mins: "minutes",
  sec: "seconds", secs: "seconds", ms: "milliseconds",
  gb: "gigabytes", mb: "megabytes", kb: "kilobytes", tb: "terabytes",
  hz: "hertz", khz: "kilohertz", mhz: "megahertz", ghz: "gigahertz",
  kw: "kilowatts", mph: "miles per hour", kph: "kilometres per hour",
};
const MAG: Record<string, string> = { k: "thousand", m: "million", b: "billion", t: "trillion" };
const FRACTIONS: Record<string, string> = {
  "1/2": "a half", "1/3": "a third", "2/3": "two thirds",
  "1/4": "a quarter", "3/4": "three quarters", "1/8": "an eighth",
};
const ABBREV: Record<string, string> = {
  mr: "Mister", mrs: "Missus", ms: "Miss", dr: "Doctor",
  prof: "Professor", rev: "Reverend", hon: "Honourable",
  ext: "extension", approx: "approximately", vs: "versus",
  est: "estimated", dept: "department", univ: "university",
  fig: "figure", eq: "equation", ref: "reference", vol: "volume",
  incl: "including", excl: "excluding", min: "minimum",
  max: "maximum", avg: "average", mt: "mount", ft: "fort",
  appt: "appointment", pp: "pages", jr: "Junior", sr: "Senior",
  inc: "Incorporated", ltd: "Limited", corp: "Corporation",
  mins: "minutes", hrs: "hours", wks: "weeks", yrs: "years",
};
const DAYS: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Tues: "Tuesday",
  Wed: "Wednesday", Weds: "Wednesday", Thu: "Thursday",
  Thur: "Thursday", Thurs: "Thursday", Fri: "Friday",
  Sat: "Saturday", Sun: "Sunday",
};
const MONTHS_ABBR: Record<string, string> = {
  Jan: "January", Feb: "February", Mar: "March",
  Apr: "April", Jun: "June", Jul: "July", Aug: "August",
  Sep: "September", Sept: "September", Oct: "October",
  Nov: "November", Dec: "December",
};
const SYMBOLS: Record<string, string> = {
  "%": " percent ", "&": " and ", "@": " at ", "+": " plus ",
  "=": " equals ", "×": " times ", "÷": " divided by ",
  "<": " less than ", ">": " greater than ", "~": " about ",
  "°": " degrees ", "€": " euros ", "£": " pounds ", "¥": " yen ",
  "©": " copyright ", "™": " trademark ", "§": " section ",
};
const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7,
  viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};
const ROMAN_CTX =
  "(?:chapter|section|part|volume|book|act|phase|appendix|world war|type|class|figure|table|step|stage)";

type Render = (match: RegExpExecArray, text: string) => string;

/** Replace every match of `pattern` using `render`, which sees the groups and the full text. */
function subAll(text: string, pattern: RegExp, render: Render): string {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out += text.slice(last, m.index) + render(m, text);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + text.slice(last);
}

function isUpper(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

function card(n: number): string {
  return cardinal(n);
}

function yearText(y: number): string {
  if ((y >= 1100 && y <= 1999) || (y >= 2000 && y <= 2099)) return yearWords(y);
  return card(y);
}

function digitWords(digits: string): string {
  return digits.split("").map((d) => card(Number(d))).join(" ");
}

function dates(input: string): string {
  let s = subAll(input, /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return m[0];
    return `${MONTHS[mo - 1]} ${ordinal(d)}, ${yearText(y)}`;
  });
  s = subAll(s, /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let y = Number(m[3]);
    if (!(a >= 1 && a <= 12 && b >= 1 && b <= 31)) return m[0];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${MONTHS[a - 1]} ${ordinal(b)}, ${yearText(y)}`;
  });
  return subAll(s, new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i"), (m) => {
    return `${m[1]} ${ordinal(Number(m[2]))}, ${yearText(Number(m[3]))}`;
  });
}

/** The am/pm group swallows a sentence-final period; put it back when the match ended the sentence. */
function keepFinalDot(match: RegExpExecArray, text: string, spoken: string): string {
  if (!match[0].endsWith(".")) return spoken;
  const rest = text.slice(match.index + match[0].length);
  const trimmed = rest.trim();
  if (trimmed === "" || (/^\s/.test(rest) && isUpper(trimmed.charAt(0)))) return `${spoken}.`;
  return spoken;
}

function times(input: string): string {
  return subAll(input, /\b(\d{1,2}):(\d{2})(?:\s*([ap]\.?m\.?))?/i, (m, text) => {
    let h = Number(m[1]);
    const mi = Number(m[2]);
    const ampm = (m[3] ?? "").toLowerCase();
    if (h > 23 || mi > 59) return m[0];
    let suffix = "";
    if (ampm) {
      suffix = ampm.startsWith("a") ? " AM" : " PM";
    } else if (h === 0) {
      h = 12;
      suffix = " AM";
    }
    let spoken: string;
    if (mi === 0) {
      spoken = !suffix ? `${card(h)} o'clock` : card(h <= 12 ? h : h - 12);
    } else if (mi < 10) {
      spoken = `${card(h <= 12 || !suffix ? h : h - 12)} oh ${card(mi)}`;
    } else {
      spoken = `${card(h <= 12 || !suffix ? h : h - 12)} ${card(mi)}`;
    }
    return keepFinalDot(m, text, spoken + suffix);
  });
}

function bareHour(input: string): string {
  return subAll(input, /\b(\d{1,2})\s*([ap])\.?m\.?(?![a-z])/i, (m, text) => {
    const h = Number(m[1]);
    if (!(h >= 1 && h <= 12)) return m[0];
    const meridiem = (m[2] ?? "").toLowerCase() === "a" ? "AM" : "PM";
    return keepFinalDot(m, text, `${card(h)} ${meridiem}`);
  });
}

function phones(input: string): string {
  return subAll(
    input,
    /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]?\d{0,4}\b/,
    (m) => {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 11) return m[0];
      const groups: string[] = [];
      let i = 0;
      if (digits.length === 11 && digits[0] === "1") {
        groups.push("one");
        i = 1;
      }
      for (const [a, b] of [[i, i + 3], [i + 3, i + 6], [i + 6, digits.length]] as const) {
        if (a < digits.length) groups.push(digitWords(digits.slice(a, b)));
      }
      return groups.filter(Boolean).join(", ");
    },
  );
}

function money(input: string): string {
  return subAll(input, /\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?([KkMmBbTt])\b)?/, (m) => {
    const amt = (m[1] ?? "").replace(/,/g, "");
    const suffix = (m[2] ?? "").toLowerCase();
    if (suffix) {
      const num = amt.includes(".") ? Number.parseFloat(amt) : Number.parseInt(amt, 10);
      const whole = Number.isInteger(num)
        ? card(Math.trunc(num))
        : `${card(Math.trunc(num))} point ${digitWords(amt.split(".")[1] ?? "")}`;
      return `${whole} ${MAG[suffix]} dollars`;
    }
    if (amt.includes(".")) {
      const [whole, cents0] = amt.split(".", 2) as [string, string];
      const dollarCount = Number(whole);
      const centCount = Number(`${cents0}00`.slice(0, 2));
      const dollars = `${card(dollarCount)} dollar${dollarCount === 1 ? "" : "s"}`;
      if (centCount) return `${dollars} and ${card(centCount)} cent${centCount === 1 ? "" : "s"}`;
      return dollars;
    }
    const dollarCount = Number(amt);
    return `${card(dollarCount)} dollar${dollarCount === 1 ? "" : "s"}`;
  });
}

function decimal(token: string): string {
  const tok = token.replace(/,/g, "");
  if (!/\d/.test(tok)) return tok;
  const dot = tok.indexOf(".");
  if (dot >= 0) {
    const whole = tok.slice(0, dot);
    return `${card(Number(whole || "0"))} point ${digitWords(tok.slice(dot + 1))}`;
  }
  return card(Number(tok));
}

function magnitudes(input: string): string {
  return subAll(input, /\b(\d[\d,]*(?:\.\d+)?)\s*([KMBT])\b/, (m) => {
    return `${decimal(m[1] ?? "")} ${MAG[(m[2] ?? "").toLowerCase()]}`;
  });
}

function fractions(input: string): string {
  return subAll(input, /\b(\d{1,3})\/(\d{1,3})\b/, (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const key = `${a}/${b}`;
    if (key in FRACTIONS) return FRACTIONS[key]!;
    if (b === 0) return m[0];
    return `${card(a)} ${ordinal(b)}${a !== 1 ? "s" : ""}`;
  });
}

function versions(input: string): string {
  return subAll(input, /\b(\d+)\.(\d+)\.(\d+)\b/, (m) => {
    return [m[1], m[2], m[3]].map((g) => card(Number(g))).join(" point ");
  });
}

function units(input: string): string {
  const names = Object.keys(UNITS).sort((a, b) => b.length - a.length);
  let s = subAll(
    input,
    new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${names.join("|")})\\b`, "i"),
    (m) => {
      const n = m[1] ?? "";
      const unit = (m[2] ?? "").toLowerCase();
      let word = UNITS[unit]!;
      if (n.replace(/,/g, "") === "1" || n.replace(/,/g, "") === "1.0") {
        word = word.endsWith("s") ? word.slice(0, -1) : word;
      }
      return `${decimal(n)} ${word}`;
    },
  );
  s = subAll(s, /([-−]?[\d.]+)\s?°\s?([CF])\b/, (m) => {
    const raw = m[1] ?? "";
    const negative = raw.startsWith("-") || raw.startsWith("−");
    const value = decimal(negative ? raw.slice(1) : raw);
    const scale = m[2] === "C" ? "Celsius" : "Fahrenheit";
    return `${negative ? "minus " : ""}${value} degrees ${scale}`;
  });
  return s;
}

function abbreviations(input: string): string {
  let s = input.replace(/\bSt\.\s+(?=[A-Z])/g, "Saint ");
  s = s.replace(/\bSt\.(?=\s*$)/g, "Street.");
  s = s.replace(/\bSt\.(?=\s*["')])/g, "Street.");
  s = s.replace(/\bSt\.(?!\s+[A-Z])/g, "Street");
  s = s.replace(/\bAve\./g, "Avenue");
  s = s.replace(/\bRd\./g, "Road");
  s = s.replace(/\bBlvd\./g, "Boulevard");
  s = s.replace(/\bNo\.\s*(?=\d)/g, "number ");
  s = s.replace(/\bNos\.\s*(?=\d)/g, "numbers ");
  // Case-sensitive: "Mon." is a day, "mon." is not.
  for (const [key, value] of Object.entries({ ...DAYS, ...MONTHS_ABBR })) {
    s = s.replace(new RegExp(`\\b${key}\\.`, "g"), value);
  }
  for (const [key, value] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${key}\\.`, "gi"), value);
  }
  return s;
}

function romans(input: string): string {
  return subAll(input, new RegExp(`\\b(${ROMAN_CTX})\\s+([IVX]{1,4})\\b`, "i"), (m) => {
    const value = ROMAN[(m[2] ?? "").toLowerCase()];
    return value === undefined ? m[0] : `${m[1]} ${card(value)}`;
  });
}

function ordinals(input: string): string {
  return subAll(input, /\b(\d+)(?:st|nd|rd|th)\b/i, (m) => ordinal(Number(m[1])));
}

function ranges(input: string): string {
  return subAll(input, /\b(\d+)\s?[-–—]\s?(\d+)\b/, (m) => `${card(Number(m[1]))} to ${card(Number(m[2]))}`);
}

function numbers(input: string): string {
  const s = input.replace(/(?<![\w.])[-−](\d)/g, "minus $1");
  return subAll(s, /\b\d[\d,]*(?:\.\d+)?\b/, (m) => {
    const token = m[0];
    // A bare four-digit integer is usually a year; "1,234" is a cardinal.
    if (!token.includes(",") && /^\d{4}$/.test(token)) {
      const value = Number(token);
      if (value >= 1100 && value <= 2099) return yearText(value);
    }
    return decimal(token);
  });
}

/** Expand `text` to its spoken form. */
export function normalizeSpokenText(text: string): string {
  let s = text
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, " - ")
    .replace(/–/g, "-")
    .replace(/…/g, "...");
  s = s.replace(/https?:\/\/\S+|www\.\S+/g, " link ");
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, " email address ");
  s = s.replace(/\be\.\s?g\./gi, "for example,");
  s = s.replace(/\bi\.\s?e\./gi, "that is,");
  s = s.replace(/\betc\./gi, "etcetera");
  s = s.replace(/\bvs\.?\b/gi, "versus");
  s = dates(s);
  s = times(s);
  s = bareHour(s);
  s = phones(s);
  s = money(s);
  s = versions(s);
  s = fractions(s);
  s = magnitudes(s);
  s = units(s);
  s = abbreviations(s);
  s = romans(s);
  s = ordinals(s);
  s = ranges(s);
  for (const [symbol, spoken] of Object.entries(SYMBOLS)) s = s.split(symbol).join(spoken);
  s = numbers(s);
  // Any colon that survived the time rule becomes a comma: the same pause, no stray token.
  s = s.replace(/:/g, ",");
  s = s.replace(/[_*`^|\\/[\]{}<>]/g, " ");
  s = s.replace(/\s+([.,!?;])/g, "$1");
  // No space is inserted before another punctuation mark ("Mon.," stays intact).
  s = s.replace(/([.,!?;])(?=[^\s"',.!?;])/g, "$1 ");
  return s.replace(/\s{2,}/g, " ").trim();
}
