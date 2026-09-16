# GitHub authentication: production setup

Sparky's production GitHub integration uses the **Sparky OAuth App**, the OAuth authorization-code flow with **PKCE**, a loopback callback owned by the desktop process, and a tiny server-side token broker.

The most important rule is simple:

- The **OAuth App client ID is public** and may be embedded in the Sparky desktop build.
- The **OAuth App client secret is confidential** and must never be embedded in Electron, JavaScript shipped to users, a public config file, a release archive, or a repository commit.
- The client secret belongs in the server-side auth broker as a platform secret.

The reference broker is in `sparky-auth-worker/` and is ready to deploy to Cloudflare Workers.

## 1. Create or configure the OAuth App

Open GitHub **Settings → Developer settings → OAuth Apps** and create/select the Sparky application.

Recommended registration values:

| Setting | Production value |
| --- | --- |
| OAuth App name | `Sparky` |
| Homepage URL | Your real HTTPS Sparky website |
| Callback URL | `http://127.0.0.1/github/oauth/callback` |
| Callback wildcard matching | **Off** |
| Device Flow | **Off** |

Why the callback has no port: GitHub supports loopback callbacks for native desktop apps. Sparky binds an available random port on `127.0.0.1`, then sends a redirect such as `http://127.0.0.1:49152/github/oauth/callback`. GitHub allows the loopback port to vary from the registered callback. Do not use `localhost` here.

### OAuth scope

Sparky requests the classic OAuth `repo` scope so the Pull Requests page can list private repositories the user can access. OAuth Apps do not provide GitHub App installation-level repository permissions, so Sparky lists repositories through `/user/repos` and never calls `/user/installations`.

### Client ID and client secret

On the OAuth App settings page:

1. Copy the **Client ID**. This is safe to place in build configuration.
2. Generate a **Client secret**.
3. Copy the secret once and place it directly into the server-side secret store described below.
4. Do not put the secret into `.env` files that are committed, `wrangler.toml`, GitHub repository variables, desktop build variables, or the Electron package.

If a client secret is ever committed or bundled into a release, revoke it in GitHub immediately and generate a new one.

## 2. Deploy the auth broker

The broker performs only three sensitive operations:

- exchange an OAuth authorization code for a user access token;
- rotate an expiring access token using a refresh token;
- revoke the current user token on disconnect.

It does not store GitHub user tokens or refresh tokens. Those remain on the user's computer.

### Cloudflare Workers setup

From the repository root:

```bash
cd sparky-auth-worker
npm install
```

Edit `wrangler.toml` and replace:

```toml
GITHUB_CLIENT_ID = "REPLACE_WITH_GITHUB_OAUTH_APP_CLIENT_ID"
```

with the OAuth App client ID. This value is public.

Then add the **client secret** to Cloudflare's encrypted secret store:

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Paste the OAuth App client secret when Wrangler asks for it. The secret must not appear in `wrangler.toml`.

Run the broker tests:

```bash
npm test
```

Deploy:

```bash
npx wrangler deploy
```

For production, attach a dedicated HTTPS hostname such as:

```text
https://auth.sparky.llc
```

The current temporary HTTPS deployment is:

```text
https://sparky-auth.sparky-nexus-updates.workers.dev
```

Use a Cloudflare custom domain or route. The desktop build rejects non-HTTPS broker URLs except loopback HTTP used for local development.

### Verify the broker

Open or request:

```text
https://auth.sparky.llc/health
```

A correctly configured broker returns a small response indicating that the GitHub client ID is configured. It never returns the client secret.

Recommended Cloudflare controls:

- keep request-body logging disabled for the auth worker;
- add rate limiting to `/v1/github/exchange`, `/v1/github/refresh`, and `/v1/github/revoke`;
- allow only HTTPS in production;
- protect the Cloudflare account with strong MFA;
- rotate the GitHub client secret if the Cloudflare account or Worker secret is suspected to be compromised.

## 3. Configure the desktop build

Sparky reads two public build settings:

```text
SPARKY_GITHUB_CLIENT_ID
SPARKY_GITHUB_AUTH_BROKER_URL
```

Example:

```text
SPARKY_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
SPARKY_GITHUB_AUTH_BROKER_URL=https://auth.sparky.llc
```

These values are intentionally public. `vite.config.ts` embeds them in the packaged desktop application so end users do not have to set environment variables after installation.

For development, the same names may be supplied as environment variables before running the desktop build. `SPARKY_GITHUB_OAUTH_CLIENT_ID` remains a temporary compatibility alias for the client ID.

### GitHub Actions

If release builds run in GitHub Actions, create **Repository Variables** (not secrets) named:

```text
SPARKY_GITHUB_CLIENT_ID
SPARKY_GITHUB_AUTH_BROKER_URL
```

Pass them into the desktop build environment.

The OAuth App **client secret must not be passed into a desktop build job**. The only CI job that should ever need the client secret is a job that deploys the server-side auth broker, and even then the preferred destination is the Worker platform's encrypted secret store rather than the built application.

## 4. What happens when a user connects GitHub

1. Sparky starts a temporary HTTP listener on `127.0.0.1` using a random available port.
2. Sparky creates a cryptographically random OAuth `state` and PKCE verifier.
3. Sparky opens GitHub in the user's system browser with the public client ID, the loopback callback, `state`, and an S256 PKCE challenge.
4. GitHub displays the Sparky OAuth authorization page.
5. After approval, GitHub redirects to Sparky's already-listening loopback port with a short-lived authorization code.
6. Sparky verifies `state` and sends the code, exact redirect URI, and PKCE verifier to the HTTPS auth broker.
7. The broker adds the confidential client secret and exchanges the code directly with GitHub.
8. The broker returns the resulting user access token and, when enabled, refresh token to the desktop process.
9. The Electron **main process** stores credentials using OS-backed `safeStorage`; the React renderer never receives them.
10. Sparky queries the OAuth user's accessible repositories through `/user/repos`.

## 5. Token storage and rotation

Sparky stores one encrypted credential record under Electron's user-data directory.

- Windows: Electron uses OS-backed protection such as DPAPI.
- macOS: Electron uses Keychain-backed protection.
- Linux: Sparky accepts secure `safeStorage` backends, but explicitly rejects Electron's `basic_text` fallback.

If secure OS credential storage is unavailable, Sparky keeps the GitHub credentials **memory-only for the current app session**. It does not fall back to plaintext token storage.

The old `github-oauth-token.bin` file from the first OAuth implementation is deleted during migration because earlier builds could have written it without encryption when `safeStorage` was unavailable.

When GitHub App user-token expiration is enabled, the access token normally expires and the refresh token is used to rotate it. Sparky refreshes before expiry and replaces both tokens with the rotated pair returned by GitHub.

## 6. Disconnecting

`Disconnect GitHub` revokes the current GitHub user access token through the server-side broker and then deletes Sparky's local encrypted credentials.

The broker uses GitHub's single-token revocation endpoint rather than deleting the user's entire application grant, so disconnecting one Sparky installation does not intentionally invalidate every other Sparky session the same user may have.

Uninstalling the GitHub App is separate. Users can manage the GitHub App installation in GitHub if they want to remove Sparky's repository access completely.

## 7. Device Flow: why it used to be required and why it is not now

**Device Flow is a setting on the GitHub OAuth App or GitHub App registration.** It is not a setting inside the repository and it is not a setting on the user's GitHub account.

The previous implementation in `main` called GitHub's device authorization endpoint (`/login/device/code`). GitHub rejects that flow unless **Enable Device Flow** is switched on for the registered app. That is what “enable Device Flow for the implementation currently in main” meant: the code path that existed at that time depended on a GitHub app-registration feature flag.

This hardened implementation no longer uses Device Flow. It uses the normal browser authorization-code flow with PKCE and an authenticated loopback redirect, so **Device Flow can remain disabled**.

For a desktop application that can launch a browser and receive a loopback callback, this gives Sparky a redirect that is bound to the local app instance, plus PKCE and `state` validation. Device Flow remains useful for genuinely constrained or headless clients that cannot receive a browser redirect.

## 8. Electron security boundary

The main Sparky window already uses the important Electron isolation controls:

```text
contextIsolation = true
nodeIntegration = false
sandbox = true
```

Keep them enabled.

The GitHub token is owned by the Electron main process. The preload bridge exposes specific actions such as status, connect, disconnect, repository listing, PR listing, and PR diff retrieval; it does not expose the token, filesystem, `ipcRenderer`, or `child_process` directly to the web renderer.

When adding future GitHub functionality, keep privileged network/token operations in the main process and expose a narrow validated IPC method instead of returning credentials to React code.

## 9. Distribution when Windows/macOS code signing is unavailable

OAuth hardening does not remove the separate trust problem created by unsigned desktop installers.

If trusted Windows Authenticode and Apple Developer ID signing are not currently obtainable in your jurisdiction, the application can still be distributed, but users may see SmartScreen/Gatekeeper warnings and you cannot provide the same publisher-identity guarantee as a signed/notarized build.

Until signing becomes available:

- distribute only from your official HTTPS site and official GitHub release page;
- publish SHA-256 hashes for every installer/archive;
- publish a detached GPG signature for a checksum manifest if you control a stable public GPG key;
- never tell users to disable operating-system security features globally;
- make unsigned-build status explicit on the download page;
- protect release publishing accounts with MFA and least-privilege credentials;
- keep update manifests and release artifacts HTTPS-only;
- treat signing/notarization as a remaining distribution limitation, not as something OAuth can compensate for.

If signing becomes available later, add it without changing the GitHub authentication architecture.

## 10. Pre-release verification checklist

Before publishing a build:

1. OAuth App callback is `http://127.0.0.1/github/oauth/callback` and wildcard callback matching is off.
2. Device Flow is off unless a separate headless client actually requires it.
3. The OAuth App requests the classic `repo` scope for private-repository access.
4. Pull Requests access is limited by the repositories the OAuth user can access.
5. `GITHUB_CLIENT_SECRET` exists only in the auth broker's encrypted platform secret store.
6. Desktop build contains the public client ID and HTTPS broker URL, but not the client secret.
7. Auth broker tests pass.
8. Desktop typecheck/tests pass.
9. Connect → authorize → repository selection → PR list → PR diff works with a private test repository.
10. Restart Sparky and confirm the secure stored session resumes when OS secure storage is available.
11. Disconnect and confirm the local credentials are removed and the previous access token no longer works.
12. Publish hashes/signatures for unsigned installers and clearly identify the official distribution locations.
