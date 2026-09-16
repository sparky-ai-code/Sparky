import { createFileRoute } from "@tanstack/react-router";

import { ArchivedItemsPanel } from "../components/settings/ArchivedItemsPanel";

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedItemsPanel,
});
