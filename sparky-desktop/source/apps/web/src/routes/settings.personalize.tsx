import { createFileRoute } from "@tanstack/react-router";

import { PersonalizeSettingsPanel } from "../components/settings/PersonalizeSettings";

function SettingsPersonalizeRoute() {
  return <PersonalizeSettingsPanel />;
}

export const Route = createFileRoute("/settings/personalize")({
  component: SettingsPersonalizeRoute,
});
