import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Teams: GitHub-accounts-as-teammates, with GitHub itself as the transport.
 *
 * - A team is a named group of GitHub logins plus a set of team projects.
 * - A team project is a GitHub repository. Adding a member grants them
 *   collaborator access to every team project in the team.
 * - A thread is a GitHub issue (labelled `sparky-team`) inside a team project.
 * - A message is a comment on that issue. Replies and emoji reactions are
 *   encoded as hidden metadata in the comment body so no external service is
 *   needed.
 */

export const TEAM_THREAD_LABEL = "sparky-team";

export const TeamGitHubLogin = TrimmedNonEmptyString.check(
  // GitHub logins: alphanumerics and single hyphens, up to 39 chars.
  // Using a permissive check here; the server re-validates against GitHub.
  Schema.isMaxLength(39),
);
export type TeamGitHubLogin = typeof TeamGitHubLogin.Type;

export const TeamProject = Schema.Struct({
  /** `owner/name` of the repository. Also used as the stable project id. */
  id: TrimmedNonEmptyString,
  nameWithOwner: TrimmedNonEmptyString,
  url: Schema.String,
  /** Optional local folder that backs this project in Sparky. */
  localPath: Schema.NullOr(Schema.String),
});
export type TeamProject = typeof TeamProject.Type;

export const Team = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  createdAt: Schema.String,
  /** GitHub logins that were invited to this team. */
  members: Schema.Array(TeamGitHubLogin),
  projects: Schema.Array(TeamProject),
});
export type Team = typeof Team.Type;

export const TeamThread = Schema.Struct({
  /** Issue node number, as a string, unique within its project. */
  id: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  number: Schema.Int,
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  author: Schema.String,
  url: Schema.String,
  commentCount: Schema.Int,
  updatedAt: Schema.String,
});
export type TeamThread = typeof TeamThread.Type;

export const TeamMessageReaction = Schema.Struct({
  emoji: TrimmedNonEmptyString,
  count: Schema.Int,
  reactedByViewer: Schema.Boolean,
});
export type TeamMessageReaction = typeof TeamMessageReaction.Type;

export const TeamMessage = Schema.Struct({
  /** GitHub comment id, as a string. The first message of a thread has id = thread id. */
  id: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  replyToId: Schema.NullOr(Schema.String),
  reactions: Schema.Array(TeamMessageReaction),
});
export type TeamMessage = typeof TeamMessage.Type;

export const TeamsListTeamsInput = Schema.Struct({});
export type TeamsListTeamsInput = typeof TeamsListTeamsInput.Type;

export const TeamsListTeamsResult = Schema.Struct({
  viewer: Schema.NullOr(TeamGitHubLogin),
  teams: Schema.Array(Team),
});
export type TeamsListTeamsResult = typeof TeamsListTeamsResult.Type;

export const TeamsCreateTeamInput = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type TeamsCreateTeamInput = typeof TeamsCreateTeamInput.Type;

export const TeamsAddProjectInput = Schema.Struct({
  teamId: TrimmedNonEmptyString,
  /** `owner/name` of an existing GitHub repository the viewer can administer. */
  nameWithOwner: TrimmedNonEmptyString,
  /** Local folder to associate with the project, if any. */
  localPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TeamsAddProjectInput = typeof TeamsAddProjectInput.Type;

export const TeamsInviteMemberInput = Schema.Struct({
  teamId: TrimmedNonEmptyString,
  login: TeamGitHubLogin,
});
export type TeamsInviteMemberInput = typeof TeamsInviteMemberInput.Type;

export const TeamsInviteMemberResult = Schema.Struct({
  team: Team,
  grants: Schema.Array(
    Schema.Struct({
      projectId: TrimmedNonEmptyString,
      status: Schema.Literals(["invited", "already-member", "failed"]),
      detail: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type TeamsInviteMemberResult = typeof TeamsInviteMemberResult.Type;

export const TeamsListThreadsInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  /** Only return threads updated at or after this ISO timestamp. */
  since: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TeamsListThreadsInput = typeof TeamsListThreadsInput.Type;

export const TeamsListThreadsResult = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  threads: Schema.Array(TeamThread),
  fetchedAt: Schema.String,
});
export type TeamsListThreadsResult = typeof TeamsListThreadsResult.Type;

export const TeamsCreateThreadInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  /** Full message text. The first line becomes the thread title. */
  body: TrimmedNonEmptyString,
});
export type TeamsCreateThreadInput = typeof TeamsCreateThreadInput.Type;

export const TeamsListMessagesInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  /** Only return messages created after this message id (incremental poll). */
  afterMessageId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamsListMessagesInput = typeof TeamsListMessagesInput.Type;

export const TeamsListMessagesResult = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  messages: Schema.Array(TeamMessage),
  fetchedAt: Schema.String,
});
export type TeamsListMessagesResult = typeof TeamsListMessagesResult.Type;

export const TeamsPostMessageInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  replyToId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamsPostMessageInput = typeof TeamsPostMessageInput.Type;

export const TeamsToggleReactionInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  emoji: TrimmedNonEmptyString,
});
export type TeamsToggleReactionInput = typeof TeamsToggleReactionInput.Type;

export const TeamsToggleReactionResult = Schema.Struct({
  added: Schema.Boolean,
});
export type TeamsToggleReactionResult = typeof TeamsToggleReactionResult.Type;

export class TeamsError extends Schema.TaggedErrorClass<TeamsError>()("TeamsError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
