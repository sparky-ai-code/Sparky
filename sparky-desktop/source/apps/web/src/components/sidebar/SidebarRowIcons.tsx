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
      <path d="M11.1 2.9a1.5 1.5 0 0 1 2.1 2.1L8.9 9.3 6.1 10l.7-2.8z" />
    </RowIcon>
  );
}

// Two source nodes feeding one target, with the branch arrow.
export function SidebarPullRequestsIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6" />
      <path d="M12 11V6.25A2.25 2.25 0 0 0 9.75 4H8" />
      <path d="M9.5 2.5 8 4l1.5 1.5" />
    </RowIcon>
  );
}

// Plug with two prongs and a cable.
export function SidebarPluginsIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <path d="M6 2.5v2.75" />
      <path d="M10 2.5v2.75" />
      <path d="M4.25 5.25h7.5v2a3.75 3.75 0 0 1-7.5 0z" />
      <path d="M8 11v2.5" />
    </RowIcon>
  );
}

// Clock face with hands, for scheduled tasks.
export function SidebarScheduleIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.25V8l1.75 1.25" />
    </RowIcon>
  );
}

// Lens and handle.
export function SidebarSearchIcon(props: RowIconProps) {
  return (
    <RowIcon {...props}>
      <circle cx="7.25" cy="7.25" r="4.25" />
      <path d="m10.5 10.5 3 3" />
    </RowIcon>
  );
}
