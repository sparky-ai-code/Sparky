import { createFileRoute } from "@tanstack/react-router";

import { PluginsSettingsPanel } from "../components/settings/PluginsSettingsPanel";

function SettingsPluginsRoute() {
  return <PluginsSettingsPanel />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: SettingsPluginsRoute,
});
