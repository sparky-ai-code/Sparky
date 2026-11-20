import {
  CircleDotIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { GitHubIcon } from "../Icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type GitHubStatus = {
  installed: boolean;
  version: string | null;
  auth: "authenticated" | "unauthenticated" | "unknown";
  account: string | null;
  detail: string | null;
};
type GitHubRepository = {
  nameWithOwner: string;
  url: string;
  isLocal: boolean;
};
type GitHubIssue = {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  authorLogin: string | null;
  body: string | null;
  commentsCount: number;
  labels: string[];
  assigneeLogin: string | null;
};
type GitHubBridge = {
  getGitHubCliStatus: () => Promise<GitHubStatus>;
  startGitHubCliAuth: () => Promise<GitHubStatus>;
  listGitHubRepositories: (input: { cwds: string[] }) => Promise<{
    repositories: GitHubRepository[];
    error: string | null;
  }>;
  listGitHubIssues: (input: {
    repository: string;
    state: "open" | "closed" | "all";
  }) => Promise<{ issues: GitHubIssue[]; error: string | null }>;
  openExternal: (url: string) => Promise<unknown>;
};
type IssueStateFilter = "open" | "closed" | "all";
type IssueOwnershipFilter = "mine" | "all";

function getBridge(): Partial<GitHubBridge> | null {
  return (
    (window.desktopBridge as
      | (typeof window.desktopBridge & Partial<GitHubBridge>)
      | undefined) ?? null
  );
}

function IssueStateIcon({ state }: { state: GitHubIssue["state"] }) {
  return state === "open" ? (
    <CircleDotIcon className="size-4 text-emerald-500" />
  ) : (
    <CircleDotIcon className="size-4 text-violet-500" />
  );
}

export function IssuesPage() {
  const projects = useProjects();
  const bridge = getBridge();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [repository, setRepository] = useState("");
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);
  const [stateFilter, setStateFilter] = useState<IssueStateFilter>("open");
  const [ownershipFilter, setOwnershipFilter] = useState<IssueOwnershipFilter>("mine");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const projectCwds = useMemo(
    () => [...new Set(projects.map((project) => project.workspaceRoot).filter(Boolean))],
    [projects],
  );
  const selectedIssue = issues.find((issue) => issue.number === selectedIssueNumber) ?? null;
  const filteredIssues = useMemo(() => {
    const account = status?.account?.toLocaleLowerCase();
    const visibleIssues = ownershipFilter === "mine" && account
      ? issues.filter(
          (issue) =>
            issue.authorLogin?.toLocaleLowerCase() === account ||
            issue.assigneeLogin?.toLocaleLowerCase() === account,
        )
      : issues;
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return visibleIssues;
    return visibleIssues.filter((issue) =>
      [issue.title, issue.body, String(issue.number), issue.authorLogin, ...issue.labels]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalized)),
    );
  }, [issues, ownershipFilter, query, status?.account]);

  const refreshStatus = useCallback(async () => {
    if (!bridge?.getGitHubCliStatus) return;
    try {
      const nextStatus = await bridge.getGitHubCliStatus();
      setStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      setStatus({
        installed: true,
        version: null,
        auth: "unknown",
        account: null,
        detail: error instanceof Error ? error.message : "Could not check the GitHub connection.",
      });
    }
  }, [bridge]);

  const loadRepositories = useCallback(async () => {
    if (!bridge?.listGitHubRepositories) return;
    setRepositoryError(null);
    try {
      const result = await bridge.listGitHubRepositories({ cwds: projectCwds });
      if (result.error) {
        setRepositoryError(result.error);
        return;
      }
      setRepositories(result.repositories);
      setRepository((current) =>
        result.repositories.some((item) => item.nameWithOwner === current)
          ? current
          : (result.repositories.find((item) => item.isLocal)?.nameWithOwner ??
            result.repositories[0]?.nameWithOwner ??
            ""),
      );
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : "Could not load GitHub repositories.");
    }
  }, [bridge, projectCwds]);

  const loadIssues = useCallback(async () => {
    if (!bridge?.listGitHubIssues || !repository) return;
    setLoading(true);
    setIssuesError(null);
    try {
      const result = await bridge.listGitHubIssues({ repository, state: stateFilter });
      if (result.error) {
        setIssuesError(result.error);
        setIssues([]);
        setSelectedIssueNumber(null);
        return;
      }
      setIssues(result.issues);
      setSelectedIssueNumber((current) =>
        current !== null && result.issues.some((issue) => issue.number === current)
          ? current
          : (result.issues[0]?.number ?? null),
      );
    } catch (error) {
      setIssuesError(error instanceof Error ? error.message : "Could not load issues.");
    } finally {
      setLoading(false);
    }
  }, [bridge, repository, stateFilter]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    if (status?.auth === "authenticated") void loadRepositories();
  }, [loadRepositories, status?.auth]);
  useEffect(() => {
    if (status?.auth === "authenticated" && repository) void loadIssues();
  }, [loadIssues, repository, stateFilter, status?.auth]);

  const connectGitHub = async () => {
    if (!bridge?.startGitHubCliAuth) return;
    setConnecting(true);
    try {
      await bridge.startGitHubCliAuth();
      const startedAt = Date.now();
      const poll = async () => {
        const next = await refreshStatus();
        if (next?.auth === "authenticated") {
          setConnecting(false);
          return;
        }
        if (Date.now() - startedAt < 5 * 60_000) {
          window.setTimeout(() => void poll(), 1_000);
        } else {
          setConnecting(false);
        }
      };
      window.setTimeout(() => void poll(), 1_000);
    } catch {
      setConnecting(false);
      void refreshStatus();
    }
  };

  if (!isElectron || !bridge?.getGitHubCliStatus) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <GitHubIcon className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h1 className="text-lg font-semibold">GitHub issues</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Connect GitHub in the Sparky desktop app to browse issues from your repositories.
          </p>
        </div>
      </div>
    );
  }

  if (status?.auth !== "authenticated") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <GitHubIcon className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Connect GitHub</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to browse issues across your repositories, or open issues from a selected project.
          </p>
          {status?.detail && status.auth === "unknown" ? (
            <p className="mt-3 text-xs text-destructive">{status.detail}</p>
          ) : null}
          <Button className="mt-5" disabled={connecting} onClick={() => void connectGitHub()}>
            {connecting ? <LoaderCircleIcon className="size-4 animate-spin" /> : <GitHubIcon className="size-4" />}
            {connecting ? "Waiting for GitHub…" : "Connect GitHub"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <CircleDotIcon className="size-5 text-emerald-500" />
            <h1 className="text-lg font-semibold tracking-tight">Issues</h1>
            {status.account ? <span className="text-xs text-muted-foreground">· @{status.account}</span> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Track work across your GitHub repositories</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Repository"
            className="h-9 max-w-[min(62vw,260px)] rounded-md border border-input bg-background px-3 text-sm"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
          >
            {repositories.map((item) => (
              <option key={item.nameWithOwner} value={item.nameWithOwner}>{item.nameWithOwner}</option>
            ))}
          </select>
          <Button aria-label="Refresh issues" size="icon" variant="outline" onClick={() => void loadIssues()}>
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border lg:max-w-[52%]">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
            <div className="inline-flex rounded-md bg-muted p-0.5" aria-label="Issue ownership">
              {(["mine", "all"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={ownershipFilter === filter}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                    ownershipFilter === filter ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setOwnershipFilter(filter)}
                >
                  {filter === "mine" ? "My issues" : "All issues"}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-md bg-muted p-0.5" aria-label="Issue status">
              {(["open", "closed", "all"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={stateFilter === filter}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                    stateFilter === filter ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setStateFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
            <div className="relative min-w-[180px] flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search issues" className="h-8 pl-8 text-xs" placeholder="Search issues…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <span className="text-xs text-muted-foreground">{filteredIssues.length} issues</span>
          </div>
          {repositoryError || issuesError ? (
            <div role="alert" className="border-b border-destructive/20 bg-destructive/5 px-5 py-3 text-sm text-destructive">
              {repositoryError ?? issuesError}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && issues.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />Loading issues…</div>
            ) : filteredIssues.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <CircleDotIcon className="mx-auto size-7 text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium">
                  {!repository ? "No GitHub repositories found" : query ? "No matching issues" : "No issues found"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {!repository ? "Connect a GitHub repository to a Sparky project." : "Try another status or repository."}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {filteredIssues.map((issue) => (
                  <li key={issue.number}>
                    <button
                      type="button"
                      aria-pressed={selectedIssueNumber === issue.number}
                      className={cn("w-full px-5 py-3.5 text-left transition-colors hover:bg-accent/50", selectedIssueNumber === issue.number && "bg-accent/60")}
                      onClick={() => setSelectedIssueNumber(issue.number)}
                    >
                      <div className="flex items-start gap-2.5">
                        <IssueStateIcon state={issue.state} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="line-clamp-2 text-sm font-medium leading-5">{issue.title}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">#{issue.number}</span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{issue.authorLogin ? `@${issue.authorLogin}` : "Unknown author"}</span>
                            <span>·</span><span>{formatRelativeTimeLabel(issue.updatedAt)}</span>
                            {issue.commentsCount > 0 ? <span className="inline-flex items-center gap-1"><MessageSquareIcon className="size-3" />{issue.commentsCount}</span> : null}
                          </div>
                          {issue.labels.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {issue.labels.slice(0, 4).map((label) => <span key={label} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{label}</span>)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="hidden min-h-0 min-w-0 flex-1 overflow-y-auto lg:block">
          {selectedIssue ? (
            <article className="mx-auto max-w-3xl p-7">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <IssueStateIcon state={selectedIssue.state} />
                  <div className="min-w-0">
                    <h2 className="text-xl font-semibold leading-7">{selectedIssue.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">#{selectedIssue.number} opened by {selectedIssue.authorLogin ? `@${selectedIssue.authorLogin}` : "unknown"} · {formatRelativeTimeLabel(selectedIssue.createdAt)}</p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => void bridge.openExternal?.(selectedIssue.url)}>
                  <ExternalLinkIcon className="size-3.5" /> GitHub
                </Button>
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                {selectedIssue.labels.map((label) => <span key={label} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">{label}</span>)}
              </div>
              <div className="mt-7 rounded-lg border border-border bg-card p-4">
                <div className="mb-3 text-xs font-medium text-muted-foreground">{selectedIssue.authorLogin ? `@${selectedIssue.authorLogin}` : "Issue description"} · {formatRelativeTimeLabel(selectedIssue.createdAt)}</div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">{selectedIssue.body?.trim() || "No description provided."}</p>
              </div>
              <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <span>{selectedIssue.commentsCount} comments</span>
                {selectedIssue.assigneeLogin ? <span>Assigned to @{selectedIssue.assigneeLogin}</span> : <span>Unassigned</span>}
                <span>Updated {formatRelativeTimeLabel(selectedIssue.updatedAt)}</span>
              </div>
            </article>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">Select an issue to see its details.</div>
          )}
        </aside>
      </div>
    </main>
  );
}
