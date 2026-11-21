import { describe, expect, it } from "vitest";

import { KNOWN_TOOLS, resolveComputerUseAction } from "./computerUseWorkEntry";

const call = (toolName: string, extra: Record<string, unknown> = {}) =>
  resolveComputerUseAction("sparky_computer_use_call_tool", {
    arguments: { toolName, arguments: extra },
  });

describe("resolveComputerUseAction", () => {
  it("names each driver tool with a friendly label and its own icon", () => {
    expect(call("click")).toEqual({ label: "Click", icon: "mouse-pointer-click" });
    expect(call("double_click")).toEqual({ label: "Double-click", icon: "mouse" });
    expect(call("right_click")).toEqual({ label: "Right-click", icon: "menu" });
    expect(call("type_text")).toEqual({ label: "Type", icon: "type" });
    expect(call("hotkey")).toEqual({ label: "Shortcut", icon: "command" });
    expect(call("get_window_state")).toEqual({ label: "Inspect window", icon: "scan-eye" });
    expect(call("launch_app")).toEqual({ label: "Open app", icon: "rocket" });
    expect(call("page")).toEqual({ label: "Web page", icon: "globe" });
  });

  it("gives every known driver tool its own icon", () => {
    const names = Object.keys(KNOWN_TOOLS);
    expect(new Set(names.map((n) => KNOWN_TOOLS[n]!.icon)).size).toBe(names.length);
  });

  it("never includes Sparky or computer-use wording in the label", () => {
    expect(call("computer_zoom_in")?.label).toBe("Zoom in");
  });

  it("names the driver tool when the wrapper's own toolName is also present", () => {
    // This is the shape the server sends: the wrapper's name at the top level and
    // the driver tool under rawInput. It used to show "Sparky computer use call tool".
    expect(
      resolveComputerUseAction("sparky_computer_use_call_tool", {
        toolName: "sparky_computer_use_call_tool",
        kind: "sparky_computer_use_call_tool",
        rawInput: { toolName: "click", arguments: { x: 1, y: 2 } },
      }),
    ).toEqual({ label: "Click", icon: "mouse-pointer-click" });
  });

  it("keeps every label to two words or fewer, with no Sparky or computer wording", () => {
    for (const { label } of Object.values(KNOWN_TOOLS)) {
      expect(label.split(" ").length).toBeLessThanOrEqual(2);
      expect(label).not.toMatch(/sparky|computer/iu);
    }
    expect(call("some_unknown_thing_here")?.label).toBe("Some unknown");
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
