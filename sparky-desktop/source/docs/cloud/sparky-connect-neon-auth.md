# Sparky Cloud Neon Auth Setup

Sparky Cloud uses Neon Auth for web, desktop, and mobile account authentication. The relay validates
Neon Auth JWTs against the configured JWKS URL, issuer, and audience. Sparky-specific profiles, devices,
sessions, usage events, and aggregates are stored in Neon Postgres by the account API.

## Public client configuration

Sparky Cloud is disabled in a fresh clone. Add these public values to the repository `.env` or `.env.local`:

```dotenv
T3CODE_NEON_AUTH_URL=https://auth.example.com
T3CODE_NEON_AUTH_OAUTH_AUTHORIZE_URL=https://auth.example.com/oauth/authorize
T3CODE_NEON_AUTH_CLI_OAUTH_CLIENT_ID=account-cli
T3CODE_ACCOUNT_API_URL=https://accounts.example.com
T3CODE_RELAY_URL=https://relay.example.com
```

The shared loader projects these canonical values into `VITE_*` and `EXPO_PUBLIC_*` aliases. Never put
`NEON_DATABASE_URL` or a private signing key in a client environment.

## Server-only account API

Copy `apps/account-api/.env.example` into a private deployment environment and set:

- `NEON_DATABASE_URL` (or `DATABASE_URL`) — the supplied Neon Postgres connection string.
- `NEON_AUTH_JWKS_URL`
- `NEON_AUTH_ISSUER`
- `NEON_AUTH_AUDIENCE`

The account API applies migrations on startup and accepts only Neon Auth bearer JWTs. The connection
string is never sent to web, desktop, or mobile clients.

## Relay deployment

Copy `infra/relay/.env.example` to `infra/relay/.env`. Configure the relay deployment credentials,
`NEON_AUTH_JWKS_URL`, `NEON_AUTH_ISSUER`, `NEON_AUTH_AUDIENCE`, and APNs values. Keep private values in
the deployment secret store; never commit them or expose them to a client build.

## Headless CLI OAuth

The `t3 connect` commands use a public PKCE client. Configure the Neon Auth authorization endpoint and
public client ID, register `http://127.0.0.1:34338/callback`, and enable the `openid`, `profile`, and
`email` scopes in the Neon Auth provider. The relay is not involved in the browser OAuth handshake.

```sh
t3 connect login
t3 connect link
t3 connect status
t3 connect unlink
t3 connect logout
```

When running over SSH, forward the callback port:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

## Desktop redirects and passkeys

Register these custom desktop schemes with the Neon Auth application when native redirects are enabled:

```text
t3code-dev://app/
t3code://app/
```

For signed macOS passkeys, create an App ID for `com.t3tools.t3code`, enable Associated Domains, create
a compatible provisioning profile, and ensure the Neon Auth RP domain serves the required Apple app-site
association document. Configure builds with:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/sparky.provisionprofile
# Optional when the RP domain differs from the Neon Auth hostname.
T3CODE_NEON_AUTH_PASSKEY_RP_DOMAINS=auth.example.com
```

When the override is absent, the build derives the RP domain from `T3CODE_NEON_AUTH_URL`. Signed builds
fail early when the Team ID, provisioning profile, or RP-domain configuration is missing.

The web onboarding route uses Neon Auth UI with Google social sign-in and the configured email flow.
Mobile uses a native Neon Auth account form. Account-specific data is returned by the account API and
stored in Neon Postgres.
