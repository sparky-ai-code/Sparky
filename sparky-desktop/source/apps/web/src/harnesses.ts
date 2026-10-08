import type { ServerProvider } from "@sparky/contracts";
import { ACP_DRIVER_KINDS } from "@sparky/shared/harnessMentions";

export function searchHarnesses(
  providers: readonly ServerProvider[],
  query: string,
): ServerProvider[] {
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:)\]}]+$/u, "");
  return providers.filter((provider) => {
    if (
      !ACP_DRIVER_KINDS.has(provider.driver) ||
      !provider.enabled ||
      provider.availability === "unavailable"
    )
      return false;
    const alias =
      provider.driver === "codexHarness"
        ? "codex"
        : provider.driver === "claudeHarness"
          ? "claude"
          : "";
    return (
      !normalized ||
      [alias, provider.instanceId, provider.displayName ?? ""].some((value) =>
        value.toLowerCase().includes(normalized),
      )
    );
  });
}

export function harnessLabel(instanceId: string): string {
  return instanceId === "codexHarness"
    ? "Codex CLI"
    : instanceId === "claudeHarness"
      ? "Claude Code"
      : instanceId;
}
