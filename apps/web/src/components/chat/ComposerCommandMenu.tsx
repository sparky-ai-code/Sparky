import {
  type ProjectEntry,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@sparky/contracts";
import { BotIcon, ListTodoIcon, PaperclipIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { formatProviderSkillInstallSource } from "~/providerSkillPresentation";
import { cn } from "~/lib/utils";
import { PluginLogo } from "../plugins/PluginLogo";
import { searchPlugins, type PluginDefinition } from "../plugins/pluginCatalog";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { PierreEntryIcon } from "./PierreEntryIcon";
import "./composerPlanModeChip.css";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    };

type ComposerCommandGroup = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

type NativePathPickerKind = "file" | "folder" | "any";

type ComposerDesktopBridge = NonNullable<typeof window.desktopBridge> & {
  pickFileOrFolder?: (options: {
    kind: NativePathPickerKind;
    initialPath?: string | null;
    targetEnvironmentId?: string;
  }) => Promise<string | null>;
};

const PATH_PLAN_MODE_ITEM: Extract<ComposerCommandItem, { type: "slash-command" }> = {
  id: "path-action:plan",
  type: "slash-command",
  command: "plan",
  label: "Plan mode",
  description: "Switch this chat to planning",
};

function SkillGlyph(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function groupCommandItems(
  items: ComposerCommandItem[],
  triggerKind: ComposerTriggerKind | null,
  groupSlashCommandSections: boolean,
): ComposerCommandGroup[] {
  if (triggerKind === "skill") {
    return items.length > 0 ? [{ id: "skills", label: "Skills", items }] : [];
  }
  if (triggerKind !== "slash-command" || !groupSlashCommandSections) {
    return [{ id: "default", label: null, items }];
  }

  const builtInItems = items.filter((item) => item.type === "slash-command");
  const providerItems = items.filter((item) => item.type === "provider-slash-command");

  const groups: ComposerCommandGroup[] = [];
  if (builtInItems.length > 0) {
    groups.push({ id: "built-in", label: "Built-in", items: builtInItems });
  }
  if (providerItems.length > 0) {
    groups.push({ id: "provider", label: "Provider", items: providerItems });
  }
  return groups;
}

const pathActionClassName =
  "mx-1 flex h-10 w-[calc(100%-0.5rem)] cursor-pointer items-center gap-3 rounded-[13px] px-2.5 text-left transition-colors duration-100 hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  pluginQuery: string;
  showWorkspaceFiles?: boolean;
  groupSlashCommandSections?: boolean;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
  onPluginSelect: (plugin: PluginDefinition) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pathMenuDismissed, setPathMenuDismissed] = useState(false);
  const groups = useMemo(
    () =>
      groupCommandItems(props.items, props.triggerKind, props.groupSlashCommandSections ?? true),
    [props.groupSlashCommandSections, props.items, props.triggerKind],
  );
  const pathItems = useMemo(
    () =>
      props.items.filter(
        (item): item is Extract<ComposerCommandItem, { type: "path" }> => item.type === "path",
      ),
    [props.items],
  );
  const pluginItems = useMemo(() => searchPlugins(props.pluginQuery), [props.pluginQuery]);
  const pathPicker = props.triggerKind === "path";

  useEffect(() => {
    if (!pathPicker) {
      setPathMenuDismissed(false);
      return;
    }

    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && listRef.current?.contains(target)) return;

      // The + button deliberately opens this same picker. Treat it as an
      // explicit reopen action even if the current @ session was dismissed.
      if (
        target instanceof Element &&
        target.closest('[data-composer-add-menu-trigger="true"]') !== null
      ) {
        setPathMenuDismissed(false);
        return;
      }

      setPathMenuDismissed(true);
      props.onHighlightedItemChange(null);
    };

    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  }, [pathPicker, props.onHighlightedItemChange]);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  const showWorkspaceFiles = pathPicker && (props.showWorkspaceFiles ?? true);

  const pickFile = async () => {
    const bridge = window.desktopBridge as ComposerDesktopBridge | undefined;
    if (!bridge?.pickFileOrFolder) return;

    // Select one file at a time to avoid eagerly loading a large batch. The
    // selected path is inserted through the same real @-file context path as
    // workspace results, so this works for any file type rather than images only.
    const selectedPath = await bridge.pickFileOrFolder({ kind: "file" });
    if (!selectedPath) return;

    props.onSelect({
      id: `native-path:${selectedPath}`,
      type: "path",
      path: selectedPath,
      pathKind: "file",
      label: basename(selectedPath),
      description: selectedPath,
    });
  };

  if (pathPicker && pathMenuDismissed) {
    return null;
  }

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div
        ref={listRef}
        data-composer-command-menu="true"
        className="relative w-full overflow-hidden rounded-[22px] border border-border/80 bg-popover text-popover-foreground shadow-2xl"
      >
        {pathPicker ? (
          <CommandList className="max-h-[min(20rem,45vh)] p-1.5">
            <CommandGroup>
              <button
                type="button"
                className={pathActionClassName}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void pickFile()}
              >
                <PaperclipIcon className="size-[18px] shrink-0 text-foreground/85" />
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="shrink-0 text-[14px] font-medium text-foreground">
                    Upload files
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground/70">
                    Add from your computer
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={pathActionClassName}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onSelect(PATH_PLAN_MODE_ITEM)}
              >
                <ListTodoIcon className="size-[18px] shrink-0 text-foreground/85" />
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="shrink-0 text-[14px] font-medium text-foreground">
                    Plan mode
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground/70">
                    Switch this chat to planning
                  </span>
                </span>
              </button>
            </CommandGroup>

            {pluginItems.length > 0 ? (
              <>
                <CommandSeparator className="mx-2 my-1.5 w-auto bg-border/60" />
                <CommandGroup>
                  <CommandGroupLabel className="px-3 pb-1 pt-1.5 text-[12px] font-medium tracking-normal text-muted-foreground/70">
                    Plugins
                  </CommandGroupLabel>
                  <div className="space-y-0.5 px-1">
                    {pluginItems.map((plugin) => (
                      <CommandItem
                        key={plugin.id}
                        value={`plugin:${plugin.id}`}
                        title={plugin.name}
                        className="flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-xl px-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent/70 hover:text-inherit data-highlighted:bg-accent/70 data-highlighted:text-inherit"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => props.onPluginSelect(plugin)}
                      >
                        <PluginLogo pluginId={plugin.id} className="size-4" />
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="shrink-0 font-medium">{plugin.name}</span>
                          <span className="min-w-0 truncate text-[12px] text-muted-foreground/70">
                            {plugin.description}
                          </span>
                        </span>
                      </CommandItem>
                    ))}
                  </div>
                </CommandGroup>
              </>
            ) : null}

            {showWorkspaceFiles ? (
              <>
                <CommandSeparator className="mx-2 my-1.5 w-auto bg-border/60" />
                <CommandGroup>
                  {pathItems.length > 0 ? (
                    pathItems.map((item) => (
                      <ComposerCommandMenuItem
                        key={item.id}
                        item={item}
                        resolvedTheme={props.resolvedTheme}
                        isActive={props.activeItemId === item.id}
                        onHighlight={props.onHighlightedItemChange}
                        onSelect={props.onSelect}
                        compactPath
                      />
                    ))
                  ) : (
                    <p className="px-3 py-2 text-[12px] text-muted-foreground/65">
                      {props.isLoading ? "Loading files..." : "No workspace files found."}
                    </p>
                  )}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        ) : props.items.length > 0 ? (
          <CommandList className="max-h-72 py-1.5">
            {groups.map((group, groupIndex) => (
              <div key={group.id}>
                {groupIndex > 0 ? <CommandSeparator className="mx-3 my-1 w-auto" /> : null}
                <CommandGroup>
                  {group.label ? (
                    <CommandGroupLabel className="px-4 pb-1.5 pt-2 text-[12px] font-medium tracking-normal text-muted-foreground/65">
                      {group.label}
                    </CommandGroupLabel>
                  ) : null}
                  {group.items.map((item) => (
                    <ComposerCommandMenuItem
                      key={item.id}
                      item={item}
                      resolvedTheme={props.resolvedTheme}
                      isActive={props.activeItemId === item.id}
                      onHighlight={props.onHighlightedItemChange}
                      onSelect={props.onSelect}
                    />
                  ))}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
        ) : (
          <div className="px-5 py-4">
            {props.triggerKind === "skill" ? (
              <CommandGroup>
                <CommandGroupLabel className="px-0 pb-1 pt-0 text-[12px] font-medium tracking-normal text-muted-foreground/65">
                  Skills
                </CommandGroupLabel>
                <p className="text-muted-foreground/70 text-xs">
                  {props.isLoading
                    ? "Searching workspace skills..."
                    : (props.emptyStateText ??
                      "No skills found. Try / to browse provider commands.")}
                </p>
              </CommandGroup>
            ) : (
              <p className="text-muted-foreground/70 text-xs">
                {props.isLoading
                  ? "Searching..."
                  : (props.emptyStateText ?? "No matching command.")}
              </p>
            )}
          </div>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
  compactPath?: boolean;
}) {
  const skillSourceLabel =
    props.item.type === "skill" ? formatProviderSkillInstallSource(props.item.skill) : null;

  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        props.compactPath
          ? "mx-1 min-h-10 w-[calc(100%-0.5rem)] cursor-pointer select-none gap-3 rounded-[13px] px-2.5 py-2 hover:bg-accent/70 hover:text-inherit data-highlighted:bg-accent/70 data-highlighted:text-inherit"
          : "mx-2 w-[calc(100%-1rem)] cursor-pointer select-none gap-2 rounded-xl px-3 py-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent/70! text-accent-foreground!",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "slash-command" ? (
        <BotIcon className="size-4 shrink-0 text-muted-foreground/80" />
      ) : null}
      {props.item.type === "provider-slash-command" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">
          <SkillGlyph className="size-3.5" />
        </span>
      ) : null}
      {props.item.type === "skill" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">
          <SkillGlyph className="size-3.5" />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className={cn("shrink-0", props.compactPath && "text-[14px]")}>
          {props.item.label}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-muted-foreground/70",
            props.compactPath ? "text-[13px]" : "text-xs",
          )}
        >
          {props.item.description}
        </span>
      </span>
      {skillSourceLabel ? (
        <span className="shrink-0 pl-2 text-muted-foreground/70 text-xs">{skillSourceLabel}</span>
      ) : null}
    </CommandItem>
  );
});
