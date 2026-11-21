import * as Effect from "effect/Effect";

import * as ServerSettings from "../../serverSettings.ts";
import { getSharedComputerUseDriver } from "../ComputerUseDriver.ts";
import { ComputerUseToolkit } from "./computerUseTools.ts";

const DISABLED = {
  error:
    "Computer use is disabled. Ask the user to enable it in Settings > Computer use before retrying.",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The handlers read the settings service once, when the layer is built. A settings
// read that fails is a defect, because these tools declare no failure channel.
export const ComputerUseToolkitHandlersLive = ComputerUseToolkit.toLayer(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const computerUseEnabled = Effect.map(
      settings.getSettings,
      (current) => current.computerUse.enabled,
    ).pipe(Effect.orDie);
    return {
      sparky_computer_use_list_tools: () =>
        Effect.gen(function* () {
          if (!(yield* computerUseEnabled)) return DISABLED;
          return yield* Effect.tryPromise({
            try: () => getSharedComputerUseDriver().listTools(),
            catch: (error) => message(error),
          }).pipe(
            Effect.map((tools) => ({ tools })),
            Effect.catch((error) => Effect.succeed({ error })),
          );
        }),
      sparky_computer_use_call_tool: (input: {
        readonly toolName: string;
        readonly arguments: Record<string, unknown>;
      }) =>
        Effect.gen(function* () {
          if (!(yield* computerUseEnabled)) return DISABLED;
          return yield* Effect.tryPromise({
            try: () => getSharedComputerUseDriver().callTool(input.toolName, input.arguments),
            catch: (error) => message(error),
          }).pipe(Effect.catch((error) => Effect.succeed({ error })));
        }),
    };
  }),
);
