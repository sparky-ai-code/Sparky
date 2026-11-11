// @effect-diagnostics nodeBuiltinImport:off - Temporary filesystem regression tests.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { MicroboxImage } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostBoxManager, microLinuxBootState, visibleLinuxKernelArguments } from "./HostBoxManager.ts";

describe("Microboxes image import", () => {
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
      }));
      await writeFile(Path.join(source, "bzImage"), "kernel image");
      await writeFile(Path.join(source, "rootfs.ext2"), "filesystem image");

      const manager = new HostBoxManager(Path.join(root, "data"));
      await expect(manager.importImage(source)).resolves.toEqual(image);
      expect(Schema.is(MicroboxImage)(image)).toBe(true);
      await expect(manager.images()).resolves.toEqual([image]);
      await expect(readFile(Path.join(root, "data", "images", image.imageId, "bzImage"), "utf8"))
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
        file: "rootfs.ext2", kernel: "bzImage",
      };
      await writeFile(Path.join(download, "image.json"), JSON.stringify(manifest));
      await writeFile(Path.join(download, "rootfs.ext2"), "version 1");
      await writeFile(Path.join(download, "bzImage"), "kernel 1");
      await manager.importImage(download);
      await writeFile(Path.join(download, "rootfs.ext2"), "version 2");
      await writeFile(Path.join(download, "bzImage"), "kernel 2");
      await expect(manager.importImage(download)).resolves.toMatchObject({
        imageId: "sparky-micro-x86_64",
      });
      expect(await readFile(Path.join(root, "installed", "images", manifest.id, "rootfs.ext2"), "utf8"))
        .toBe("version 2");
      expect(await readFile(Path.join(root, "installed", "images", manifest.id, "bzImage"), "utf8"))
        .toBe("kernel 2");
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
  it("does not mistake a connected VM monitor or kernel boot output for a desktop", () => {
    expect(microLinuxBootState("Booting the kernel\n")).toBe("booting");
    expect(microLinuxBootState("[0.0] Linux version\nStarting syslogd")).toBe("booting");
    expect(microLinuxBootState("SPARKY_MICRO_DESKTOP_READY\n")).toBe("ready");
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
