import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/mcp")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/plugins", replace: true });
  },
});
