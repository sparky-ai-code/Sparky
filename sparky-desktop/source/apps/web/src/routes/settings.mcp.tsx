import { createFileRoute } from "@tanstack/react-router";

import { McpSettingsPanel } from "../components/settings/McpSettingsPanel";

function SettingsMcpRoute() {
  return <McpSettingsPanel />;
}

export const Route = createFileRoute("/settings/mcp")({
  component: SettingsMcpRoute,
});
