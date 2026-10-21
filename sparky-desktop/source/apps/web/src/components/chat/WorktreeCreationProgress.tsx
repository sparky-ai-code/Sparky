import { useEffect, useState } from "react";
import { FolderGit2Icon } from "lucide-react";

const ESTIMATED_CREATION_DURATION_MS = 30_000;

export function WorktreeCreationProgress() {
  const [progress, setProgress] = useState(4);

  useEffect(() => {
    const startedAt = Date.now();
    const updateProgress = () => {
      const elapsed = Date.now() - startedAt;
      setProgress(
        Math.min(96, Math.max(4, Math.round((elapsed / ESTIMATED_CREATION_DURATION_MS) * 100))),
      );
    };
    const intervalId = window.setInterval(updateProgress, 250);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div
      role="status"
      aria-label={`Creating worktree, approximately ${progress}%`}
      className="relative mx-2.5 mb-2 overflow-hidden rounded-lg border border-border/70 bg-muted/35 px-3 py-2 sm:mx-3"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FolderGit2Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Creating worktree</span>
        <span className="shrink-0 tabular-nums text-foreground/75">~{progress}%</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${progress}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
