import { createFileRoute } from "@tanstack/react-router";

import { McpSettingsPanel } from "../components/settings/McpSettingsPanel";

function SettingsPluginsRoute() {
  return <McpSettingsPanel />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: SettingsPluginsRoute,
});
