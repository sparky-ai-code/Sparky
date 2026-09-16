import { readClerkAccountToken } from "./clerkRuntime";

const accountApiUrl = import.meta.env.VITE_ACCOUNT_API_URL?.trim() || null;

export interface AccountApiSnapshot {
  readonly profile: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly avatarUrl: string | null;
  };
  readonly stats: Record<string, unknown>;
  readonly devices: ReadonlyArray<Record<string, unknown>>;
  readonly sessions: ReadonlyArray<Record<string, unknown>>;
}

export function hasAccountApiConfig(): boolean {
  return accountApiUrl !== null;
}

export async function fetchAccountSnapshot(): Promise<AccountApiSnapshot | null> {
  if (!hasAccountApiConfig()) return null;
  const token = await readClerkAccountToken();
  if (!token) return null;
  const response = await fetch(new URL("/v1/account", `${accountApiUrl}/`).toString(), {
    headers: { authorization: `Bearer ${token}` },
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Account API returned ${response.status}.`);
  }
  return (await response.json()) as AccountApiSnapshot;
}

export async function recordAccountUsageEvent(event: Record<string, unknown>): Promise<boolean> {
  if (!hasAccountApiConfig()) return false;
  const token = await readClerkAccountToken();
  if (!token) return false;
  const response = await fetch(new URL("/v1/account/usage-events", `${accountApiUrl}/`).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    credentials: "omit",
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new Error(`Account API returned ${response.status}.`);
  }
  const result = (await response.json()) as { readonly accepted?: unknown };
  return result.accepted === true;
}
