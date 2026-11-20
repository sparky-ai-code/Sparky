import { describe, expect, it } from "vitest";

import { resolveComputerUseAction } from "./computerUseWorkEntry";

const call = (toolName: string, extra: Record<string, unknown> = {}) =>
  resolveComputerUseAction("sparky_computer_use_call_tool", {
    arguments: { toolName, arguments: extra },
  });

describe("resolveComputerUseAction", () => {
  it("names each driver tool with a short label and its own icon", () => {
    expect(call("click")).toEqual({ label: "Click", icon: "mouse-pointer-click" });
    expect(call("double_click")).toEqual({ label: "Double click", icon: "mouse-pointer-click" });
    expect(call("move_cursor")).toEqual({ label: "Move", icon: "mouse-pointer-2" });
    expect(call("scroll")).toEqual({ label: "Scroll", icon: "arrow-down-up" });
    expect(call("type_text")).toEqual({ label: "Type", icon: "keyboard" });
    expect(call("press_key")).toEqual({ label: "Press key", icon: "keyboard" });
    expect(call("hotkey")).toEqual({ label: "Shortcut", icon: "keyboard" });
    expect(call("get_window_state")).toEqual({ label: "Inspect window", icon: "eye" });
    expect(call("launch_app")).toEqual({ label: "Open app", icon: "app-window" });
    expect(call("page")).toEqual({ label: "Browser page", icon: "globe" });
    expect(call("set_agent_cursor_style")?.label).toBe("Cursor settings");
  });

  it("never includes Sparky or computer-use wording in the label", () => {
    expect(call("computer_zoom_in")?.label).toBe("Zoom in");
  });

  it("reads the inner name from rawInput or a JSON string", () => {
    expect(
      resolveComputerUseAction("sparky_computer_use_call_tool", { rawInput: { toolName: "click" } })
        ?.label,
    ).toBe("Click");
    expect(
      resolveComputerUseAction("sparky_computer_use_call_tool", {
        arguments: JSON.stringify({ toolName: "scroll" }),
      })?.label,
    ).toBe("Scroll");
  });

  it("falls back gracefully and ignores other tools", () => {
    expect(resolveComputerUseAction("sparky_computer_use_call_tool", undefined)?.label).toBe(
      "Action",
    );
    expect(resolveComputerUseAction("sparky_computer_use_list_tools", {})?.label).toBe(
      "List tools",
    );
    expect(resolveComputerUseAction("sparky_mcp_call_tool", {})).toBeUndefined();
  });
});
