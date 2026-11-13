import { createMicroboxesEnvironmentAtoms } from "@sparky/client-runtime/state/microboxes";
import { connectionAtomRuntime } from "../connection/runtime";

export const microboxesEnvironment = createMicroboxesEnvironmentAtoms(connectionAtomRuntime);
