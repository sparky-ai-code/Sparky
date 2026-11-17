/*
 * Tiny Voca browser inference, adapted from n4ze3m/tiny-voca (Apache-2.0).
 * https://github.com/n4ze3m/tiny-voca
 * Dizione phonemizer (Apache-2.0): https://github.com/n4ze3m/dizione
 * We download pinned, public model/code assets on demand instead of bundling
 * model weights in every Sparky installer. All inference remains on-device.
 */
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const MODEL_URL = "https://huggingface.co/n4ze3m/tiny-voca/resolve/main/";
const DIZIONE_URL = "https://cdn.jsdelivr.net/gh/n4ze3m/dizione@8cd889e4de7be6bd1dd2e6891344a0729fa14dd4/src/dizione/";
const MODULES = [
  "__init__.py", "align.py", "convert.py", "engine.py", "g2p.py",
  "homographs.py", "morphology.py", "normalize.py", "sentence.py",
  "symbols.py", "tables.py",
];
const TABLES = [
  "abbreviations.txt", "chat.txt", "endings.txt", "exceptions.txt",
  "function_words.txt", "homograph_fixes.txt", "homograph_rules.txt",
  "letters.txt", "phrases.txt", "units.txt",
];
const DATA = ["lexicon.tsv", "align.json", "g2p.json", "g2p.npz", "homographs.json"];
let pyodide, phonemize, session, config;
let initialized;
const cancelled = new Set();
const status = (text) => postMessage({ type: "status", text });

async function download(url) {
  const cacheKey = "sparky-tiny-voca-1";
  let cache;
  try {
    cache = await caches.open(cacheKey);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch { /* Cache Storage is optional (e.g. on restricted renderer profiles). */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error("Tiny Voca asset download failed (" + response.status + ")");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (cache) void cache.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}

async function startPhonemizer() {
  status("Loading Tiny Voca pronunciation data…");
  pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
  await pyodide.loadPackage("numpy");
  pyodide.FS.mkdirTree("/dizione-src/dizione/data");
  pyodide.FS.mkdirTree("/dizione-data");
  const sources = await Promise.all([
    ...MODULES.map((name) => download(DIZIONE_URL + name)),
    ...TABLES.map((name) => download(DIZIONE_URL + "data/" + name)),
    ...DATA.map((name) => download(MODEL_URL + "phonemizer/" + name)),
  ]);
  let index = 0;
  for (const name of MODULES) pyodide.FS.writeFile("/dizione-src/dizione/" + name, sources[index++]);
  for (const name of TABLES) pyodide.FS.writeFile("/dizione-src/dizione/data/" + name, sources[index++]);
  for (const name of DATA) pyodide.FS.writeFile("/dizione-data/" + name, sources[index++]);
  pyodide.runPython(`
import json, os, sys
os.environ["DIZIONE_DATA"] = "/dizione-data"
sys.path.insert(0, "/dizione-src")
import dizione
def phonemize_json(text):
    try:
        result = dizione.phonemize(text)
    except ValueError:
        if any(word for mark, words in dizione.pieces(text) if not mark for word in words):
            raise
        return "null"
    return json.dumps({"ids": list(result.ids), "stress": list(result.stress)})
phonemize_json("Warm up.")
`);
  phonemize = pyodide.globals.get("phonemize_json");
}

async function startModel() {
  status("Loading Tiny Voca speech model…");
  const [cfg, weights] = await Promise.all([
    download(MODEL_URL + "config.json"),
    download(MODEL_URL + "onnx/model.onnx"),
  ]);
  config = JSON.parse(new TextDecoder().decode(cfg));
  ort.env.wasm.wasmPaths = ORT_URL;
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(weights, { executionProviders: ["wasm"] });
}

function init() {
  if (!initialized) {
    initialized = (async () => {
      status("Preparing Tiny Voca…");
      importScripts(PYODIDE_URL + "pyodide.js", ORT_URL + "ort.wasm.min.js");
      await Promise.all([startPhonemizer(), startModel()]);
      postMessage({ type: "ready" });
    })().catch((error) => { initialized = undefined; throw error; });
  }
  return initialized;
}

function sentences(text) {
  const parts = [];
  let current = "";
  const ABBREV = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc)|\b[A-Z])\.$/i;
  for (const piece of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/)) {
    current = current ? current + " " + piece : piece;
    if (!ABBREV.test(current)) { parts.push(current); current = ""; }
  }
  if (current) parts.push(current);
  return parts.filter((part) => /[\p{L}\p{N}]/u.test(part));
}

function fit(text) {
  const result = JSON.parse(phonemize(text));
  if (!result) return [];
  if (result.ids.length <= config.model.max_tokens - 12) return [result];
  const pieces = text.split(/(?<=[,;:—])\s+/);
  if (pieces.length > 1) return pieces.flatMap(fit);
  const words = text.split(" ");
  if (words.length < 2) return [];
  const split = Math.ceil(words.length / 2);
  return [...fit(words.slice(0, split).join(" ")), ...fit(words.slice(split).join(" "))];
}

async function synthesize(phones, voice, speed) {
  const count = phones.ids.length;
  const integers = (values) => new ort.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, count]);
  const scalar = (value) => new ort.Tensor("float32", Float32Array.from([value]), [1]);
  const output = await session.run({
    tokens: integers(phones.ids),
    stress: integers(phones.stress),
    voice: new ort.Tensor("int64", BigInt64Array.from([BigInt(voice)]), [1]),
    speed: scalar(speed),
    pitch_shift: scalar(0),
    pitch_range: scalar(1),
  });
  return output.audio.data;
}

function limitPeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak > 0.99) for (let i = 0; i < samples.length; i++) samples[i] *= 0.99 / peak;
}

async function speak(data) {
  let count = 0;
  const text = data.text.trim().replace(/([^.!?…,;:])$/, "$1.");
  for (const sentence of sentences(text)) {
    if (cancelled.has(data.id)) break;
    for (const phones of fit(sentence)) {
      if (cancelled.has(data.id)) break;
      const audio = (await synthesize(phones, data.voice, data.speed)).slice();
      if (cancelled.has(data.id)) break;
      limitPeak(audio);
      postMessage({ type: "sentence", id: data.id, audio, sampleRate: config.sample_rate }, [audio.buffer]);
      count++;
    }
  }
  if (cancelled.has(data.id)) {
    cancelled.delete(data.id);
    return;
  }
  if (!count) throw new Error("Tiny Voca currently supports English text only.");
  postMessage({ type: "done", id: data.id });
}

onmessage = async ({ data }) => {
  if (data.type === "cancel") {
    cancelled.add(data.id);
    return;
  }
  try {
    await init();
    if (data.type === "speak") await speak(data);
  } catch (error) {
    postMessage({ type: "error", id: data.id, message: String(error?.message || error) });
  }
};
