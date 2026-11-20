import { squashAtomCommandFailure } from "@sparky/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";

/** A human-readable message for a failed Teams command or query. */
export function teamsFailureMessage(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = error.detail;
    if (typeof detail === "string" && detail.trim().length > 0) {
      return detail;
    }
  }
  return fallback;
}
