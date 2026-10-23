import { useCallback, useState, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BoxesIcon,
  SlidersHorizontalIcon,
  PaletteIcon,
  BrainIcon,
  KeyboardIcon,
  PlugZapIcon,
  SearchIcon,
  Settings2Icon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import { McpIcon } from "./McpIcon";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/personalize"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/models"
  | "/settings/plugins"
  | "/settings/mcp"
  | "/settings/memory"
  | "/settings/archived";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  section: "Your workspace" | "AI & tools" | "Preferences" | "Data";
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", section: "Your workspace", to: "/settings/general", icon: Settings2Icon },
  {
    label: "Personalize",
    section: "Your workspace",
    to: "/settings/personalize",
    icon: SlidersHorizontalIcon,
  },
  {
    label: "Appearance",
    section: "Your workspace",
    to: "/settings/appearance",
    icon: PaletteIcon,
  },
  { label: "Models", section: "AI & tools", to: "/settings/models", icon: BoxesIcon },
  { label: "Plugins", section: "AI & tools", to: "/settings/plugins", icon: PlugZapIcon },
  { label: "MCP", section: "AI & tools", to: "/settings/mcp", icon: McpIcon },
  { label: "Memory", section: "AI & tools", to: "/settings/memory", icon: BrainIcon },
  { label: "Keybindings", section: "Preferences", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Archive", section: "Data", to: "/settings/archived", icon: ArchiveIcon },
];

const SETTINGS_NAV_SECTIONS = ["Your workspace", "AI & tools", "Preferences", "Data"] as const;

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const [search, setSearch] = useState("");
  const filteredItems = SETTINGS_NAV_ITEMS.filter((item) =>
    item.label.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="gap-0 overflow-x-hidden">
        <div className="px-3 pt-3">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
            <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search settings"
              aria-label="Search settings sections"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
        {SETTINGS_NAV_SECTIONS.map((section) => {
          const sectionItems = filteredItems.filter((item) => item.section === section);
          if (sectionItems.length === 0) return null;
          return (
            <SidebarGroup key={section} className="px-2 py-0.5">
              <SidebarGroupLabel className="h-7 px-2.5 text-[11px] font-medium text-muted-foreground/75">
                {section}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-1">
                {sectionItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.to;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        size="sm"
                        isActive={isActive}
                        className={
                          isActive
                            ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                            : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                        }
                        onClick={() => handleSectionClick(item.to)}
                      >
                        <Icon
                          className={
                            isActive
                              ? "size-4 shrink-0 text-foreground"
                              : "size-4 shrink-0 text-muted-foreground/60"
                          }
                        />
                        <span className="truncate">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
        {filteredItems.length === 0 ? (
          <p className="px-5 py-4 text-xs text-muted-foreground">No settings sections found.</p>
        ) : null}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
          <SidebarMenu className="min-w-0">
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={handleBackClick}
              >
                <ArrowLeftIcon className="size-4" />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarFooter>
    </>
  );
}
