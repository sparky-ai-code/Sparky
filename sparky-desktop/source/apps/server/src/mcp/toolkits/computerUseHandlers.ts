import * as Effect from "effect/Effect";

import * as ServerSettings from "../../serverSettings.ts";
import { getSharedComputerUseDriver } from "../ComputerUseDriver.ts";
import { ComputerUseToolkit } from "./computerUseTools.ts";

const DISABLED = {
  error:
    "Computer use is disabled. Ask the user to enable it in Settings > Computer use before retrying.",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const handlers = {
  sparky_computer_use_list_tools: () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      if (!(yield* settings.getSettings).computerUse.enabled) return DISABLED;
      return yield* Effect.tryPromise({
        try: () => getSharedComputerUseDriver().listTools(),
        catch: (error) => error,
      }).pipe(
        Effect.map((tools) => ({ tools })),
        Effect.catch((error) => Effect.succeed({ error: message(error) })),
      );
    }),
  sparky_computer_use_call_tool: (input) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      if (!(yield* settings.getSettings).computerUse.enabled) return DISABLED;
      return yield* Effect.tryPromise({
        try: () => getSharedComputerUseDriver().callTool(input.toolName, input.arguments),
        catch: (error) => error,
      }).pipe(Effect.catch((error) => Effect.succeed({ error: message(error) })));
    }),
} satisfies Parameters<typeof ComputerUseToolkit.toLayer>[0];

export const ComputerUseToolkitHandlersLive = ComputerUseToolkit.toLayer(handlers);
