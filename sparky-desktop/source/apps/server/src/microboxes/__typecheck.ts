// Temporary compile-time probe. Remove before merging.
import type * as Layer from "effect/Layer";
import * as Microboxes from "./Microboxes.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

declare const isActual: typeof Microboxes.layer extends Layer.Layer<
  Microboxes.Microboxes,
  never,
  ServerConfig.ServerConfig | ServerSettings.ServerSettingsService
> ? true : false;
const expectedTrue: true = isActual;
void expectedTrue;
