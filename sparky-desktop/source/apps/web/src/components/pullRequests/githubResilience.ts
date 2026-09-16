export function shouldApplyGitHubListResult(error: string | null): boolean {
  return error === null;
}

export function isGitHubAuthError(detail: string | null): boolean {
  if (!detail) return false;
  const normalized = detail.toLowerCase();
  if (normalized.includes("rate limit") || normalized.includes("secondary rate limit"))
    return false;
  return [
    "not authenticated",
    "authentication failed",
    "authentication is required",
    "bad credentials",
    "invalid_grant",
    "invalid token",
    "token revoked",
    "session expired",
    "status 401",
    "http 401",
  ].some((marker) => normalized.includes(marker));
}

export function isTransientGitHubStatus(detail: string | null): boolean {
  if (!detail) return false;
  const normalized = detail.toLowerCase();
  return normalized.includes("could not reach github") || normalized.includes("session was kept");
}
