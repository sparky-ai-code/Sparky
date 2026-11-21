import type { KeyboardEvent, ReactNode } from "react";

import { resolveThreadRowClassName } from "../Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

/** Same list container the sidebar uses for its thread rows. */
export function TeamSidebarRowList(props: { readonly children: ReactNode }) {
  return (
    <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1 py-0 sm:mx-1 sm:px-1.5">
      {props.children}
    </SidebarMenuSub>
  );
}

interface TeamSidebarRowProps {
  readonly title: string;
  /** Muted line under the title, like the sidebar's folder path. */
  readonly meta: string | null;
  /** Status on the bottom line, before the time. */
  readonly status: ReactNode | null;
  /** Time on the bottom line, right-aligned, like the sidebar's last-interacted time. */
  readonly time: string | null;
  readonly badge?: ReactNode;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}

/**
 * A project or thread row drawn with the same classes and layout as the sidebar's thread rows.
 */
export function TeamSidebarRow(props: TeamSidebarRowProps) {
  const { title, meta, status, time, badge, isActive, onSelect } = props;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        className={`${resolveThreadRowClassName({ isActive, isSelected: false })} relative isolate !h-auto min-h-20 items-start gap-2 py-2.5`}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 line-clamp-2 overflow-hidden text-xs font-medium leading-snug text-foreground/90">
              {title}
            </span>
            {badge}
          </div>
          {meta !== null ? (
            <div className="flex min-w-0 items-center gap-1 truncate text-[10px] text-muted-foreground/65">
              <span className="min-w-0 truncate">{meta}</span>
            </div>
          ) : null}
          {status !== null || time !== null ? (
            <div className="flex min-w-0 items-center gap-2 truncate text-[10px]">
              {status}
              {time !== null ? (
                <span className="shrink-0 tabular-nums text-muted-foreground/65">{time}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
