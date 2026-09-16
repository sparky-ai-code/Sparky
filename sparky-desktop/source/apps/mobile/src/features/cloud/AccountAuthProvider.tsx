import { createInternalNeonAuth } from "@neondatabase/auth";
import { BetterAuthVanillaAdapter } from "@neondatabase/auth/vanilla/adapters";
import Constants from "expo-constants";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface AccountUser {
  readonly id: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly image?: string | null;
}

export interface AccountAuthState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly user: AccountUser | null;
  readonly getToken: () => Promise<string | null>;
  readonly signInEmail: (email: string, password: string) => Promise<void>;
  readonly signUpEmail: (email: string, password: string, name: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

const AccountAuthContext = createContext<AccountAuthState | null>(null);

const authUrl = (() => {
  const extra = Constants.expoConfig?.extra as
    | { readonly neonAuth?: { readonly url?: unknown } }
    | undefined;
  const value = extra?.neonAuth?.url;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    return url.origin + "/";
  } catch {
    return null;
  }
})();

const neonAuth = authUrl
  ? createInternalNeonAuth(authUrl, { adapter: BetterAuthVanillaAdapter() })
  : null;

export function useAccountAuth(): AccountAuthState {
  const value = useContext(AccountAuthContext);
  if (value === null) {
    throw new Error("useAccountAuth must be used inside AccountAuthProvider");
  }
  return value;
}

export function AccountAuthProvider({ children }: { readonly children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(neonAuth === null);
  const [user, setUser] = useState<AccountUser | null>(null);

  const refresh = useCallback(async () => {
    if (neonAuth === null) {
      setIsLoaded(true);
      setUser(null);
      return;
    }
    const result = await neonAuth.adapter.getSession();
    setUser(result.data?.user ?? null);
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AccountAuthState>(
    () => ({
      isLoaded,
      isSignedIn: user !== null,
      userId: user?.id ?? null,
      user,
      getToken: () => neonAuth?.getJWTToken() ?? Promise.resolve(null),
      signInEmail: async (email, password) => {
        if (neonAuth === null) throw new Error("Neon Auth is not configured.");
        const result = await neonAuth.adapter.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message ?? "Could not sign in.");
        await refresh();
      },
      signUpEmail: async (email, password, name) => {
        if (neonAuth === null) throw new Error("Neon Auth is not configured.");
        const result = await neonAuth.adapter.signUp.email({ email, password, name });
        if (result.error) throw new Error(result.error.message ?? "Could not create account.");
        await refresh();
      },
      signOut: async () => {
        if (neonAuth !== null) {
          await neonAuth.adapter.signOut();
        }
        setUser(null);
      },
      refresh,
    }),
    [isLoaded, refresh, user],
  );

  return <AccountAuthContext.Provider value={value}>{children}</AccountAuthContext.Provider>;
}
