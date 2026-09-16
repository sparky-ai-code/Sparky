import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/source-control")({
  loader: () => {
    throw redirect({ to: "/settings/general" });
  },
});
