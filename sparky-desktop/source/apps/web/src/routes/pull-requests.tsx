import { createFileRoute, redirect } from "@tanstack/react-router";

import { PullRequestsPage } from "../components/pullRequests/PullRequestsPage";

export const Route = createFileRoute("/pull-requests")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: PullRequestsPage,
});
