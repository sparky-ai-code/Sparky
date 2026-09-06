import { PlugZapIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { SidebarMenuButton, useSidebar } from "../ui/sidebar";

const HOST_ATTRIBUTE = "data-plugins-sidebar-host";

function findOrCreateHost(): HTMLElement | null {
  const scheduleTrigger = document.querySelector<HTMLElement>(
    '[data-testid="sidebar-schedules-trigger"]',
  );
  const scheduleItem = scheduleTrigger?.closest<HTMLElement>('[data-slot="sidebar-menu-item"]');
  const menu = scheduleItem?.parentElement;
  if (!scheduleItem || !menu) return null;

  const existing = menu.querySelector<HTMLElement>(`[${HOST_ATTRIBUTE}]`);
  if (existing) return existing;

  const host = document.createElement("li");
  host.setAttribute(HOST_ATTRIBUTE, "");
  host.setAttribute("data-slot", "sidebar-menu-item");
  host.setAttribute("data-sidebar", "menu-item");
  host.className = scheduleItem.className;
  menu.insertBefore(host, scheduleItem);
  return host;
}

export function PluginsSidebarEntry() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let currentHost: HTMLElement | null = null;
    const attach = () => {
      const nextHost = findOrCreateHost();
      if (nextHost === currentHost) return;
      currentHost = nextHost;
      setHost(nextHost);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      currentHost?.remove();
    };
  }, []);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/plugins" });
  }, [isMobile, navigate, setOpenMobile]);

  if (!host) return null;

  return createPortal(
    <SidebarMenuButton
      size="sm"
      isActive={pathname === "/plugins"}
      className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
      data-testid="sidebar-plugins-trigger"
      aria-label="Open plugins"
      onClick={handleClick}
    >
      <PlugZapIcon className="size-3.5 text-muted-foreground/70" />
      <span className="flex-1 truncate text-left text-xs">Plugins</span>
    </SidebarMenuButton>,
    host,
  );
}
