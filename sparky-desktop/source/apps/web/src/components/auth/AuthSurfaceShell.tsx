import type { ReactNode } from "react";
import { SparkyLogo } from "../SparkyLogo";

/**
 * Minimal frame for account surfaces. It intentionally uses the app's semantic
 * theme tokens so the page follows the operating system appearance setting.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="h-dvh max-h-dvh overflow-y-auto bg-background px-5 text-foreground sm:px-8">
      <main className="mx-auto w-full max-w-[430px] py-10 sm:py-16">{children}</main>
    </div>
  );
}

export function AuthLoadingScreen() {
  return (
    <div className="flex h-dvh max-h-dvh items-center justify-center bg-background px-5 text-foreground sm:px-8">
      <div aria-label="Loading Sparky" className="flex items-center justify-center" role="status">
        <SparkyLogo role="img" aria-label="Sparky" className="size-20" />
        <span className="sr-only">Loading Sparky</span>
      </div>
    </div>
  );
}
