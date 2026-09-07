/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * Every driver that the server knows how to instantiate from settings is
 * listed here. The `ProviderInstanceRegistry` iterates this array when
 * resolving `providerInstances` entries; anything not in the array surfaces
 * as an `"unavailable"` shadow snapshot at runtime (see
 * `buildUnavailableProviderSnapshot`).
 *
 * The aggregated Sparky driver owns the OpenAI/Codex, Claude/Anthropic,
 * Google/Gemini catalogs. Standalone native CLI drivers are
 * intentionally not registered here, so they cannot create duplicate
 * provider instances in the backend or picker.
 *
 * Adding a new first-party driver means:
 *   1. implement `ProviderDriver` in a sibling `Drivers/<Name>Driver.ts`,
 *   2. add it to this array,
 *   3. ensure the runtime layer satisfies its declared `R`.
 *
 * The aggregated `BuiltInDriversEnv` type is the union of every driver's
 * env requirement — the registry layer's `R` is this type, and the runtime
 * layer (ChildProcessSpawner, FileSystem, Path, ServerConfig,
 * must satisfy it.
 *
 * @module provider/builtInDrivers
 */
import { SparkyDriver } from "./Drivers/SparkyDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { ServerConfig } from "../config.ts";
import type { ProviderEventLoggers } from "./Layers/ProviderEventLoggers.ts";

/**
 * Union of infrastructure services required to construct any built-in
 * driver. The registry layer declares `R = BuiltInDriversEnv`; the runtime
 * layer must provide every service in this union.
 */
export type BuiltInDriversEnv = ServerSettingsService | ServerConfig | ProviderEventLoggers;

/** Only the aggregated Sparky runtime is exposed as a built-in provider. */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [SparkyDriver];
