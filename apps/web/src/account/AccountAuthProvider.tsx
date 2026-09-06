import { setManagedRelaySession } from "@sparky/client-runtime/relay";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  clearPluginSession,
  createPluginSession,
  loadPluginSessionToken,
} from "../components/plugins/pluginApi";
import { AuthLoadingScreen, AuthSurfaceShell } from "../components/auth/AuthSurfaceShell";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  clerkAuthFrameUrl,
  clerkAuthOrigin,
  clerkExternalAuthUrl,
  exchangeClerkBrowserCode,
  isClerkFrameMessage,
  restoreClerkSession,
  setActiveClerkTokenReader,
  type ClerkFrameMessage,
  type ClerkSession,
  type ClerkUser,
} from "./clerkRuntime";

type AccountState =
  | { readonly status: "loading"; readonly user: null; readonly session: null }
  | { readonly status: "signed-out"; readonly user: null; readonly session: null }
  | {
      readonly status: "signed-in";
      readonly user: ClerkUser;
      readonly session: ClerkSession;
      readonly pluginSessionReady: boolean;
      readonly pluginError: string | null;
    }
  | { readonly status: "error"; readonly user: null; readonly session: null; readonly error: string };

const AccountContext = createContext<AccountState>({ status: "loading", user: null, session: null });
const TOKEN_REQUEST_TIMEOUT_MS = 5_000;
let tokenRequestSequence = 0;

function tokenExpiresWithin(token: string, seconds: number): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const json = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    const exp = (JSON.parse(json) as { readonly exp?: unknown }).exp;
    return typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000) + seconds;
  } catch {
    return true;
  }
}

export function useAccountState(): AccountState {
  return useContext(AccountContext);
}

function makeRequestId(): string {
  tokenRequestSequence += 1;
  return `clerk-token-${tokenRequestSequence}`;
}

export function AccountAuthProvider({ children }: { readonly children: ReactNode }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const latestTokenRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const pluginSessionIdRef = useRef<string | null>(null);
  const pendingTokenRequestsRef = useRef(
    new Map<string, { readonly resolve: (token: string | null) => void; readonly timeout: number }>(),
  );
  const pendingExternalStateRef = useRef<string | null>(null);
  const externalSessionRef = useRef(false);
  const restoringSessionRef = useRef(true);
  const [state, setState] = useState<AccountState>({ status: "loading", user: null, session: null });

  const readToken = useCallback(async (): Promise<string | null> => {
    const frameWindow = iframeRef.current?.contentWindow;
    let frameToken: string | null = null;
    if (frameWindow) {
      const requestId = makeRequestId();
      frameToken = await new Promise<string | null>((resolve) => {
        const timeout = window.setTimeout(() => {
          pendingTokenRequestsRef.current.delete(requestId);
          resolve(null);
        }, TOKEN_REQUEST_TIMEOUT_MS);
        pendingTokenRequestsRef.current.set(requestId, { resolve, timeout });
        frameWindow.postMessage(
          { source: "sparky-clerk-host", type: "request-token", requestId },
          clerkAuthOrigin(),
        );
      });
    }
    if (frameToken && !tokenExpiresWithin(frameToken, 15)) {
      latestTokenRef.current = frameToken;
      return frameToken;
    }

    const savedPluginSessionToken = loadPluginSessionToken();
    if (savedPluginSessionToken) {
      const restored = await restoreClerkSession(savedPluginSessionToken).catch(() => null);
      if (restored) {
        latestTokenRef.current = restored.token;
        activeSessionIdRef.current = restored.sessionId;
        return restored.token;
      }
    }
    return frameToken ?? latestTokenRef.current;
  }, []);

  useEffect(() => {
    let active = true;
    const clearAccount = () => {
      if (externalSessionRef.current || restoringSessionRef.current) return;
      latestTokenRef.current = null;
      activeSessionIdRef.current = null;
      pluginSessionIdRef.current = null;
      setActiveClerkTokenReader(null);
      setManagedRelaySession(appAtomRegistry, null);
      void clearPluginSession();
      if (active) setState({ status: "signed-out", user: null, session: null });
    };

    const applySession = (message: Extract<ClerkFrameMessage, { readonly type: "session" }>) => {
      latestTokenRef.current = message.token;
      activeSessionIdRef.current = message.sessionId;
      const user: ClerkUser = {
        id: message.user.id,
        primaryEmailAddress: message.user.email
          ? { emailAddress: message.user.email }
          : null,
      };
      const session: ClerkSession = {
        id: message.sessionId,
        getToken: readToken,
      };
      const alreadyReady = pluginSessionIdRef.current === message.sessionId;

      setActiveClerkTokenReader(readToken);
      setManagedRelaySession(appAtomRegistry, {
        accountId: user.id,
        readAccountToken: readToken,
      });
      setState({
        status: "signed-in",
        user,
        session,
        pluginSessionReady: alreadyReady,
        pluginError: null,
      });

      if (alreadyReady) return;
      void createPluginSession(message.token)
        .then(() => {
          if (!active || activeSessionIdRef.current !== message.sessionId) return;
          pluginSessionIdRef.current = message.sessionId;
          setState({
            status: "signed-in",
            user,
            session,
            pluginSessionReady: true,
            pluginError: null,
          });
        })
        .catch((error: unknown) => {
          if (!active || activeSessionIdRef.current !== message.sessionId) return;
          setState({
            status: "signed-in",
            user,
            session,
            pluginSessionReady: false,
            pluginError: error instanceof Error ? error.message : "Plugin session could not be created.",
          });
        });
    };

    const startExternalAuth = () => {
      const openExternal = window.desktopBridge?.openExternal;
      if (typeof openExternal !== "function") {
        setState({ status: "error", user: null, session: null, error: "Browser sign-in is only available in Sparky Desktop." });
        return;
      }
      const state = window.crypto.randomUUID();
      pendingExternalStateRef.current = state;
      void openExternal(clerkExternalAuthUrl(state)).then((opened) => {
        if (opened === false) throw new Error("Sparky could not open the default browser.");
      }).catch((error: unknown) => {
        pendingExternalStateRef.current = null;
        setState({ status: "error", user: null, session: null, error: error instanceof Error ? error.message : "Sparky could not open the default browser." });
      });
    };

    const handleExternalCallback = (callbackUrl: string) => {
      let parsed: URL;
      try {
        parsed = new URL(callbackUrl);
      } catch {
        return;
      }
      const code = parsed.searchParams.get("code");
      const callbackState = parsed.searchParams.get("state");
      const expectedState = pendingExternalStateRef.current;
      if (
        parsed.pathname !== "/clerk-callback" ||
        !code ||
        !callbackState ||
        !expectedState ||
        callbackState !== expectedState
      ) {
        setState({ status: "error", user: null, session: null, error: "The browser sign-in callback was invalid or expired." });
        return;
      }
      pendingExternalStateRef.current = null;
      void exchangeClerkBrowserCode(code)
        .then((result) => {
          if (result.state !== expectedState) {
            throw new Error("The browser sign-in state did not match the request.");
          }
          externalSessionRef.current = true;
          applySession({
            source: "sparky-clerk-frame",
            type: "session",
            token: result.token,
            sessionId: result.sessionId,
            user: result.user,
          });
        })
        .catch((error: unknown) => {
          setState({ status: "error", user: null, session: null, error: error instanceof Error ? error.message : "The browser sign-in could not be completed." });
        });
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      if (!active || event.origin !== clerkAuthOrigin()) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isClerkFrameMessage(event.data)) return;
      const message = event.data;

      if (message.type === "token") {
        const pending = pendingTokenRequestsRef.current.get(message.requestId);
        if (!pending) return;
        pendingTokenRequestsRef.current.delete(message.requestId);
        window.clearTimeout(pending.timeout);
        if (message.token) latestTokenRef.current = message.token;
        pending.resolve(message.token);
        return;
      }

      if (message.type === "signed-out") {
        clearAccount();
        return;
      }

      if (message.type === "ready") {
        return;
      }

      if (message.type === "external-auth") {
        startExternalAuth();
        return;
      }

      if (message.type === "error") {
        if (activeSessionIdRef.current === null) {
          setState({ status: "error", user: null, session: null, error: message.message });
        }
        return;
      }

      if (message.type === "session") {
        applySession(message);
      }
    };

    window.addEventListener("message", onMessage);
    const removeClerkCallback = window.desktopBridge?.onClerkCallback?.(handleExternalCallback);
    const savedPluginSessionToken = loadPluginSessionToken();
    void (savedPluginSessionToken ? restoreClerkSession(savedPluginSessionToken) : Promise.resolve(null))
      .then((restored) => {
        if (!active) return;
        if (!restored) {
          setState({ status: "signed-out", user: null, session: null });
          return;
        }
        externalSessionRef.current = true;
        // The saved opaque plugin session already represents this Clerk
        // session. Reuse it rather than issuing another session on every
        // app launch, while the Worker refresh endpoint provides a fresh
        // short-lived Clerk JWT for account and relay requests.
        pluginSessionIdRef.current = restored.sessionId;
        applySession({
          source: "sparky-clerk-frame",
          type: "session",
          token: restored.token,
          sessionId: restored.sessionId,
          user: restored.user,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          user: null,
          session: null,
          error: error instanceof Error ? error.message : "Saved Sparky session could not be restored.",
        });
      })
      .finally(() => {
        restoringSessionRef.current = false;
      });
    return () => {
      active = false;
      window.removeEventListener("message", onMessage);
      removeClerkCallback?.();
      setActiveClerkTokenReader(null);
      for (const pending of pendingTokenRequestsRef.current.values()) {
        window.clearTimeout(pending.timeout);
        pending.resolve(null);
      }
      pendingTokenRequestsRef.current.clear();
    };
  }, [readToken]);

  const contextValue = useMemo(() => state, [state]);
  const authFrame = (
    <iframe
      ref={iframeRef}
      title="Sparky account sign in"
      src={clerkAuthFrameUrl()}
      sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      aria-hidden={state.status === "loading" || state.status === "signed-in"}
      className={
        state.status === "loading" || state.status === "signed-in"
          ? "pointer-events-none fixed left-0 top-0 size-px border-0 opacity-0"
          : "h-[min(660px,calc(100vh-3rem))] w-full max-w-[480px] border-0 bg-transparent"
      }
    />
  );

  if (state.status === "loading") {
    // Keep the broker frame mounted while the branded loading screen is shown.
    // The frame is what emits the Clerk ready/session message that advances
    // this state; returning only the splash would make loading permanent.
    return (
      <>
        <AuthLoadingScreen />
        {authFrame}
      </>
    );
  }

  if (state.status === "signed-out") {
    return <AuthSurfaceShell>{authFrame}</AuthSurfaceShell>;
  }

  if (state.status === "error") {
    return (
      <AuthSurfaceShell>
        <div className="w-full max-w-[480px] rounded-2xl border border-border bg-card p-5 text-sm">
          <h1 className="font-semibold">Sparky sign in</h1>
          <p className="mt-2 leading-6 text-muted-foreground">{state.error}</p>
          <div className="mt-4 overflow-hidden rounded-xl border border-border/70">{authFrame}</div>
        </div>
      </AuthSurfaceShell>
    );
  }

  return (
    <AccountContext.Provider value={contextValue}>
      {authFrame}
      {children}
    </AccountContext.Provider>
  );
}
