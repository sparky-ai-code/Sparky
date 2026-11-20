import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  TEAM_THREAD_LABEL,
  Team,
  TeamsError,
  type TeamMessage,
  type TeamProject,
  type TeamThread,
  type TeamsAddProjectInput,
  type TeamsCreateTeamInput,
  type TeamsCreateThreadInput,
  type TeamsInviteMemberInput,
  type TeamsInviteMemberResult,
  type TeamsListMessagesInput,
  type TeamsListMessagesResult,
  type TeamsListTeamsInput,
  type TeamsListTeamsResult,
  type TeamsListThreadsInput,
  type TeamsListThreadsResult,
  type TeamsPostMessageInput,
  type TeamsToggleReactionInput,
  type TeamsToggleReactionResult,
} from "@sparky/contracts";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  aggregateReactions,
  deriveThreadTitle,
  encodeMessageBody,
  encodeReactionBody,
  findOwnReactionCommentId,
  parseMarker,
} from "./TeamsCodec.ts";
import * as TeamsStore from "./TeamsStore.ts";

// ---------------------------------------------------------------------------
// GitHub response shapes (only the fields Sparky reads)
// ---------------------------------------------------------------------------

const GitHubUser = Schema.Struct({ login: Schema.String });

const GitHubRepo = Schema.Struct({
  full_name: Schema.String,
  html_url: Schema.String,
  permissions: Schema.optionalKey(
    Schema.Struct({
      admin: Schema.optionalKey(Schema.Boolean),
      push: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const GitHubIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  html_url: Schema.String,
  comments: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
  user: Schema.NullOr(GitHubUser),
  pull_request: Schema.optionalKey(Schema.Unknown),
});
type GitHubIssue = typeof GitHubIssue.Type;

const GitHubComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  user: Schema.NullOr(GitHubUser),
});
type GitHubComment = typeof GitHubComment.Type;

const decodeRepo = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubRepo));
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssue));
const decodeComment = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubComment));

// ---------------------------------------------------------------------------
// Validation and error helpers
// ---------------------------------------------------------------------------

const REPO_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NUMERIC_ID_PATTERN = /^\d+$/;
const TEAM_LABEL_COLOR = "5319e7";
const MAX_ERROR_DETAIL_LENGTH = 500;
const GITHUB_TOKEN_PATTERN = /(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g;

interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

const readProperty = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** Pick a short, token-free description of a GitHub CLI failure. */
const describeFailure = (error: unknown): string => {
  const candidates = [
    readProperty(readProperty(error, "cause"), "detail"),
    readProperty(error, "detail"),
    readProperty(error, "message"),
  ];
  const text =
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    ) ?? "GitHub request failed.";
  return text.trim().replace(GITHUB_TOKEN_PATTERN, "[redacted]").slice(0, MAX_ERROR_DETAIL_LENGTH);
};

const newTeamId = (): string => NodeCrypto.randomUUID();

const toTeamsError = (operation: string, cause: unknown): TeamsError =>
  Schema.is(TeamsError)(cause)
    ? cause
    : new TeamsError({ operation, detail: describeFailure(cause), cause });

const decodeFailure = (operation: string) => (cause: unknown) =>
  new TeamsError({
    operation,
    detail: "GitHub returned an unexpected response.",
    cause,
  });

const repoRef = (operation: string, nameWithOwner: string): Effect.Effect<RepoRef, TeamsError> => {
  const match = REPO_PATTERN.exec(nameWithOwner.trim());
  const owner = match?.[1];
  const name = match?.[2];
  return owner !== undefined && name !== undefined
    ? Effect.succeed({ owner, name })
    : Effect.fail(
        new TeamsError({ operation, detail: "Expected a repository in owner/name form." }),
      );
};

const repoPath = (ref: RepoRef) =>
  `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;

const requireNumericId = (
  operation: string,
  field: string,
  value: string,
): Effect.Effect<string, TeamsError> =>
  NUMERIC_ID_PATTERN.test(value)
    ? Effect.succeed(value)
    : Effect.fail(new TeamsError({ operation, detail: `${field} must be a GitHub numeric id.` }));

const authorOf = (user: { readonly login: string } | null) => user?.login ?? "ghost";

const bodyTextOf = (raw: string | null) => {
  const body = raw ?? "";
  const parsed = parseMarker(body);
  return parsed === null ? body : parsed.text;
};

const replyToOf = (raw: string | null): string | null => {
  const parsed = parseMarker(raw ?? "");
  return parsed !== null && parsed.kind === "message" ? parsed.replyTo : null;
};

const toCommentLike = (comment: GitHubComment) => ({
  id: String(comment.id),
  author: authorOf(comment.user),
  body: comment.body ?? "",
});

const toThread = (issue: GitHubIssue, projectId: string): TeamThread => ({
  id: String(issue.number),
  projectId,
  number: issue.number,
  title: issue.title.trim() || "Untitled thread",
  state: issue.state === "closed" ? "closed" : "open",
  author: authorOf(issue.user),
  url: issue.html_url,
  commentCount: issue.comments,
  updatedAt: issue.updated_at,
});

const isAlreadyExistsError = (error: TeamsError) =>
  /already[_ ]exists/i.test(error.detail) || /HTTP 422/i.test(error.detail);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * TeamsService - Team state lives in a local JSON store. Threads, messages,
 * reactions and repository access are all carried by GitHub through `gh`.
 */
export class TeamsService extends Context.Service<
  TeamsService,
  {
    readonly listTeams: (
      input: TeamsListTeamsInput,
    ) => Effect.Effect<TeamsListTeamsResult, TeamsError>;
    readonly createTeam: (input: TeamsCreateTeamInput) => Effect.Effect<Team, TeamsError>;
    readonly addProject: (input: TeamsAddProjectInput) => Effect.Effect<Team, TeamsError>;
    readonly inviteMember: (
      input: TeamsInviteMemberInput,
    ) => Effect.Effect<TeamsInviteMemberResult, TeamsError>;
    readonly listThreads: (
      input: TeamsListThreadsInput,
    ) => Effect.Effect<TeamsListThreadsResult, TeamsError>;
    readonly createThread: (input: TeamsCreateThreadInput) => Effect.Effect<TeamThread, TeamsError>;
    readonly listMessages: (
      input: TeamsListMessagesInput,
    ) => Effect.Effect<TeamsListMessagesResult, TeamsError>;
    readonly postMessage: (input: TeamsPostMessageInput) => Effect.Effect<TeamMessage, TeamsError>;
    readonly toggleReaction: (
      input: TeamsToggleReactionInput,
    ) => Effect.Effect<TeamsToggleReactionResult, TeamsError>;
  }
>()("t3/teams/TeamsService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const github = yield* GitHubCli.GitHubCli;
  const store = yield* TeamsStore.TeamsStore;
  const writeLock = yield* Semaphore.make(1);
  // `gh api` takes explicit repository paths, so any existing directory works as cwd.
  const cwd = config.cwd;

  const withWriteLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    writeLock.withPermits(1)(effect);

  /** Run `gh api <args>`; a JSON body is sent on stdin. */
  const ghApi = (operation: string, args: ReadonlyArray<string>, body?: unknown) =>
    github
      .execute({
        cwd,
        args: ["api", ...args, ...(body !== undefined ? ["--input", "-"] : [])],
        ...(body !== undefined ? { stdin: JSON.stringify(body) } : {}),
      })
      .pipe(
        Effect.map((output) => output.stdout),
        Effect.mapError((cause) => toTeamsError(operation, cause)),
      );

  /** Paginated list endpoint; each item comes back as one compact JSON line. */
  const ghApiPaged = (operation: string, endpoint: string) =>
    ghApi(operation, ["--paginate", "--jq", ".[] | tojson", endpoint]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  const fetchViewer = (operation: string) =>
    ghApi(operation, ["user", "--jq", ".login"]).pipe(
      Effect.map((stdout) => {
        const login = stdout.trim();
        return login.length > 0 ? login : null;
      }),
    );

  const fetchComments = (operation: string, ref: RepoRef, threadId: string) =>
    ghApiPaged(operation, `${repoPath(ref)}/issues/${threadId}/comments?per_page=100`).pipe(
      Effect.flatMap((lines) =>
        Effect.forEach(lines, (line) =>
          decodeComment(line).pipe(Effect.mapError(decodeFailure(operation))),
        ),
      ),
    );

  const grantCollaborator = (operation: string, nameWithOwner: string, login: string) =>
    repoRef(operation, nameWithOwner).pipe(
      Effect.flatMap((ref) =>
        ghApi(
          operation,
          ["-X", "PUT", `${repoPath(ref)}/collaborators/${encodeURIComponent(login)}`],
          { permission: "push" },
        ),
      ),
      Effect.asVoid,
    );

  const ensureThreadLabel = (operation: string, ref: RepoRef) =>
    ghApi(operation, ["-X", "POST", `${repoPath(ref)}/labels`], {
      name: TEAM_THREAD_LABEL,
      color: TEAM_LABEL_COLOR,
    }).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        isAlreadyExistsError(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );

  /** Find the team that owns a project. Projects outside any team are rejected. */
  const findTeamForProject = (operation: string, projectId: string) =>
    store.read.pipe(
      Effect.flatMap((teams) => {
        for (const team of teams) {
          const project = team.projects.find((candidate) => candidate.id === projectId);
          if (project !== undefined) {
            return Effect.succeed({ team, project });
          }
        }
        return Effect.fail(
          new TeamsError({ operation, detail: "That project is not part of any team." }),
        );
      }),
    );

  const listTeams: TeamsService["Service"]["listTeams"] = Effect.fn("TeamsService.listTeams")(
    function* (_input) {
      const teams = yield* store.read;
      const viewer = yield* fetchViewer("TeamsService.listTeams").pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      return { viewer, teams: [...teams] };
    },
  );

  const createTeam: TeamsService["Service"]["createTeam"] = Effect.fn("TeamsService.createTeam")(
    function* (input) {
      const team: Team = {
        id: newTeamId(),
        name: input.name,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        members: [],
        projects: [],
      };
      yield* withWriteLock(
        store.read.pipe(Effect.flatMap((teams) => store.write([...teams, team]))),
      );
      return team;
    },
  );

  const addProject: TeamsService["Service"]["addProject"] = Effect.fn("TeamsService.addProject")(
    function* (input) {
      const operation = "TeamsService.addProject";
      const requested = yield* repoRef(operation, input.nameWithOwner);
      const repo = yield* ghApi(operation, [repoPath(requested)]).pipe(
        Effect.flatMap((stdout) =>
          decodeRepo(stdout).pipe(Effect.mapError(decodeFailure(operation))),
        ),
      );
      const permissions = repo.permissions;
      if (permissions !== undefined && permissions.admin !== true && permissions.push !== true) {
        return yield* new TeamsError({
          operation,
          detail: `You need push or admin access to ${repo.full_name} to share it with a team.`,
        });
      }

      const team = yield* withWriteLock(
        Effect.gen(function* () {
          const teams = yield* store.read;
          const existing = teams.find((candidate) => candidate.id === input.teamId);
          if (existing === undefined) {
            return yield* new TeamsError({ operation, detail: "Team not found." });
          }
          const previous = existing.projects.find((candidate) => candidate.id === repo.full_name);
          const project: TeamProject = {
            id: repo.full_name,
            nameWithOwner: repo.full_name,
            url: repo.html_url,
            localPath: input.localPath ?? previous?.localPath ?? null,
          };
          const projects =
            previous === undefined
              ? [...existing.projects, project]
              : existing.projects.map((candidate) =>
                  candidate.id === project.id ? project : candidate,
                );
          const updated: Team = { ...existing, projects };
          yield* store.write(
            teams.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
          );
          return updated;
        }),
      );

      // Existing members get access to the new project. Failures are logged,
      // not fatal: the project is still added and can be re-shared later.
      yield* Effect.forEach(team.members, (login) =>
        grantCollaborator(operation, repo.full_name, login).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to grant team member access to project", {
              projectId: repo.full_name,
              login,
              detail: error.detail,
            }),
          ),
        ),
      );
      return team;
    },
  );

  const inviteMember: TeamsService["Service"]["inviteMember"] = Effect.fn(
    "TeamsService.inviteMember",
  )(function* (input) {
    const operation = "TeamsService.inviteMember";
    if (!LOGIN_PATTERN.test(input.login)) {
      return yield* new TeamsError({ operation, detail: "That is not a valid GitHub login." });
    }

    const team = yield* withWriteLock(
      Effect.gen(function* () {
        const teams = yield* store.read;
        const existing = teams.find((candidate) => candidate.id === input.teamId);
        if (existing === undefined) {
          return yield* new TeamsError({ operation, detail: "Team not found." });
        }
        const loginKey = input.login.toLowerCase();
        if (existing.members.some((member) => member.toLowerCase() === loginKey)) {
          return existing;
        }
        const updated: Team = { ...existing, members: [...existing.members, input.login] };
        yield* store.write(
          teams.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
        );
        return updated;
      }),
    );

    const grants = yield* Effect.forEach(team.projects, (project) =>
      grantCollaborator(operation, project.nameWithOwner, input.login).pipe(
        Effect.map(() => ({ projectId: project.id, status: "invited" as const })),
        Effect.catch((error) =>
          Effect.succeed({
            projectId: project.id,
            status: "failed" as const,
            detail: error.detail,
          }),
        ),
      ),
    );
    return { team, grants };
  });

  const listThreads: TeamsService["Service"]["listThreads"] = Effect.fn("TeamsService.listThreads")(
    function* (input) {
      const operation = "TeamsService.listThreads";
      const { project } = yield* findTeamForProject(operation, input.projectId);
      const ref = yield* repoRef(operation, project.nameWithOwner);

      const query = new URLSearchParams({
        labels: TEAM_THREAD_LABEL,
        state: "all",
        per_page: "100",
      });
      if (input.since) {
        query.set("since", input.since);
      }
      const lines = yield* ghApiPaged(operation, `${repoPath(ref)}/issues?${query.toString()}`);
      const issues = yield* Effect.forEach(lines, (line) =>
        decodeIssue(line).pipe(Effect.mapError(decodeFailure(operation))),
      );

      return {
        projectId: input.projectId,
        // The issues endpoint also returns pull requests; those are not threads.
        threads: issues
          .filter((issue) => issue.pull_request === undefined)
          .map((issue) => toThread(issue, project.id)),
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      };
    },
  );

  const createThread: TeamsService["Service"]["createThread"] = Effect.fn(
    "TeamsService.createThread",
  )(function* (input) {
    const operation = "TeamsService.createThread";
    const { project } = yield* findTeamForProject(operation, input.projectId);
    const ref = yield* repoRef(operation, project.nameWithOwner);
    yield* ensureThreadLabel(operation, ref);

    const issue = yield* ghApi(operation, ["-X", "POST", `${repoPath(ref)}/issues`], {
      title: deriveThreadTitle(input.body),
      body: encodeMessageBody(null, input.body),
      labels: [TEAM_THREAD_LABEL],
    }).pipe(
      Effect.flatMap((stdout) =>
        decodeIssue(stdout).pipe(Effect.mapError(decodeFailure(operation))),
      ),
    );
    return toThread(issue, project.id);
  });

  const listMessages: TeamsService["Service"]["listMessages"] = Effect.fn(
    "TeamsService.listMessages",
  )(function* (input) {
    const operation = "TeamsService.listMessages";
    const { project } = yield* findTeamForProject(operation, input.projectId);
    const ref = yield* repoRef(operation, project.nameWithOwner);
    const threadId = yield* requireNumericId(operation, "threadId", input.threadId);
    const afterId = input.afterMessageId
      ? yield* requireNumericId(operation, "afterMessageId", input.afterMessageId)
      : null;

    const issue = yield* ghApi(operation, [`${repoPath(ref)}/issues/${threadId}`]).pipe(
      Effect.flatMap((stdout) =>
        decodeIssue(stdout).pipe(Effect.mapError(decodeFailure(operation))),
      ),
    );
    const comments = yield* fetchComments(operation, ref, threadId);
    const viewer = yield* fetchViewer(operation).pipe(Effect.catch(() => Effect.succeed(null)));
    const reactions = aggregateReactions(comments.map(toCommentLike), viewer);

    const rootId = String(issue.number);
    const rootMessage: TeamMessage = {
      id: rootId,
      threadId,
      author: authorOf(issue.user),
      body: bodyTextOf(issue.body),
      createdAt: issue.created_at,
      replyToId: replyToOf(issue.body),
      reactions: [...(reactions.get(rootId) ?? [])],
    };

    const commentMessages: TeamMessage[] = [];
    for (const comment of comments) {
      const raw = comment.body ?? "";
      const parsed = parseMarker(raw);
      if (parsed !== null && parsed.kind === "reaction") {
        continue;
      }
      const id = String(comment.id);
      commentMessages.push({
        id,
        threadId,
        author: authorOf(comment.user),
        body: parsed === null ? raw : parsed.text,
        createdAt: comment.created_at,
        replyToId: replyToOf(raw),
        reactions: [...(reactions.get(id) ?? [])],
      });
    }

    // Comment ids grow monotonically; the thread root uses the issue number,
    // which sorts before any comment id, so it is only returned on a full read.
    const messages = [rootMessage, ...commentMessages].filter(
      (message) => afterId === null || Number(message.id) > Number(afterId),
    );

    return {
      projectId: input.projectId,
      threadId,
      messages,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });

  const postMessage: TeamsService["Service"]["postMessage"] = Effect.fn("TeamsService.postMessage")(
    function* (input) {
      const operation = "TeamsService.postMessage";
      const { project } = yield* findTeamForProject(operation, input.projectId);
      const ref = yield* repoRef(operation, project.nameWithOwner);
      const threadId = yield* requireNumericId(operation, "threadId", input.threadId);
      const replyToId = input.replyToId
        ? yield* requireNumericId(operation, "replyToId", input.replyToId)
        : null;

      const comment = yield* ghApi(
        operation,
        ["-X", "POST", `${repoPath(ref)}/issues/${threadId}/comments`],
        { body: encodeMessageBody(replyToId, input.body) },
      ).pipe(
        Effect.flatMap((stdout) =>
          decodeComment(stdout).pipe(Effect.mapError(decodeFailure(operation))),
        ),
      );

      return {
        id: String(comment.id),
        threadId,
        author: authorOf(comment.user),
        body: input.body,
        createdAt: comment.created_at,
        replyToId,
        reactions: [],
      };
    },
  );

  const toggleReaction: TeamsService["Service"]["toggleReaction"] = Effect.fn(
    "TeamsService.toggleReaction",
  )(function* (input) {
    const operation = "TeamsService.toggleReaction";
    const { project } = yield* findTeamForProject(operation, input.projectId);
    const ref = yield* repoRef(operation, project.nameWithOwner);
    const threadId = yield* requireNumericId(operation, "threadId", input.threadId);
    const messageId = yield* requireNumericId(operation, "messageId", input.messageId);

    const viewer = yield* fetchViewer(operation);
    if (viewer === null) {
      return yield* new TeamsError({
        operation,
        detail: "Could not determine your GitHub login. Run `gh auth login` and retry.",
      });
    }

    const comments = yield* fetchComments(operation, ref, threadId);
    const ownReactionId = findOwnReactionCommentId(
      comments.map(toCommentLike),
      viewer,
      messageId,
      input.emoji,
    );
    if (ownReactionId !== null) {
      yield* ghApi(operation, [
        "-X",
        "DELETE",
        `${repoPath(ref)}/issues/comments/${ownReactionId}`,
      ]);
      return { added: false };
    }

    yield* ghApi(operation, ["-X", "POST", `${repoPath(ref)}/issues/${threadId}/comments`], {
      body: encodeReactionBody(messageId, input.emoji),
    });
    return { added: true };
  });

  return TeamsService.of({
    listTeams,
    createTeam,
    addProject,
    inviteMember,
    listThreads,
    createThread,
    listMessages,
    postMessage,
    toggleReaction,
  });
});

export const layer = Layer.effect(TeamsService, make);
