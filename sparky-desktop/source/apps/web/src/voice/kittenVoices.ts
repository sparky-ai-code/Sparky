import type { VoiceSelection } from "@sparky/contracts/settings";

/** Kitten TTS nano English voices, with the descriptions their model repository gives them. */
export const KITTEN_VOICES: ReadonlyArray<{ key: VoiceSelection; name: string; description: string }> = [
  { key: "eleanor", name: "Eleanor", description: "Somber historian" },
  { key: "martha", name: "Martha", description: "Weathered radio journalist" },
  { key: "serena", name: "Serena", description: "Gentle yoga instructor" },
  { key: "iris", name: "Iris", description: "Hushed museum guide" },
  { key: "grace", name: "Grace", description: "Soothing nurse" },
  { key: "edith", name: "Edith", description: "Elderly grandmother, soft" },
  { key: "otis", name: "Otis", description: "Rumbling blues musician" },
  { key: "vincent", name: "Vincent", description: "Hushed museum guide" },
  { key: "max", name: "Max", description: "Energetic sports announcer" },
  { key: "danny", name: "Danny", description: "Cheerful podcast host" },
];
