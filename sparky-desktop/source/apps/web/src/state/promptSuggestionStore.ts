import { create } from "zustand";

/**
 * Next-prompt suggestion state, keyed by `threadId:turnId`. Held in memory
 * only: suggestions are cheap to regenerate and must never leak into a
 * persisted draft.
 */
export type PromptSuggestionEntry =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly suggestion: string }
  | { readonly status: "empty" };

interface PromptSuggestionStoreState {
  readonly entries: Readonly<Record<string, PromptSuggestionEntry>>;
  readonly setEntry: (key: string, entry: PromptSuggestionEntry) => void;
}

export const usePromptSuggestionStore = create<PromptSuggestionStoreState>()((set) => ({
  entries: {},
  setEntry: (key, entry) => set((state) => ({ entries: { ...state.entries, [key]: entry } })),
}));
