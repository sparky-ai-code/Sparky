// Local, on-demand Whisper inference. Microphone samples never leave this worker.
// The model and the pinned Transformers.js runtime are downloaded and cached by the browser.
// Use the CDN's ESM build, which rewrites package dependencies into absolute module
// URLs. Importing the raw dist file left "onnxruntime-common" unresolved in Electron.
const TRANSFORMERS_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm";
let modelPromise;

function model() {
  if (!modelPromise) {
    modelPromise = (async () => {
      postMessage({ type: "status", text: "Loading local speech recognition…" });
      const { env, pipeline } = await import(TRANSFORMERS_URL);
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      const transcriber = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
        device: "wasm",
        dtype: "q8",
        progress_callback: ({ status }) => {
          if (status === "download") postMessage({ type: "status", text: "Downloading speech recognition model…" });
        },
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
