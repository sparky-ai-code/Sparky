import {
  createInternalNeonAuth,
  type NeonAuth,
} from "@neondatabase/auth";
import {
  BetterAuthReactAdapter,
  type BetterAuthReactAdapterInstance,
} from "@neondatabase/auth/react/adapters";

const neonAuthUrl = import.meta.env.VITE_NEON_AUTH_URL?.trim() || null;

type SparkyNeonAuth = NeonAuth<BetterAuthReactAdapterInstance>;

/**
 * The Neon Auth URL is public client configuration. The database connection
 * string is never used by the renderer and must remain server-side.
 */
export const neonAuth: SparkyNeonAuth | null = neonAuthUrl
  ? createInternalNeonAuth<BetterAuthReactAdapterInstance>(neonAuthUrl, {
      adapter: BetterAuthReactAdapter(),
    })
  : null;

export const hasNeonAuthConfig = neonAuth !== null;
