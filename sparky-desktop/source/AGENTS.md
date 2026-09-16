# AGENTS.md

## Canonical Sparky workspace

- Current Sparky 1.1 work belongs in `C:\Users\Lenovo\Downloads\Sparkyxxxx-sparky-1.1-merged-clean`.
- This desktop TypeScript monorepo is `C:\Users\Lenovo\Downloads\Sparkyxxxx-sparky-1.1-merged-clean\sparky-desktop\source`.
- `C:\Users\Lenovo\Downloads\Sparkyxxxx` is an older 1.0.5 checkout; do not silently switch to it.
- Keep package-local `node_modules` directories named `node_modules`; package managers and build tools require that convention.
- Internal workspace packages use the `@sparky/*` namespace. Remaining `@t3tools/...` strings in source are stable Effect service/storage identifiers; do not mass-replace them. The `t3` server CLI/package, `t3@latest` remote bootstrap spec, `~/.t3`, `/.well-known/t3/*`, `/api/t3-connect/*`, and legacy `T3CODE_*` keys remain unchanged compatibility contracts.

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-sparky-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-sparky-mobile` skill. Connect one representative iOS Simulator or Android Emulator available on the host to one isolated environment and verify the affected flow. On compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in the Sparky in-app browser or another available agent browser; use Android when it is the affected or viable platform.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## Sparky agent continuity guardrails

These rules apply to provider, orchestration, timeline, and desktop release work:

- A user follow-up in an existing thread must continue the same provider conversation. Preserve and verify the provider session/resume cursor; do not silently create a fresh provider session for each message.
- The visible timeline is not proof of provider context. Before changing this path, verify a two-turn probe where the second provider request can answer a fact from the first user message, including after a server/provider restart. Every follow-up must carry the durable thread identity and the persisted transcript/session file; if the resume cursor or transcript is missing, fail loudly instead of falling back to a new session. Never fix context loss by blindly prepending the whole UI transcript to every request, because that duplicates history and increases token cost.
- Test both an in-process follow-up and a provider/server restart. The provider request for the second turn must carry the durable conversation identity (for Sparky, the per-thread session binding or equivalent resume cursor).
- Treat `turn.completed` and the final assistant item as separate lifecycle signals. The UI may settle only when the final assistant item is complete or the authoritative turn-completed event arrives, and must never leave a working timer after the final reply is visible.
- For one-shot provider adapters, treat the protocol's terminal result frame as the end of the turn; never make `turn.completed` wait on a child-process `close` event that may be held open by MCP/browser resources.
- A hidden agent completion signal must be terminal only after the user-facing summary is streamed; suppress its lifecycle from the UI, persist its protocol result for conversation continuity, and clear both the provider and orchestration active-turn state.
- Any edit/write/file-change timeline row must retain its observed diff statistics after the activity completes. Added lines are green and removed lines are red; do not infer a zero diff merely because a lifecycle update omitted the original tool input.
- Add a regression test for every change touching context continuity or terminal rendering, then run focused tests, relevant typechecks, and the packaged desktop build before claiming release readiness.

## Desktop update safety

- The updater’s public and build-time contracts are protected: keep `SPARKY_UPDATE_URL`, `SPARKY_UPDATE_SITE_URL`, `/get/updates/*`, `latest.yml`, `latest-mac*.yml`, Electron `productName`/application identity, and the `@t3tools`/`T3CODE_*` compatibility namespaces unchanged unless the task explicitly includes a migration.
- Directory and documentation renames must not change `app-update.yml` discovery, `electron-updater` feed configuration, release-channel selection, or installer asset names.
- Validate updater changes with the focused `ElectronUpdater`/`DesktopUpdates` tests and the public download-worker route tests for Windows, macOS arm64, and macOS x64.
