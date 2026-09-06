const DEFINITIVE_AUTH_ERROR =
  /\b(?:bad credentials|invalid[_ ]grant|invalid token|token revoked|token has been revoked)\b/iu;

/**
 * A broker/API outage is not evidence that the locally encrypted credential is
 * invalid. Only clear credentials after an explicit authentication failure.
 */
export function isDefinitiveGitHubAuthFailure(status: number | null, detail: string): boolean {
  if (status === 401) return true;
  return DEFINITIVE_AUTH_ERROR.test(detail);
}
