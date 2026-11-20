import { WS_METHODS } from "@sparky/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Atoms for the GitHub-backed Teams feature. Mirrors `sourceControl.ts`:
 * queries are keyed by environment + input, commands are serialized per
 * environment so chat writes never race each other.
 *
 * Polling is NOT done here. The web layer owns refresh cadence so that only
 * the message/thread views update and nothing else re-renders.
 */
export function createTeamsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    listTeams: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:teams:list-teams",
      tag: WS_METHODS.teamsListTeams,
    }),
    listThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:teams:list-threads",
      tag: WS_METHODS.teamsListThreads,
    }),
    listMessages: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:teams:list-messages",
      tag: WS_METHODS.teamsListMessages,
    }),
    createTeam: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teams:create-team",
      tag: WS_METHODS.teamsCreateTeam,
      scheduler: commandScheduler,
      concurrency,
    }),
    addProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teams:add-project",
      tag: WS_METHODS.teamsAddProject,
      scheduler: commandScheduler,
      concurrency,
    }),
    inviteMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teams:invite-member",
      tag: WS_METHODS.teamsInviteMember,
      scheduler: commandScheduler,
      concurrency,
    }),
    createThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teams:create-thread",
      tag: WS_METHODS.teamsCreateThread,
      scheduler: commandScheduler,
      concurrency,
    }),
    postMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teams:post-message",
      tag: WS_METHODS.teamsPostMessage,
      scheduler: commandScheduler,
      concurrency,
    }),
    toggleReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teams:toggle-reaction",
      tag: WS_METHODS.teamsToggleReaction,
      scheduler: commandScheduler,
      concurrency,
    }),
  };
}
