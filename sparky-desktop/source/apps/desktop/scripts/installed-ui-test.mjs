import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const appPath = process.env.SPARKY_UI_TEST_APP;
const artifactDir = process.env.SPARKY_UI_TEST_ARTIFACT_DIR;
if (!appPath || !artifactDir) {
  throw new Error("SPARKY_UI_TEST_APP and SPARKY_UI_TEST_ARTIFACT_DIR are required.");
}

const routes = [
  ["onboarding", "/onboarding"],
  ["plugins", "/plugins"],
  ["pull-requests", "/pull-requests"],
  ["schedules", "/schedules"],
  ["settings", "/settings", "/settings/general"],
  ["settings-archived", "/settings/archived"],
  ["settings-diagnostics", "/settings/diagnostics"],
  ["settings-general", "/settings/general"],
  ["settings-instructions", "/settings/instructions"],
  ["settings-keybindings", "/settings/keybindings"],
  ["settings-memory", "/settings/memory"],
  ["settings-models", "/settings/models"],
  ["settings-personalize", "/settings/personalize"],
  ["settings-plugins", "/settings/plugins"],
  ["settings-source-control", "/settings/source-control"],
];

async function reservePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a debug port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForDevTools(port, child) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Sparky exited during startup (${child.exitCode}).`);
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // The app has not opened its DevTools endpoint yet.
    }
    await delay(500);
  }
  throw new Error("Sparky did not expose its renderer for UI verification within 90 seconds.");
}

async function stopApp(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = NodeChildProcess.spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    if (child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(10_000)]);
    }
    if (child.exitCode === null) child.kill("SIGKILL");
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function removeTemporaryProfile(profileDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await NodeFS.rm(profileDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (
        process.platform !== "win32" ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code) ||
        attempt === 4
      ) {
        throw error;
      }
      await delay(1_000);
    }
  }
}

await NodeFS.mkdir(artifactDir, { recursive: true });
const port = await reservePort();
const profileDir = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sparky-installed-ui-"));
const child = NodeChildProcess.spawn(
  appPath,
  [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
  ],
  {
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      T3CODE_HOME: NodePath.join(profileDir, "home"),
      ELECTRON_ENABLE_LOGGING: "1",
    },
  },
);

let browser;
const pageErrors = [];
try {
  await waitForDevTools(port, child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  const observedPages = new Set();
  let page;
  let stablePolls = 0;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const candidates = contexts.flatMap((context) => context.pages()).filter((candidate) =>
      !candidate.isClosed() && !candidate.url().startsWith("devtools://"),
    );
    for (const candidate of candidates) {
      if (!observedPages.has(candidate)) {
        observedPages.add(candidate);
        candidate.on("pageerror", (error) => pageErrors.push(error.name));
      }
    }
    let candidate;
    for (const current of [...candidates].reverse()) {
      const bodyText = await current.locator("body").innerText().catch(() => "");
      if (bodyText.trim().length >= 10) {
        candidate = current;
        break;
      }
    }
    if (candidate && candidate === page) {
      stablePolls += 1;
      if (stablePolls >= 6) break;
    } else {
      stablePolls = 0;
      page = candidate;
    }
    await delay(500);
  }
  if (!page || stablePolls < 4) {
    throw new Error(`Sparky did not keep a usable renderer window open (exit code: ${child.exitCode ?? "running"}).`);
  }
  await page.waitForFunction(() => document.readyState === "complete", undefined, { timeout: 60_000 });

  const initialPath = await page.evaluate(() => window.location.hash.slice(1) || "/");
  const initialText = await page.locator("body").innerText().catch(() => "");
  if (initialText.trim().length < 10) throw new Error("The installed app window rendered no usable content.");
  await page.screenshot({ path: NodePath.join(artifactDir, "chat-start.png"), fullPage: true });
  const composer = page.locator('[contenteditable="true"]').first();
  if (await composer.isVisible().catch(() => false)) {
    const smokePrompt = "Sparky installed-app input check";
    await composer.fill(smokePrompt);
    if (!(await composer.innerText()).includes(smokePrompt)) {
      throw new Error("The chat composer did not retain typed input.");
    }
    await composer.fill("");
  }

  const manifest = [{ name: "chat-start", path: initialPath }];
  for (const [name, path, expectedPath = path] of routes) {
    await page.evaluate((nextPath) => {
      window.location.hash = nextPath;
    }, path);
    await page.waitForTimeout(1_000);
    const actualPath = await page.evaluate(() => window.location.hash.slice(1) || "/");
    if (actualPath.replace(/\/$/u, "") !== expectedPath.replace(/\/$/u, "")) {
      throw new Error(`Route ${path} redirected to ${actualPath}; expected ${expectedPath}.`);
    }
    const text = await page.locator("body").innerText().catch(() => "");
    if (text.trim().length < 10) throw new Error(`Route ${actualPath} rendered no usable content.`);
    if (text.includes("Something went wrong.")) throw new Error(`Route ${actualPath} rendered the app error boundary.`);
    await page.screenshot({ path: NodePath.join(artifactDir, `${name}.png`), fullPage: true });
    manifest.push({ name, path: actualPath });
  }

  if (pageErrors.length > 0) {
    throw new Error(`The renderer raised ${pageErrors.length} uncaught error(s): ${[...new Set(pageErrors)].join(", ")}.`);
  }
  await NodeFS.writeFile(
    NodePath.join(artifactDir, "manifest.json"),
    `${JSON.stringify({ platform: process.platform, screenshots: manifest }, null, 2)}\n`,
  );
  console.log(`Installed app launched and rendered ${manifest.length} route screenshots.`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopApp(child);
  await removeTemporaryProfile(profileDir);
}
