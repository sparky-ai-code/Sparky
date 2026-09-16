import type { AuthSessionId } from "@sparky/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface ProviderExecutionContextValue {
  readonly authSessionId: AuthSessionId | null;
}

export class ProviderExecutionContext extends Context.Service<
  ProviderExecutionContext,
  ProviderExecutionContextValue
>()("t3/provider/ProviderExecutionContext") {}

// The provider execution context is optional for callers that issue anonymous sessions.
export const currentAuthSessionId = Effect.gen(function* () {
  const context = yield* Effect.context<ProviderExecutionContext>();
  return (
    Option.getOrNull(Context.getOption(context, ProviderExecutionContext))?.authSessionId ?? null
  );
}) as Effect.Effect<AuthSessionId | null>;
