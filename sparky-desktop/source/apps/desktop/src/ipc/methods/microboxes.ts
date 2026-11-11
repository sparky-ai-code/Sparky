import { DesktopMicroboxesSetupStateSchema } from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as MicroboxesSetup from "../../microboxes/MicroboxesSetup.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getSetupState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MICROBOXES_GET_SETUP_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopMicroboxesSetupStateSchema,
  handler: () => Effect.promise(() => MicroboxesSetup.getMicroboxesSetupState()),
});

export const setup = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MICROBOXES_SETUP_CHANNEL,
  payload: Schema.Void,
  result: DesktopMicroboxesSetupStateSchema,
  handler: () => Effect.promise(() => MicroboxesSetup.setupMicroboxes()),
});
