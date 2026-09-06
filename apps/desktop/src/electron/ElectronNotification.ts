import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export interface ElectronNotificationInput {
  readonly title: string;
  readonly body: string;
}

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    readonly show: (input: ElectronNotificationInput) => Effect.Effect<void>;
  }
>()("@sparky/desktop/electron/ElectronNotification") {}

export const make = ElectronNotification.of({
  show: (input) =>
    Effect.sync(() => {
      if (!Electron.Notification.isSupported()) {
        return;
      }
      new Electron.Notification({
        title: input.title,
        body: input.body,
      }).show();
    }),
});

export const layer = Layer.succeed(ElectronNotification, make);
