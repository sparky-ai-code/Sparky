// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Local hypervisor process boundary.
import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import { existsSync } from "node:fs";
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
const SAFE_IMAGE_ID = /^[a-z0-9-]{1,48}$/u;
const SAFE_IMAGE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

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
  private stopping = false;
  private creating = 0;

  private readonly root: string;
  constructor(root: string) { this.root = root; }

  async importImage(sourceDirectory: string): Promise<MicroboxImage> {
    if (!Path.isAbsolute(sourceDirectory)) {
      throw new MicroboxHostError("invalid-input", "Choose an image folder on this computer.");
    }
    const source = await Fs.realpath(sourceDirectory).catch(() => {
      throw new MicroboxHostError("image-missing", "The selected image folder cannot be opened.");
    });
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
    const files = ["image.json", manifest.file, ...(manifest.kernel ? [manifest.kernel] : [])];
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
    }
    const imagesDir = Path.join(this.root, "images");
    const target = Path.join(imagesDir, manifest.id);
    await Fs.mkdir(imagesDir, { recursive: true });
    const exists = await Fs.stat(target).then(() => true, () => false);
    if (exists) throw new MicroboxHostError("invalid-input", "This guest image is already installed.");
    const temporary = Path.join(imagesDir, `.install-${randomUUID()}`);
    await Fs.mkdir(temporary);
    let installed = false;
    try {
      for (const file of files) await Fs.copyFile(Path.join(source, file), Path.join(temporary, file));
      await Fs.rename(temporary, target);
      installed = true;
      await this.image(manifest.id);
    } catch (cause) {
      await Fs.rm(temporary, { recursive: true, force: true });
      if (installed) await Fs.rm(target, { recursive: true, force: true });
      if (cause instanceof MicroboxHostError) throw cause;
      throw new MicroboxHostError("io-error", "Couldn't install this guest image.");
    }
    return {
      imageId: manifest.id, name: manifest.name,
      kind: manifest.kind, architecture: manifest.architecture,
    };
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
      manifest.id !== id ||
      !["linux-kernel", "disk", "installer-iso"].includes(manifest.kind) ||
      !["x86_64", "aarch64"].includes(manifest.architecture) ||
      !SAFE_IMAGE_FILE.test(manifest.file) ||
      (manifest.kind === "linux-kernel" && (!manifest.kernel || !SAFE_IMAGE_FILE.test(manifest.kernel)))
    ) throw new MicroboxHostError("image-missing", "The selected guest image is invalid.");
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
          imageId: manifest.id,
          name: manifest.name,
          kind: manifest.kind,
          architecture: manifest.architecture,
        });
      } catch { /* Ignore incomplete images rather than advertising them. */ }
    }
    return output;
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
    if (this.stopping) throw new MicroboxHostError("busy", "Microboxes are shutting down.");
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
      "-monitor", "none", "-serial", "null", "-qmp", "stdio",
      "-m", String(memoryMiB), "-smp", String(cpus),
      "-machine", manifest.architecture === "aarch64" ? "virt" : "pc",
      ...accelerator(manifest.architecture),
      "-device", manifest.architecture === "aarch64" ? "virtio-gpu-pci" : "virtio-vga",
      "-device", "qemu-xhci",
      "-device", "usb-tablet",
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
        const overlay = Path.join(directory, "rootfs.img");
        await Fs.copyFile(guestFile, overlay);
        args.push(
          "-kernel", Path.join(imageDir, manifest.kernel!),
          "-append", manifest.append ?? "root=/dev/vda rw console=ttyS0",
          "-drive", `file=${guestDrivePath(overlay)},format=raw,if=virtio`,
        );
      } else if (manifest.kind === "disk") {
        const overlay = Path.join(directory, "disk.qcow2");
        await execFile(imageTool("qemu-img"), [
          "create", "-f", "qcow2", "-F", "qcow2", "-b", guestFile, overlay,
        ], { timeout: 60_000, windowsHide: true });
        args.push("-drive", `file=${guestDrivePath(overlay)},format=qcow2,if=virtio`);
      } else {
        const overlay = Path.join(directory, "disk.qcow2");
        await execFile(imageTool("qemu-img"), ["create", "-f", "qcow2", overlay, "32G"], {
          timeout: 60_000, windowsHide: true,
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
        if (current) current.status.state = "stopped";
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
        if (this.stopping || status.state === "stopped") throw new Error("Box setup was disabled.");
        status.state = "running";
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
    if (box.status.state !== "running") {
      throw new MicroboxHostError("busy", "This box isn't running.");
    }
    return box;
  }

  async snapshot(threadId: string, boxId: string): Promise<MicroboxSnapshot> {
    const box = this.running(threadId, boxId);
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
