/**
 * Hypervisor-level boot smoke check for the custom Sparky Micro Linux image.
 * This verifies QMP startup and produces a real VM framebuffer screenshot.
 * It does not by itself certify that all graphical applications are functional.
 */
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, copyFile, rm, mkdir, writeFile } from "node:fs/promises";
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
  const serialLog = join(scratch, "boot-serial.log");
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
      "-display", "none", "-monitor", "none", "-serial", `file:${serialLog}`,
      "-qmp", "stdio",
      "-device", arch === "aarch64" ? "virtio-gpu-pci" : "virtio-vga",
      "-device", "qemu-xhci", "-device", "usb-tablet", "-device", "usb-kbd",
      "-nic", "none",
      "-kernel", join(directory, manifest.kernel),
      "-append", `${manifest.append ?? "root=/dev/vda rw"} console=tty0`,
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
    // QMP becomes available long before Linux reaches userspace. Requiring an
    // actual desktop-ready signal prevents a SeaBIOS kernel screen from passing.
    // TCG emulation on ARM can be slower than native hardware acceleration.
    const deadline = Date.now() + (arch === "aarch64" ? 180_000 : 120_000);
    let log = "";
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      log = await readFile(serialLog, "utf8").catch(() => "");
      if (log.includes("SPARKY_MICRO_DESKTOP_READY")) {
        ready = true;
        break;
      }
      if (log.includes("SPARKY_MICRO_DESKTOP_ERROR") || /kernel panic|VFS: Unable to mount root fs|No working init found/iu.test(log)) {
        break;
      }
    }
    // Capture both framebuffer and bounded serial diagnostics even on failure.
    // These are purpose-built test images with no user data.
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
    log = await readFile(serialLog, "utf8").catch(() => "");
    if (log) await copyFile(serialLog, join(screenshotDirectory, `sparky-micro-${arch}-serial.log`));
    if (!ready) {
      process.stderr.write(`Guest serial console tail (${arch}):\n${log.slice(-9_000)}\n`);
      throw new Error("Sparky Micro Linux did not start its graphical desktop within the boot deadline.");
    }
    // End-to-end computer-use acceptance test. A working graphical desktop
    // must be able to receive a mouse click and keyboard input, not just paint
    // a framebuffer. Foot starts in the upper-left part of the guest display.
    if (process.env.SPARKY_MICRO_VERIFY_GUI_INPUT === "1") {
      const width = screenshot.readUInt32BE(16);
      const height = screenshot.readUInt32BE(20);
      const inputPoint = (n) => Math.round(n * 32767);
      const mx = inputPoint(0.20);
      const my = inputPoint(0.26);
      await request("input-send-event", { events: [
        { type: "abs", data: { axis: "x", value: mx } },
        { type: "abs", data: { axis: "y", value: my } },
        { type: "btn", data: { button: "left", down: true } },
        { type: "btn", data: { button: "left", down: false } },
      ] });
      await new Promise((res) => setTimeout(res, 350));
      const shellLine = "echo sparkyguiinputok >/dev/ttyS0\n";
      for (const char of shellLine) {
        const shifted = char === ">" || /^[A-Z]$/u.test(char);
        const key = char === " " ? "spc"
          : char === ">" ? "dot"
          : char === "/" ? "slash"
          : char === "\n" ? "ret" : char.toLowerCase();
        const event = (code, down) => ({
          type: "key", data: { down, key: { type: "qcode", data: code } },
        });
        const events = [
          ...(shifted ? [event("shift", true)] : []),
          event(key, true), event(key, false),
          ...(shifted ? [event("shift", false)] : []),
        ];
        await request("input-send-event", { events });
        await new Promise((res) => setTimeout(res, 25));
      }
      let verified = false;
      const inputDeadline = Date.now() + 15_000;
      while (Date.now() < inputDeadline) {
        log = await readFile(serialLog, "utf8").catch(() => "");
        if (log.includes("sparkyguiinputok")) {
          verified = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      if (log) await copyFile(serialLog, join(screenshotDirectory, `sparky-micro-${arch}-serial.log`));
      if (!verified) {
        throw new Error("Guest GUI booted, but mouse/keyboard input did not reach its graphical terminal.");
      }
      process.stdout.write(`Sparky Micro Linux ${arch}: pointer and keyboard exercised in GUI.\n`);
    }
    process.stdout.write(`Sparky Micro Linux ${arch}: desktop-ready signal and framebuffer passed.\n`);
  } finally {
    if (machine) {
      machine.removeAllListeners("exit");
      machine.removeAllListeners("error");
      if (machine.exitCode === null && machine.signalCode === null) {
        const exited = new Promise((resolveExit) => machine.once("close", resolveExit));
        machine.kill();
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 7_000))]);
      }
    }
    if (process.env.SPARKY_MICRO_CAPTURE_GUEST_LOGS === "1") {
      // The CI diagnostic is opt-in. Examine the guest filesystem after VM
      // shutdown so Weston and seatd failures aren't lost when the scratch
      // directory is removed. Never use this on untrusted user images.
      await mkdir(screenshotDirectory, { recursive: true });
      const merged = join(scratch, "merged.raw");
      try {
        await runFile("qemu-img", ["convert", "-O", "raw", target, merged], { timeout: 120_000 });
        for (const name of ["sparky-micro-desktop.log", "seatd.log", "desktop-terminal.log"]) {
          const output = join(screenshotDirectory, `sparky-micro-${arch}-${name}.txt`);
          try {
            const { stdout, stderr } = await runFile(
              "debugfs", ["-R", `cat /var/log/${name}`, merged],
              { timeout: 20_000, maxBuffer: 1_000_000 },
            );
            await writeFile(output, stdout || stderr);
          } catch (error) {
            await writeFile(output, `Could not read guest log: ${error.message}\n`);
          }
        }
      } catch (error) {
        await writeFile(join(screenshotDirectory, "guest-disk-diagnostics.txt"), `Guest log extraction failed: ${error.message}\n`);
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
