# Sparky Microboxes: implementation and operations

This document may name internal virtualization components. **Never expose the word
"QEMU" or underlying host command/output in Sparky's end-user interface.** The
user-facing setup message is **"Setting up Sparky Microboxes…"** and the right
panel tab label is **"Boxes"**.

## Implemented in draft PR #108

- Server-authoritative `microboxesEnabled` switch (off by default); every
  create, list, screenshot and input operation checks its current value.
- Separate `microboxesInternetEnabled` switch (off by default). The host
  uses user-mode NAT when requested; no networking for other boxes.
- Host runtime detection and explicit, privileged Electron confirmation for
  WinGet on Windows, Homebrew on macOS and selected Linux package managers.
  Host setup checks binaries but does **not** imply a guest image exists.
- Server-managed VM processes, bounded RAM/CPU, maximum four live boxes,
  sparse copy-on-write guest disks rather than full disk copies,
  per-thread ownership and cleanup on server shutdown, opt-out or thread deletion.
- VM monitor protocol for PNG screenshots and pointer, keyboard and scroll
  inputs. Each screenshot is collected into a unique temporary file and deleted
  after it is read. The browser-like Boxes tab polls only while shown.
- Agent MCP tools: `box_images`, `box_list`, `box_create`, `box_status`,
  `box_snapshot`, `box_click`, `box_scroll`, `box_type`, `box_press`,
  `box_drag`, `box_stop`, `box_destroy`. The agent's authenticated thread identity is
  used; a tool caller cannot select a different thread. Tools may be visible
  in discovery while disabled, but every action is denied server-side.
- WebSocket RPC methods and typed client atoms for the same operations. Users
  can install guest images from local folders and manage them in the Boxes tab.
- Workspace-scoped `artifactRelativePath` in `box_create` copies a single
  installer under 2 GiB and attaches it as a read-only virtual FAT USB device.
- Buildroot image scripts and CI workflow for independent x86-64 and ARM64
  artifacts, containing the Linux kernel, musl, BusyBox, eudev, seatd,
  Weston/Wayland and Pixman rendering plus a GUI terminal. A separate smoke
  job attempts to boot each image and capture its virtual framebuffer for
  inspection, without claiming a complete GUI acceptance test. This is neither
  Ubuntu nor Alpine.
- A protocol unit test suite verifies the VM monitor handshake, command
  correlation, keyboard events and unsupported character handling.

## Internal hypervisor implementation

The host VM engine is **QEMU**. The VM manager uses KVM on compatible Linux,
HVF on compatible macOS, WHPX on compatible Windows and software acceleration
as fallback. ARM64 guests use the AArch64 virt machine and a 64-bit CPU
definition.

Guest files are stored under the backend's server data directory in
`microboxes/images/<image-id>/`; per-box copied disks live under
`microboxes/boxes/<box-uuid>/`.

The guest image format is `image.json` with an `id`, `name`, `kind`,
`architecture`, `file`, and `kernel` for direct Linux boot. Files are
copied from a chosen folder after validating identifiers, realpaths and size.

The VM process gets a reduced host environment, excluding provider keys and
authorization tokens. The backend refuses host paths outside the selected
thread workspace for installer mounts, and each process uses its own
working directory. No guest remote display port or SSH port is opened.

## Still required before production

- **Boot verification:** CI compilation is in progress; a successful Buildroot
  build does not prove its GUI comes up on every host, and the image must be
  tested under real Windows, macOS and Linux hosts.
- **Automatic, signed guest-image installation:** currently users select an
  image folder. Production should retrieve an authenticated, checksum-pinned
  release artifact directly through Sparky, showing exact stages and errors.
- **Better computer-use semantics:** current controls are screenshot/pixel and
  keyboard based, not a semantic native accessibility tree. Implement the
  guest `sparky-boxd` authentication and accessibility bridge for stable
  element IDs and native app actions.
- **Network isolation:** user-mode networking is only a basic boundary.
  Apply host/private-network destination restrictions before enabling internet
  in production; do not assume NAT blocks host networks.
- **Windows/macOS guest integration:** their installers need licensed,
  compatible guest OS images and the relevant firmware/platform support. A
  Linux guest cannot run native Windows or macOS installers.
- **Release-test automation:** clean snapshots, reliable installer launch,
  structured GUI assertions, screenshot/crash evidence and final reports.
- **Lifecycle hardening:** persisted stopped-box recovery and boot
  exit/timeout logging for diagnostics (thread-deletion cleanup is implemented).
- **Performance:** avoid unbounded screenshot buffering or constant polling
  for invisible views; benchmark memory usage on representative hosts.
- **Permission UX:** tool discovery filtering for disabled sessions and
  per-user opt-ins if the backend hosts multiple users.

**Do not merge or describe this draft as a production-ready VM solution
until these are complete and verified.**

## Image build

From `sparky-desktop/source` on Linux:

```bash
bash microboxes/os/build-x86_64.sh
bash microboxes/os/build-aarch64.sh
```

Both scripts use pinned Buildroot tag `2026.08.1`. The workflow
`.github/workflows/microboxes-guest-image.yml` at the repository root runs
the two builds as matrix jobs and uploads non-publication test artifacts.
The settings image-folder picker can import the generated directories.
A separate CI job attempts a real guest boot using the same sparse disk overlay
format as the server and uploads a PNG screenshot as evidence. An image build
passing alone is not proof of a functioning graphical desktop.

## Installer testing

An agent can build a release artifact inside its authenticated thread workspace,
create a box from the matching installed guest image, pass the artifact's
workspace-relative path to `box_create`, and then inspect/operate the installer
using snapshots and input. The mounted artifact is read-only and is copied into
the per-box staging directory before VM boot.

This is currently a **manual agent-driven GUI test path**, not a certified
release test suite. Require an OS-matched guest for native installation
packages, and preserve appropriate license and platform constraints.
