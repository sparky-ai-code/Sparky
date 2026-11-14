# Sparky Micro Linux guest

This is a **custom image produced from the Linux kernel + Buildroot**. It does
not fork an existing Linux distribution. The guest contains BusyBox, musl,
the Weston Wayland compositor, seatd, input drivers and a small set of test
client applications, with Pixman software rendering.

Build on Linux with `bash microboxes/os/build-x86_64.sh` (x86-64) or
`bash microboxes/os/build-aarch64.sh` (ARM64). Both scripts use the pinned
Buildroot 2026.08.1 release and produce a kernel (`bzImage` or `Image`),
ext filesystem, `image.json` and `SHA256SUMS`. The resulting guest image is embedded into Sparky installers and automatically
imported on first use. No image download, extraction or Settings import button
is required. A copy is installed under the server data directory as a
checksum-derived revision rather than a single mutable image identity.

ARM64 uses the virtual AArch64 machine with a 64-bit CPU definition, and
initially requires software rasterization through Weston/Pixman.

The installer workflow builds and smoke-tests the Linux guest, checks SHA-256
integrity, and bundles the architecture-matched image in the desktop
application's `microboxes` resources. Distribution signing, provenance and
native host acceptance still need to be validated before production release.

The image is configured to boot directly into a graphical Weston session
with a Foot Wayland terminal (as a readily keyboard/mouse-controllable test
application). There is **no default text-console login prompt**: the guest
is an automated graphical workspace, not an interactive user-login distro.
Serial output still reports desktop readiness or clear startup failures.
An older test image that stops at `buildroot login:` must be replaced with
an image built from the updated sources.

The initial OS boots a graphical Weston desktop. It is not a general-purpose
Linux package manager distribution; graphical apps for this guest must be
compiled against its userspace or packaged as compatible static binaries.

Windows and macOS installer testing requires separate, properly licensed
guest operating systems. The Sparky Micro Linux image does not run .exe, .msi,
.dmg, or .pkg installers.

### Required guest image revision

Rebuilding Sparky's installer now **includes** the newly boot-verified Linux
guest. Installing Sparky and then enabling Microboxes is sufficient to prepare
the guest without manual image selection. Current official images include
`"boxImageVersion": 2`; older login-only images are rejected. Each content
revision is independently installed, preserving existing box disks until they
are removed. A successful compile alone does **not** certify the image: its
graphical boot-and-input smoke test must pass as well.

### Wayland display readiness

The Linux guest pins the compositor to `wayland-0` with an explicit Weston
`--socket` option. This avoids a Weston 15 default of `wayland-1` which
previously left the guest visible but incorrectly marked as booting; the
Wayland terminal and desktop-ready handshake use that same display name.

### Installer attachments

The host exposes the workspace-scoped installer as the **second VirtIO disk**
(`/dev/vdb1`) after the Linux root disk (`/dev/vda`). The source file is
copied into the box's private staging folder, and the guest's write operations
are redirected into an ephemeral QEMU snapshot. No writes affect the workspace.
The guest mounts the FAT partition read-only at `/mnt/sparky-installer` and
logs `SPARKY_MICRO_INSTALLER_READY` on its serial console. When no installer is
attached, boot proceeds normally without any mount attempt.

Installing an image is not equivalent to executing an installer automatically.
Agents must explicitly start an application after identifying its compatible
package or executable format. Linux Microboxes cannot run Windows `.exe` or
`.msi` installers natively; those require a compatible Windows guest.
The previously released guest image lacks built-in VFAT support. **Use a newly
built guest kernel/filesystem from this PR for attached installers** and
create a new box using its checksum-derived image ID.
