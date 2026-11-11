# Sparky Micro Linux guest

This is a **custom image produced from the Linux kernel + Buildroot**. It does
not fork an existing Linux distribution. The guest contains BusyBox, musl,
the Weston Wayland compositor, seatd, input drivers and a small set of test
client applications, with Pixman software rendering.

Build on Linux with `bash microboxes/os/build-x86_64.sh` (x86-64) or
`bash microboxes/os/build-aarch64.sh` (ARM64). Both scripts use the pinned
Buildroot 2026.08.1 release and produce a kernel (`bzImage` or `Image`),
ext filesystem, `image.json` and `SHA256SUMS`. The resulting guest image
can be imported from Settings → Microboxes, or installed under
`microboxes/images/sparky-micro-<architecture>` in the server data directory.

ARM64 uses the virtual AArch64 machine with a 64-bit CPU definition, and
initially requires software rasterization through Weston/Pixman.

GitHub Actions can build and upload this image as an artifact without publishing
a release. A separate signed distribution mechanism is required before the
desktop app can provide one-click guest image downloads.

The initial OS boots a graphical Weston desktop. It is not a general-purpose
Linux package manager distribution; graphical apps for this guest must be
compiled against its userspace or packaged as compatible static binaries.

Windows and macOS installer testing requires separate, properly licensed
guest operating systems. The Sparky Micro Linux image does not run .exe, .msi,
.dmg, or .pkg installers.
