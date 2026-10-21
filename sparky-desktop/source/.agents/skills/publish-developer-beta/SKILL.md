---
name: publish-developer-beta
description: Publish an explicitly requested Sparky developer-beta desktop release through the GitHub Release workflow. Use when asked to publish or prepare a beta release, not for stable releases or nightly builds.
---

# Publish a developer beta release

## Safety and intent

- Only publish when the user explicitly requests a beta release and identifies the source revision (branch/commit) and version, or explicitly authorizes you to choose them.
- Developer betas are not fully verified. Confirm the target commit is the intended one and that the change is suitable for an opt-in prerelease. Never represent it as stable or verified.
- Do not push tags, create releases, or dispatch workflows without explicit authorization for that action. Do not bypass failing checks or change signing/security settings.
- Never request or expose credentials. Use the authenticated GitHub integration/CLI already provided by the environment; stop and report if unavailable.

## Version and workflow

- Use SemVer prerelease form `X.Y.Z-beta.N`, for example `1.4.0-beta.1`. Increment `N` for another beta in the same version series; do not reuse a release tag.
- In GitHub Actions, run `.github/workflows/release.yml` via **workflow_dispatch** with `channel=beta`, `version=X.Y.Z-beta.N`, and the requested source ref.
- Do not use the stable tag path for beta releases. The beta workflow creates a `vX.Y.Z-beta.N` prerelease and marks it not-latest; it publishes the CLI with the `beta` dist-tag and updater metadata under the `beta` channel.
- If the workflow does not offer the beta choice or its version validation rejects this format, stop; do not improvise another release route.

## Verify completion

1. Wait for the workflow run to finish and inspect all relevant jobs. Report failures; never report a failed/incomplete run as published.
2. Verify the GitHub Release exists at `vX.Y.Z-beta.N`, is marked **Pre-release**, and is not the latest stable release.
3. Verify the release contains platform installers and updater metadata including `beta.yml` and platform-specific beta metadata/assets. Check that the release commit matches the requested source.
4. Confirm the beta npm dist-tag only if that publish job succeeded.
5. Give the user the release URL, version, source commit, and exact verification status. Clearly note that this developer beta is less verified than stable.
