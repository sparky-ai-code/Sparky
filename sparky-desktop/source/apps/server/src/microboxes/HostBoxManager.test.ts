// @effect-diagnostics nodeBuiltinImport:off - Temporary filesystem regression tests.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { MicroboxImage } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostBoxManager } from "./HostBoxManager.ts";

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
