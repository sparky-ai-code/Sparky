import { create } from "zustand";
import type { ScopedThreadRef } from "@sparky/contracts";
import { scopedThreadKey } from "@sparky/client-runtime/environment";

export type SplitChatSide = "left" | "right" | "bottom-left" | "bottom-right";
export type SplitChatPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

interface SplitChatState {
  readonly panes: Partial<Record<SplitChatPosition, ScopedThreadRef>>;
  setSplit: (current: ScopedThreadRef, selected: ScopedThreadRef, side: SplitChatSide) => void;
  clearSplit: () => void;
}

export const useSplitChatStore = create<SplitChatState>((set) => ({
  panes: {},
  setSplit: (current, selected, side) => set((state) => {
    const position: SplitChatPosition = side === "left" ? "top-left"
      : side === "right" ? "top-right" : side;
    const panes = { ...state.panes };
    // Bottom targets become the normal left/right split until both top panes are occupied.
    const target = position.startsWith("bottom-") && (!panes["top-left"] || !panes["top-right"])
      ? position === "bottom-left" ? "top-left" : "top-right"
      : position;
    if (target === "top-left" || target === "top-right") {
      panes[target === "top-left" ? "top-right" : "top-left"] ??= current;
    }
    panes[target] = selected;
    return { panes };
  }),
  clearSplit: () => set({ panes: {} }),
}));

export function sameSplitChatThread(
  left: ScopedThreadRef | null,
  right: ScopedThreadRef | null,
): boolean {
  return left !== null && right !== null && scopedThreadKey(left) === scopedThreadKey(right);
}

export function splitChatTargetForSide(
  side: SplitChatSide,
  current: ScopedThreadRef,
  dragged: ScopedThreadRef,
): { left: ScopedThreadRef; right: ScopedThreadRef } {
  return side === "left" ? { left: dragged, right: current } : { left: current, right: dragged };
}
