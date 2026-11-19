import { createFileRoute } from "@tanstack/react-router";

import { UserAnalyticsSettingsPanel } from "../components/settings/UserAnalyticsSettingsPanel";

function SettingsAnalyticsRoute() {
  return <UserAnalyticsSettingsPanel />;
}

export const Route = createFileRoute("/settings/analytics")({
  component: SettingsAnalyticsRoute,
});
