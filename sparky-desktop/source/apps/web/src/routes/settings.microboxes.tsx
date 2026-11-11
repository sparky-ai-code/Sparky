import { createFileRoute } from "@tanstack/react-router";
import { MicroboxesSettingsPanel } from "../components/settings/MicroboxesSettingsPanel";

export const Route = createFileRoute("/settings/microboxes")({
  component: MicroboxesSettingsPanel,
});
