# Sparky 1.1 workspace map

- The canonical active Sparky 1.1 workspace is `C:\Users\Lenovo\Downloads\Sparkyxxxx-sparky-1.1-merged-clean`.
- The desktop TypeScript monorepo is `sparky-desktop/source`.
- Product-side directories are `sparky-website`, `sparky-analytics`, `sparky-download-worker`, and `sparky-marketing`.
- Historical installers, release bundles, inspection output, and temporary snapshots live under `sparky-local-artifacts/`; do not search or edit them as source.
- The Rust workspace remains in `crates/`; do not rename it casually because Cargo package paths and release tooling depend on it.
- `node_modules` directories intentionally keep that exact name inside each package. They are runtime dependency stores, not source products; do not rename or search-and-replace them.
- `C:\Users\Lenovo\Downloads\Sparkyxxxx` is the older 1.0.5 checkout. Do not use it for current Sparky 1.1 fixes or releases unless explicitly comparing historical code.
- Before editing Sparky, run `git worktree list` and confirm the active path and branch; preserve unrelated worktree changes.

## Naming and scope guardrails

- Use Sparky directory names when describing or locating current code. Do not reintroduce `t3code-main` path references.
- The nested app now uses the internal `@sparky/*` workspace package namespace. Legacy `@t3tools/...` strings that remain in source are stable Effect service/storage identifiers and must not be mass-renamed. `T3CODE_*` configuration keys and protocol identifiers remain compatibility contracts.
- Do not edit `.repos/`, generated bundles, release artifacts, or temporary inspection folders as part of a source-directory rename unless the task explicitly includes them.
- Treat `sparky-local-artifacts/` as preserved local history. Do not delete or reintroduce its contents into runtime/build paths; new release outputs should be created by the desktop release scripts in their expected workspace output directory.

## Desktop update safety

- Treat the updater path as a protected public interface. Preserve `SPARKY_UPDATE_URL`, `SPARKY_UPDATE_SITE_URL`, `/get/updates/*`, `latest.yml`, `latest-mac*.yml`, Electron `productName`/application identity, and the release manifest filenames.
- Before and after source renames, run the focused download-worker route tests and desktop updater tests. Confirm Windows, macOS arm64, and macOS x64 feeds still resolve to the intended public release assets.
- Never change release routing, updater metadata, or installer identity as a side effect of directory cleanup. Any intentional release change requires separate release verification.
- The `t3` server CLI/package name, `t3@latest` remote bootstrap spec, `~/.t3` state directory, `/.well-known/t3/*` endpoints, `/api/t3-connect/*`, and `T3CODE_*` keys are public compatibility contracts. Do not rename them as part of the internal `@sparky/*` package migration.
