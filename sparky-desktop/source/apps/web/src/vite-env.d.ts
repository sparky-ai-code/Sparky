/// <reference types="vite-plus/client" />

import type { DesktopBridge, LocalApi } from "@sparky/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_NEON_AUTH_URL: string;
  readonly VITE_NEON_AUTH_OAUTH_AUTHORIZE_URL: string;
  readonly VITE_NEON_AUTH_CLI_OAUTH_CLIENT_ID: string;
  readonly VITE_ACCOUNT_API_URL: string;
  readonly VITE_SPARKY_ANALYTICS_ENDPOINT: string;
  readonly VITE_RELAY_OTLP_TRACES_URL: string;
  readonly VITE_RELAY_OTLP_TRACES_DATASET: string;
  readonly VITE_RELAY_OTLP_TRACES_TOKEN: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }
}
