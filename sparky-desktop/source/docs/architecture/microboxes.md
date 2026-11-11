# Sparky Microboxes: implementation status and architecture

This document describes internal implementation details. Product UI refers exclusively to **Sparky Microboxes** and **Boxes**; it must never display the underlying hypervisor's product name, including in errors or notifications.

## Status

First foundation slice:
- Server-authoritative `microboxesEnabled` setting, **false by default**.
- Main-process-only, user-approved runtime provisioning for Windows (WinGet), macOS (Homebrew), and selected Linux package managers (polkit authorization where needed).
- Host runtime detection, bounded execution, serialization of overlapping install requests, and explicit errors.
- New thread-scoped Boxes right-panel surface and setup/settings integration.
- Tests for installer command selection and independently addressable box tabs.

**Not completed:** custom guest image, image manifest/download and signature verification, VM lifecycle and networking, QMP control, display streaming, guest authentication, native accessibility bridge, installer GUI testing, and agent MCP box tools. The settings switch does **not** grant any agent tools until backend authorization is implemented.

## Runtime

The host VM engine is **QEMU**. Support should be implemented through a platform adapter:
- Windows: WHPX, with explicit OS feature enablement approval.
- macOS: HVF, with Virtualization.framework available for compatible Apple guest use cases.
- Linux: KVM, with permission/availability checks.

The first setup implementation uses known package managers rather than unsafe unverified executable downloads. It verifies the installed binary before reporting its core components present. A built-in, signed distribution and true per-stage download progress will be added before the feature is presented as fully ready.

## Guest OS and GUI

Build the default **SparkyOS Micro** image from the Linux kernel plus a Buildroot-produced userspace (musl, BusyBox, a minimal init, Wayland/Weston with pixman rendering, and a small authenticated `sparky-boxd` agent). The default image is neither Ubuntu nor Alpine. Keep the root filesystem immutable and use per-box overlays.

Expose a live desktop display in the existing right-hand tab strip, reusing Browser's dimensions, maximize behavior, focus and cursor semantics, but **not** treating it as a browser page. Input should support mouse, keyboard and scrolling; guest-native semantic accessibility should be preferred where available. Windows installer testing requires a licensed Windows guest, not the Linux guest.

## Agent tool boundary

A future MCP toolkit will expose `box_create`, `box_status`, `box_snapshot`, `box_click`, `box_type`, `box_press`, `box_transfer`, `box_stop` and `box_destroy`.

Tools must be absent or inaccessible when `microboxesEnabled` is false, and **every execution** must check current server settings rather than only a stale MCP token captured at connection time. Tool capability scopes are bound to environment, thread and user authorization. Disabling the setting revokes permission and stops active boxes according to the documented shutdown policy.

Do not expose host private networks, host credentials or arbitrary mount points to guests by default. Apply network policy at the VM boundary, not just inside the guest. No reusable guest image may contain user secrets.

## Release testing

A future release test plan should select a guest OS matching the installer artifact, restore a clean snapshot, transfer the artifact, run the installer through the GUI, validate app startup/interactions and preserve logs/screenshots as evidence. Windows and macOS guest licensing and host compatibility requirements are separate from whether the Sparky desktop application can itself run on the host platform.
