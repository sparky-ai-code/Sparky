import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettingsPanel } from "../components/settings/SkillsSettingsPanel";

export const Route = createFileRoute("/settings/skills")({
  component: SkillsSettingsPanel,
});
