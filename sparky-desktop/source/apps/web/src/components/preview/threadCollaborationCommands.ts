import {
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
} from "@sparky/contracts";
import { EnvironmentSupervisor } from "@sparky/client-runtime/connection";
import { ShellSnapshotLoader } from "@sparky/client-runtime/state/shell";
import { ThreadSnapshotLoader } from "@sparky/client-runtime/state/threads";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "@sparky/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "~/connection/runtime";

/**
 * These commands use the desktop's EXISTING authenticated environment
 * connections; the model never receives any backend credential or URL.
 * Require an active connection and fresh HTTP data, never an offline cache.
 */
const requirePreparedConnection = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const connection = yield* SubscriptionRef.get(supervisor.state);
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (connection.phase !== "connected" || Option.isNone(prepared)) {
    return yield* Effect.fail(new Error("The requested environment is not connected."));
  }
  return prepared.value;
});

export const threadRelayShell = createEnvironmentCommand(connectionAtomRuntime, {
  label: "thread-relay:shell-snapshot",
  execute: (_input: Record<string, never>) =>
    Effect.gen(function* () {
      const prepared = yield* requirePreparedConnection;
      const loader = yield* ShellSnapshotLoader;
      const snapshot = yield* loader.load(prepared);
      if (Option.isNone(snapshot)) {
        return yield* Effect.fail(new Error("Could not fetch live projects and threads."));
      }
      return snapshot.value;
    }),
});

export const threadRelayRead = createEnvironmentCommand(connectionAtomRuntime, {
  label: "thread-relay:thread-snapshot",
  execute: (input: { readonly threadId: string }) =>
    Effect.gen(function* () {
      const prepared = yield* requirePreparedConnection;
      const loader = yield* ThreadSnapshotLoader;
      const snapshot = yield* loader.load(prepared, ThreadId.make(input.threadId));
      if (Option.isNone(snapshot)) {
        return yield* Effect.fail(new Error("Thread not found or detail unavailable."));
      }
      return snapshot.value.thread;
    }),
});

export const threadRelayServerConfig = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-relay:server-config",
  tag: WS_METHODS.serverGetConfig,
});

export const threadRelayRefs = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-relay:list-refs",
  tag: WS_METHODS.vcsListRefs,
});

export const threadRelayStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-relay:vcs-status",
  tag: WS_METHODS.vcsRefreshStatus,
});

export const threadRelayCreateWorktree = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-relay:create-worktree",
  tag: WS_METHODS.vcsCreateWorktree,
});

export const threadRelayRemoveWorktree = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-relay:remove-worktree",
  tag: WS_METHODS.vcsRemoveWorktree,
});

export const threadRelayDispatch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-relay:dispatch-command",
  tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
});
