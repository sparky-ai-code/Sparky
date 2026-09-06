# Contributing to Sparky

Thanks for contributing to Sparky.

## Development setup

1. Install Node.js `24.13.1` and pnpm `11.10.0`.
2. Clone the repository.
3. Run `pnpm install`.
4. Start the desktop development environment with `pnpm dev:desktop`.

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm test
pnpm test:desktop-smoke
```

## Pull requests

Keep changes focused and include tests for behavior changes when practical. Do not commit generated installers, dependency directories, production credentials, signing material, private service configuration, or internal-only documentation.

## Security-sensitive changes

Never place API keys, OAuth client secrets, signing certificates, private endpoints, or user data in source control. Use local environment configuration or the appropriate platform secret store instead.

## Third-party code

If a change adds or modifies third-party code, preserve required copyright and license notices and update `THIRD_PARTY_NOTICES.md` when appropriate.