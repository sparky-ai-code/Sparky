// Places the pinned speech models and ONNX Runtime files under public/voice/, so the
// desktop installer ships them. Nothing is fetched at runtime.
//
// - Kitten TTS nano (English): KittenML/kitten-tts-2-nano, Apache-2.0.
// - Whisper tiny.en q8: onnx-community/whisper-tiny.en (OpenAI Whisper, MIT).
// - ONNX Runtime Web WASM: copied from the installed onnxruntime-web package.
//
// Every downloaded file is checked against a pinned SHA-256. A mismatch fails the build.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KITTEN = "https://huggingface.co/KittenML/kitten-tts-2-nano/resolve/0843ae614780b04e4260c91b601e374c4b81250d/";
const WHISPER = "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/";
const WHISPER_DIR = "models/onnx-community/whisper-tiny.en/";

const REMOTE_FILES = [
  { url: `${KITTEN}kitten_tts_2_nano_en.onnx`, out: "kitten/model.onnx", sha256: "3a63a18b3f5cb1dbd99d7f53cb60fdb995e23a21e98d21f9f32d378668dab98e" },
  { url: `${KITTEN}voices_en.npz`, out: "kitten/voices_en.npz", sha256: "8dd673489b0130f23dd32d8c8b7cd49cf454cad029eaa6f0cd8c0f386c374e3e" },
  { url: `${KITTEN}vocab.json`, out: "kitten/vocab.json", sha256: "f96ba7baac25095152c28d9d23bca33685cd7411aad802f9fb1c9a3d2b06d046" },
  { url: `${KITTEN}g2p/cmu_misaki_us.json`, out: "kitten/cmu_misaki_us.json", sha256: "ae564e1a76df3501058a5ec99d135d016759c9475042fb6c3811374daee1ef04" },
  ...[
    ["added_tokens.json", "560be47bea388757f8d4cc185c5d82067426cbb6361e38016dd90ddc01ab203a"],
    ["config.json", "251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233"],
    ["generation_config.json", "7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9"],
    ["merges.txt", "1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5"],
    ["normalizer.json", "bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd"],
    ["onnx/decoder_model_merged_quantized.onnx", "c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52"],
    ["onnx/encoder_model_quantized.onnx", "e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25"],
    ["preprocessor_config.json", "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d"],
    ["quantize_config.json", "6e0e27f293a5c17ff2ca8046f06079c0120aa2ede6456faac8ec4b3203471a55"],
    ["special_tokens_map.json", "98bdf3ec5b32e31575b02f64b0a32bde7c0449075d34484a7df9bdd3cdeb9fb9"],
    ["tokenizer.json", "5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0"],
    ["tokenizer_config.json", "93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c"],
    ["vocab.json", "f6bd25a65e4e63ca31360e9fb11c7e4f9a391a78385d640acd814092dd6eee4f"],
  ].map(([path, sha256]) => ({ url: `${WHISPER}${path}`, out: `${WHISPER_DIR}${path}`, sha256 })),
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fileMatches(path, expected) {
  if (!existsSync(path)) return false;
  return sha256(await readFile(path)) === expected;
}

async function download({ url, out, sha256: expected }, outRoot) {
  const target = join(outRoot, out);
  if (await fileMatches(target, expected)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Voice asset download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`Voice asset checksum mismatch: ${url}`);
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target);
}

async function copyOnnxRuntime(webRoot, outRoot) {
  const dist = join(webRoot, "node_modules", "onnxruntime-web", "dist");
  // The bundled ORT entry points import the jsep build by name, so it must ship too.
  const names = (await readdir(dist)).filter((name) => /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(name));
  if (names.length === 0) throw new Error("onnxruntime-web WASM files were not found.");
  for (const name of names) {
    await mkdir(join(outRoot, "ort"), { recursive: true });
    await copyFile(join(dist, name), join(outRoot, "ort", name));
  }
}

/** Ensures public/voice/ holds every pinned speech asset. Safe to run repeatedly. */
export async function fetchVoiceAssets(webRoot) {
  const outRoot = join(webRoot, "public", "voice");
  for (const file of REMOTE_FILES) await download(file, outRoot);
  await copyOnnxRuntime(webRoot, outRoot);
  return outRoot;
}

// Command line: node scripts/fetch-voice-assets.mjs
if (import.meta.main) {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  fetchVoiceAssets(webRoot).then(
    (outRoot) => console.log(`Voice assets ready in ${outRoot}`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
