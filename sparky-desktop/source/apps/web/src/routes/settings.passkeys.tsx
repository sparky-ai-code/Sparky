import { createFileRoute } from "@tanstack/react-router";
import { PasskeysSettingsPanel } from "../components/settings/PasskeysSettingsPanel";

export const Route = createFileRoute("/settings/passkeys")({
  component: PasskeysSettingsPanel,
});
