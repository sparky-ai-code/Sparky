import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettings";

function SettingsAppearanceRoute() {
  return <AppearanceSettingsPanel />;
}

export const Route = createFileRoute("/settings/appearance")({
  component: SettingsAppearanceRoute,
});
