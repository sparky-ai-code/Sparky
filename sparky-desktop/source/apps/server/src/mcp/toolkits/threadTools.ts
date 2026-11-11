import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Tool, Toolkit } from "effect/unstable/ai";

const ThreadSearchRow = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  updatedAt: Schema.String,
  snippet: Schema.String,
});
const ThreadMessageRow = Schema.Struct({
  role: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
});
const ThreadHeaderRow = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const makeThreadQueries = (sql: SqlClient.SqlClient["Service"]) => ({
  search: SqlSchema.findAll({
    Request: Schema.Struct({ query: Schema.String, limit: Schema.Number }),
    Result: ThreadSearchRow,
    execute: ({ query, limit }) => {
      const pattern = `%${query}%`;
      return sql`
        SELECT t.thread_id AS "threadId", t.title, t.project_id AS "projectId",
          t.updated_at AS "updatedAt",
          COALESCE((SELECT substr(m.text, 1, 500) FROM projection_thread_messages m
            WHERE m.thread_id = t.thread_id AND m.text LIKE ${pattern}
            ORDER BY m.created_at DESC LIMIT 1), '') AS snippet
        FROM projection_threads t
        WHERE t.deleted_at IS NULL AND (t.title LIKE ${pattern} OR EXISTS (
          SELECT 1 FROM projection_thread_messages m
          WHERE m.thread_id = t.thread_id AND m.text LIKE ${pattern}
        ))
        ORDER BY t.updated_at DESC, t.thread_id ASC LIMIT ${limit}
      `;
    },
  }),
  get: SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ThreadHeaderRow,
    execute: ({ threadId }) => sql`
      SELECT thread_id AS "threadId", title, project_id AS "projectId",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL
    `,
  }),
  messages: SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String, limit: Schema.Number, offset: Schema.Number }),
    Result: ThreadMessageRow,
    execute: ({ threadId, limit, offset }) => sql`
      SELECT role, text, created_at AS "createdAt" FROM projection_thread_messages
      WHERE thread_id = ${threadId} ORDER BY created_at ASC, message_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `,
  }),
  count: SqlSchema.findOne({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: Schema.Struct({ total: Schema.Number }),
    execute: ({ threadId }) => sql`
      SELECT COUNT(*) AS total FROM projection_thread_messages WHERE thread_id = ${threadId}
    `,
  }),
});

export const SearchThreadsTool = Tool.make("searchThreads", {
  description:
    "Search all Sparky threads across projects by matching their titles and message text. Returns recent matching threads with a matching message excerpt when available.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
      description: "Text to find in thread titles and messages.",
    }),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))).annotate({
      description: "Maximum number of matching threads to return (default 10, maximum 50).",
    }),
  }),
  success: Schema.Struct({
    threads: Schema.Array(ThreadSearchRow),
    count: Schema.Number,
  }),
})
  .annotate(Tool.Title, "Search threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ReadThreadTool = Tool.make("readThread", {
  description:
    "Read a Sparky thread by its thread ID, including its title and paginated messages. Archived threads are readable; deleted threads are not.",
  parameters: Schema.Struct({
    threadId: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "The exact Sparky thread ID to read.",
    }),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
      description: "Maximum messages to return (default 50, maximum 100).",
    }),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
      description: "Number of earliest messages to skip when paging (default 0).",
    }),
  }),
  success: Schema.Struct({
    thread: ThreadHeaderRow,
    messages: Schema.Array(ThreadMessageRow),
    totalMessages: Schema.Number,
    offset: Schema.Number,
    hasMore: Schema.Boolean,
  }),
})
  .annotate(Tool.Title, "Read thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolsToolkit = Toolkit.make(SearchThreadsTool, ReadThreadTool);
export const ThreadToolsToolkitHandlersLive = ThreadToolsToolkit.toLayer({
  searchThreads: ({ query, limit }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* makeThreadQueries(sql).search({
        query: query.trim(),
        limit: limit ?? 10,
      });
      return { threads, count: threads.length };
    }),
  readThread: ({ threadId, limit, offset }) =>
    Effect.gen(function* () {
      const queries = makeThreadQueries(yield* SqlClient.SqlClient);
      const thread = yield* queries.get({ threadId });
      if (thread._tag === "None") {
        return yield* Effect.fail(new Error(`No Sparky thread found with ID ${threadId}.`));
      }
      const start = offset ?? 0;
      const messages = yield* queries.messages({
        threadId,
        limit: limit ?? 50,
        offset: start,
      });
      const { total } = yield* queries.count({ threadId });
      return {
        thread: thread.value,
        messages,
        totalMessages: total,
        offset: start,
        hasMore: start + messages.length < total,
      };
    }),
});
