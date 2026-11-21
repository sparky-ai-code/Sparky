import { describe, expect, it } from "vite-plus/test";
import expected from "./testdata/voices-expected.json" with { type: "json" };
import { DEFLATED_NPZ_BASE64, STORED_NPZ_BASE64 } from "./testdata/voices-npz";
import { parseVoicePacks } from "./kittenArchive";

function decode(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

describe("Kitten TTS voice packs", () => {
  const archives = { "numpy.savez (stored)": STORED_NPZ_BASE64, "numpy.savez_compressed (deflated)": DEFLATED_NPZ_BASE64 };
  for (const [label, base64] of Object.entries(archives)) {
    it(`reads every array of a ${label} archive`, async () => {
      const packs = await parseVoicePacks(decode(base64));
      expect([...packs.keys()].sort()).toEqual(["eleanor", "max"]);
      for (const [name, reference] of Object.entries(expected)) {
        const pack = packs.get(name)!;
        expect(pack.rows).toBe(reference.rows);
        expect(pack.data.length).toBe(reference.rows * 256);
        expect(pack.data.slice(0, 4)).toEqual(Float32Array.from(reference.first));
        expect(pack.data.slice(-4)).toEqual(Float32Array.from(reference.last));
        const sum = pack.data.reduce((total, value) => total + value, 0);
        expect(sum).toBeCloseTo(reference.sum, 3);
      }
    });
  }

  it("rejects bytes that are not a zip archive", async () => {
    await expect(parseVoicePacks(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/zip/);
  });
});
