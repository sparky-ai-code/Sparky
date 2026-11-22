export type ComputerUseIconName =
  | "mouse-pointer-click"
  | "mouse-pointer-2"
  | "mouse-pointer"
  | "mouse"
  | "menu"
  | "move"
  | "keyboard"
  | "type"
  | "command"
  | "text-cursor-input"
  | "arrow-down-up"
  | "layout-grid"
  | "panels-top-left"
  | "scan-eye"
  | "rocket"
  | "power"
  | "bug"
  | "app-window"
  | "monitor"
  | "crosshair"
  | "toggle-right"
  | "route"
  | "palette"
  | "shield-check"
  | "activity"
  | "sliders-horizontal"
  | "settings"
  | "list-tree"
  | "zoom-in"
  | "globe"
  | "video"
  | "square"
  | "radio"
  | "history"
  | "download"
  | "play-circle"
  | "log-out"
  | "refresh-cw"
  | "list-checks";

export interface ComputerUseAction {
  readonly label: string;
  readonly icon: ComputerUseIconName;
}

const WRAPPER_TOOLS = new Set(["sparky_computer_use_call_tool", "sparky_computer_use_list_tools"]);

export function isComputerUseWrapperTool(toolName: string | undefined): boolean {
  return WRAPPER_TOOLS.has(toolName?.trim().toLowerCase() ?? "");
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

/**
 * Finds the driver tool name ("click", "scroll", ...) inside a wrapper call's payload.
 * The wrapper's own top-level `toolName` is the wrapper name, not the driver tool,
 * so the nested arguments are checked first and wrapper names are ignored.
 */
export function extractComputerUseInnerToolName(toolData: unknown): string | undefined {
  const root = asRecord(toolData);
  if (!root) return undefined;
  const containers = [
    asRecord(root.rawInput),
    asRecord(root.arguments),
    asRecord(root.input),
    asRecord(root.args),
    asRecord(asRecord(root.item)?.arguments),
    root,
  ];
  for (const container of containers) {
    const name = typeof container?.toolName === "string" ? container.toolName.trim() : "";
    if (name && !isComputerUseWrapperTool(name)) return name;
  }
  return undefined;
}

/** Fallback label for an unknown driver tool: at most two words. */
const humanize = (name: string): string => {
  const words = name
    .replace(/[_\-.]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Action";
};

// Exact names of the tools exposed by `cua-driver mcp`. Labels are friendly and
// intentionally differ from the backend names; every tool has its own icon.
export const KNOWN_TOOLS: Record<string, ComputerUseAction> = {
  list_apps: { label: "Browse apps", icon: "layout-grid" },
  list_windows: { label: "Find windows", icon: "panels-top-left" },
  get_window_state: { label: "Inspect window", icon: "scan-eye" },
  launch_app: { label: "Open app", icon: "rocket" },
  kill_app: { label: "Quit app", icon: "power" },
  bring_to_front: { label: "Bring forward", icon: "app-window" },
  debug_window_info: { label: "Debug window", icon: "bug" },
  click: { label: "Click", icon: "mouse-pointer-click" },
  double_click: { label: "Double-click", icon: "mouse" },
  right_click: { label: "Right-click", icon: "menu" },
  drag: { label: "Drag", icon: "move" },
  type_text: { label: "Type", icon: "type" },
  press_key: { label: "Press key", icon: "keyboard" },
  hotkey: { label: "Shortcut", icon: "command" },
  set_value: { label: "Fill field", icon: "text-cursor-input" },
  scroll: { label: "Scroll", icon: "arrow-down-up" },
  get_screen_size: { label: "Screen size", icon: "monitor" },
  get_cursor_position: { label: "Find cursor", icon: "crosshair" },
  move_cursor: { label: "Move", icon: "mouse-pointer-2" },
  set_agent_cursor_enabled: { label: "Show cursor", icon: "toggle-right" },
  set_agent_cursor_motion: { label: "Cursor motion", icon: "route" },
  set_agent_cursor_style: { label: "Cursor style", icon: "palette" },
  get_agent_cursor_state: { label: "Cursor info", icon: "mouse-pointer" },
  check_permissions: { label: "Permissions", icon: "shield-check" },
  health_report: { label: "Health check", icon: "activity" },
  get_config: { label: "Read settings", icon: "sliders-horizontal" },
  set_config: { label: "Change settings", icon: "settings" },
  get_accessibility_tree: { label: "Scan desktop", icon: "list-tree" },
  zoom: { label: "Zoom", icon: "zoom-in" },
  page: { label: "Web page", icon: "globe" },
  start_recording: { label: "Record", icon: "video" },
  stop_recording: { label: "Stop recording", icon: "square" },
  get_recording_state: { label: "Recording status", icon: "radio" },
  replay_trajectory: { label: "Replay", icon: "history" },
  install_ffmpeg: { label: "Get ffmpeg", icon: "download" },
  start_session: { label: "Begin session", icon: "play-circle" },
  end_session: { label: "End session", icon: "log-out" },
  check_for_update: { label: "Check updates", icon: "refresh-cw" },
};

/** Maps a driver tool name to a short label and a distinct icon. */
export function describeComputerUseTool(innerToolName: string): ComputerUseAction {
  const name = innerToolName
    .trim()
    .toLowerCase()
    .replace(/^(computer|cua|desktop)[_\-.]/u, "");
  const known = KNOWN_TOOLS[name];
  if (known) return known;
  if (/double[_-]?click/u.test(name)) return { label: "Double-click", icon: "mouse-pointer-click" };
  if (/right[_-]?click/u.test(name)) return { label: "Right-click", icon: "mouse-pointer-click" };
  if (/click|tap/u.test(name)) return { label: "Click", icon: "mouse-pointer-click" };
  if (/drag/u.test(name)) return { label: "Drag", icon: "move" };
  if (/move|hover/u.test(name)) return { label: "Move", icon: "mouse-pointer-2" };
  if (/scroll/u.test(name)) return { label: "Scroll", icon: "arrow-down-up" };
  if (/hotkey|press|key/u.test(name)) return { label: "Press key", icon: "keyboard" };
  if (/type|text|input/u.test(name)) return { label: "Type", icon: "keyboard" };
  if (/screenshot|capture/u.test(name)) return { label: "Screenshot", icon: "scan-eye" };
  if (/launch|open[_-]?app/u.test(name)) return { label: "Open app", icon: "app-window" };
  if (/list[_-]?(apps|windows)/u.test(name)) return { label: "List windows", icon: "app-window" };
  if (/state|snapshot|inspect|read|get/u.test(name)) return { label: "Inspect", icon: "scan-eye" };
  if (/wait|sleep/u.test(name)) return { label: "Wait", icon: "history" };
  return { label: humanize(name), icon: "mouse-pointer-2" };
}

/** Presentation for a Sparky computer-use wrapper call, or undefined for any other tool. */
export function resolveComputerUseAction(
  toolName: string | undefined,
  toolData: unknown,
): ComputerUseAction | undefined {
  const normalized = toolName?.trim().toLowerCase();
  if (!isComputerUseWrapperTool(normalized)) return undefined;
  if (normalized === "sparky_computer_use_list_tools") {
    return { label: "List tools", icon: "list-checks" };
  }
  const inner = extractComputerUseInnerToolName(toolData);
  return inner ? describeComputerUseTool(inner) : { label: "Action", icon: "mouse-pointer-2" };
}
