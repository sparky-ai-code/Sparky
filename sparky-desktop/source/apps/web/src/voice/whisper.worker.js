// Local, on-demand Whisper inference. Microphone samples never leave this worker.
// The model and the pinned Transformers.js runtime are downloaded and cached by the browser.
const TRANSFORMERS_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.web.min.js";
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
    const result = await transcriber(new Float32Array(data.audio), {
      return_timestamps: false,
      language: "english",
      task: "transcribe",
    });
    postMessage({ type: "transcript", id: data.id, text: String(result.text || "").trim() });
  } catch (error) {
    postMessage({ type: "error", id: data.id, message: String(error?.message || error) });
  }
};
