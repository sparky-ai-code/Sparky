// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Local hypervisor process boundary.
import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import * as Path from "node:path";
import { promisify } from "node:util";

import type {
  MicroboxCreateInput,
  MicroboxImage,
  MicroboxStatus,
  MicroboxSnapshot,
} from "@sparky/contracts";
import { QmpClient, keyEvent, textKeyEvents } from "./QmpClient.ts";

const execFile = promisify(execFileCallback);

type GuestManifest = {
  id: string;
  name: string;
  kind: "linux-kernel" | "disk" | "installer-iso";
  architecture: "x86_64" | "aarch64";
  file: string;
  kernel?: string;
  append?: string;
  boxImageVersion?: number;
};
type MutableStatus = { -readonly [K in keyof MicroboxStatus]: MicroboxStatus[K] };
type RunningBox = {
  status: MutableStatus;
  process: ChildProcessWithoutNullStreams;
  qmp: QmpClient;
  directory: string;
  width: number;
  height: number;
};
const MAX_BOXES = 4;
// Image artifacts use IDs such as "sparky-micro-x86_64"; underscores are safe in a single directory component.
const SAFE_IMAGE_ID = /^[a-z0-9_-]{1,48}$/u;
const SAFE_IMAGE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const CURRENT_SPARKY_MICRO_IMAGE_VERSION = 2;
const OFFICIAL_MICRO_IMAGE_ID = /^sparky-micro-(?:x86_64|aarch64)$/u;
const OFFICIAL_MICRO_VERSIONED_ID = /^sparky-micro-(?:x86_64|aarch64)-v2-[0-9a-f]{12}$/u;

/** SHA256SUMS guards against accidentally mismatched kernel/rootfs files. */
function parseMicroboxChecksums(raw: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64})[ \t]+\*?([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/u.exec(line);
    if (!match || checksums.has(match[2]!)) {
      throw new MicroboxHostError("invalid-input", "The Linux guest checksum file is invalid.");
    }
    checksums.set(match[2]!, match[1]!);
  }
  return checksums;
}
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function versionedMicroboxId(manifest: GuestManifest, rootfsHash: string): string {
  return `${manifest.id}-v${CURRENT_SPARKY_MICRO_IMAGE_VERSION}-${rootfsHash.slice(0, 12)}`;
}
function assertCurrentSparkyMicroImage(manifest: GuestManifest): void {
  if (OFFICIAL_MICRO_IMAGE_ID.test(manifest.id) &&
      manifest.boxImageVersion !== CURRENT_SPARKY_MICRO_IMAGE_VERSION) {
    throw new MicroboxHostError("image-missing",
      "This is an outdated Sparky Micro Linux image that may boot to a login prompt. Delete existing boxes using it, then install a newly built Linux guest image folder (not the Windows installer).");
  }
}
export function acceptsBoxInput(state: MicroboxStatus["state"]): boolean {
  return state === "starting" || state === "running";
}

const DESKTOP_READY_MARKER = "SPARKY_MICRO_DESKTOP_READY";
const DESKTOP_FAILED_MARKER = "SPARKY_MICRO_DESKTOP_ERROR";
const BOOT_POLL_MS = 1_000;
const LINUX_BOOT_TIMEOUT_MS = 120_000;
const ARM_EMULATED_BOOT_TIMEOUT_MS = 240_000;

/** Boot diagnostics are local; only these fixed status messages reach an agent. */
export function microLinuxBootState(serialOutput: string): "ready" | "failed" | "booting" {
  if (serialOutput.includes(DESKTOP_READY_MARKER)) return "ready";
  if (
    serialOutput.includes(DESKTOP_FAILED_MARKER) ||
    /kernel panic|VFS: Unable to mount root fs|No working init found/iu.test(serialOutput)
  ) return "failed";
  return "booting";
}

export function visibleLinuxKernelArguments(append: string): string {
  // Display kernel/init messages in the VM while retaining the serial debug
  // console. Without tty0, the framebuffer remains at "Booting the kernel".
  return /(?:^|\s)console=tty0(?:\s|$)/u.test(append)
    ? append
    : `${append} console=tty0`;
}


export class MicroboxHostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const nativeArch = process.arch === "arm64" ? "aarch64" : "x86_64";
function accelerator(guestArch: string): string[] {
  if (guestArch !== nativeArch) return ["-accel", "tcg"];
  const host = process.platform;
  return host === "linux"
    ? ["-accel", "kvm", "-accel", "tcg"]
    : host === "darwin"
      ? ["-accel", "hvf", "-accel", "tcg"]
      : host === "win32"
        ? ["-accel", "whpx", "-accel", "tcg"]
        : ["-accel", "tcg"];
}

function imageTool(name: string): string {
  const binary = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = process.platform === "win32"
    ? [
        Path.join(process.env.ProgramFiles ?? "C:\\Program Files", "qemu", binary),
        Path.join(process.env.LOCALAPPDATA ?? "", "Programs", "QEMU", binary),
      ]
    : process.platform === "darwin"
      ? [`/opt/homebrew/bin/${binary}`, `/usr/local/bin/${binary}`]
      : [];
  return candidates.find((candidate) => existsSync(candidate)) ?? binary;
}

function imageBinary(architecture: string): string {
  return imageTool(`qemu-system-${architecture}`);
}

function guestRuntimeEnv(): NodeJS.ProcessEnv {
  // Do not pass provider credentials, session tokens or arbitrary host secrets
  // to guest-hypervisor processes.
  const allowed = [
    "PATH", "Path", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function guestDrivePath(path: string): string {
  // QEMU's -drive grammar separates properties at commas. Escape host paths.
  return path.replaceAll(",", ",,");
}

/**
 * One image = one named directory with an immutable manifest and image files.
 * Agent calls can only select installed IDs, never arbitrary host paths.
 */
export class HostBoxManager {
  private readonly boxes = new Map<string, RunningBox>();
  private readonly deletedThreads = new Set<string>();
  private readonly updatingImages = new Set<string>();
  private stopping = false;
  private creating = 0;

  private readonly root: string;
  constructor(root: string) { this.root = root; }

  private async watchLinuxDesktop(boxId: string, timeoutMs: number): Promise<void> {
    const box = this.boxes.get(boxId);
    if (!box) return;
    const serialFile = Path.join(box.directory, "boot-serial.log");
    const deadline = Date.now() + timeoutMs;
    let outcome: "ready" | "failed" | "booting" = "booting";
    while (
      Date.now() < deadline &&
      this.boxes.get(boxId) === box &&
      box.status.state === "starting"
    ) {
      const serialOutput = await Fs.readFile(serialFile, "utf8").catch(() => "");
      outcome = microLinuxBootState(serialOutput);
      if (outcome !== "booting") break;
      await new Promise<void>((resolve) => setTimeout(resolve, BOOT_POLL_MS));
    }
    if (this.boxes.get(boxId) !== box || box.status.state !== "starting") return;
    if (outcome === "ready") {
      box.status.state = "running";
      delete box.status.bootMessage;
      return;
    }
    box.status.state = "error";
    box.status.bootMessage = outcome === "failed"
      ? "The Linux guest could not start its desktop. Install the updated Sparky Micro Linux image."
      : "The Linux graphical desktop did not become ready. Install the latest Sparky Micro Linux image and recreate this box.";
    await box.qmp.stop().catch(() => undefined);
  }

  async importImage(sourceDirectory: string): Promise<MicroboxImage> {
    if (!Path.isAbsolute(sourceDirectory)) {
      throw new MicroboxHostError("invalid-input", "Choose an image folder on this computer.");
    }
    let source = await Fs.realpath(sourceDirectory).catch(() => {
      throw new MicroboxHostError("image-missing", "The selected image folder cannot be opened.");
    });
    // Windows extraction tools sometimes create one additional directory.
    // Safely recognize that wrapper without asking users to hunt for image.json.
    const directManifest = await Fs.stat(Path.join(source, "image.json"))
      .then((stat) => stat.isFile(), () => false);
    if (!directManifest) {
      const children = await Fs.readdir(source, { withFileTypes: true }).catch(() => []);
      const candidates: string[] = [];
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const candidate = await Fs.realpath(Path.join(source, child.name)).catch(() => "");
        if (!candidate.startsWith(source + Path.sep)) continue;
        const containsManifest = await Fs.stat(Path.join(candidate, "image.json"))
          .then((stat) => stat.isFile(), () => false);
        if (containsManifest) candidates.push(candidate);
      }
      if (candidates.length !== 1) {
        throw new MicroboxHostError("image-missing", candidates.length > 1
          ? "Multiple guest image folders were found. Select the folder containing image.json."
          : "Select an extracted guest image folder containing image.json and rootfs.ext2. Extract the ZIP before installing.");
      }
      source = candidates[0]!;
    }
    let manifest: GuestManifest;
    try {
      manifest = JSON.parse(await Fs.readFile(Path.join(source, "image.json"), "utf8")) as GuestManifest;
    } catch {
      throw new MicroboxHostError("image-missing", "The folder does not contain a valid Microboxes image.");
    }
    if (
      !manifest || !SAFE_IMAGE_ID.test(manifest.id) || !SAFE_IMAGE_FILE.test(manifest.file) ||
      !["linux-kernel", "disk", "installer-iso"].includes(manifest.kind) ||
      !["x86_64", "aarch64"].includes(manifest.architecture) ||
      (manifest.kind === "linux-kernel" && (!manifest.kernel || !SAFE_IMAGE_FILE.test(manifest.kernel))) ||
      typeof manifest.name !== "string" || manifest.name.length < 1 || manifest.name.length > 80
    ) {
      throw new MicroboxHostError("invalid-input", "The image manifest is invalid.");
    }
    assertCurrentSparkyMicroImage(manifest);
    const files = ["image.json", manifest.file, ...(manifest.kernel ? [manifest.kernel] : [])];
    let installedId = manifest.id;
    if (OFFICIAL_MICRO_IMAGE_ID.test(manifest.id)) {
      // Earlier imports used this same ID for a login-only root filesystem.
      // Verify the actual bytes, and install each revision into its own dir.
      const checksums = parseMicroboxChecksums(await Fs.readFile(
        Path.join(source, "SHA256SUMS"), "utf8",
      ).catch(() => {
        throw new MicroboxHostError("image-missing",
          "The Linux guest is missing SHA256SUMS. Download and extract the complete tested ZIP.");
      }));
      for (const name of files) {
        const expected = checksums.get(name);
        if (!expected) {
          throw new MicroboxHostError("invalid-input", "The Linux guest checksum list is incomplete.");
        }
        const actual = await sha256File(Path.join(source, name)).catch(() => {
          throw new MicroboxHostError("image-missing", "A Linux guest image file could not be read.");
        });
        if (actual !== expected) {
          throw new MicroboxHostError("invalid-input",
            `The Linux guest file ${name} differs from its checksum. Re-extract the ZIP.`);
        }
      }
      installedId = versionedMicroboxId(manifest, checksums.get(manifest.file)!);
      files.push("SHA256SUMS");
    }
    let unpackedBytes = 0;
    for (const name of files) {
      const real = await Fs.realpath(Path.join(source, name)).catch(() => {
        throw new MicroboxHostError("image-missing", "A guest image component is missing.");
      });
      if (!real.startsWith(source + Path.sep)) {
        throw new MicroboxHostError("invalid-input", "Guest image files must be inside their selected folder.");
      }
      const stat = await Fs.stat(real);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024 * 1024) {
        throw new MicroboxHostError("invalid-input", "Guest image is not a supported file.");
      }
      unpackedBytes += stat.size;
    }
    const imagesDir = Path.join(this.root, "images");
    const target = Path.join(imagesDir, installedId);
    // Upgrade in place, but never change the backing file under a live or
    // stopped box's copy-on-write disk. The user must delete those boxes first.
    if (this.updatingImages.has(manifest.id)) {
      throw new MicroboxHostError("busy", "This guest image is already being installed.");
    }
    this.updatingImages.add(manifest.id);
    try {
      if (
        this.creating > 0 ||
        [...this.boxes.values()].some((box) => box.status.imageId === installedId)
      ) {
        throw new MicroboxHostError(
          "busy", "Delete existing boxes using this guest image before installing its update.",
        );
      }
      await Fs.mkdir(imagesDir, { recursive: true });
      // The GitHub ZIP is ~24 MiB, but rootfs.ext2 expands to 1 GiB; an
      // independent installed copy needs that much real storage again.
      const freeBytes = await Fs.statfs(imagesDir)
        .then((stat) => Number(stat.bavail) * Number(stat.bsize), () => undefined);
      if (freeBytes !== undefined && freeBytes < unpackedBytes + 64 * 1024 * 1024) {
        throw new MicroboxHostError("io-error",
          "Not enough free disk space to install the Linux guest. The extracted image is about 1 GiB; free more space and retry.");
      }
      const exists = await Fs.stat(target).then(() => true, () => false);
      const temporary = Path.join(imagesDir, `.install-${randomUUID()}`);
      const backup = Path.join(imagesDir, `.previous-${randomUUID()}`);
      await Fs.mkdir(temporary);
      let backedUp = false;
      let activated = false;
      try {
        for (const file of files) {
          await Fs.copyFile(Path.join(source, file), Path.join(temporary, file));
        }
        if (exists) {
          await Fs.rename(target, backup);
          backedUp = true;
        }
        await Fs.rename(temporary, target);
        activated = true;
        await this.image(installedId);
      } catch (cause) {
        if (activated) await Fs.rm(target, { recursive: true, force: true });
        if (backedUp) {
          // Preserve the previously working image even if the new one fails
          // validation or the final filesystem rename fails.
          await Fs.rename(backup, target);
        }
        if (cause instanceof MicroboxHostError) throw cause;
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code === "ENOSPC") {
          throw new MicroboxHostError("io-error", "Not enough free disk space to copy the guest image.");
        }
        if (code === "EACCES" || code === "EPERM" || code === "EBUSY") {
          throw new MicroboxHostError("io-error",
            "Sparky cannot replace the installed image because its files are in use or access is denied. Close running boxes and check folder permissions.");
        }
        throw new MicroboxHostError("io-error",
          "Couldn't copy the image into Sparky's data folder. Check available disk space and folder permissions.");
      } finally {
        await Fs.rm(temporary, { recursive: true, force: true });
      }
      if (backedUp) await Fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return {
        imageId: installedId, name: manifest.name,
        kind: manifest.kind, architecture: manifest.architecture,
      };
    } finally {
      this.updatingImages.delete(manifest.id);
    }
  }

  private async image(id: string): Promise<{ manifest: GuestManifest; directory: string }> {
    if (!SAFE_IMAGE_ID.test(id)) throw new MicroboxHostError("invalid-input", "Invalid image selection.");
    const directory = Path.join(this.root, "images", id);
    const raw = await Fs.readFile(Path.join(directory, "image.json"), "utf8").catch(() => {
      throw new MicroboxHostError("image-missing", "Install a guest image before creating a box.");
    });
    let manifest: GuestManifest;
    try { manifest = JSON.parse(raw) as GuestManifest; }
    catch { throw new MicroboxHostError("image-missing", "Guest image metadata is invalid."); }
    if (
      (manifest.id !== id && !(
        OFFICIAL_MICRO_IMAGE_ID.test(manifest.id) && OFFICIAL_MICRO_VERSIONED_ID.test(id)
      )) ||
      !["linux-kernel", "disk", "installer-iso"].includes(manifest.kind) ||
      !["x86_64", "aarch64"].includes(manifest.architecture) ||
      !SAFE_IMAGE_FILE.test(manifest.file) ||
      (manifest.kind === "disk" && !manifest.file.toLowerCase().endsWith(".qcow2")) ||
      (manifest.kind === "linux-kernel" && (!manifest.kernel || !SAFE_IMAGE_FILE.test(manifest.kernel)))
    ) throw new MicroboxHostError("image-missing", "The selected guest image is invalid.");
    assertCurrentSparkyMicroImage(manifest);
    if (OFFICIAL_MICRO_IMAGE_ID.test(manifest.id)) {
      // Never launch the old fixed-ID installation: it may still contain a
      // Buildroot login even if a new ZIP was downloaded elsewhere.
      if (id === manifest.id) {
        throw new MicroboxHostError("image-missing",
          "The old Linux image is still installed. Import the verified guest ZIP to create a new image revision.");
      }
      const sums = parseMicroboxChecksums(await Fs.readFile(
        Path.join(directory, "SHA256SUMS"), "utf8",
      ).catch(() => {
        throw new MicroboxHostError("image-missing", "Installed Linux guest checksums are missing.");
      }));
      const rootHash = sums.get(manifest.file);
      if (!rootHash || id !== versionedMicroboxId(manifest, rootHash)) {
        throw new MicroboxHostError("image-missing", "The installed Linux guest identity is inconsistent.");
      }
    }
    const realDir = await Fs.realpath(directory);
    const files = [manifest.file, ...(manifest.kernel ? [manifest.kernel] : [])];
    for (const name of files) {
      const target = await Fs.realpath(Path.join(realDir, name)).catch(() => {
        throw new MicroboxHostError("image-missing", "A required guest image file is missing.");
      });
      if (!target.startsWith(realDir + Path.sep)) {
        throw new MicroboxHostError("image-missing", "Unsafe image file location.");
      }
      const stat = await Fs.stat(target);
      if (!stat.isFile()) throw new MicroboxHostError("image-missing", "Invalid guest image file.");
    }
    return { manifest, directory: realDir };
  }

  async images(): Promise<MicroboxImage[]> {
    const directory = Path.join(this.root, "images");
    const entries = await Fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const output: MicroboxImage[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_IMAGE_ID.test(entry.name)) continue;
      try {
        const { manifest } = await this.image(entry.name);
        output.push({
          imageId: entry.name,
          name: OFFICIAL_MICRO_VERSIONED_ID.test(entry.name)
            ? `${manifest.name} (verified v2)` : manifest.name,
          kind: manifest.kind,
          architecture: manifest.architecture,
        });
      } catch { /* Ignore incomplete images rather than advertising them. */ }
    }
    // Deterministic default: the newest successfully installed guest wins.
    const timestamps = await Promise.all(output.map((image) =>
      Fs.stat(Path.join(directory, image.imageId, "image.json"))
        .then((stat) => stat.mtimeMs, () => 0),
    ));
    return output.map((image, index) => ({ image, time: timestamps[index] ?? 0 }))
      .sort((a, b) => b.time - a.time)
      .map(({ image }) => image);
  }

  list(threadId: string): MicroboxStatus[] {
    return [...this.boxes.values()]
      .filter((entry) => entry.status.threadId === threadId)
      .map((entry) => ({ ...entry.status }));
  }

  private owned(threadId: string, boxId: string): RunningBox {
    const box = this.boxes.get(boxId);
    if (!box) throw new MicroboxHostError("not-found", "The box no longer exists.");
    if (box.status.threadId !== threadId) {
      throw new MicroboxHostError("forbidden", "This box belongs to a different thread.");
    }
    return box;
  }

  async create(input: MicroboxCreateInput, workspaceRoot?: string): Promise<MicroboxStatus> {
    if (this.deletedThreads.has(input.threadId)) {
      throw new MicroboxHostError("forbidden", "This chat thread no longer exists.");
    }
    if (this.stopping) throw new MicroboxHostError("busy", "Microboxes are shutting down.");
    if (this.updatingImages.has(input.imageId)) throw new MicroboxHostError("busy", "This image is being updated.");
    if (this.boxes.size + this.creating >= MAX_BOXES) {
      throw new MicroboxHostError("limit", "Stop an existing box first (maximum four).");
    }
    this.creating += 1;
    try {
    const { manifest, directory: imageDir } = await this.image(input.imageId);
    const boxId = randomUUID();
    const directory = Path.join(this.root, "boxes", boxId);
    const memoryMiB = input.memoryMiB ?? (manifest.kind === "linux-kernel" ? 512 : 2048);
    const cpus = input.cpus ?? 2;
    if (memoryMiB < 256 || memoryMiB > 8192 || cpus < 1 || cpus > 4) {
      throw new MicroboxHostError("invalid-input", "Invalid box resource limits.");
    }
    await Fs.mkdir(directory, { recursive: true });
    const args = [
      "-nodefaults", "-no-user-config", "-display", "none",
      "-monitor", "none", "-serial", manifest.kind === "linux-kernel"
        ? `file:${Path.join(directory, "boot-serial.log")}` : "null", "-qmp", "stdio",
      "-m", String(memoryMiB), "-smp", String(cpus),
      "-machine", manifest.architecture === "aarch64" ? "virt" : "pc",
      ...(manifest.architecture === "aarch64" ? ["-cpu", "max"] : []),
      // The Linux guest's known-good QEMU tests use TCG. WHPX on Windows can
      // change the observed boot/display path; avoid it until separately
      // verified through this same HostBoxManager integration path.
      ...(process.platform === "win32" && manifest.kind === "linux-kernel" &&
        OFFICIAL_MICRO_IMAGE_ID.test(manifest.id)
        ? ["-accel", "tcg,thread=multi"] : accelerator(manifest.architecture)),
      "-device", manifest.architecture === "aarch64" ? "virtio-gpu-pci" : "virtio-vga",
      "-device", "qemu-xhci",
      "-device", "usb-tablet",
      // ARM virt has no implicit PS/2 keyboard; attach a real USB HID keyboard.
      "-device", "usb-kbd",
      ...(input.internet ? ["-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0"] : ["-nic", "none"]),
    ];
    const guestFile = Path.join(imageDir, manifest.file);
    let artifactName: string | undefined;
    try {
      if (input.artifactRelativePath !== undefined) {
        if (!workspaceRoot || !Path.isAbsolute(workspaceRoot)) {
          throw new MicroboxHostError("forbidden", "An authenticated workspace is required to attach an installer.");
        }
        const relative = input.artifactRelativePath;
        if (Path.isAbsolute(relative) || relative.includes("\\") || relative.includes(":") || relative.includes("\0")) {
          throw new MicroboxHostError("invalid-input", "Installer path must be relative to the workspace.");
        }
        const root = await Fs.realpath(workspaceRoot);
        const resolved = await Fs.realpath(Path.resolve(root, relative)).catch(() => {
          throw new MicroboxHostError("not-found", "The installer was not found in this workspace.");
        });
        if (!resolved.startsWith(root + Path.sep)) {
          throw new MicroboxHostError("forbidden", "Installers must be inside this thread's workspace.");
        }
        const stat = await Fs.stat(resolved);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) {
          throw new MicroboxHostError("invalid-input", "Installer file must be nonempty and smaller than 2 GiB.");
        }
        const extension = Path.extname(resolved).toLowerCase();
        if (![".exe", ".msi", ".appimage", ".deb", ".rpm", ".sh", ".pkg"].includes(extension)) {
          throw new MicroboxHostError("invalid-input", "Unsupported installer artifact type.");
        }
        artifactName = "sparky-installer" + extension;
        const mountDirectory = Path.join(directory, "installer");
        await Fs.mkdir(mountDirectory, { recursive: true });
        await Fs.copyFile(resolved, Path.join(mountDirectory, artifactName));
        // QEMU snapshots a virtual FAT directory at boot; never mutate while guest is running.
        args.push(
          "-drive", `file=fat:ro:${guestDrivePath(mountDirectory)},format=raw,if=none,id=installer`,
          "-device", "usb-storage,drive=installer",
        );
      }
      if (manifest.kind === "linux-kernel") {
        const overlay = Path.join(directory, "rootfs.qcow2");
        // A sparse copy-on-write layer starts quickly without duplicating the
        // entire guest root filesystem for each concurrently running box.
        await execFile(imageTool("qemu-img"), [
          "create", "-f", "qcow2", "-F", "raw", "-b", guestFile, overlay,
        ], { timeout: 60_000, windowsHide: true, env: guestRuntimeEnv() });
        args.push(
          "-kernel", Path.join(imageDir, manifest.kernel!),
          "-append", visibleLinuxKernelArguments(manifest.append ?? "root=/dev/vda rw console=ttyS0"),
          "-drive", `file=${guestDrivePath(overlay)},format=qcow2,if=virtio`,
        );
      } else if (manifest.kind === "disk") {
        const overlay = Path.join(directory, "disk.qcow2");
        await execFile(imageTool("qemu-img"), [
          "create", "-f", "qcow2", "-F", "qcow2", "-b", guestFile, overlay,
        ], { timeout: 60_000, windowsHide: true, env: guestRuntimeEnv() });
        args.push("-drive", `file=${guestDrivePath(overlay)},format=qcow2,if=virtio`);
      } else {
        const overlay = Path.join(directory, "disk.qcow2");
        await execFile(imageTool("qemu-img"), ["create", "-f", "qcow2", overlay, "32G"], {
          timeout: 60_000, windowsHide: true, env: guestRuntimeEnv(),
        });
        args.push(
          "-drive", `file=${guestDrivePath(overlay)},format=qcow2,if=virtio`,
          "-drive", `file=${guestDrivePath(guestFile)},media=cdrom,readonly=on`,
          "-boot", "order=d",
        );
      }
      const child = spawn(imageBinary(manifest.architecture), args, {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: guestRuntimeEnv(),
      });
      // Drain diagnostic stderr; otherwise a full pipe could stall the VM.
      child.stderr.resume();
      const qmp = new QmpClient(child);
      const status: MutableStatus = {
        boxId,
        threadId: input.threadId,
        imageId: input.imageId,
        name: input.name || manifest.name,
        state: "starting",
        memoryMiB, cpus,
        internet: input.internet ?? false,
        ...(artifactName ? { artifactName } : {}),
        startedAt: new Date().toISOString(),
      };
      this.boxes.set(boxId, { status, process: child, qmp, directory, width: 1024, height: 768 });
      child.on("exit", () => {
        const current = this.boxes.get(boxId);
        if (!current || current.status.state === "error") return;
        if (current.status.state === "starting") {
          current.status.state = "error";
          current.status.bootMessage = "The Linux guest exited before its desktop finished starting.";
        } else {
          current.status.state = "stopped";
        }
      });
      let startupTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (this.stopping) throw new Error("Box setup was disabled.");
        await Promise.race([
          qmp.ready,
          new Promise<never>((_, reject) => {
            startupTimeout = setTimeout(() => reject(new Error("VM startup timed out.")), 20_000);
          }),
        ]);
        if (this.stopping || this.deletedThreads.has(input.threadId) || status.state === "stopped") {
          throw new Error("Box setup was canceled.");
        }
        if (manifest.kind === "linux-kernel" && manifest.id.startsWith("sparky-micro-")) {
          status.bootMessage = "Starting the Linux graphical desktop…";
          // Return once the VM monitor is connected, but report "running"
          // only after the guest actually starts Weston.
          void this.watchLinuxDesktop(
            boxId,
            manifest.architecture === nativeArch ? LINUX_BOOT_TIMEOUT_MS : ARM_EMULATED_BOOT_TIMEOUT_MS,
          ).catch(() => {
            const current = this.boxes.get(boxId);
            if (current && current.status.state === "starting") {
              current.status.state = "error";
              current.status.bootMessage = "The Linux desktop could not start.";
              void current.qmp.stop().catch(() => undefined);
            }
          });
        } else {
          status.state = "running";
        }
      } catch {
        await qmp.stop();
        this.boxes.delete(boxId);
        throw new MicroboxHostError("launch-failed", "Sparky could not start this guest image.");
      } finally {
        if (startupTimeout) clearTimeout(startupTimeout);
      }
      return { ...status };
    } catch (cause) {
      if (!this.boxes.has(boxId)) await Fs.rm(directory, { recursive: true, force: true });
      if (cause instanceof MicroboxHostError) throw cause;
      throw new MicroboxHostError("launch-failed", "Sparky could not create the box.");
    }
    } finally {
      this.creating -= 1;
    }
  }

  status(threadId: string, boxId: string): MicroboxStatus {
    return { ...this.owned(threadId, boxId).status };
  }

  private running(threadId: string, boxId: string): RunningBox {
    const box = this.owned(threadId, boxId);
    if (!acceptsBoxInput(box.status.state)) {
      throw new MicroboxHostError("busy", "This box isn't accepting input.");
    }
    return box;
  }

  async snapshot(threadId: string, boxId: string): Promise<MicroboxSnapshot> {
    const box = this.owned(threadId, boxId);
    if (box.status.state !== "starting" && box.status.state !== "running") {
      throw new MicroboxHostError("busy", "This box is not booting or running.");
    }
    const image = Path.join(box.directory, `screen-${randomUUID()}.png`);
    let bytes: Buffer;
    try {
      await box.qmp.command("screendump", { filename: image, format: "png" });
      bytes = await Fs.readFile(image);
    } finally {
      await Fs.rm(image, { force: true }).catch(() => undefined);
    }
    if (bytes.length > MAX_SNAPSHOT_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new MicroboxHostError("protocol-error", "The box could not provide a valid screenshot.");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 8192 || height > 8192) {
      throw new MicroboxHostError("protocol-error", "Invalid VM screen size.");
    }
    box.width = width; box.height = height;
    return { mimeType: "image/png", data: bytes.toString("base64"), width, height };
  }

  async click(threadId: string, boxId: string, x: number, y: number, button: "left" | "right" | "middle"): Promise<void> {
    const box = this.running(threadId, boxId);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= box.width || y >= box.height) {
      throw new MicroboxHostError("invalid-input", "Click coordinates are outside the VM display.");
    }
    const value = (n: number, extent: number) => Math.round((n * 32767) / Math.max(extent - 1, 1));
    await box.qmp.command("input-send-event", { events: [
      { type: "abs", data: { axis: "x", value: value(x, box.width) } },
      { type: "abs", data: { axis: "y", value: value(y, box.height) } },
      { type: "btn", data: { button, down: true } },
      { type: "btn", data: { button, down: false } },
    ] });
  }

  async drag(
    threadId: string,
    boxId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
  ): Promise<void> {
    const box = this.running(threadId, boxId);
    const validPoint = (x: number, y: number) =>
      Number.isInteger(x) && Number.isInteger(y) &&
      x >= 0 && y >= 0 && x < box.width && y < box.height;
    if (!validPoint(fromX, fromY) || !validPoint(toX, toY)) {
      throw new MicroboxHostError("invalid-input", "Drag coordinates are outside the VM display.");
    }
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 1200) {
      throw new MicroboxHostError("invalid-input", "Drag duration must be between 100 and 1200 ms.");
    }
    const abs = (n: number, extent: number) => Math.round(n * 32767 / Math.max(extent - 1, 1));
    const move = (x: number, y: number) => [
      { type: "abs", data: { axis: "x", value: abs(x, box.width) } },
      { type: "abs", data: { axis: "y", value: abs(y, box.height) } },
    ];
    const button = { type: "btn", data: { button: "left", down: true } };
    await box.qmp.command("input-send-event", { events: [...move(fromX, fromY), button] });
    try {
      const steps = Math.min(40, Math.max(5, Math.ceil(durationMs / 30)));
      for (let index = 1; index <= steps; index++) {
        const t = index / steps;
        const x = Math.round(fromX + (toX - fromX) * t);
        const y = Math.round(fromY + (toY - fromY) * t);
        await box.qmp.command("input-send-event", { events: move(x, y) });
        if (index < steps) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(durationMs / steps)));
        }
      }
    } finally {
      // Always release the mouse even when the drag is interrupted.
      await box.qmp.command("input-send-event", {
        events: [{ type: "btn", data: { button: "left", down: false } }],
      }).catch(() => undefined);
    }
  }

  async scroll(
    threadId: string,
    boxId: string,
    direction: "up" | "down",
    steps: number,
  ): Promise<void> {
    const box = this.running(threadId, boxId);
    if (!Number.isInteger(steps) || steps < 1 || steps > 16) {
      throw new MicroboxHostError("invalid-input", "Scroll steps must be between 1 and 16.");
    }
    const button = direction === "up" ? "wheel-up" : "wheel-down";
    const events = Array.from({ length: steps }, () => [
      { type: "btn", data: { button, down: true } },
      { type: "btn", data: { button, down: false } },
    ]).flat();
    await box.qmp.command("input-send-event", { events });
  }

  async press(threadId: string, boxId: string, key: string): Promise<void> {
    const box = this.running(threadId, boxId);
    const aliases: Record<string, string> = {
      control: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift", meta: "meta_l",
      enter: "ret", return: "ret", escape: "esc", esc: "esc", tab: "tab",
      backspace: "backspace", delete: "delete", space: "spc",
      arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
      home: "home", end: "end", pageup: "pgup", pagedown: "pgdn",
    };
    const keys = key.split("+").map((part) => aliases[part.trim().toLowerCase()] ?? part.trim().toLowerCase());
    if (keys.length > 4 || keys.some((part) => !/^(?:[a-z0-9_]{1,20})$/u.test(part))) {
      throw new MicroboxHostError("invalid-input", "Unsupported keyboard shortcut.");
    }
    await box.qmp.command("input-send-event", { events: [
      ...keys.map((k) => keyEvent(k, true)),
      ...[...keys].reverse().map((k) => keyEvent(k, false)),
    ] });
  }

  async type(threadId: string, boxId: string, text: string): Promise<void> {
    const box = this.running(threadId, boxId);
    if (text.length > 4096) throw new MicroboxHostError("invalid-input", "Text is too long.");
    const events = [...text].flatMap(textKeyEvents);
    for (let index = 0; index < events.length; index += 64) {
      await box.qmp.command("input-send-event", { events: events.slice(index, index + 64) });
    }
  }

  async stop(threadId: string, boxId: string, destroy = false): Promise<void> {
    const box = this.owned(threadId, boxId);
    if (box.status.state !== "stopped") {
      box.status.state = "stopping";
      await box.qmp.stop().catch(() => undefined);
      box.status.state = "stopped";
    }
    if (destroy) {
      this.boxes.delete(boxId);
      await Fs.rm(box.directory, { recursive: true, force: true });
    }
  }

  /** Thread deletion must stop running VMs and discard private disks. */
  async destroyThread(threadId: string): Promise<void> {
    // Keep a tombstone so an overlapping VM boot cannot resurrect a deleted chat.
    this.deletedThreads.add(threadId);
    const owned = [...this.boxes.entries()]
      .filter(([, box]) => box.status.threadId === threadId);
    await Promise.all(owned.map(async ([boxId, box]) => {
      this.boxes.delete(boxId);
      await box.qmp.stop().catch(() => undefined);
      box.status.state = "stopped";
      await Fs.rm(box.directory, { recursive: true, force: true });
    }));
  }

  resume(): void {
    this.stopping = false;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    const entries = [...this.boxes.values()];
    await Promise.all(entries.map(async (box) => {
      await box.qmp.stop().catch(() => undefined);
      box.status.state = "stopped";
    }));
  }
}
