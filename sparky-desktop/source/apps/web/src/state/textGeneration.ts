import { createTextGenerationEnvironmentAtoms } from "@sparky/client-runtime/state/textGeneration";

import { connectionAtomRuntime } from "../connection/runtime";

export const textGenerationEnvironment =
  createTextGenerationEnvironmentAtoms(connectionAtomRuntime);
