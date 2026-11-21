import { useProjects } from "../../state/entities";
import { FolderIcon } from "../Hugeicons";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

function normalizeRoot(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

interface TeamProjectRowProps {
  readonly name: string;
  /** The team project's linked folder. The row uses that folder's Sparky project favicon. */
  readonly localPath: string | null;
  readonly onSelect: () => void;
}

/** A project as a square, taller row with its favicon on the left. */
export function TeamProjectRow(props: TeamProjectRowProps) {
  const { name, localPath, onSelect } = props;
  const projects = useProjects();
  const linked =
    localPath === null
      ? null
      : (projects.find(
          (project) => normalizeRoot(project.workspaceRoot) === normalizeRoot(localPath),
        ) ?? null);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        className="h-10 gap-3 rounded-md px-3 text-left hover:bg-accent cursor-pointer"
        onClick={onSelect}
      >
        {linked !== null ? (
          <ProjectFavicon
            environmentId={linked.environmentId}
            cwd={linked.workspaceRoot}
            className="!size-5"
          />
        ) : (
          <FolderIcon className="size-5 shrink-0 text-muted-foreground/60" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {name}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
