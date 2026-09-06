export type PluginId =
  | "github"
  | "jira"
  | "notion"
  | "gmail"
  | "outlook"
  | "slack"
  | "sentry"
  | "figma";

export interface PluginDefinition {
  readonly id: PluginId;
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export const PLUGINS: readonly PluginDefinition[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Work with repositories, pull requests, issues, and comments",
    keywords: ["code", "repository", "pull request", "issue"],
  },
  {
    id: "jira",
    name: "Jira",
    description: "Search, create, and update Jira issues",
    keywords: ["atlassian", "issue", "board", "sprint"],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search and update pages and team knowledge",
    keywords: ["docs", "database", "knowledge", "wiki"],
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, draft, and send email",
    keywords: ["google", "email", "inbox", "message"],
  },
  {
    id: "outlook",
    name: "Outlook",
    description: "Read, draft, and send Microsoft email",
    keywords: ["microsoft", "email", "inbox", "message"],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read channels and send team messages",
    keywords: ["chat", "message", "channel", "team"],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Inspect and update application issues",
    keywords: ["errors", "issues", "monitoring", "observability"],
  },
  {
    id: "figma",
    name: "Figma",
    description: "Read files and work with design comments",
    keywords: ["design", "component", "prototype", "ui"],
  },
] as const;

export const PLUGIN_TOKEN_PREFIX = "@plugin:";

export function getPluginById(pluginId: string): PluginDefinition | null {
  return PLUGINS.find((plugin) => plugin.id === pluginId) ?? null;
}

export function serializePluginToken(pluginId: PluginId): string {
  return `${PLUGIN_TOKEN_PREFIX}${pluginId}`;
}

export function replacePluginTokensWithNames(text: string): string {
  return text.replace(
    /(^|\s)@plugin:([a-z]+)(?=$|[\s.,!?;:)\]}])/g,
    (match, prefix: string, id: string) => {
      const plugin = getPluginById(id);
      return plugin ? `${prefix}${plugin.name}` : match;
    },
  );
}

export function searchPlugins(query: string): PluginDefinition[] {
  const normalizedQuery = query.trim().toLocaleLowerCase().replace(/[.,!?;:)\]}]+$/u, "");
  return PLUGINS.filter((plugin) => matchesPlugin(plugin, normalizedQuery)).sort((left, right) => {
    const rank = (plugin: PluginDefinition) => {
      if (!normalizedQuery) return 0;
      const name = plugin.name.toLocaleLowerCase();
      if (name === normalizedQuery) return 0;
      if (name.startsWith(normalizedQuery)) return 1;
      if (name.includes(normalizedQuery)) return 2;
      return plugin.keywords.some((keyword) => keyword.toLocaleLowerCase().startsWith(normalizedQuery))
        ? 3
        : 4;
    };
    return rank(left) - rank(right);
  });
}

export function matchesPlugin(plugin: PluginDefinition, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [plugin.name, plugin.description, ...plugin.keywords].some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
}
