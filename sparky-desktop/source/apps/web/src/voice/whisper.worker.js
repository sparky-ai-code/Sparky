// Local Whisper speech recognition (tiny.en, q8). Microphone samples never leave this worker.
// The Transformers.js runtime and the model files are bundled into the app at build time
// (see scripts/fetch-voice-assets.mjs). Nothing is downloaded at runtime.
import { env, pipeline } from "@huggingface/transformers";

let modelPromise;
let assetBase = "";

function model() {
  if (!modelPromise) {
    modelPromise = (async () => {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useBrowserCache = false;
      env.localModelPath = new URL("voice/models/", assetBase).href;
      env.backends.onnx.wasm.wasmPaths = new URL("voice/ort/", assetBase).href;
      const transcriber = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
        device: "wasm",
        dtype: "q8",
      });
      postMessage({ type: "ready" });
      return transcriber;
    })().catch((error) => {
      modelPromise = undefined;
      throw error;
    });
  }
  return modelPromise;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.assetBase) assetBase = data.assetBase;
    const transcriber = await model();
    if (data.type !== "transcribe") return;
    // whisper-tiny.en is English-only. Transformers.js rejects explicit
    // language/task options on this model rather than silently ignoring them.
    const result = await transcriber(new Float32Array(data.audio), {
      return_timestamps: false,
    });
    postMessage({ type: "transcript", id: data.id, text: String(result.text || "").trim() });
  } catch (error) {
    postMessage({ type: "error", id: data.id, message: String(error?.message || error) });
  }
};
