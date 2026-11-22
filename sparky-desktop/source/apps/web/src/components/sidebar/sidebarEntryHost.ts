// Shared placement for sidebar actions that live outside the main Sidebar tree
// (Pull requests, Plugins). They portal into the Schedule action's container so
// the order is New chat, Pull requests, Plugins, Schedule, Search in both layouts.

export const SIDEBAR_ICON_ACTIONS_TESTID = "sidebar-icon-actions";

export const SIDEBAR_HORIZONTAL_ACTION_BUTTON_CLASS =
  "inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0";

export function findOrCreateSidebarEntryHost(input: {
  readonly hostAttribute: string;
  readonly horizontal: boolean;
}): HTMLElement | null {
  const scheduleTrigger = document.querySelector<HTMLElement>(
    '[data-testid="sidebar-schedules-trigger"]',
  );
  if (!scheduleTrigger) return null;

  // Horizontal: the Schedule button sits directly in the icon row.
  // Vertical: it sits inside a SidebarMenuItem inside a SidebarMenu.
  const scheduleItem = input.horizontal
    ? scheduleTrigger
    : scheduleTrigger.closest<HTMLElement>('[data-slot="sidebar-menu-item"]');
  const container = input.horizontal
    ? scheduleTrigger.closest<HTMLElement>(`[data-testid="${SIDEBAR_ICON_ACTIONS_TESTID}"]`)
    : (scheduleItem?.parentElement ?? null);
  if (!scheduleItem || !container) return null;

  const existing = container.querySelector<HTMLElement>(`[${input.hostAttribute}]`);
  if (existing) return existing;

  const host = document.createElement(input.horizontal ? "span" : "li");
  host.setAttribute(input.hostAttribute, "");
  if (input.horizontal) {
    host.className = "inline-flex";
  } else {
    host.setAttribute("data-slot", "sidebar-menu-item");
    host.setAttribute("data-sidebar", "menu-item");
    host.className = scheduleItem.className;
  }
  container.insertBefore(host, scheduleItem);
  return host;
}
