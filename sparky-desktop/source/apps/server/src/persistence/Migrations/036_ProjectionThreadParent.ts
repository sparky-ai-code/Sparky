import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN parent_thread_id TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent
    ON projection_threads(parent_thread_id, created_at)
  `;
});
