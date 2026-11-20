import { createFileRoute, redirect } from "@tanstack/react-router";

import { IssuesPage } from "../components/issues/IssuesPage";

export const Route = createFileRoute("/issues")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: IssuesPage,
});
