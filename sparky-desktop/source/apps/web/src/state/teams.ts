import { createTeamsEnvironmentAtoms } from "@sparky/client-runtime/state/teams";

import { connectionAtomRuntime } from "../connection/runtime";

export const teamsEnvironment = createTeamsEnvironmentAtoms(connectionAtomRuntime);
