// Run through pnpm --filter @sparky/desktop exec node scripts/voice-smoke.mjs.
// End-to-end: a real WAV recording -> MediaRecorder -> Whisper -> onSend -> Tiny Voca.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, "../../..");
const port = 5741;
const url = "http://127.0.0.1:" + port + "/voice-smoke.html";
const server = spawn("pnpm", [
  "--filter", "@sparky/web", "exec", "vite", "--host", "127.0.0.1",
  "--port", String(port), "--strictPort",
], {
  cwd: sourceRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
});
let serverLog = "";
server.stdout.on("data", (buffer) => { serverLog += buffer.toString(); });
server.stderr.on("data", (buffer) => { serverLog += buffer.toString(); });
let browser;
let page;

try {
  let running = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error("Vite exited: " + serverLog);
    try {
      const response = await fetch(url);
      if (response.ok) { running = true; break; }
    } catch { /* Vite is still starting. */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!running) throw new Error("Timed out starting Vite: " + serverLog);

  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console: " + message.text());
  });
  page.on("requestfailed", (request) => errors.push("request: " + request.url() + " " + request.failure()?.errorText));

  await page.addInitScript(() => {
    window.__voiceStatusHistory = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const ctx = new AudioContext();
          const destination = ctx.createMediaStreamDestination();
          const response = await fetch("/voice-test-utterance.wav");
          if (!response.ok) throw new Error("Missing audio fixture");
          const audio = await ctx.decodeAudioData(await response.arrayBuffer());
          const source = ctx.createBufferSource();
          source.buffer = audio;
          source.connect(destination);
          await ctx.resume();
          // Give VoiceSession time to attach its analyser and MediaRecorder.
          source.start(ctx.currentTime + 0.75);
          return destination.stream;
        },
      },
    });
  });

  await page.goto(url);
  await page.getByRole("button", { name: "Start voice test" }).click();
  // Detect both success and the actual error without waiting for an opaque timeout.
  await page.waitForFunction(() =>
    Boolean(window.__voiceTestError) ||
    document.querySelector('[data-testid="chat-feed"] [data-role="user"]'),
    { timeout: 300_000 },
  );
  const error = await page.locator('[data-testid="voice-error"]').textContent();
  if (error) throw new Error("Voice engine failed: " + error);
  const userMessage = await page.locator('[data-testid="chat-feed"] [data-role="user"]').first().textContent();
  if (!userMessage || userMessage.trim().length < 3) throw new Error("No recognized utterance");

  await page.waitForFunction(() =>
    Boolean(window.__voiceTestError) ||
    (window.__voiceStatusHistory ?? []).includes("Speaking…"),
    { timeout: 300_000 },
  );
  const after = await page.locator('[data-testid="voice-error"]').textContent();
  if (after) throw new Error("Tiny Voca failed: " + after);
  await page.waitForFunction(() => {
    const statuses = window.__voiceStatusHistory ?? [];
    const speaking = statuses.lastIndexOf("Speaking…");
    return Boolean(window.__voiceTestError) || (speaking !== -1 && statuses.slice(speaking + 1).includes("Listening…"));
  }, { timeout: 300_000 });
  const playbackError = await page.locator('[data-testid="voice-error"]').textContent();
  if (playbackError) throw new Error("Speech playback failed: " + playbackError);
  const assistant = await page.locator('[data-testid="chat-feed"] [data-role="assistant"]').first().textContent();
  if (!assistant?.includes("Sparky is speaking")) throw new Error("Assistant reply never reached the chat feed");
  console.log("Voice smoke passed. Whisper transcript: " + userMessage);
  console.log("Chat reply spoken through Tiny Voca.");
} catch (error) {
  console.error("Voice smoke failed", error);
  if (page) {
    const status = await page.locator('[data-testid="voice-status"]').textContent().catch(() => "?");
    const history = await page.evaluate(() => window.__voiceStatusHistory ?? []).catch(() => []);
    const pageError = await page.locator('[data-testid="voice-error"]').textContent().catch(() => "?");
    console.error("Final status:", status, "Error:", pageError, "Status history:", history);
  }
  console.error("Vite:", serverLog.slice(-1500));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill("SIGTERM");
}
