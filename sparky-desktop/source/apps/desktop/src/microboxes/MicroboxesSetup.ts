// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Electron host provisioning boundary.
import { execFile as execFileCallback } from "node:child_process";
import * as Path from "node:path";
import { promisify } from "node:util";
import { dialog } from "electron";
import type { DesktopMicroboxesSetupState } from "@sparky/contracts";
import { selectMicroboxesInstallPlan } from "./MicroboxesInstallPlan.ts";

const execFile = promisify(execFileCallback);
type Host = DesktopMicroboxesSetupState["platform"];

const host: Host =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : process.platform === "linux"
        ? "linux"
        : "unsupported";

const target = process.arch === "arm64" ? "aarch64" : "x86_64";
const binary = `qemu-system-${target}`;
let setupInFlight: Promise<DesktopMicroboxesSetupState> | null = null;

async function canRun(executable: string, args: readonly string[] = ["--version"]): Promise<boolean> {
  try {
    await execFile(executable, [...args], { timeout: 12_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function runtimeInstalled(): Promise<boolean> {
  const candidates = [binary];
  if (host === "windows") {
    const executable = `${binary}.exe`;
    candidates.push(
      Path.join(process.env.ProgramFiles ?? "C:\\Program Files", "qemu", executable),
      Path.join(process.env.LOCALAPPDATA ?? "", "Programs", "QEMU", executable),
    );
  } else if (host === "macos") {
    candidates.push(`/opt/homebrew/bin/${binary}`, `/usr/local/bin/${binary}`);
  }
  for (const candidate of candidates) {
    if (await canRun(candidate)) return true;
  }
  return false;
}

const publicState = (
  status: DesktopMicroboxesSetupState["status"],
  detail: string | null = null,
): DesktopMicroboxesSetupState => ({ status, platform: host, detail });

export async function getMicroboxesSetupState(): Promise<DesktopMicroboxesSetupState> {
  if (setupInFlight) return publicState("installing", "Setting up Sparky Microboxes…");
  if (await runtimeInstalled()) {
    return publicState(
      "engine-ready",
      "Core components are installed. A Microboxes guest image is still required before you can start a box.",
    );
  }
  const plan = await selectMicroboxesInstallPlan(
    host,
    async (name) => canRun(name),
    typeof process.getuid === "function" && process.getuid() === 0,
  );
  return plan
    ? publicState("not-installed", "Sparky Microboxes have not been set up on this device.")
    : publicState(
        "unsupported",
        "Automatic setup is unavailable on this device. A supported system package manager and required permissions are needed.",
      );
}

async function executeSetup(): Promise<DesktopMicroboxesSetupState> {
  if (await runtimeInstalled()) return getMicroboxesSetupState();
  const plan = await selectMicroboxesInstallPlan(
    host,
    async (name) => canRun(name),
    typeof process.getuid === "function" && process.getuid() === 0,
  );
  if (!plan) return getMicroboxesSetupState();

  // Confirmation must live in the privileged process, not only in the renderer.
  const approval = await dialog.showMessageBox({
    type: "question",
    title: "Set up Sparky Microboxes",
    message: "Set up Sparky Microboxes on this computer?",
    detail:
      "Sparky will install virtualization components using your system's trusted software manager. " +
      "Your operating system may request administrator approval. A guest image is installed separately.",
    buttons: ["Cancel", "Set up Sparky Microboxes"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (approval.response !== 1) return getMicroboxesSetupState();

  try {
    await execFile(plan.executable, [...plan.args], {
      timeout: 20 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: false,
    });
    if (!(await runtimeInstalled())) {
      return publicState(
        "error",
        "Setup finished, but Sparky could not verify the Microboxes components. Restart Sparky and check again.",
      );
    }
    return publicState(
      "engine-ready",
      "Core components are installed. A Microboxes guest image is still required before you can start a box.",
    );
  } catch {
    // Never return internal package-manager details to the renderer.
    return publicState(
      "error",
      "Couldn't finish setting up Sparky Microboxes. Check your system permissions and try again.",
    );
  }
}

export async function setupMicroboxes(): Promise<DesktopMicroboxesSetupState> {
  if (setupInFlight) return setupInFlight;
  setupInFlight = executeSetup();
  try {
    return await setupInFlight;
  } finally {
    setupInFlight = null;
  }
}
