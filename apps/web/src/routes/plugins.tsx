import { createFileRoute, redirect } from "@tanstack/react-router";

import { PluginsPage } from "../components/plugins/PluginsPage";

export const Route = createFileRoute("/plugins")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: PluginsPage,
});
