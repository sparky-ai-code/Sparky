# Saved-credential vault: security and release verification

This is a **desktop-only** encrypted password vault. The MCP agent receives only
credential metadata and may request a same-origin fill; the privileged Electron
process decrypts and inserts the password into the website. The website can
necessarily read its login fields. Native WebAuthn passkeys remain in the OS or
hardware authenticator; the vault stores only a website reference, not a key.

## Automated coverage

- `apps/desktop/src/secrets/SecretVault.test.ts`: encrypted file, exact origin,
  name collision, update/remove, invalid records, missing keychain, Linux fallback,
  and metadata-only passkey references.
- `apps/desktop/src/preview/SecretProtectionPolicy.test.ts`: safe click targets
  and denylist for browser inspection/recording once a credential is present.
- `apps/server/src/mcp/toolkits/preview/tools.test.ts`: agent tool arguments do
  not accept plaintext secrets.

## Required real-desktop smoke test before merging

Run on Windows, macOS, and Linux with an unlocked *secure* keychain. Use a
dedicated disposable account on a trusted local HTTPS login test fixture:

1. Add two named passwords on separate HTTPS origins. Verify the UI lists only
   metadata and that the file under Electron `userData` contains no plaintext.
2. Use `secrets_list`, navigate to the matching site, and call `secrets_use`
   by ID and by name. Verify login fields fill and agent results contain no
   password. Verify cross-site, HTTP, and ambiguous name requests fail.
3. While filled, attempt `preview_snapshot`, `preview_evaluate`,
   `preview_wait_for`, `preview_type`, `preview_press`, `preview_scroll`,
   and `preview_recording_start`. They must return no page data. A simple
   sign-in button locator or coordinate click must still work.
4. Start a browser recording before filling. The normal renderer agent path
   should stop it first; bypassing that path with direct desktop IPC must fail
   closed if recording remains active. A protected tab must emit no screencast
   frames or console/network diagnostics.
5. On an SPA-only route change, inspection must remain blocked. After a full
   document navigation, it can resume but must not replay console/network
   events from the password-bearing page.
6. Test a queued snapshot/JavaScript inspection competing with autofill, and a
   redirect between lookup and insertion (including a same-origin reload).
   They must not leak or fill the password into a different document.
   After any `preview_evaluate` on the page, `secrets_use` must fail until
   a full navigation clears preinstalled JavaScript observers.
7. Edit a login without replacing its password, then replace the password,
   remove it, and restart Sparky. Verify persistence/revocation.
8. Test a real site WebAuthn passkey flow: the OS prompt must require user
   approval. The entry is only a reference, not a generated/imported passkey.
9. Confirm unavailable/unlocked Linux insecure `basic_text` fallback refuses
   storage, and verify there is no credential content in logs, errors, tool
   results, recording artifacts or agent context.

## Security boundary

The browser's website necessarily receives its password. This protects the
model/tool boundary; it does *not* protect against a malicious website, browser
extension, OS compromise, or unrestricted native shell access.

Desktop integration checks are **manual release gates**, not covered by unit
tests. Do not claim end-to-end passkey or browser verification from CI alone.
