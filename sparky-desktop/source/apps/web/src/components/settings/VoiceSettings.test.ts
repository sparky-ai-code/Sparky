import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS, VoiceSpeed } from "@sparky/contracts/settings";

describe("Voice settings", () => {
  it("defaults older saved settings to female voice and normal speed", () => {
    expect(Schema.decodeSync(ClientSettingsSchema)({}).voiceSelection).toBe("F2");
    expect(DEFAULT_CLIENT_SETTINGS.voiceSpeed).toBe(1);
  });

  it("persists voice and speed independently of model configuration", () => {
    const settings = Schema.decodeSync(ClientSettingsSchema)({
      voiceSelection: "M2",
      voiceSpeed: 1.25,
    });
    expect(settings.voiceSelection).toBe("M2");
    expect(settings.voiceSpeed).toBe(1.25);
  });

  it("rejects speeds outside the model's supported range", () => {
    expect(Schema.is(VoiceSpeed)(0.6)).toBe(false);
    expect(Schema.is(VoiceSpeed)(1.45)).toBe(false);
    expect(Schema.is(VoiceSpeed)(1)).toBe(true);
  });
});
