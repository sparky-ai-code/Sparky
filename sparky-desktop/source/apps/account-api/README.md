# Sparky account API

This service owns the application-specific account/profile/device/usage tables in Neon Postgres.
Neon Auth remains the identity provider; the API accepts only Neon Auth JWTs and never receives the
database connection string from a browser.

Required environment variables:

- `NEON_DATABASE_URL` (or `DATABASE_URL`) — server-only Neon Postgres connection string.
- `NEON_AUTH_JWKS_URL`
- `NEON_AUTH_ISSUER`
- `NEON_AUTH_AUDIENCE`

Optional: `HOST`, `PORT`, and `SPARKY_ACCOUNT_CORS_ORIGIN`.

Run locally with `pnpm --filter @sparky/account-api dev`. The service automatically loads the gitignored
`apps/account-api/.env.local` file; paste the production `NEON_DATABASE_URL` there before starting.
The first startup applies `migrations/001_account.sql` idempotently.
