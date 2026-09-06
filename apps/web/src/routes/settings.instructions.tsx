import { createFileRoute } from "@tanstack/react-router";

import { InstructionsSettingsPanel } from "../components/settings/InstructionsSettings";

function SettingsInstructionsRoute() {
  return <InstructionsSettingsPanel />;
}

export const Route = createFileRoute("/settings/instructions")({
  component: SettingsInstructionsRoute,
});
