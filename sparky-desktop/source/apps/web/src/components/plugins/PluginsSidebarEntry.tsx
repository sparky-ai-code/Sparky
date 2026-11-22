import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useClientSettings } from "~/hooks/useSettings";
import {
  findOrCreateSidebarEntryHost,
  SIDEBAR_HORIZONTAL_ACTION_BUTTON_CLASS,
} from "../sidebar/sidebarEntryHost";
import { SidebarPluginsIcon } from "../sidebar/SidebarRowIcons";
import { SidebarMenuButton, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const HOST_ATTRIBUTE = "data-plugins-sidebar-host";

export function PluginsSidebarEntry() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const horizontal = useClientSettings((settings) => settings.sidebarLayout) === "horizontal";
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let currentHost: HTMLElement | null = null;
    const attach = () => {
      const nextHost = findOrCreateSidebarEntryHost({ hostAttribute: HOST_ATTRIBUTE, horizontal });
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
      setHost(null);
    };
  }, [horizontal]);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/plugins" });
  }, [isMobile, navigate, setOpenMobile]);

  if (!host) return null;

  if (horizontal) {
    return createPortal(
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Open plugins"
              aria-current={pathname === "/plugins" ? "page" : undefined}
              data-testid="sidebar-plugins-trigger"
              className={SIDEBAR_HORIZONTAL_ACTION_BUTTON_CLASS}
              onClick={handleClick}
            />
          }
        >
          <SidebarPluginsIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Plugins</TooltipPopup>
      </Tooltip>,
      host,
    );
  }

  return createPortal(
    <SidebarMenuButton
      size="sm"
      isActive={pathname === "/plugins"}
      className="sidebar-row-action gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
      data-testid="sidebar-plugins-trigger"
      aria-label="Open plugins"
      onClick={handleClick}
    >
      <SidebarPluginsIcon className="size-3.5 text-muted-foreground/70" />
      <span className="flex-1 truncate text-left text-xs">Plugins</span>
    </SidebarMenuButton>,
    host,
  );
}
