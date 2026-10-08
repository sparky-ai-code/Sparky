import { OpenAI, ClaudeAI, ACPRegistryIcon } from "../Icons";

export function HarnessLogo({ id, className }: { id: string; className?: string }) {
  const Icon = id.startsWith("codexHarness")
    ? OpenAI
    : id.startsWith("claudeHarness")
      ? ClaudeAI
      : ACPRegistryIcon;
  return <Icon className={className} aria-hidden />;
}
