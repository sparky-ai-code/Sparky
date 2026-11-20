# Sparky

Sparky is a local desktop coding agent with built-in file, search, editing, and terminal tools. It connects directly to models from OpenAI, Anthropic, and Google.

> [!WARNING]
> Sparky is very early. Expect bugs. Add at least one model API key from **Settings > Models** before starting a task.

## Repository layout

This is a monorepo. Each top-level directory is a separate project.

| Path | What it is |
| --- | --- |
| [`crates/`](crates) | Rust workspace for the agent core: providers (`sparky_ai`), tools (`sparky_tools`), sessions, memory, compaction, prompts, extensions, and the `sparky` CLI (`sparky_cli`). |
| [`sparky-desktop/source/`](sparky-desktop/source) | The desktop app and its server, web UI, and mobile code (pnpm monorepo). See its own [README](sparky-desktop/source/README.md). |
| [`sparky-website/`](sparky-website) | The public website, documentation, changelog, and legal notices. |
| [`sparky-analytics/`](sparky-analytics) | Convex backend for analytics and desktop release metadata. |
| [`sparky-auth-worker/`](sparky-auth-worker) | Cloudflare Worker for GitHub OAuth and plugin authentication. |
| [`sparky-download-worker/`](sparky-download-worker) | Cloudflare Worker that routes public desktop downloads and update requests. |
| [`scripts/`](scripts) | Release, parity, and smoke-test scripts. |
| `.github/`, `.circleci/`, `bitrise.yml` | CI configuration. |

## Getting started

### Agent core (Rust)

Requires a recent stable Rust toolchain.

```bash
cargo build --workspace
cargo test --workspace
cargo run -p sparky_cli --bin sparky
```

### Desktop app (Node.js)

Requires Node.js `^24.13.1` and pnpm `11.10.0`. Full setup and build steps are in [`sparky-desktop/source/README.md`](sparky-desktop/source/README.md). To build the Windows installer:

```bash
cd sparky-desktop/source
pnpm install
pnpm dist:desktop:win:x64
```

### Website and services

Each service has its own `package.json` and can be run from its directory, for example `npm run dev` in `sparky-website/`.

## Documentation

- Product documentation lives in [`sparky-website/docs/`](sparky-website/docs).
- Desktop app docs live in [`sparky-desktop/source/docs/`](sparky-desktop/source/docs).

## Acknowledgements

Sparky is built on the [T3 Code](https://github.com/pingdotgg/t3code) codebase, which is MIT licensed and copyright T3 Tools Inc. Thank you to the T3 Code team for the foundation this project builds on.

## Contributing

Sparky is not accepting outside contributions yet.

## License

Sparky's own code is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Sparky.

Some directories contain third-party code that keeps its original license:

- [`sparky-desktop/source/`](sparky-desktop/source) is MIT licensed, copyright T3 Tools Inc. (see [its LICENSE](sparky-desktop/source/LICENSE)).
- Vendored and third-party files keep their own license files, such as the bundled skills under `sparky-desktop/source/.agents/skills/` and the modules under `sparky-desktop/source/apps/mobile/modules/`.
- Third-party dependency notices are published at [`sparky-website/licenses.html`](sparky-website/licenses.html) and [`sparky-website/public/third-party-notices.txt`](sparky-website/public/third-party-notices.txt).

Where a file or directory has its own license, that license applies to that file or directory.
