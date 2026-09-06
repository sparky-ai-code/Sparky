import { createFileRoute, redirect } from "@tanstack/react-router";

import { ScheduledTasksPage } from "../components/schedules/ScheduledTasksPage";

export const Route = createFileRoute("/schedules")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: ScheduledTasksPage,
});
