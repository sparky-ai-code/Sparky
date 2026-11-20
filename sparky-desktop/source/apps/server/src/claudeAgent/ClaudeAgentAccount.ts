// @effect-diagnostics globalTimers:off
/**
 * Detects whether the user's own Claude Code is signed in, and to which plan.
 *
 * The probe starts the Claude Code process with a prompt that never yields, so the
 * CLI only initializes and reports its account. No model request is sent, and no
 * token is read or stored by Sparky. Sign-in itself stays in Anthropic's CLI
 * (`claude auth login`).
 *
 * @module claudeAgent/ClaudeAgentAccount
 */
import { query as sdkQuery, type AccountInfo } from "@anthropic-ai/claude-agent-sdk";

import { buildClaudeAgentChildEnvironment } from "./ClaudeAgentOptions.ts";

export interface ClaudeAccountStatus {
  readonly signedIn: boolean;
  readonly email?: string | undefined;
  /** Human plan name, for example "Max" or "Pro". */
  readonly plan?: string | undefined;
  readonly reason?: string | undefined;
}

export const CLAUDE_SIGN_IN_COMMAND = "claude auth login";

const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
  ultra: "Ultra",
};

/** "max" -> "Max", "claude_max_5x" -> "Max" when the name carries a known plan. */
export function claudeAccountPlanLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.trim().toLowerCase();
  if (!normalized) return undefined;
  const known = Object.keys(PLAN_LABELS).find((plan) => normalized.includes(plan));
  if (known) return PLAN_LABELS[known];
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function claudeAccountStatusFromInfo(info: AccountInfo | undefined): ClaudeAccountStatus {
  const plan = claudeAccountPlanLabel(info?.subscriptionType);
  const email = info?.email?.trim() || undefined;
  if (!info || (!plan && !email)) {
    return {
      signedIn: false,
      reason: `Claude Code is not signed in. Run \`${CLAUDE_SIGN_IN_COMMAND}\` in a terminal, then refresh.`,
    };
  }
  return { signedIn: true, email, plan };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out reading the Claude Code account.")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Never resolves, so the CLI initializes without starting a turn. */
async function* neverYieldingPrompt(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

export async function probeClaudeAccount(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly pathToClaudeCodeExecutable?: string | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<ClaudeAccountStatus> {
  const abortController = new AbortController();
  const query = sdkQuery({
    prompt: neverYieldingPrompt(),
    options: {
      cwd: input.cwd,
      // No API key: the probe reports the CLI's own sign-in, not a key.
      env: buildClaudeAgentChildEnvironment({ environment: input.environment }),
      settingSources: [],
      abortController,
      ...(input.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }
        : {}),
    },
  });
  try {
    // initializationResult() reports the account the CLI loaded at startup, the same
    // call T3 Code uses to label its Claude sign-in.
    const init = await withTimeout(query.initializationResult(), input.timeoutMs ?? 15_000);
    return claudeAccountStatusFromInfo(init.account);
  } catch (error) {
    return {
      signedIn: false,
      reason: error instanceof Error ? error.message : "Could not read the Claude Code account.",
    };
  } finally {
    abortController.abort();
    query.close();
  }
}
