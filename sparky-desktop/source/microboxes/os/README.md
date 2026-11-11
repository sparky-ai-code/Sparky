# Sparky Micro Linux guest

This is a **custom image produced from the Linux kernel + Buildroot**. It does
not fork an existing Linux distribution. The guest contains BusyBox, musl,
the Weston Wayland compositor, seatd, input drivers and a small set of test
client applications, with Pixman software rendering.

Build on Linux: `bash microboxes/os/build-x86_64.sh`. The script uses the
official Buildroot 2026.08.1 release and produces a `bzImage`, ext filesystem,
`image.json` and `SHA256SUMS`. These files form one installed image directory
under `microboxes/images/sparky-micro-x86_64` in the **server** data directory.

GitHub Actions can build and upload this image as an artifact without publishing
a release. A separate signed distribution mechanism is required before the
desktop app can provide one-click guest image downloads.

The initial OS boots a graphical Weston desktop. It is not a general-purpose
Linux package manager distribution; graphical apps for this guest must be
compiled against its userspace or packaged as compatible static binaries.

Windows and macOS installer testing requires separate, properly licensed
guest operating systems. The Sparky Micro Linux image does not run .exe, .msi,
.dmg, or .pkg installers.
