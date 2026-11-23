import { WS_METHODS } from "@sparky/contracts";
import type { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createTextGenerationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    generatePromptSuggestion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:text-generation:prompt-suggestion",
      tag: WS_METHODS.generatePromptSuggestion,
    }),
  };
}
