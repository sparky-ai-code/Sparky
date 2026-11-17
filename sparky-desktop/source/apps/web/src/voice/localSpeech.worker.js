// Local Whisper transcription fallback for Electron, where browser Web Speech
// recognition generally has no working backend. No microphone audio is uploaded.
// Transformers.js and the quantized ONNX weights are fetched on first use and cached.
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
let transcriberPromise = null;

function loadTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { env, pipeline } = await import(/* @vite-ignore */ TRANSFORMERS);
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
        device: "wasm",
        dtype: "q8",
        progress_callback: (progress) => {
          if (progress.status === "progress") {
            self.postMessage({ type: "status", text: "Downloading local speech model… " +
              Math.round(progress.progress || 0) + "%" });
          }
        },
      });
    })().catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      self.postMessage({ type: "status", text: "Loading local speech recognition…" });
      await loadTranscriber();
      self.postMessage({ type: "ready" });
    } else if (data.type === "transcribe") {
      const transcriber = await loadTranscriber();
      const result = await transcriber(data.audio, {
        language: "english",
        task: "transcribe",
      });
      self.postMessage({
        type: "transcript",
        id: data.id,
        text: String(result.text || "").trim(),
      });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
