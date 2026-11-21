import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS, VoiceSelection, VoiceSpeed } from "@sparky/contracts/settings";
import { KITTEN_VOICES } from "../../voice/kittenVoices";

describe("Voice settings", () => {
  it("defaults older saved settings to a Kitten voice at normal speed", () => {
    expect(Schema.decodeSync(ClientSettingsSchema)({}).voiceSelection).toBe("serena");
    expect(DEFAULT_CLIENT_SETTINGS.voiceSpeed).toBe(1);
  });

  it("persists the chosen voice and speed independently of model configuration", () => {
    const settings = Schema.decodeSync(ClientSettingsSchema)({
      voiceSelection: "vincent",
      voiceSpeed: 1.25,
    });
    expect(settings.voiceSelection).toBe("vincent");
    expect(settings.voiceSpeed).toBe(1.25);
  });

  it("offers exactly the voices the model ships, and only those are valid", () => {
    expect(KITTEN_VOICES.map((voice) => voice.key)).toHaveLength(10);
    for (const voice of KITTEN_VOICES) expect(Schema.is(VoiceSelection)(voice.key)).toBe(true);
    expect(Schema.is(VoiceSelection)("F2")).toBe(false);
  });

  it("rejects speeds outside the model's supported range", () => {
    expect(Schema.is(VoiceSpeed)(0.6)).toBe(false);
    expect(Schema.is(VoiceSpeed)(1.45)).toBe(false);
    expect(Schema.is(VoiceSpeed)(1)).toBe(true);
  });
});
