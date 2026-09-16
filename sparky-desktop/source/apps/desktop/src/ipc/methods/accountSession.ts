import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopAccountSessionStore from "../../app/DesktopAccountSessionStore.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const getAccountSessionToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_ACCOUNT_SESSION_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.accountSession.get")(function* () {
    const store = yield* DesktopAccountSessionStore.DesktopAccountSessionStore;
    return Option.getOrNull(yield* store.get);
  }),
});

export const setAccountSessionToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_ACCOUNT_SESSION_TOKEN_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.accountSession.set")(function* (token) {
    const store = yield* DesktopAccountSessionStore.DesktopAccountSessionStore;
    return yield* store.set(token);
  }),
});
