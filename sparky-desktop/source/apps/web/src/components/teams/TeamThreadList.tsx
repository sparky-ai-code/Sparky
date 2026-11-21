import { TeamSidebarRow } from "./TeamSidebarRow";
import { formatRelativeTime } from "./teamsLogic";

/** The fields a thread row needs. Sparky's thread shells have all of them. */
export interface ProjectThreadRow {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

interface TeamThreadListProps<T extends ProjectThreadRow> {
  readonly threads: readonly T[];
  readonly onOpen: (thread: T) => void;
}

/**
 * A project's threads as rows in the same list as the project rows. Clicking one opens Sparky's
 * normal thread view. Renders list items only; the caller provides the list.
 */
export function TeamThreadList<T extends ProjectThreadRow>(props: TeamThreadListProps<T>) {
  const { threads, onOpen } = props;

  return (
    <>
      {threads.map((thread) => (
        <TeamSidebarRow
          key={thread.id}
          title={thread.title}
          meta={null}
          status={null}
          time={formatRelativeTime(thread.updatedAt)}
          isActive={false}
          onSelect={() => onOpen(thread)}
        />
      ))}
    </>
  );
}
