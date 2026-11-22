// Icons for the icon-only "horizontal" sidebar row. Drawn on a 16px grid with a
// 1.5px stroke, round caps and joins, so the five read as one family. Used only
// by the horizontal layout; the vertical list keeps its own icons.

import type { SVGProps } from "react";

type RowIconProps = SVGProps<SVGSVGElement>;

function RowIcon({ children, ...props }: RowIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

// Open rounded square with a pencil in the corner.
export function SidebarNewChatIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <path d="M8.25 2.75H5A2.25 2.25 0 0 0 2.75 5v6A2.25 2.25 0 0 0 5 13.25h6A2.25 2.25 0 0 0 13.25 11V7.75" />
      <path className="sidebar-row-icon-write" d="M11.1 2.9a1.5 1.5 0 0 1 2.1 2.1L8.9 9.3 6.1 10l.7-2.8z" />
    </RowIcon>
  );
}

// Two source nodes feeding one target, with the branch arrow.
export function SidebarPullRequestsIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle className="sidebar-row-icon-pop" cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6" />
      <path className="sidebar-row-icon-draw" pathLength={1} d="M12 11V6.25A2.25 2.25 0 0 0 9.75 4H8" />
      <path className="sidebar-row-icon-arrow" d="M9.5 2.5 8 4l1.5 1.5" />
    </RowIcon>
  );
}

// Puzzle piece: the piece body with one knob on top, which lifts out on hover.
export function SidebarPluginsIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <path d="M6 5.5H3V13h10V5.5h-3" />
      <path className="sidebar-row-icon-knob" d="M6 5.5a2 2 0 0 1 4 0" />
    </RowIcon>
  );
}

// Clock face with hands, for scheduled tasks.
export function SidebarScheduleIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path className="sidebar-row-icon-minute" d="M8 8V5.25" />
      <path className="sidebar-row-icon-hour" d="M8 8l1.75 1.25" />
    </RowIcon>
  );
}

// Lens and handle.
export function SidebarSearchIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <circle className="sidebar-row-icon-ripple" cx="7.25" cy="7.25" r="2" strokeWidth={1} />
      <circle cx="7.25" cy="7.25" r="4.25" />
      <path className="sidebar-row-icon-scan" d="M5.5 7.25H9" strokeWidth={1} />
      <path d="m10.5 10.5 3 3" />
    </RowIcon>
  );
}
