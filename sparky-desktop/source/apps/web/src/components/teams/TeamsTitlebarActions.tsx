import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useSidebarVisibility } from "../ui/sidebar";

const CONTROL_SELECTOR = "[data-sidebar-control]";
const HOST_ATTRIBUTE = "data-teams-titlebar-actions";

/**
 * Renders its children in the title bar, right after the sidebar toggle. The icons stay where
 * they are, and step aside to the right by the sidebar's width while the sidebar is open.
 */
export function TeamsTitlebarActions(props: { readonly children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const sidebarOpen = useSidebarVisibility();

  useEffect(() => {
    let createdHost: HTMLElement | null = null;
    const attach = () => {
      const control = document.querySelector<HTMLElement>(CONTROL_SELECTOR);
      if (control === null) {
        setHost(null);
        return;
      }
      let existing = control.querySelector<HTMLElement>(`[${HOST_ATTRIBUTE}]`);
      if (existing === null) {
        existing = document.createElement("div");
        existing.setAttribute(HOST_ATTRIBUTE, "");
        existing.className =
          "pointer-events-auto ml-1 flex items-center gap-1 transition-[margin] duration-200 ease-linear";
        control.appendChild(existing);
        createdHost = existing;
      }
      setHost(existing);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      createdHost?.remove();
      setHost(null);
    };
  }, []);

  useEffect(() => {
    if (host === null) {
      return;
    }
    // The toggle sits at the left edge; open, the icons move to just past the sidebar panel.
    host.style.marginLeft = sidebarOpen ? "calc(var(--sidebar-width) - 75px)" : "";
  }, [host, sidebarOpen]);

  return host !== null ? createPortal(props.children, host) : null;
}
