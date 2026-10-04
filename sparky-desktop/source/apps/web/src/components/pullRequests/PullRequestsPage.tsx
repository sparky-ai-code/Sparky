import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@sparky/client-runtime/state/runtime";
import {
  CheckCircle2Icon,
  BookOpenIcon,
  Code2Icon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  LockIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { gitEnvironment } from "../../state/git";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { GitHubIcon } from "../Icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  parsePullRequestReviewOutput,
  validatePullRequestReviewFindings,
} from "@sparky/shared/pullRequestReview";
import {
  buildPullRequestReviewPrompt,
  buildPullRequestReviewSystemPrompt,
  findPullRequestReviewWorkspace,
  splitPullRequestDiffForReview,
} from "./pullRequestReview.ts";
import {
  getPullRequestReviewProgressSnapshot,
  startPullRequestReviewProgress,
  subscribeToPullRequestReviewProgress,
} from "./pullRequestReviewProgress.ts";
import {
  isGitHubAuthError,
  isTransientGitHubStatus,
  shouldApplyGitHubListResult,
} from "./githubResilience.ts";

type PullRequestScope = "all" | "authored";
type PullRequestView = "summary" | "code";
type PullRequestActionBusy = "merge" | "squash" | "close" | "review" | null;
type GitHubBusyState = "checking" | "installing" | "auth" | "disconnect" | null;

type GitHubCliStatus = {
  installed: boolean;
  version: string | null;
  auth: "authenticated" | "unauthenticated" | "unknown";
  account: string | null;
  detail: string | null;
};

type GitHubRepository = {
  nameWithOwner: string;
  url: string;
  isPrivate: boolean | null;
  isLocal: boolean;
  updatedAt: string | null;
};

type GitHubPullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  createdAt: string;
  authorLogin: string | null;
  reviewDecision: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string | null;
  commentsCount: number;
  reviewsCount: number;
  checksCount: number | null;
  failedChecksCount: number | null;
  reviewers: string[];
  labels: string[];
};

type GitHubRepositoryListResult = {
  repositories: GitHubRepository[];
  error: string | null;
};

type GitHubPullRequestListResult = {
  repository: string;
  pullRequests: GitHubPullRequest[];
  error: string | null;
};

type GitHubPullRequestDetailResult = {
  pullRequest: GitHubPullRequest | null;
  error: string | null;
};

type GitHubPullRequestDiffResult = {
  diff: string | null;
  headSha: string | null;
  error: string | null;
};

type GitHubPullRequestComment = {
  id: string;
  kind: "conversation" | "review" | "inline";
  authorLogin: string | null;
  body: string;
  createdAt: string | null;
  url: string | null;
  path: string | null;
  line: number | null;
};

type GitHubPullRequestReviewFinding = {
  path: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
};

type GitHubDesktopBridge = {
  getGitHubCliStatus: () => Promise<GitHubCliStatus>;
  installGitHubCli: () => Promise<GitHubCliStatus>;
  startGitHubCliAuth: () => Promise<GitHubCliStatus>;
  disconnectGitHub: () => Promise<GitHubCliStatus>;
  listGitHubRepositories: (input: { cwds: string[] }) => Promise<GitHubRepositoryListResult>;
  listGitHubPullRequests: (input: {
    repository: string;
    scope: PullRequestScope;
  }) => Promise<GitHubPullRequestListResult>;
  getGitHubPullRequest: (input: {
    repository: string;
    number: number;
  }) => Promise<GitHubPullRequestDetailResult>;
  getGitHubPullRequestComments?: (input: {
    repository: string;
    number: number;
  }) => Promise<{ comments: GitHubPullRequestComment[]; error: string | null }>;
  getGitHubPullRequestDiff: (input: {
    repository: string;
    number: number;
  }) => Promise<GitHubPullRequestDiffResult>;
  updateGitHubPullRequest: (input: {
    repository: string;
    number: number;
    action: "merge" | "squash" | "close";
  }) => Promise<{ error: string | null }>;
  postGitHubPullRequestReview?: (input: {
    repository: string;
    number: number;
    expectedHeadSha: string;
    summary: string;
    findings: GitHubPullRequestReviewFinding[];
  }) => Promise<{ submittedComments: number; skippedComments: number; error: string | null }>;
  openExternal: (url: string) => Promise<unknown>;
};

type PullRequestDiffCacheEntry = {
  diff: string | null;
  updatedAt: string;
};

const PULL_REQUEST_REFRESH_INTERVAL_MS = 30_000;
const PULL_REQUEST_REFRESH_MAX_INTERVAL_MS = 5 * 60_000;
const GITHUB_AUTH_STATUS_POLL_INTERVAL_MS = 1_000;
const GITHUB_AUTH_STATUS_POLL_TIMEOUT_MS = 5 * 60_000;
const MAX_DETAIL_CACHE_ENTRIES = 80;
const MAX_DIFF_CACHE_ENTRIES = 20;

const pageCache: {
  status: GitHubCliStatus | null;
  repositories: GitHubRepository[];
  selectedRepository: string | null;
  scope: PullRequestScope;
  view: PullRequestView;
  query: string;
} = {
  status: null,
  repositories: [],
  selectedRepository: null,
  scope: "all",
  view: "summary",
  query: "",
};

const pullRequestListCache = new Map<string, GitHubPullRequest[]>();
const selectedNumberCache = new Map<string, number | null>();
const pullRequestDetailCache = new Map<string, GitHubPullRequest>();
const pullRequestDiffCache = new Map<string, PullRequestDiffCacheEntry>();

function listCacheKey(repository: string, scope: PullRequestScope): string {
  return `${repository}:${scope}`;
}

function pullRequestCacheKey(repository: string, number: number): string {
  return `${repository}#${number}`;
}

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function clearGitHubPageData(): void {
  pageCache.repositories = [];
  pageCache.selectedRepository = null;
  pullRequestListCache.clear();
  selectedNumberCache.clear();
  pullRequestDetailCache.clear();
  pullRequestDiffCache.clear();
}

function getGitHubBridge(): GitHubDesktopBridge | null {
  const bridge = window.desktopBridge as
    | (typeof window.desktopBridge & Partial<GitHubDesktopBridge>)
    | undefined;
  if (
    !bridge ||
    typeof bridge.getGitHubCliStatus !== "function" ||
    typeof bridge.installGitHubCli !== "function" ||
    typeof bridge.startGitHubCliAuth !== "function" ||
    typeof bridge.disconnectGitHub !== "function" ||
    typeof bridge.listGitHubRepositories !== "function" ||
    typeof bridge.listGitHubPullRequests !== "function" ||
    typeof bridge.getGitHubPullRequest !== "function" ||
    typeof bridge.getGitHubPullRequestDiff !== "function" ||
    typeof bridge.updateGitHubPullRequest !== "function"
  ) {
    return null;
  }
  return bridge as GitHubDesktopBridge;
}

function statusLabel(pr: GitHubPullRequest): string {
  if (pr.isDraft) return "Draft";
  if (pr.state.toUpperCase() === "MERGED") return "Merged";
  if (pr.state.toUpperCase() === "CLOSED") return "Closed";
  if (pr.reviewDecision === "APPROVED") return "Approved";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  return "Open";
}

function statusDotClassName(pr: GitHubPullRequest): string {
  if (pr.isDraft) return "bg-muted-foreground/70";
  if (pr.state.toUpperCase() === "MERGED") return "bg-violet-500";
  if (pr.state.toUpperCase() === "CLOSED") return "bg-destructive";
  if (pr.reviewDecision === "APPROVED") return "bg-emerald-500";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "bg-destructive";
  return "bg-amber-400";
}

function reviewLabel(pr: GitHubPullRequest): string {
  if (pr.reviewDecision === "APPROVED") return "Approved";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "Review required";
  return pr.reviewers.length > 0 ? pr.reviewers.join(", ") : "No review requested";
}

function checksLabel(pr: GitHubPullRequest): string {
  if (pr.checksCount === null || pr.failedChecksCount === null) return "Unavailable";
  if (pr.checksCount === 0) return "No checks";
  if (pr.failedChecksCount > 0) return `${pr.failedChecksCount} failing of ${pr.checksCount}`;
  return `${pr.checksCount} check${pr.checksCount === 1 ? "" : "s"}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

function GitHubConnectionCard({
  status,
  busy,
  onSignIn,
}: {
  status: GitHubCliStatus;
  busy: GitHubBusyState;
  onSignIn: () => void;
}) {
  const isBusy = busy !== null;
  const canRetry = status.auth === "unknown" && isTransientGitHubStatus(status.detail);
  const buttonLabel = canRetry ? "Retry GitHub" : "Connect GitHub";

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center bg-background text-foreground">
      <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
        <GitHubIcon className="size-16 text-foreground" aria-hidden="true" />
        <Button
          variant="outline"
          className="h-10 min-w-[190px] rounded-lg border border-border bg-background px-6 text-sm font-medium text-foreground shadow-none hover:bg-muted"
          onClick={onSignIn}
          disabled={isBusy || (status.auth === "unknown" && !canRetry)}
          aria-label={canRetry ? "Retry GitHub connection" : "Connect GitHub"}
        >
          {busy === "auth" ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
          {busy === "auth" ? "Opening GitHub…" : buttonLabel}
        </Button>
        {status.detail ? (
          <p className="text-xs leading-5 text-muted-foreground">{status.detail}</p>
        ) : null}
      </div>
    </main>
  );
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1.25rem_7rem_minmax(0,1fr)] items-start gap-2 py-2 text-sm">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-foreground/90">{children}</div>
    </div>
  );
}

function PullRequestDescription({ body }: { body: string | null }) {
  if (!body?.trim())
    return <p className="text-sm text-muted-foreground">No description provided.</p>;
  return (
    <div className="space-y-2 text-sm leading-6 text-foreground/90">
      {body.split(/\r?\n/).map((line, index) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return <div key={index} className="h-2" />;
        if (trimmed.startsWith("### "))
          return (
            <h4 key={index} className="pt-2 text-base font-semibold">
              {trimmed.slice(4)}
            </h4>
          );
        if (trimmed.startsWith("## "))
          return (
            <h3 key={index} className="pt-3 text-lg font-semibold">
              {trimmed.slice(3)}
            </h3>
          );
        if (trimmed.startsWith("# "))
          return (
            <h2 key={index} className="pt-3 text-xl font-semibold">
              {trimmed.slice(2)}
            </h2>
          );
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div key={index} className="flex gap-2 pl-1">
              <span className="text-muted-foreground">•</span>
              <span>{trimmed.slice(2)}</span>
            </div>
          );
        }
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <div className="min-w-max font-mono text-[12px] leading-5">
      {lines.map((line, index) => {
        const added = line.startsWith("+") && !line.startsWith("+++");
        const removed = line.startsWith("-") && !line.startsWith("---");
        const hunk = line.startsWith("@@");
        const fileHeader = line.startsWith("diff --git ");
        return (
          <div
            key={index}
            className={cn(
              "min-h-5 whitespace-pre px-4",
              fileHeader &&
                "mt-3 border-y border-border bg-muted/70 py-1 font-semibold text-foreground",
              hunk && "bg-accent/50 text-accent-foreground",
              added && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              removed && "bg-destructive/10 text-destructive",
              !fileHeader && !hunk && !added && !removed && "text-foreground/80",
            )}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export function PullRequestsPage() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const reviewModelSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection:
        settings.pullRequestReviewModelSelection ?? settings.textGenerationModelSelection,
    },
    serverProviders,
  );
  const reviewPullRequestCommand = useAtomCommand(gitEnvironment.reviewPullRequest, {
    reportFailure: false,
    reportDefect: false,
  });
  const pullRequestReviewSnapshot = useSyncExternalStore(
    subscribeToPullRequestReviewProgress,
    getPullRequestReviewProgressSnapshot,
    getPullRequestReviewProgressSnapshot,
  );
  const projectCwds = useMemo(
    () => [...new Set(projects.map((project) => project.workspaceRoot).filter(Boolean))],
    [projects],
  );

  const initialListKey = pageCache.selectedRepository
    ? listCacheKey(pageCache.selectedRepository, pageCache.scope)
    : null;
  const initialPullRequests = initialListKey
    ? (pullRequestListCache.get(initialListKey) ?? [])
    : [];
  const cachedSelectedNumber = initialListKey ? selectedNumberCache.get(initialListKey) : undefined;
  const initialSelectedNumber =
    cachedSelectedNumber !== undefined &&
    cachedSelectedNumber !== null &&
    initialPullRequests.some((pr) => pr.number === cachedSelectedNumber)
      ? cachedSelectedNumber
      : (initialPullRequests[0]?.number ?? null);
  const initialPullRequestKey =
    pageCache.selectedRepository && initialSelectedNumber !== null
      ? pullRequestCacheKey(pageCache.selectedRepository, initialSelectedNumber)
      : null;
  const initialSummary =
    initialSelectedNumber === null
      ? null
      : (initialPullRequests.find((pr) => pr.number === initialSelectedNumber) ?? null);
  const initialDetail = initialPullRequestKey
    ? (pullRequestDetailCache.get(initialPullRequestKey) ?? initialSummary)
    : null;
  const initialDiffEntry = initialPullRequestKey
    ? pullRequestDiffCache.get(initialPullRequestKey)
    : undefined;
  const initialDiffIsFresh =
    initialDiffEntry !== undefined &&
    initialDetail !== null &&
    initialDiffEntry.updatedAt === initialDetail.updatedAt;

  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const commentsRequestRef = useRef(0);
  const [scope, setScope] = useState<PullRequestScope>(pageCache.scope);
  const [view, setView] = useState<PullRequestView>(pageCache.view);
  const [query, setQuery] = useState(pageCache.query);
  const [status, setStatus] = useState<GitHubCliStatus | null>(pageCache.status);
  const [repositories, setRepositories] = useState<GitHubRepository[]>(pageCache.repositories);
  const [selectedRepository, setSelectedRepository] = useState<string | null>(
    pageCache.selectedRepository,
  );
  const [pullRequests, setPullRequests] = useState<GitHubPullRequest[]>(initialPullRequests);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(initialSelectedNumber);
  const selectedPullRequestKeyRef = useRef<string | null>(
    selectedRepository && initialSelectedNumber !== null
      ? pullRequestCacheKey(selectedRepository, initialSelectedNumber)
      : null,
  );
  const [selectedPullRequest, setSelectedPullRequest] = useState<GitHubPullRequest | null>(
    initialDetail,
  );
  const [diff, setDiff] = useState<string | null>(
    initialDiffIsFresh ? (initialDiffEntry?.diff ?? null) : null,
  );
  const [statusBusy, setStatusBusy] = useState<GitHubBusyState>(
    pageCache.status === null ? "checking" : null,
  );
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [loadingPullRequests, setLoadingPullRequests] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<GitHubPullRequestComment[]>([]);
  const [commentsBusy, setCommentsBusy] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [pullRequestActionBusy, setPullRequestActionBusy] = useState<PullRequestActionBusy>(null);
  const [pullRequestActionError, setPullRequestActionError] = useState<string | null>(null);
  const reviewProject = useMemo(
    () => findPullRequestReviewWorkspace(projects, primaryEnvironmentId),
    [primaryEnvironmentId, projects],
  );
  const canPostPullRequestReview =
    typeof getGitHubBridge()?.postGitHubPullRequestReview === "function";

  useEffect(() => {
    pageCache.scope = scope;
  }, [scope]);
  useEffect(() => {
    pageCache.view = view;
  }, [view]);
  useEffect(() => {
    pageCache.query = query;
  }, [query]);
  useEffect(() => {
    pageCache.selectedRepository = selectedRepository;
  }, [selectedRepository]);
  useEffect(() => {
    selectedPullRequestKeyRef.current =
      selectedRepository && selectedNumber !== null
        ? pullRequestCacheKey(selectedRepository, selectedNumber)
        : null;
  }, [selectedNumber, selectedRepository]);
  useEffect(() => {
    commentsRequestRef.current += 1;
    setCommentsOpen(false);
    setComments([]);
    setCommentsBusy(false);
    setCommentsError(null);
  }, [selectedNumber, selectedRepository]);

  const markAuthRequired = useCallback((detail: string | null) => {
    const next: GitHubCliStatus = {
      installed: true,
      version: pageCache.status?.version ?? null,
      auth: "unauthenticated",
      account: null,
      detail: detail ?? "Your GitHub session is missing or expired.",
    };
    pageCache.status = next;
    setStatus(next);
  }, []);

  const handlePullRequestComments = useCallback(async () => {
    if (commentsOpen) {
      setCommentsOpen(false);
      return;
    }
    const pullRequest =
      selectedPullRequest ?? pullRequests.find((pr) => pr.number === selectedNumber) ?? null;
    const bridge = getGitHubBridge();
    if (!selectedRepository || !pullRequest || !bridge?.getGitHubPullRequestComments) return;

    const requestId = ++commentsRequestRef.current;
    setCommentsOpen(true);
    setCommentsBusy(true);
    setCommentsError(null);
    try {
      const result = await bridge.getGitHubPullRequestComments({
        repository: selectedRepository,
        number: pullRequest.number,
      });
      if (commentsRequestRef.current !== requestId) return;
      if (result.error) {
        if (isGitHubAuthError(result.error)) markAuthRequired(result.error);
        setCommentsError(result.error);
        setComments([]);
      } else {
        setComments(result.comments);
      }
    } catch (error) {
      if (commentsRequestRef.current !== requestId) return;
      const detail = error instanceof Error ? error.message : String(error);
      if (isGitHubAuthError(detail)) markAuthRequired(detail);
      setCommentsError(detail);
      setComments([]);
    } finally {
      if (commentsRequestRef.current === requestId) setCommentsBusy(false);
    }
  }, [
    commentsOpen,
    markAuthRequired,
    pullRequests,
    selectedNumber,
    selectedPullRequest,
    selectedRepository,
  ]);

  const refreshStatus = useCallback(
    async (showBusy = pageCache.status === null) => {
      const bridge = getGitHubBridge();
      if (!bridge) {
        setStatusBusy(null);
        pageCache.status = null;
        setStatus(null);
        return null;
      }
      if (showBusy) setStatusBusy("checking");
      try {
        let next = await bridge.getGitHubCliStatus();
        if (!next.installed) {
          setStatusBusy("installing");
          next = await bridge.installGitHubCli();
        }
        if (
          next.auth === "unknown" &&
          pageCache.status?.auth === "authenticated" &&
          isTransientGitHubStatus(next.detail)
        ) {
          return pageCache.status;
        }
        pageCache.status = next;
        setStatus(next);
        return next;
      } catch (cause) {
        const detail = errorMessage(cause, "Could not check the GitHub connection.");
        if (isGitHubAuthError(detail)) {
          markAuthRequired(detail);
        } else if (pageCache.status === null) {
          const fallback: GitHubCliStatus = {
            installed: true,
            version: null,
            auth: "unknown",
            account: null,
            detail,
          };
          pageCache.status = fallback;
          setStatus(fallback);
        }
        return null;
      } finally {
        setStatusBusy(null);
      }
    },
    [markAuthRequired],
  );

  const loadRepositories = useCallback(async () => {
    const bridge = getGitHubBridge();
    if (!bridge) return;
    const hadCache = pageCache.repositories.length > 0;
    setLoadingRepositories(!hadCache);
    if (!hadCache) setRepositoryError(null);
    try {
      const result = await bridge.listGitHubRepositories({ cwds: projectCwds });
      const nextError = result.error;
      if (isGitHubAuthError(nextError)) {
        markAuthRequired(nextError);
        return;
      }
      if (!shouldApplyGitHubListResult(result.error)) {
        setRepositoryError(null);
        return;
      }
      pageCache.repositories = result.repositories;
      setRepositories(result.repositories);
      setRepositoryError(nextError);
      setSelectedRepository((current) => {
        const next =
          current && result.repositories.some((repo) => repo.nameWithOwner === current)
            ? current
            : (result.repositories.find((repo) => repo.isLocal)?.nameWithOwner ??
              result.repositories[0]?.nameWithOwner ??
              null);
        pageCache.selectedRepository = next;
        return next;
      });
    } catch (cause) {
      const detail = errorMessage(cause, "Could not load repositories from GitHub.");
      if (isGitHubAuthError(detail)) {
        markAuthRequired(detail);
        return;
      }
      // A failed refresh is not an empty repository list. Keep the last known
      // state and stay quiet so a temporary outage cannot disrupt the page.
      setRepositoryError(null);
    } finally {
      setLoadingRepositories(false);
    }
  }, [markAuthRequired, projectCwds]);

  const loadPullRequests = useCallback(
    async (showBusy = false): Promise<"success" | "failed"> => {
      const bridge = getGitHubBridge();
      if (!bridge || !selectedRepository) return "failed";
      const repository = selectedRepository;
      const currentScope = scope;
      const key = listCacheKey(repository, currentScope);
      const cached = pullRequestListCache.get(key);
      const requestId = ++listRequestRef.current;
      setLoadingPullRequests(showBusy || cached === undefined);
      if (cached === undefined) setListError(null);
      try {
        const result = await bridge.listGitHubPullRequests({ repository, scope: currentScope });
        if (requestId !== listRequestRef.current) return "failed";
        const nextError = result.error;
        if (isGitHubAuthError(nextError)) {
          markAuthRequired(nextError);
          return "failed";
        }
        if (!shouldApplyGitHubListResult(result.error)) {
          setListError(null);
          return "failed";
        }
        pullRequestListCache.set(key, result.pullRequests);
        setPullRequests(result.pullRequests);
        setListError(nextError);
        setSelectedNumber((current) => {
          const cachedSelection = selectedNumberCache.get(key);
          const next =
            current !== null && result.pullRequests.some((pr) => pr.number === current)
              ? current
              : cachedSelection !== undefined &&
                  cachedSelection !== null &&
                  result.pullRequests.some((pr) => pr.number === cachedSelection)
                ? cachedSelection
                : (result.pullRequests[0]?.number ?? null);
          selectedNumberCache.set(key, next);
          return next;
        });
        return "success";
      } catch (cause) {
        if (requestId !== listRequestRef.current) return "failed";
        const detail = errorMessage(cause, "Could not load pull requests.");
        if (isGitHubAuthError(detail)) {
          markAuthRequired(detail);
          return "failed";
        }
        // Refresh failures are intentionally silent and non-destructive. The
        // current list remains visible, including when there was no cache yet.
        setListError(null);
        return "failed";
      } finally {
        if (requestId === listRequestRef.current) setLoadingPullRequests(false);
      }
    },
    [markAuthRequired, scope, selectedRepository],
  );

  useEffect(() => {
    void refreshStatus(pageCache.status === null);
  }, [refreshStatus]);
  useEffect(() => {
    if (status?.auth === "authenticated") void loadRepositories();
  }, [loadRepositories, status?.auth]);

  useEffect(() => {
    listRequestRef.current += 1;
    detailRequestRef.current += 1;
    diffRequestRef.current += 1;
    setListError(null);
    setDetailError(null);
    setDiffError(null);

    if (!selectedRepository) {
      setPullRequests([]);
      setSelectedNumber(null);
      setSelectedPullRequest(null);
      setDiff(null);
      return;
    }

    const key = listCacheKey(selectedRepository, scope);
    const cached = pullRequestListCache.get(key);
    if (cached !== undefined) {
      setPullRequests(cached);
      const previousSelection = selectedNumberCache.get(key);
      const nextSelection =
        previousSelection !== undefined &&
        previousSelection !== null &&
        cached.some((pr) => pr.number === previousSelection)
          ? previousSelection
          : (cached[0]?.number ?? null);
      selectedNumberCache.set(key, nextSelection);
      setSelectedNumber(nextSelection);
    } else {
      setPullRequests([]);
      setSelectedNumber(null);
      setSelectedPullRequest(null);
      setDiff(null);
    }

    if (status?.auth === "authenticated") void loadPullRequests(false);
  }, [loadPullRequests, scope, selectedRepository, status?.auth]);

  useEffect(() => {
    const bridge = getGitHubBridge();
    diffRequestRef.current += 1;
    setDiffError(null);
    if (!bridge || !selectedRepository || selectedNumber === null) {
      setSelectedPullRequest(null);
      setDiff(null);
      setLoadingDetail(false);
      return;
    }

    const listKey = listCacheKey(selectedRepository, scope);
    selectedNumberCache.set(listKey, selectedNumber);
    const key = pullRequestCacheKey(selectedRepository, selectedNumber);
    const summary = pullRequests.find((pr) => pr.number === selectedNumber) ?? null;
    const cachedDetail = pullRequestDetailCache.get(key);
    const current = cachedDetail ?? summary;
    setSelectedPullRequest(current);
    setDetailError(null);

    const cachedDiff = pullRequestDiffCache.get(key);
    const latestUpdatedAt = current?.updatedAt ?? summary?.updatedAt;
    if (
      cachedDiff !== undefined &&
      latestUpdatedAt !== undefined &&
      cachedDiff.updatedAt === latestUpdatedAt
    ) {
      setDiff(cachedDiff.diff);
    } else {
      setDiff(null);
    }

    // Check-run status can change without the pull request's updated_at changing.
    const requestId = ++detailRequestRef.current;
    setLoadingDetail(current === null);
    void bridge
      .getGitHubPullRequest({ repository: selectedRepository, number: selectedNumber })
      .then((result) => {
        if (requestId !== detailRequestRef.current) return;
        const nextError = result.pullRequest === null ? result.error : null;
        if (isGitHubAuthError(nextError)) {
          markAuthRequired(nextError);
          return;
        }
        if (result.pullRequest) {
          setBoundedCache(
            pullRequestDetailCache,
            key,
            result.pullRequest,
            MAX_DETAIL_CACHE_ENTRIES,
          );
          setSelectedPullRequest(result.pullRequest);
        }
        setDetailError(nextError);
      })
      .catch((cause) => {
        const detail = errorMessage(cause, "Could not load pull request details.");
        if (isGitHubAuthError(detail)) {
          markAuthRequired(detail);
          return;
        }
        if (requestId === detailRequestRef.current && current === null) setDetailError(detail);
      })
      .finally(() => {
        if (requestId === detailRequestRef.current) setLoadingDetail(false);
      });
  }, [markAuthRequired, pullRequests, scope, selectedNumber, selectedRepository]);

  useEffect(() => {
    const bridge = getGitHubBridge();
    if (view !== "code" || !bridge || !selectedRepository || selectedNumber === null) return;

    const key = pullRequestCacheKey(selectedRepository, selectedNumber);
    const current =
      selectedPullRequest ?? pullRequests.find((pr) => pr.number === selectedNumber) ?? null;
    const updatedAt = current?.updatedAt;
    const cached = pullRequestDiffCache.get(key);
    if (cached !== undefined && updatedAt !== undefined && cached.updatedAt === updatedAt) {
      setDiff(cached.diff);
      setLoadingDiff(false);
      setDiffError(null);
      return;
    }

    const requestId = ++diffRequestRef.current;
    setLoadingDiff(diff === null);
    setDiffError(null);
    void bridge
      .getGitHubPullRequestDiff({ repository: selectedRepository, number: selectedNumber })
      .then((result) => {
        if (requestId !== diffRequestRef.current) return;
        if (isGitHubAuthError(result.error)) {
          markAuthRequired(result.error);
          return;
        }
        if (result.error === null && updatedAt !== undefined) {
          setBoundedCache(
            pullRequestDiffCache,
            key,
            { diff: result.diff, updatedAt },
            MAX_DIFF_CACHE_ENTRIES,
          );
        }
        if (result.error === null) {
          setDiff(result.diff);
          setDiffError(null);
        }
      })
      .catch((cause) => {
        const detail = errorMessage(cause, "Could not load pull request code changes.");
        if (isGitHubAuthError(detail)) {
          markAuthRequired(detail);
          return;
        }
        if (requestId === diffRequestRef.current && diff === null) setDiffError(detail);
      })
      .finally(() => {
        if (requestId === diffRequestRef.current) setLoadingDiff(false);
      });
  }, [
    diff,
    markAuthRequired,
    pullRequests,
    selectedNumber,
    selectedPullRequest,
    selectedRepository,
    view,
  ]);

  useEffect(() => {
    if (status?.auth !== "authenticated" || !selectedRepository) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const schedule = (delay: number) => {
      timer = window.setTimeout(async () => {
        const result = await loadPullRequests(false);
        if (cancelled) return;
        if (result === "success") failures = 0;
        else failures += 1;
        const nextDelay =
          result === "success"
            ? PULL_REQUEST_REFRESH_INTERVAL_MS
            : Math.min(
                PULL_REQUEST_REFRESH_INTERVAL_MS * 2 ** failures,
                PULL_REQUEST_REFRESH_MAX_INTERVAL_MS,
              );
        schedule(nextDelay);
      }, delay);
    };
    schedule(PULL_REQUEST_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadPullRequests, selectedRepository, status?.auth]);

  const handleSignIn = useCallback(async () => {
    const bridge = getGitHubBridge();
    if (!bridge) return;
    setStatusBusy("auth");
    try {
      const started = await bridge.startGitHubCliAuth();
      pageCache.status = started;
      setStatus(started);

      const deadline = Date.now() + GITHUB_AUTH_STATUS_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (started.auth === "authenticated") break;
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, GITHUB_AUTH_STATUS_POLL_INTERVAL_MS),
        );
        const latest = await bridge.getGitHubCliStatus();
        pageCache.status = latest;
        setStatus(latest);
        if (latest.auth === "authenticated" || !latest.installed) break;
      }
    } catch (cause) {
      const next: GitHubCliStatus = {
        installed: true,
        version: null,
        auth: "unauthenticated",
        account: null,
        detail: errorMessage(cause, "GitHub sign-in did not complete."),
      };
      pageCache.status = next;
      setStatus(next);
    } finally {
      setStatusBusy(null);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    const bridge = getGitHubBridge();
    if (!bridge) return;
    setStatusBusy("disconnect");
    try {
      const next = await bridge.disconnectGitHub();
      clearGitHubPageData();
      pageCache.status = next;
      setStatus(next);
      setRepositories([]);
      setSelectedRepository(null);
      setPullRequests([]);
      setSelectedNumber(null);
      setSelectedPullRequest(null);
      setDiff(null);
      setRepositoryError(null);
      setListError(null);
      setDetailError(null);
      setDiffError(null);
    } catch (cause) {
      setRepositoryError(errorMessage(cause, "Could not disconnect GitHub."));
    } finally {
      setStatusBusy(null);
    }
  }, []);

  const handlePullRequestAction = useCallback(
    async (action: "merge" | "squash" | "close") => {
      const bridge = getGitHubBridge();
      const currentPullRequest =
        selectedPullRequest ?? pullRequests.find((pr) => pr.number === selectedNumber) ?? null;
      if (
        !bridge ||
        !selectedRepository ||
        !currentPullRequest ||
        pullRequestActionBusy !== null ||
        pullRequestReviewSnapshot.activeKey !== null
      )
        return;
      setPullRequestActionBusy(action);
      setPullRequestActionError(null);
      try {
        const result = await bridge.updateGitHubPullRequest({
          repository: selectedRepository,
          number: currentPullRequest.number,
          action,
        });
        if (result.error) throw new Error(result.error);
        const nextState = action === "close" ? "CLOSED" : "MERGED";
        const updated = { ...currentPullRequest, state: nextState };
        setSelectedPullRequest(updated);
        setBoundedCache(
          pullRequestDetailCache,
          pullRequestCacheKey(selectedRepository, updated.number),
          updated,
          MAX_DETAIL_CACHE_ENTRIES,
        );
        const key = listCacheKey(selectedRepository, scope);
        const nextList = pullRequests.map((pr) => (pr.number === updated.number ? updated : pr));
        pullRequestListCache.set(key, nextList);
        setPullRequests(nextList);
        void loadPullRequests(true);
      } catch (cause) {
        setPullRequestActionError(errorMessage(cause, `Could not ${action} pull request.`));
      } finally {
        setPullRequestActionBusy(null);
      }
    },
    [
      loadPullRequests,
      pullRequestActionBusy,
      pullRequestReviewSnapshot.activeKey,
      pullRequests,
      scope,
      selectedNumber,
      selectedPullRequest,
      selectedRepository,
    ],
  );

  const handlePullRequestReview = useCallback(() => {
    const bridge = getGitHubBridge();
    const postGitHubPullRequestReview = bridge?.postGitHubPullRequestReview?.bind(bridge);
    const currentPullRequest =
      selectedPullRequest ?? pullRequests.find((pr) => pr.number === selectedNumber) ?? null;
    if (
      !bridge ||
      !postGitHubPullRequestReview ||
      !selectedRepository ||
      !currentPullRequest ||
      !reviewProject ||
      pullRequestActionBusy !== null ||
      pullRequestReviewSnapshot.activeKey !== null
    ) {
      return;
    }

    const reviewKey = pullRequestCacheKey(selectedRepository, currentPullRequest.number);
    const reviewTask = startPullRequestReviewProgress(reviewKey, async (report) => {
      try {
        report("fetching", "Fetching the current pull-request diff from GitHub…");
        const diffResult = await bridge.getGitHubPullRequestDiff({
          repository: selectedRepository,
          number: currentPullRequest.number,
        });
        if (diffResult.error) throw new Error(diffResult.error);
        if (!diffResult.diff || !diffResult.headSha) {
          throw new Error("GitHub did not return a pull request diff and head commit.");
        }
        if (selectedPullRequestKeyRef.current === reviewKey) setDiff(diffResult.diff);
        if (currentPullRequest.updatedAt) {
          setBoundedCache(
            pullRequestDiffCache,
            reviewKey,
            {
              diff: diffResult.diff,
              updatedAt: currentPullRequest.updatedAt,
            },
            MAX_DIFF_CACHE_ENTRIES,
          );
        }

        const reviewChunks = splitPullRequestDiffForReview(diffResult.diff);
        if (reviewChunks.length === 0) {
          throw new Error(
            "GitHub returned no reviewable changed-file hunks for this pull request.",
          );
        }

        const findings: ReturnType<typeof parsePullRequestReviewOutput>["findings"][number][] = [];
        const findingKeys = new Set<string>();
        const summaries: string[] = [];
        let generatedFindingCount = 0;
        let skippedFindingCount = 0;
        for (const [index, diffChunk] of reviewChunks.entries()) {
          const prompt = buildPullRequestReviewPrompt({
            title: currentPullRequest.title,
            body: currentPullRequest.body,
            url: currentPullRequest.url,
            baseBranch: currentPullRequest.baseRefName,
            headBranch: currentPullRequest.headRefName,
            diff: diffChunk,
          });
          report(
            "reviewing",
            `Reviewing GitHub change segment ${index + 1} of ${reviewChunks.length}…`,
          );
          const generated = await reviewPullRequestCommand({
            environmentId: reviewProject.environmentId,
            input: {
              cwd: reviewProject.workspaceRoot,
              modelSelection: reviewModelSelection,
              systemPrompt: buildPullRequestReviewSystemPrompt({
                focus: settings.pullRequestReviewFocus,
                effort: settings.pullRequestReviewEffort,
              }),
              prompt,
            },
          });
          if (generated._tag === "Failure") {
            if (isAtomCommandInterrupted(generated)) throw new Error("The review was interrupted.");
            throw squashAtomCommandFailure(generated);
          }

          report("validating", `Validating findings from change segment ${index + 1}…`);
          const review = parsePullRequestReviewOutput(generated.value.response);
          generatedFindingCount += review.findings.length;
          summaries.push(review.summary);
          const chunkValidation = validatePullRequestReviewFindings(review.findings, diffChunk);
          skippedFindingCount += chunkValidation.skippedCount;
          for (const finding of chunkValidation.findings) {
            const key = `${finding.path}\0${finding.line}`;
            if (findingKeys.has(key)) {
              skippedFindingCount += 1;
              continue;
            }
            findingKeys.add(key);
            findings.push(finding);
          }
        }

        const validated = validatePullRequestReviewFindings(findings, diffResult.diff);
        if (generatedFindingCount === 0) {
          throw new Error(
            `The model returned no actionable findings across ${reviewChunks.length} GitHub change segment(s), so no review was posted. Try another model or broaden the review focus.`,
          );
        }
        if (findings.length === 0 || validated.findings.length === 0) {
          throw new Error(
            `The model returned ${generatedFindingCount} finding(s), but none matched an added line in the current diff. No review was posted.`,
          );
        }
        const summary =
          reviewChunks.length === 1
            ? (summaries[0] ?? "")
            : `Reviewed ${reviewChunks.length} GitHub change segments; ${validated.findings.length} actionable finding(s) are listed below.`;
        report(
          "posting",
          `Posting ${validated.findings.length} validated inline comment(s) to GitHub…`,
        );
        const posted = await postGitHubPullRequestReview({
          repository: selectedRepository,
          number: currentPullRequest.number,
          expectedHeadSha: diffResult.headSha,
          summary,
          findings: [...validated.findings],
        });
        if (posted.error) throw new Error(posted.error);

        const skippedCount = skippedFindingCount + validated.skippedCount + posted.skippedComments;
        const commentLabel =
          posted.submittedComments === 1
            ? "1 inline comment"
            : `${posted.submittedComments} inline comments`;
        const refreshedDetail = await bridge
          .getGitHubPullRequest({
            repository: selectedRepository,
            number: currentPullRequest.number,
          })
          .catch(() => null);
        if (refreshedDetail?.pullRequest) {
          setBoundedCache(
            pullRequestDetailCache,
            reviewKey,
            refreshedDetail.pullRequest,
            MAX_DETAIL_CACHE_ENTRIES,
          );
          if (selectedPullRequestKeyRef.current === reviewKey) {
            setSelectedPullRequest(refreshedDetail.pullRequest);
          }
        }
        report(
          "success",
          `Review posted with ${commentLabel}.${
            skippedCount > 0
              ? ` ${skippedCount} finding(s) were omitted because they were duplicates, exceeded GitHub's inline-comment limit, or did not match added lines.`
              : ""
          }`,
        );
        void loadPullRequests(true);
      } catch (cause) {
        const message = errorMessage(cause, "Could not review this pull request.");
        if (isGitHubAuthError(message)) markAuthRequired(message);
        throw new Error(message, { cause });
      }
    });
    if (!reviewTask) return;

    setPullRequestActionBusy("review");
    setPullRequestActionError(null);
    void reviewTask.finally(() => setPullRequestActionBusy(null));
  }, [
    loadPullRequests,
    markAuthRequired,
    pullRequestActionBusy,
    pullRequestReviewSnapshot.activeKey,
    pullRequests,
    reviewModelSelection,
    reviewProject,
    reviewPullRequestCommand,
    selectedNumber,
    selectedPullRequest,
    selectedRepository,
    settings.pullRequestReviewEffort,
    settings.pullRequestReviewFocus,
  ]);

  const visiblePullRequests = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return pullRequests;
    return pullRequests.filter((pr) =>
      [pr.title, String(pr.number), pr.authorLogin ?? "", pr.headRefName, pr.baseRefName]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [pullRequests, query]);

  const selectedSummary =
    selectedNumber === null
      ? null
      : (pullRequests.find((pr) => pr.number === selectedNumber) ?? null);
  const displayedPullRequest = selectedPullRequest ?? selectedSummary;
  const displayedCommentsCount = displayedPullRequest
    ? displayedPullRequest.commentsCount + displayedPullRequest.reviewsCount
    : 0;
  const selectedReviewKey =
    selectedRepository && displayedPullRequest
      ? pullRequestCacheKey(selectedRepository, displayedPullRequest.number)
      : null;
  const reviewProgressForSelectedPullRequest = selectedReviewKey
    ? (pullRequestReviewSnapshot.progressByKey.get(selectedReviewKey) ?? null)
    : null;
  const activePullRequestActionBusy =
    pullRequestActionBusy ?? (pullRequestReviewSnapshot.activeKey !== null ? "review" : null);

  if (!isElectron || getGitHubBridge() === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-background p-6 text-foreground">
        <section className="max-w-lg rounded-xl border border-border bg-card p-6 text-center shadow-sm">
          <GitPullRequestIcon className="mx-auto size-8 text-muted-foreground" />
          <h1 className="mt-3 text-lg font-semibold">
            Pull requests are available in Sparky Desktop
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Connect GitHub in the desktop app to browse and review pull requests.
          </p>
        </section>
      </main>
    );
  }

  if ((statusBusy === "checking" || statusBusy === "installing") && status === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-background p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          {statusBusy === "installing" ? "Preparing GitHub…" : "Checking GitHub…"}
        </div>
      </main>
    );
  }

  if (status && (!status.installed || status.auth !== "authenticated")) {
    return (
      <GitHubConnectionCard
        status={status}
        busy={statusBusy}
        onSignIn={() => void handleSignIn()}
      />
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background pt-[var(--workspace-topbar-height)] text-foreground">
      <div className="flex min-h-0 flex-1 overflow-hidden border-t border-border">
        <aside className="flex w-[390px] min-w-[330px] max-w-[45%] flex-col border-r border-border bg-card/30">
          <div className="shrink-0 border-b border-border px-4 pb-3 pt-3">
            <div className="flex items-center gap-1">
              {(["all", "authored"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                    scope === value
                      ? "bg-muted text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                  onClick={() => setScope(value)}
                >
                  {value === "all" ? "All" : "Authored"}
                </button>
              ))}
              <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
                {status?.account ? `@${status.account}` : "GitHub"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                disabled={statusBusy !== null}
                onClick={() => void handleDisconnect()}
              >
                {statusBusy === "disconnect" ? (
                  <LoaderCircleIcon className="size-3 animate-spin" />
                ) : null}
                Disconnect
              </Button>
            </div>
            <div className="mt-3">
              <Select
                value={selectedRepository}
                onValueChange={(value) => {
                  if (typeof value === "string") setSelectedRepository(value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full border-border bg-background/80 font-medium shadow-none"
                  disabled={repositories.length === 0 && loadingRepositories}
                >
                  <BookOpenIcon className="size-3.5 text-muted-foreground" />
                  <SelectValue
                    placeholder={
                      loadingRepositories ? "Loading repositories…" : "Select repository"
                    }
                  />
                </SelectTrigger>
                <SelectContent popupClassName="min-w-[320px]" matchTriggerWidth>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.nameWithOwner} value={repository.nameWithOwner}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{repository.nameWithOwner}</span>
                        {repository.isLocal ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            local
                          </span>
                        ) : null}
                        {repository.isPrivate ? <LockIcon className="size-3 opacity-60" /> : null}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {repositoryError ? (
                <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {repositoryError}
                </p>
              ) : null}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search pull requests"
                  className="h-9 rounded-lg bg-background pl-8 text-sm"
                />
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Refresh pull requests"
                disabled={!selectedRepository || loadingPullRequests}
                onClick={() => void loadPullRequests(true)}
              >
                <RefreshCwIcon className={cn("size-4", loadingPullRequests && "animate-spin")} />
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex h-9 shrink-0 items-center border-b border-border px-4 text-xs text-muted-foreground">
              <span>{visiblePullRequests.length} pull requests</span>
              {selectedRepository ? (
                <span className="ml-auto truncate pl-3">{selectedRepository}</span>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!selectedRepository ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                  Select a repository to view its pull requests.
                </div>
              ) : listError && pullRequests.length === 0 ? (
                <div className="m-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
                  {listError}
                </div>
              ) : loadingPullRequests && pullRequests.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="size-4 animate-spin" /> Loading pull requests…
                </div>
              ) : visiblePullRequests.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No pull requests match this view.
                </div>
              ) : (
                <div className="space-y-1">
                  {visiblePullRequests.map((pr) => {
                    const selected = selectedNumber === pr.number;
                    return (
                      <button
                        key={pr.number}
                        type="button"
                        className={cn(
                          "flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors",
                          selected
                            ? "bg-muted text-foreground"
                            : "hover:bg-muted/50 hover:text-foreground",
                        )}
                        onClick={() => setSelectedNumber(pr.number)}
                      >
                        <span
                          className={cn(
                            "mt-1.5 size-2 shrink-0 rounded-full",
                            statusDotClassName(pr),
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 text-sm font-medium leading-5">
                            {pr.title}
                          </div>
                          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <span>#{pr.number}</span>
                            <span>·</span>
                            <span className="truncate">{pr.authorLogin ?? "unknown"}</span>
                            <span>·</span>
                            <span className="shrink-0">
                              {formatRelativeTimeLabel(pr.updatedAt)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-[11px] text-muted-foreground/80">
                            {pr.headRefName} → {pr.baseRefName}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto bg-background">
          {!displayedPullRequest ? (
            <div className="flex h-full min-h-[320px] items-center justify-center px-8 text-center">
              <div>
                <GitPullRequestIcon className="mx-auto size-8 text-muted-foreground/60" />
                <h2 className="mt-3 text-base font-medium">
                  {selectedRepository ? "Select a pull request" : "Select a repository"}
                </h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Choose a pull request to inspect it inside Sparky.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="sticky top-0 z-10 flex h-12 items-center border-b border-border bg-background/95 px-5 backdrop-blur">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors",
                      view === "summary"
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                    onClick={() => setView("summary")}
                  >
                    <FileTextIcon className="size-4" /> Summary
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors",
                      view === "code"
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                    onClick={() => setView("code")}
                  >
                    <Code2Icon className="size-4" /> Code
                  </button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => void getGitHubBridge()?.openExternal(displayedPullRequest.url)}
                >
                  <ExternalLinkIcon className="size-3.5" /> Open in GitHub
                </Button>
              </div>

              {view === "code" ? (
                <div className="min-h-full overflow-x-auto bg-background pb-8">
                  <div className="sticky left-0 z-[1] flex h-11 min-w-full items-center border-b border-border bg-card/40 px-4 text-xs text-muted-foreground">
                    <Code2Icon className="mr-2 size-3.5" /> {displayedPullRequest.changedFiles}{" "}
                    changed file{displayedPullRequest.changedFiles === 1 ? "" : "s"}
                    <span className="ml-3 text-emerald-500">+{displayedPullRequest.additions}</span>
                    <span className="ml-2 text-destructive">-{displayedPullRequest.deletions}</span>
                  </div>
                  {loadingDiff && diff === null ? (
                    <div className="flex min-w-[500px] items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
                      <LoaderCircleIcon className="size-4 animate-spin" /> Loading code changes…
                    </div>
                  ) : diffError && diff === null ? (
                    <div className="m-5 min-w-[500px] rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                      {diffError}
                    </div>
                  ) : diff !== null ? (
                    <DiffViewer diff={diff} />
                  ) : (
                    <div className="p-8 text-sm text-muted-foreground">
                      No code changes were returned for this pull request.
                    </div>
                  )}
                </div>
              ) : (
                <article className="mx-auto w-full max-w-4xl px-8 py-7">
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-2 size-2.5 shrink-0 rounded-full",
                        statusDotClassName(displayedPullRequest),
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <h1 className="text-2xl font-semibold leading-tight tracking-tight">
                        {displayedPullRequest.title}
                      </h1>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {displayedPullRequest.authorLogin ?? "Unknown author"} · #
                        {displayedPullRequest.number} ·{" "}
                        {formatRelativeTimeLabel(displayedPullRequest.createdAt)}
                      </p>
                      {displayedPullRequest.state.toUpperCase() === "OPEN" ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              activePullRequestActionBusy !== null ||
                              reviewProject === null ||
                              !canPostPullRequestReview
                            }
                            title={
                              reviewProject === null
                                ? "Open a workspace in the primary environment to enable AI reviews."
                                : !canPostPullRequestReview
                                  ? "Update Sparky to enable AI pull request reviews."
                                  : undefined
                            }
                            onClick={() => void handlePullRequestReview()}
                          >
                            {pullRequestReviewSnapshot.activeKey === selectedReviewKey ? (
                              <LoaderCircleIcon className="size-3.5 animate-spin" />
                            ) : (
                              <GitPullRequestIcon className="size-3.5" />
                            )}
                            Review PR
                          </Button>
                          <Button
                            size="sm"
                            disabled={
                              activePullRequestActionBusy !== null || displayedPullRequest.isDraft
                            }
                            onClick={() => void handlePullRequestAction("merge")}
                          >
                            {pullRequestActionBusy === "merge" ? (
                              <LoaderCircleIcon className="size-3.5 animate-spin" />
                            ) : null}
                            Merge
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              activePullRequestActionBusy !== null || displayedPullRequest.isDraft
                            }
                            onClick={() => void handlePullRequestAction("squash")}
                          >
                            {pullRequestActionBusy === "squash" ? (
                              <LoaderCircleIcon className="size-3.5 animate-spin" />
                            ) : null}
                            Squash merge
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={activePullRequestActionBusy !== null}
                            onClick={() => void handlePullRequestAction("close")}
                          >
                            {pullRequestActionBusy === "close" ? (
                              <LoaderCircleIcon className="size-3.5 animate-spin" />
                            ) : null}
                            Close
                          </Button>
                        </div>
                      ) : null}
                      {reviewProgressForSelectedPullRequest ? (
                        <p
                          role={
                            reviewProgressForSelectedPullRequest.phase === "error"
                              ? "alert"
                              : "status"
                          }
                          aria-live={
                            reviewProgressForSelectedPullRequest.phase === "error"
                              ? "assertive"
                              : "polite"
                          }
                          className={cn(
                            "mt-2 flex items-center gap-2 text-xs",
                            reviewProgressForSelectedPullRequest.phase === "error"
                              ? "text-destructive"
                              : reviewProgressForSelectedPullRequest.phase === "success"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-muted-foreground",
                          )}
                        >
                          {reviewProgressForSelectedPullRequest.phase === "fetching" ||
                          reviewProgressForSelectedPullRequest.phase === "reviewing" ||
                          reviewProgressForSelectedPullRequest.phase === "validating" ||
                          reviewProgressForSelectedPullRequest.phase === "posting" ? (
                            <LoaderCircleIcon className="size-3.5 animate-spin" />
                          ) : null}
                          {reviewProgressForSelectedPullRequest.message}
                        </p>
                      ) : null}
                      {pullRequestActionError ? (
                        <p role="alert" className="mt-2 text-xs text-destructive">
                          {pullRequestActionError}
                        </p>
                      ) : null}
                    </div>
                    {loadingDetail ? (
                      <LoaderCircleIcon className="mt-1 size-4 animate-spin text-muted-foreground" />
                    ) : null}
                  </div>
                  <div className="mt-7 border-y border-border py-2">
                    <DetailRow icon={<GitBranchIcon className="size-4" />} label="Branch">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-xs">
                          {displayedPullRequest.headRefName}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-mono text-xs">
                          {displayedPullRequest.baseRefName}
                        </span>
                        <span className="ml-1 text-xs text-emerald-500">
                          +{displayedPullRequest.additions}
                        </span>
                        <span className="text-xs text-destructive">
                          -{displayedPullRequest.deletions}
                        </span>
                      </div>
                    </DetailRow>
                    <DetailRow icon={<UsersIcon className="size-4" />} label="Reviewers">
                      {reviewLabel(displayedPullRequest)}
                    </DetailRow>
                    <DetailRow icon={<MessageSquareIcon className="size-4" />} label="Comments">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          {displayedCommentsCount} comment
                          {displayedCommentsCount === 1 ? "" : "s"}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          aria-expanded={commentsOpen}
                          disabled={!getGitHubBridge()?.getGitHubPullRequestComments}
                          onClick={() => void handlePullRequestComments()}
                        >
                          {commentsBusy ? (
                            <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                          ) : null}
                          {commentsOpen ? "Hide comments" : "View comments"}
                        </Button>
                      </div>
                    </DetailRow>
                    <DetailRow icon={<CheckCircle2Icon className="size-4" />} label="Checks">
                      {checksLabel(displayedPullRequest)}
                    </DetailRow>
                    <DetailRow icon={<GitPullRequestIcon className="size-4" />} label="Status">
                      {statusLabel(displayedPullRequest)}
                      {displayedPullRequest.changedFiles > 0
                        ? ` · ${displayedPullRequest.changedFiles} changed file${displayedPullRequest.changedFiles === 1 ? "" : "s"}`
                        : ""}
                    </DetailRow>
                  </div>
                  {commentsOpen ? (
                    <section className="mt-5 rounded-lg border border-border bg-card/40 p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h2 className="text-sm font-semibold">Pull request comments</h2>
                        {commentsBusy ? (
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading…
                          </span>
                        ) : null}
                      </div>
                      {commentsError ? (
                        <p role="alert" aria-live="assertive" className="text-sm text-destructive">
                          {commentsError}
                        </p>
                      ) : commentsBusy && comments.length === 0 ? null : comments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No comments on this pull request yet.
                        </p>
                      ) : (
                        <ol className="space-y-3">
                          {comments.map((comment) => (
                            <li
                              key={comment.id}
                              className="rounded-md border border-border/70 bg-background/70 p-3"
                            >
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  {comment.authorLogin ?? "Unknown author"}
                                </span>
                                <span>·</span>
                                <span>
                                  {comment.kind === "inline"
                                    ? "Code comment"
                                    : comment.kind === "review"
                                      ? "Review"
                                      : "Conversation"}
                                </span>
                                {comment.createdAt ? (
                                  <>
                                    <span>·</span>
                                    <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                                  </>
                                ) : null}
                                {comment.path ? (
                                  <span className="font-mono">
                                    {comment.path}
                                    {comment.line ? `:${comment.line}` : ""}
                                  </span>
                                ) : null}
                                {comment.url ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto h-6 px-1.5 text-xs"
                                    onClick={() =>
                                      void getGitHubBridge()?.openExternal(comment.url!)
                                    }
                                  >
                                    <ExternalLinkIcon className="size-3" /> GitHub
                                  </Button>
                                ) : null}
                              </div>
                              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                                {comment.body}
                              </p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  ) : null}
                  {displayedPullRequest.labels.length > 0 ? (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {displayedPullRequest.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {detailError ? (
                    <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
                      {detailError}
                    </div>
                  ) : null}
                  <section className="mt-7">
                    <div className="flex items-center gap-2 border-b border-border pb-3">
                      <FileTextIcon className="size-4 text-muted-foreground" />
                      <h2 className="text-base font-semibold">Description</h2>
                    </div>
                    <div className="pt-5">
                      <PullRequestDescription body={displayedPullRequest.body} />
                    </div>
                  </section>
                </article>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
