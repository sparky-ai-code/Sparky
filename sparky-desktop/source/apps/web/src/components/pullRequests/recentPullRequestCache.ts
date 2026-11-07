export type CachedPullRequest = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly updatedAt: string;
  readonly repository: string;
};

const STORAGE_KEY = "sparky:recent-pull-requests:v1";
const CHANGE_EVENT = "sparky:recent-pull-requests-updated";
const LIMIT = 30;

function readStorage(): CachedPullRequest[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is CachedPullRequest =>
      typeof item === "object" && item !== null &&
      Number.isInteger(item.number) && typeof item.title === "string" &&
      typeof item.url === "string" && typeof item.state === "string" &&
      typeof item.isDraft === "boolean" && typeof item.updatedAt === "string" &&
      typeof item.repository === "string",
    ).slice(0, LIMIT);
  } catch {
    return [];
  }
}

export function readRecentPullRequestCache(): ReadonlyArray<CachedPullRequest> {
  return readStorage();
}

export function cacheRecentPullRequests(repository: string, pullRequests: ReadonlyArray<Omit<CachedPullRequest, "repository">>): void {
  if (typeof window === "undefined") return;
  const next = [...pullRequests.map((pullRequest) => ({ ...pullRequest, repository })), ...readStorage()]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.repository === item.repository && candidate.number === item.number) === index)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, LIMIT);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Keep the in-memory PR view usable when browser storage is unavailable/full.
  }
}

export async function refreshRecentPullRequests(cwds: string[]): Promise<void> {
  if (typeof window === "undefined" || cwds.length === 0) return;
  const bridge = window.desktopBridge as typeof window.desktopBridge & {
    getGitHubCliStatus?: () => Promise<{ auth: string }>;
    listGitHubRepositories?: (input: { cwds: string[] }) => Promise<{
      repositories: Array<{ nameWithOwner: string; isLocal: boolean }>;
      error: string | null;
    }>;
    listGitHubPullRequests?: (input: { repository: string; scope: "all" }) => Promise<{
      pullRequests: Array<Omit<CachedPullRequest, "repository">>;
      error: string | null;
    }>;
  };
  if (!bridge?.getGitHubCliStatus || !bridge.listGitHubRepositories || !bridge.listGitHubPullRequests) return;
  try {
    const status = await bridge.getGitHubCliStatus();
    if (status.auth !== "authenticated") return;
    const repositories = await bridge.listGitHubRepositories({ cwds });
    if (repositories.error) return;
    const repository = repositories.repositories.find((item) => item.isLocal) ?? repositories.repositories[0];
    if (!repository) return;
    const result = await bridge.listGitHubPullRequests({ repository: repository.nameWithOwner, scope: "all" });
    if (result.error) return;
    cacheRecentPullRequests(repository.nameWithOwner, result.pullRequests);
  } catch {
    // Keep cached summaries available when GitHub is unavailable.
  }
}

export function subscribeRecentPullRequestCache(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
