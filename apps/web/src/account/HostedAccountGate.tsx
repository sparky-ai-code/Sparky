import type { ReactNode } from "react";

// Clerk now gates the entire renderer in AccountAuthProvider before the router
// mounts. Hosted/static mode therefore does not need a second provider-specific
// account gate, and keeping one would cause duplicate auth flows.
export function HostedAccountGate({ appShell }: { readonly appShell: ReactNode }) {
  return appShell;
}
