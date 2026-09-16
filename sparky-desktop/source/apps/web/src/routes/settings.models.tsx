import { createFileRoute } from "@tanstack/react-router";

import { ModelsSettingsPanel } from "../components/settings/ModelsSettingsPanel";

function SettingsModelsRoute() {
  return <ModelsSettingsPanel />;
}

export const Route = createFileRoute("/settings/models")({
  component: SettingsModelsRoute,
});
