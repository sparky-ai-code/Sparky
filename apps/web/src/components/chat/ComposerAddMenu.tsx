import type { EnvironmentId, ProviderInteractionMode } from "@sparky/contracts";
import { PlusIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";

/**
 * The + button deliberately does not own a separate menu. It asks the
 * composer to open the exact same path picker used by @ without changing the
 * prompt text.
 */
export const ComposerAddMenu = memo(function ComposerAddMenu(props: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  workspaceContextEnabled: boolean;
  interactionMode: ProviderInteractionMode;
  disabled?: boolean;
  onOpenPicker: () => void;
  onPlanMode: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      disabled={props.disabled}
      aria-label="Add context"
      data-composer-add-menu-trigger="true"
      className="shrink-0 rounded-full text-muted-foreground/75 hover:text-foreground [&+[data-slot=separator]]:hidden"
      onPointerDown={(event) => {
        // Keep the editor selection/caret stable so the shared picker opens
        // exactly where the user was already typing.
        event.preventDefault();
      }}
      onClick={props.onOpenPicker}
    >
      <PlusIcon className="size-4" aria-hidden />
    </Button>
  );
});
