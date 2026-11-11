/**
 * Hypervisor-level boot smoke check for the custom Sparky Micro Linux image.
 * This verifies QMP startup and produces a real VM framebuffer screenshot.
 * It does not by itself certify that all graphical applications are functional.
 */
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, copyFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const runFile = promisify(execFile);

const [imageDirectory, screenshotDirectory] = process.argv.slice(2);
if (!imageDirectory || !screenshotDirectory) {
  process.stderr.write("Usage: node smoke-boot.mjs <image-dir> <screenshots-dir>\n");
  process.exitCode = 2;
} else {
  await main(resolve(imageDirectory), resolve(screenshotDirectory));
}

async function main(directory, screenshotDirectory) {
  const manifest = JSON.parse(await readFile(join(directory, "image.json"), "utf8"));
  const arch = manifest.architecture;
  if (!["x86_64", "aarch64"].includes(arch) || manifest.kind !== "linux-kernel") {
    throw new Error("Unsupported graphical Linux boot image.");
  }
  const scratch = await mkdtemp(join(tmpdir(), "sparky-micro-smoke-"));
  const target = join(scratch, "rootfs.qcow2");
  let machine;
  let pending = new Map();
  let sequence = 0;
  let pendingBuffer = "";
  let greet;
  let failGreeting;
  const greeted = new Promise((resolveReady, rejectReady) => {
    greet = resolveReady;
    failGreeting = rejectReady;
  });
  const fail = (error) => {
    failGreeting(error);
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
  };
  const request = (execute, args = {}) => new Promise((fulfill, reject) => {
    const id = String(++sequence);
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The guest monitor did not respond."));
    }, 10_000);
    pending.set(id, { fulfill, reject, timeout });
    machine.stdin.write(JSON.stringify({ execute, arguments: args, id }) + "\n");
  });
  try {
    await runFile("qemu-img", [
      "create", "-f", "qcow2", "-F", "raw", "-b",
      join(directory, manifest.file), target,
    ], { timeout: 60_000 });
    const args = [
      "-nodefaults", "-no-user-config",
      "-machine", arch === "aarch64" ? "virt" : "pc",
      ...(arch === "aarch64" ? ["-cpu", "max"] : []),
      "-accel", "tcg",
      "-m", "512", "-smp", "2",
      "-display", "none", "-monitor", "none", "-serial", "null",
      "-qmp", "stdio",
      "-device", arch === "aarch64" ? "virtio-gpu-pci" : "virtio-vga",
      "-device", "qemu-xhci", "-device", "usb-tablet",
      "-nic", "none",
      "-kernel", join(directory, manifest.kernel),
      "-append", manifest.append ?? "root=/dev/vda rw",
      "-drive", `file=${target.replaceAll(",", ",,")},format=qcow2,if=virtio`,
    ];
    machine = spawn(`qemu-system-${arch}`, args, {
      cwd: scratch, stdio: ["pipe", "pipe", "pipe"],
    });
    machine.stderr.resume();
    machine.once("error", fail);
    machine.once("exit", () => fail(new Error("The graphical box stopped before verification.")));
    machine.stdout.setEncoding("utf8");
    machine.stdout.on("data", (chunk) => {
      pendingBuffer += chunk;
      if (pendingBuffer.length > 1_000_000) return fail(new Error("Unexpected monitor output."));
      let newline;
      while ((newline = pendingBuffer.indexOf("\n")) >= 0) {
        const raw = pendingBuffer.slice(0, newline);
        pendingBuffer = pendingBuffer.slice(newline + 1);
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        if (data.QMP) { greet(); continue; }
        const entry = pending.get(data.id);
        if (!entry) continue;
        pending.delete(data.id);
        clearTimeout(entry.timeout);
        if (data.error) entry.reject(new Error("Guest monitor rejected the command."));
        else entry.fulfill(data.return);
      }
    });
    await Promise.race([
      greeted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Guest monitor did not start.")), 20_000)),
    ]);
    await request("qmp_capabilities");
    await mkdir(screenshotDirectory, { recursive: true });
    const capture = join(scratch, randomUUID() + ".png");
    // Give Weston time to render. Capture is evidence for review, not a GUI assertion.
    await new Promise((resolveWait) => setTimeout(resolveWait, 15_000));
    await request("screendump", { filename: capture, format: "png" });
    const screenshot = await readFile(capture);
    if (
      screenshot.length < 128 ||
      screenshot.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      screenshot.readUInt32BE(16) < 640 ||
      screenshot.readUInt32BE(20) < 480
    ) {
      throw new Error("Guest did not expose a valid framebuffer screenshot.");
    }
    await copyFile(capture, join(screenshotDirectory, `sparky-micro-${arch}.png`));
    process.stdout.write(`Sparky Micro Linux ${arch}: boot monitor and framebuffer passed.\n`);
  } finally {
    if (machine) {
      machine.removeAllListeners("exit");
      machine.removeAllListeners("error");
      machine.kill();
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
