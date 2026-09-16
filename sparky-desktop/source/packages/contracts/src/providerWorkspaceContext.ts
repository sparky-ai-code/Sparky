import * as Schema from "effect/Schema";

/** Whether a provider session is associated with a user project. */
export const ProviderWorkspaceContext = Schema.Literals(["project", "none"]);
export type ProviderWorkspaceContext = typeof ProviderWorkspaceContext.Type;
