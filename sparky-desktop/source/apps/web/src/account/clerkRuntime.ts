export type ClerkUser = {
  readonly id: string;
  readonly primaryEmailAddress?: { readonly emailAddress?: string | null } | null;
};

export type ClerkSession = {
  readonly id: string;
  getToken: (options?: Record<string, unknown>) => Promise<string | null>;
};

export type ClerkFrameMessage =
  | { readonly source: "sparky-clerk-frame"; readonly type: "ready"; readonly frontendApi?: string }
  | { readonly source: "sparky-clerk-frame"; readonly type: "signed-out" }
  | { readonly source: "sparky-clerk-frame"; readonly type: "external-auth" }
  | {
      readonly source: "sparky-clerk-frame";
      readonly type: "session";
      readonly token: string;
      readonly sessionId: string;
      readonly user: { readonly id: string; readonly email: string | null };
    }
  | {
      readonly source: "sparky-clerk-frame";
      readonly type: "token";
      readonly requestId: string;
      readonly token: string | null;
    }
  | { readonly source: "sparky-clerk-frame"; readonly type: "error"; readonly message: string };

const DEFAULT_WORKER_URL = "https://auth.sparky.llc";
let activeAccountTokenReader: (() => Promise<string | null>) | null = null;

function workerBaseUrl(): string {
  const configured = import.meta.env.VITE_SPARKY_PLUGIN_WORKER_URL?.trim() || DEFAULT_WORKER_URL;
  try {
    const url = new URL(configured);
    return url.toString().replace(/\/$/u, "");
  } catch {
    return DEFAULT_WORKER_URL;
  }
}

export function clerkAuthFrameUrl(): string {
  return `${workerBaseUrl()}/v1/clerk/desktop`;
}

export function clerkAuthOrigin(): string {
  return new URL(clerkAuthFrameUrl()).origin;
}

export function clerkCallbackUrl(): string {
  return `${window.location.protocol}//${window.location.host}/clerk-callback`;
}

export function clerkExternalAuthUrl(state: string): string {
  const url = new URL(clerkAuthFrameUrl());
  url.searchParams.set("mode", "external");
  url.searchParams.set("redirect_uri", clerkCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export type ClerkBrowserExchange = {
  readonly token: string;
  readonly sessionId: string;
  readonly state: string;
  readonly user: { readonly id: string; readonly email: string | null };
};

export async function exchangeClerkBrowserCode(code: string): Promise<ClerkBrowserExchange> {
  let lastError = "Clerk browser sign-in could not be completed.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${workerBaseUrl()}/v1/clerk/bridge/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const value = await response.json().catch(() => null);
    if (
      response.ok &&
      typeof value?.token === "string" &&
      typeof value.sessionId === "string" &&
      typeof value.state === "string" &&
      value.user &&
      typeof value.user.id === "string" &&
      (typeof value.user.email === "string" || value.user.email === null)
    ) {
      return value as ClerkBrowserExchange;
    }
    lastError = typeof value?.error === "string" ? value.error : lastError;
    if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  throw new Error(lastError);
}

export async function restoreClerkSession(pluginSessionToken: string): Promise<ClerkBrowserExchange | null> {
  const response = await fetch(`${workerBaseUrl()}/v1/clerk/restore`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pluginSessionToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (response.status === 401) return null;
  const value = await response.json().catch(() => null);
  if (
    response.ok &&
    typeof value?.token === "string" &&
    typeof value.sessionId === "string" &&
    value.user &&
    typeof value.user.id === "string" &&
    (typeof value.user.email === "string" || value.user.email === null)
  ) {
    return {
      token: value.token,
      sessionId: value.sessionId,
      state: "restored",
      user: value.user,
    };
  }
  throw new Error(
    typeof value?.error === "string" ? value.error : "Saved Sparky session could not be restored.",
  );
}

export function isClerkFrameMessage(value: unknown): value is ClerkFrameMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.source !== "sparky-clerk-frame" || typeof record.type !== "string") return false;
  if (record.type === "ready" || record.type === "signed-out" || record.type === "external-auth") return true;
  if (record.type === "error") return typeof record.message === "string";
  if (record.type === "token") {
    return (
      typeof record.requestId === "string" &&
      (typeof record.token === "string" || record.token === null)
    );
  }
  if (record.type === "session") {
    if (
      typeof record.token !== "string" ||
      typeof record.sessionId !== "string" ||
      !record.user ||
      typeof record.user !== "object"
    ) {
      return false;
    }
    const user = record.user as Record<string, unknown>;
    return (
      typeof user.id === "string" &&
      (typeof user.email === "string" || user.email === null)
    );
  }
  return false;
}

export function setActiveClerkTokenReader(
  reader: (() => Promise<string | null>) | null,
): void {
  activeAccountTokenReader = reader;
}

export function readClerkAccountToken(): Promise<string | null> {
  return activeAccountTokenReader?.() ?? Promise.resolve(null);
}
