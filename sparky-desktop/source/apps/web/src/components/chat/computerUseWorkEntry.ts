export type ComputerUseIconName =
  | "mouse-pointer-click"
  | "mouse-pointer-2"
  | "keyboard"
  | "move"
  | "arrow-down-up"
  | "camera"
  | "eye"
  | "app-window"
  | "clock"
  | "globe"
  | "settings"
  | "video"
  | "x"
  | "zoom-in"
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

/** Finds the driver tool name ("click", "scroll", ...) inside a wrapper call's payload. */
export function extractComputerUseInnerToolName(toolData: unknown): string | undefined {
  const root = asRecord(toolData);
  if (!root) return undefined;
  const containers = [
    root,
    asRecord(root.arguments),
    asRecord(root.rawInput),
    asRecord(root.input),
    asRecord(root.args),
    asRecord(asRecord(root.item)?.arguments),
  ];
  for (const container of containers) {
    const name = container?.toolName;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return undefined;
}

const humanize = (name: string): string => {
  const words = name.replace(/[_\-.]+/gu, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Action";
};

// Exact names of the tools exposed by `cua-driver mcp`, with short labels.
const KNOWN_TOOLS: Record<string, ComputerUseAction> = {
  list_apps: { label: "List apps", icon: "app-window" },
  list_windows: { label: "List windows", icon: "app-window" },
  get_window_state: { label: "Inspect window", icon: "eye" },
  launch_app: { label: "Open app", icon: "app-window" },
  kill_app: { label: "Close app", icon: "x" },
  bring_to_front: { label: "Focus window", icon: "app-window" },
  debug_window_info: { label: "Window info", icon: "eye" },
  click: { label: "Click", icon: "mouse-pointer-click" },
  double_click: { label: "Double click", icon: "mouse-pointer-click" },
  right_click: { label: "Right click", icon: "mouse-pointer-click" },
  drag: { label: "Drag", icon: "move" },
  type_text: { label: "Type", icon: "keyboard" },
  press_key: { label: "Press key", icon: "keyboard" },
  hotkey: { label: "Shortcut", icon: "keyboard" },
  set_value: { label: "Set value", icon: "keyboard" },
  scroll: { label: "Scroll", icon: "arrow-down-up" },
  get_screen_size: { label: "Screen size", icon: "eye" },
  get_cursor_position: { label: "Cursor position", icon: "mouse-pointer-2" },
  move_cursor: { label: "Move", icon: "mouse-pointer-2" },
  set_agent_cursor_enabled: { label: "Cursor settings", icon: "mouse-pointer-2" },
  set_agent_cursor_motion: { label: "Cursor settings", icon: "mouse-pointer-2" },
  set_agent_cursor_style: { label: "Cursor settings", icon: "mouse-pointer-2" },
  get_agent_cursor_state: { label: "Cursor settings", icon: "mouse-pointer-2" },
  check_permissions: { label: "Check access", icon: "settings" },
  health_report: { label: "Health check", icon: "settings" },
  get_config: { label: "Driver settings", icon: "settings" },
  set_config: { label: "Driver settings", icon: "settings" },
  get_accessibility_tree: { label: "Inspect desktop", icon: "eye" },
  zoom: { label: "Zoom", icon: "zoom-in" },
  page: { label: "Browser page", icon: "globe" },
  start_recording: { label: "Start recording", icon: "video" },
  stop_recording: { label: "Stop recording", icon: "video" },
  get_recording_state: { label: "Recording status", icon: "video" },
  replay_trajectory: { label: "Replay", icon: "video" },
  install_ffmpeg: { label: "Install ffmpeg", icon: "settings" },
  start_session: { label: "Start session", icon: "clock" },
  end_session: { label: "End session", icon: "clock" },
  check_for_update: { label: "Check for update", icon: "settings" },
};

/** Maps a driver tool name to a short label and a distinct icon. */
export function describeComputerUseTool(innerToolName: string): ComputerUseAction {
  const name = innerToolName
    .trim()
    .toLowerCase()
    .replace(/^(computer|cua|desktop)[_\-.]/u, "");
  const known = KNOWN_TOOLS[name];
  if (known) return known;
  if (/double[_-]?click/u.test(name)) return { label: "Double click", icon: "mouse-pointer-click" };
  if (/right[_-]?click/u.test(name)) return { label: "Right click", icon: "mouse-pointer-click" };
  if (/click|tap/u.test(name)) return { label: "Click", icon: "mouse-pointer-click" };
  if (/drag/u.test(name)) return { label: "Drag", icon: "move" };
  if (/move|hover/u.test(name)) return { label: "Move", icon: "mouse-pointer-2" };
  if (/scroll/u.test(name)) return { label: "Scroll", icon: "arrow-down-up" };
  if (/hotkey|press|key/u.test(name)) return { label: "Press key", icon: "keyboard" };
  if (/type|text|input/u.test(name)) return { label: "Type", icon: "keyboard" };
  if (/screenshot|capture/u.test(name)) return { label: "Screenshot", icon: "camera" };
  if (/launch|open[_-]?app/u.test(name)) return { label: "Open app", icon: "app-window" };
  if (/list[_-]?(apps|windows)/u.test(name)) return { label: "List windows", icon: "app-window" };
  if (/state|snapshot|inspect|read|get/u.test(name)) return { label: "Inspect", icon: "eye" };
  if (/wait|sleep/u.test(name)) return { label: "Wait", icon: "clock" };
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
