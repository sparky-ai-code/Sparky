# Sparky

Sparky is an open-source, local-first desktop coding agent for working with software projects from a native desktop app.

This repository contains the source required to develop and build the Sparky desktop application. Sparky-hosted websites, marketing properties, download/update services, analytics services, private deployment configuration, internal agent instructions, and internal product documentation are intentionally not part of this public source tree.

## Relationship to T3 Code

Sparky uses portions of the T3 Code user interface as a visual foundation under the MIT License. The T3 Code-derived portion is limited to UI code; Sparky's application/runtime architecture, integrations, packaging, and product behavior are maintained separately and are not the T3 Code project structure.

The original T3 Code copyright and MIT license notice are preserved in [`LICENSES/T3-CODE-MIT.txt`](LICENSES/T3-CODE-MIT.txt). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for details.

## What's included

- `apps/desktop` — Electron desktop shell and native desktop integration.
- `apps/web` — the renderer/UI bundled into the desktop application. This is **not** the hosted Sparky website.
- `apps/server` — the local runtime bundled with Sparky.
- `packages` — shared application packages.
- `assets`, `patches`, and build tooling required by the desktop app.

## What's intentionally not included

The public repository does not ship Sparky's hosted website or marketing app, download worker, update portal, hosted account/analytics infrastructure, mobile application, private deployment infrastructure, internal planning/agent files, or private release-operations material.

## Requirements

- Node.js `24.13.1` (the repository declares `^24.13.1`)
- pnpm `11.10.0`
- Git
- Native build tooling for the operating system you are targeting

For signed production installers you will also need the normal platform signing credentials/tooling for macOS or Windows. Signing credentials are not part of this repository.

## Install dependencies

```bash
pnpm install
```

## Run Sparky locally

Start the desktop development environment:

```bash
pnpm dev:desktop
```

Model-provider configuration is handled from Sparky's **Settings → Models** UI; provider secrets do not belong in the repository.

Useful checks before submitting a change:

```bash
pnpm typecheck
pnpm test
pnpm test:desktop-smoke
```

## Build the desktop app

Build the desktop runtime without producing an installer:

```bash
pnpm build:desktop
```

### Windows installers

```bash
# x64 NSIS installer
pnpm dist:desktop:win:x64

# ARM64 NSIS installer
pnpm dist:desktop:win:arm64
```

### macOS installers

```bash
# Apple silicon DMG
pnpm dist:desktop:dmg:arm64

# Intel DMG
pnpm dist:desktop:dmg:x64
```

### Linux installers

```bash
# x64 AppImage
pnpm dist:desktop:linux

# x64 Debian package
pnpm dist:desktop:linux:deb
```

The artifact builder also supports explicit platform, architecture, target, output-directory, version, and signing options through `scripts/build-desktop-artifact.ts`.

Cross-compilation support varies by Electron/electron-builder target and native dependency. For the most predictable release artifacts, build on the target operating system and architecture.

## Repository configuration

Sparky is designed to run locally. The public `.env.example` intentionally contains no Sparky production endpoints or hosted-service credentials. If you add a self-hosted integration, document its required variables without committing secrets.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Third-party software

Sparky depends on third-party open-source packages and contains T3 Code-derived UI code. License notices must be preserved when redistributing source or binaries. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the license metadata shipped with individual dependencies.

## License

Sparky is released under the MIT License. See [`LICENSE`](LICENSE).

Third-party components remain subject to their own license terms.