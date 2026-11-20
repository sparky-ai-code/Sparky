import { create } from "zustand";

interface OptimisticThreadActivityState {
  updatedAtByThreadKey: Record<string, string>;
  markThreadMessage: (threadKey: string, createdAt: string) => void;
}

export const useOptimisticThreadActivity = create<OptimisticThreadActivityState>((set) => ({
  updatedAtByThreadKey: {},
  markThreadMessage: (threadKey, createdAt) =>
    set((state) => {
      const previous = state.updatedAtByThreadKey[threadKey];
      if (previous && Date.parse(previous) >= Date.parse(createdAt)) return state;
      return {
        updatedAtByThreadKey: { ...state.updatedAtByThreadKey, [threadKey]: createdAt },
      };
    }),
}));
