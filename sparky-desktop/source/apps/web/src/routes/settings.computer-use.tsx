import { createFileRoute, redirect } from "@tanstack/react-router";

import { ComputerUseSettingsPanel } from "../components/settings/ComputerUseSettingsPanel";
import { isElectron } from "../env";

function SettingsComputerUseRoute() {
  return <ComputerUseSettingsPanel />;
}

export const Route = createFileRoute("/settings/computer-use")({
  beforeLoad: () => {
    if (!isElectron) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsComputerUseRoute,
});
