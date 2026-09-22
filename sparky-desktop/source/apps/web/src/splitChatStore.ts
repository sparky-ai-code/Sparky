import { create } from "zustand";
import type { ScopedThreadRef } from "@sparky/contracts";
import { scopedThreadKey } from "@sparky/client-runtime/environment";

export type SplitChatSide = "left" | "right";

interface SplitChatState {
  readonly left: ScopedThreadRef | null;
  readonly right: ScopedThreadRef | null;
  setSplit: (left: ScopedThreadRef, right: ScopedThreadRef) => void;
  clearSplit: () => void;
}

export const useSplitChatStore = create<SplitChatState>((set) => ({
  left: null,
  right: null,
  setSplit: (left, right) => set({ left, right }),
  clearSplit: () => set({ left: null, right: null }),
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
