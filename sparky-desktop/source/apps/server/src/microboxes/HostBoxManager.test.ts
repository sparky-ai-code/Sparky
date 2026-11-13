// @effect-diagnostics nodeBuiltinImport:off - Temporary filesystem regression tests.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { MicroboxCreateInput } from "@sparky/contracts";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { MicroboxImage } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostBoxManager, acceptsBoxInput, microLinuxBootState, visibleLinuxKernelArguments } from "./HostBoxManager.ts";

async function writeImageSums(folder: string, names: string[]): Promise<void> {
  const lines = await Promise.all(names.map(async (name) => {
    const hash = createHash("sha256").update(await readFile(Path.join(folder, name))).digest("hex");
    return `${hash}  ${name}`;
  }));
  await writeFile(Path.join(folder, "SHA256SUMS"), lines.join("\n") + "\n");
}


describe("Microboxes image import", () => {
  it("imports the real GitHub artifact when Windows extraction adds an outer folder", async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "sparky-box-nested-"));
    const outer = Path.join(root, "extracted");
    const inner = Path.join(outer, "sparky-micro-linux-x86_64-gui-input-tested");
    try {
      await mkdir(inner, { recursive: true });
      await writeFile(Path.join(inner, "image.json"), JSON.stringify({
        id: "sparky-micro-x86_64", name: "Sparky Micro Linux",
        kind: "linux-kernel", architecture: "x86_64",
        file: "rootfs.ext2", kernel: "bzImage", boxImageVersion: 2,
      }));
      await writeFile(Path.join(inner, "bzImage"), "kernel");
      await writeFile(Path.join(inner, "rootfs.ext2"), "filesystem");
      await writeImageSums(inner, ["bzImage", "rootfs.ext2", "image.json"]);
      const manager = new HostBoxManager(Path.join(root, "data"));
      await expect(manager.importImage(outer)).resolves.toMatchObject({
        imageId: expect.stringMatching(/^sparky-micro-x86_64-v2-[0-9a-f]{12}$/u),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects selecting a folder with multiple guest images rather than guessing", async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "sparky-box-ambiguous-"));
    try {
      for (const folder of ["a", "b"]) {
        const nested = Path.join(root, folder);
        await mkdir(nested);
        await writeFile(Path.join(nested, "image.json"), "{}");
      }
      const manager = new HostBoxManager(Path.join(root, "data"));
      await expect(manager.importImage(root)).rejects.toMatchObject({
        code: "image-missing",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports the existing Sparky Micro Linux x86_64 release folder", async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "sparky-box-import-"));
    const source = Path.join(root, "download");
    try {
      await mkdir(source);
      const image = {
        imageId: "sparky-micro-x86_64",
        name: "Sparky Micro Linux",
        kind: "linux-kernel",
        architecture: "x86_64",
      } as const;
      await writeFile(Path.join(source, "image.json"), JSON.stringify({
        id: image.imageId,
        name: image.name,
        kind: image.kind,
        architecture: image.architecture,
        file: "rootfs.ext2",
        kernel: "bzImage",
        append: "root=/dev/vda rw console=ttyS0",
        boxImageVersion: 2,
      }));
      await writeFile(Path.join(source, "bzImage"), "kernel image");
      await writeFile(Path.join(source, "rootfs.ext2"), "filesystem image");
      await writeImageSums(source, ["bzImage", "rootfs.ext2", "image.json"]);

      const manager = new HostBoxManager(Path.join(root, "data"));
      const imported = await manager.importImage(source);
      expect(imported).toMatchObject({ ...image, imageId: expect.stringMatching(/^sparky-micro-x86_64-v2-[0-9a-f]{12}$/u) });
      expect(Schema.is(MicroboxImage)(imported)).toBe(true);
      await expect(manager.images()).resolves.toEqual([{
        ...imported, name: "Sparky Micro Linux (verified v2)",
      }]);
      await expect(readFile(Path.join(root, "data", "images", imported.imageId, "bzImage"), "utf8"))
        .resolves.toBe("kernel image");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows replacing a downloaded guest image without changing its ID", async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "sparky-box-upgrade-"));
    const download = Path.join(root, "download");
    const manager = new HostBoxManager(Path.join(root, "installed"));
    try {
      await mkdir(download);
      const manifest = {
        id: "sparky-micro-x86_64", name: "Sparky Micro Linux",
        kind: "linux-kernel", architecture: "x86_64",
        file: "rootfs.ext2", kernel: "bzImage", boxImageVersion: 2,
      };
      await writeFile(Path.join(download, "image.json"), JSON.stringify(manifest));
      await writeFile(Path.join(download, "rootfs.ext2"), "version 1");
      await writeFile(Path.join(download, "bzImage"), "kernel 1");
      await writeImageSums(download, ["bzImage", "rootfs.ext2", "image.json"]);
      const firstImage = await manager.importImage(download);
      await writeFile(Path.join(download, "rootfs.ext2"), "version 2");
      await writeFile(Path.join(download, "bzImage"), "kernel 2");
      await writeImageSums(download, ["bzImage", "rootfs.ext2", "image.json"]);
      const secondImage = await manager.importImage(download);
      expect(firstImage.imageId).not.toBe(secondImage.imageId);
      expect(secondImage.imageId).toMatch(/^sparky-micro-x86_64-v2-[0-9a-f]{12}$/u);
      expect((await manager.images()).map((image) => image.imageId))
        .toEqual([secondImage.imageId, firstImage.imageId]);
      expect(await readFile(Path.join(root, "installed", "images", firstImage.imageId, "rootfs.ext2"), "utf8"))
        .toBe("version 1");
      expect(await readFile(Path.join(root, "installed", "images", secondImage.imageId, "rootfs.ext2"), "utf8"))
        .toBe("version 2");
      expect(await readFile(Path.join(root, "installed", "images", secondImage.imageId, "bzImage"), "utf8"))
        .toBe("kernel 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a mislabeled root filesystem rather than booting the wrong guest", async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "sparky-box-hash-"));
    const source = Path.join(root, "image");
    try {
      await mkdir(source);
      await writeFile(Path.join(source, "image.json"), JSON.stringify({
        id: "sparky-micro-x86_64", name: "Sparky Micro Linux",
        kind: "linux-kernel", architecture: "x86_64",
        file: "rootfs.ext2", kernel: "bzImage", boxImageVersion: 2,
      }));
      await writeFile(Path.join(source, "bzImage"), "kernel");
      await writeFile(Path.join(source, "rootfs.ext2"), "new GUI filesystem");
      await writeImageSums(source, ["bzImage", "rootfs.ext2", "image.json"]);
      await writeFile(Path.join(source, "rootfs.ext2"), "old text login filesystem");
      const manager = new HostBoxManager(Path.join(root, "data"));
      await expect(manager.importImage(source)).rejects.toMatchObject({ code: "invalid-input" });
      await expect(manager.images()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues rejecting unsafe image IDs even though underscores are supported", async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "sparky-box-import-"));
    const source = Path.join(root, "download");
    try {
      await mkdir(source);
      const manager = new HostBoxManager(Path.join(root, "data"));
      for (const id of ["../escape", "space name", "back\\\\slash"]) {
        await writeFile(Path.join(source, "image.json"), JSON.stringify({
          id, name: "Invalid image", kind: "linux-kernel", architecture: "x86_64",
          file: "rootfs.ext2", kernel: "bzImage",
        }));
        await expect(manager.importImage(source)).rejects.toMatchObject({ code: "invalid-input" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Sparky Micro Linux desktop readiness", () => {
  it("forwards input during boot to avoid a visible but unresponsive VM", () => {
    expect(acceptsBoxInput("starting")).toBe(true);
    expect(acceptsBoxInput("running")).toBe(true);
    expect(acceptsBoxInput("stopped")).toBe(false);
    expect(acceptsBoxInput("stopping")).toBe(false);
    expect(acceptsBoxInput("error")).toBe(false);
  });
  it("does not mistake a connected VM monitor or kernel boot output for a desktop", () => {
    expect(microLinuxBootState("Booting the kernel\n")).toBe("booting");
    expect(microLinuxBootState("[0.0] Linux version\nStarting syslogd")).toBe("booting");
    expect(microLinuxBootState("SPARKY_MICRO_DESKTOP_READY\n")).toBe("ready");
    expect(microLinuxBootState("SPARKY_MICRO_DESKTOP_READY\n", true)).toBe("failed");
    expect(microLinuxBootState(
      "SPARKY_MICRO_INSTALLER_READY\nSPARKY_MICRO_DESKTOP_READY\n", true,
    )).toBe("ready");
    expect(microLinuxBootState(
      "SPARKY_MICRO_INSTALLER_MOUNT_ERROR\nSPARKY_MICRO_DESKTOP_READY\n", true,
    )).toBe("failed");
    expect(microLinuxBootState("Kernel panic - not syncing: VFS: Unable to mount root fs")).toBe("failed");
    expect(microLinuxBootState("SPARKY_MICRO_DESKTOP_ERROR")).toBe("failed");
  });
  it("keeps graphical kernel boot messages visible without dropping the serial console", () => {
    expect(visibleLinuxKernelArguments("root=/dev/vda rw console=ttyS0"))
      .toBe("root=/dev/vda rw console=ttyS0 console=tty0");
    expect(visibleLinuxKernelArguments("root=/dev/vda console=tty0"))
      .toBe("root=/dev/vda console=tty0");
  });
});

describe("Sparky Micro Linux image compatibility", () => {
  it("does not reinstall the old login-only guest from the Windows-installer generation", async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "sparky-old-box-image-"));
    const source = Path.join(root, "image");
    try {
      await mkdir(source);
      await writeFile(Path.join(source, "image.json"), JSON.stringify({
        id: "sparky-micro-x86_64",
        name: "Sparky Micro Linux",
        kind: "linux-kernel",
        architecture: "x86_64",
        file: "rootfs.ext2",
        kernel: "bzImage",
      }));
      const manager = new HostBoxManager(Path.join(root, "installed"));
      await expect(manager.importImage(source)).rejects.toMatchObject({ code: "image-missing" });
      await expect(manager.images()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Real integration verification, enabled only by CI with a compiled guest.
 * Exercises HostBoxManager.importImage/create/snapshot/click/type, not the
 * separate smoke-boot.mjs launcher, to prevent the two paths from diverging.
 */
const realGuest = process.env.SPARKY_MICRO_REAL_GUEST_DIR;
const integrationTest = realGuest ? it : it.skip;
integrationTest("boots and controls the real graphical guest through HostBoxManager without attachment", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "sparky-real-box-"));
  const manager = new HostBoxManager(Path.join(root, "state"));
  const threadId = "microboxes-real-integration" as MicroboxCreateInput["threadId"];
  let bootLog = "";
  try {
    const imported = await manager.importImage(Path.resolve(realGuest!));
    expect(imported.imageId).toMatch(/^sparky-micro-x86_64-v2-[0-9a-f]{12}$/u);
    const images = await manager.images();
    expect(images[0]?.imageId).toBe(imported.imageId);
    const started = await manager.create({
      threadId, imageId: imported.imageId, memoryMiB: 512, cpus: 2,
    });
    const serial = Path.join(root, "state", "boxes", started.boxId, "boot-serial.log");
    const deadline = Date.now() + 120_000;
    let state = "starting";
    while (Date.now() < deadline) {
      const current = manager.status(threadId, started.boxId);
      state = current.state;
      bootLog = await readFile(serial, "utf8").catch(() => "");
      if (current.state === "running" || current.state === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(state, `VM never started its GUI: ${bootLog.slice(-4000)}`).toBe("running");
    expect(bootLog).toContain("SPARKY_MICRO_DESKTOP_READY");

    const screen = await manager.snapshot(threadId, started.boxId);
    expect(screen.width).toBeGreaterThanOrEqual(640);
    expect(screen.height).toBeGreaterThanOrEqual(480);
    await manager.click(threadId, started.boxId,
      Math.round(screen.width * 0.20), Math.round(screen.height * 0.26), "left");
    await new Promise((resolve) => setTimeout(resolve, 350));
    await manager.type(threadId, started.boxId,
      "echo sparky_manager_input_ok >/dev/ttyS0\n");
    let typed = false;
    const inputDeadline = Date.now() + 20_000;
    while (Date.now() < inputDeadline) {
      bootLog = await readFile(serial, "utf8").catch(() => "");
      if (bootLog.includes("sparky_manager_input_ok")) {
        typed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(typed, `UI input did not reach the guest terminal: ${bootLog.slice(-2000)}`).toBe(true);
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

integrationTest("boots and controls the real graphical guest through HostBoxManager with installer attachment", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "sparky-attached-box-"));
  const workspace = Path.join(root, "workspace");
  const manager = new HostBoxManager(Path.join(root, "state"));
  const threadId = "attached-real-integration" as MicroboxCreateInput["threadId"];
  let serialOutput = "";
  try {
    await mkdir(Path.join(workspace, "dist"), { recursive: true });
    await writeFile(Path.join(workspace, "dist", "sample-installer.sh"),
      "#!/bin/sh\\necho attached installer\\n");
    const imported = await manager.importImage(Path.resolve(realGuest!));
    const started = await manager.create({
      threadId,
      imageId: imported.imageId,
      memoryMiB: 512,
      cpus: 2,
      artifactRelativePath: "dist/sample-installer.sh",
    }, workspace);
    expect(started.artifactName).toBe("sparky-installer.sh");
    const serial = Path.join(root, "state", "boxes", started.boxId, "boot-serial.log");
    const deadline = Date.now() + 120_000;
    let state: string = started.state;
    while (Date.now() < deadline) {
      const current = manager.status(threadId, started.boxId);
      state = current.state;
      serialOutput = await readFile(serial, "utf8").catch(() => "");
      if (state === "running" || state === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(state, `Guest failed to boot with attached installer: ${serialOutput.slice(-4000)}`).toBe("running");
    expect(serialOutput).toContain("SPARKY_MICRO_DESKTOP_READY");
    expect(serialOutput, "Guest must mount attached installer on boot").toContain("SPARKY_MICRO_INSTALLER_READY");
    expect(serialOutput).not.toContain("SPARKY_MICRO_INSTALLER_MOUNT_ERROR");
    const screen = await manager.snapshot(threadId, started.boxId);
    expect(screen.width).toBeGreaterThanOrEqual(640);
    expect(screen.height).toBeGreaterThanOrEqual(480);

    // Verify the file is actually accessible to the guest and not merely a
    // second QEMU drive that happens to allow the desktop to start.
    // A desktop-ready marker may precede Foot's first painted frame.
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    await manager.click(threadId, started.boxId,
      Math.round(screen.width * 0.20), Math.round(screen.height * 0.26), "left");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await manager.type(threadId, started.boxId, "echo sparky_attachment_input_ok >/dev/ttyS0\n");
    let keyboardReady = false;
    const keyboardDeadline = Date.now() + 10_000;
    while (Date.now() < keyboardDeadline) {
      serialOutput = await readFile(serial, "utf8").catch(() => "");
      if (serialOutput.includes("sparky_attachment_input_ok")) {
        keyboardReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(keyboardReady, `Guest input did not reach Foot after attachment: ${serialOutput.slice(-2500)}`).toBe(true);
    // S90sparky-micro automatically mounts the second VirtIO FAT partition.
    // Confirm actual file contents can be consumed inside the guest.
    await manager.type(threadId, started.boxId,
      "cat /mnt/sparky-installer/sparky-installer.sh >/dev/ttyS0\n");
    let readable = false;
    const mountDeadline = Date.now() + 20_000;
    while (Date.now() < mountDeadline) {
      serialOutput = await readFile(serial, "utf8").catch(() => "");
      if (serialOutput.includes("attached installer")) {
        readable = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(readable, `Attached file was not readable from the guest: ${serialOutput.slice(-6000)}`).toBe(true);
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
