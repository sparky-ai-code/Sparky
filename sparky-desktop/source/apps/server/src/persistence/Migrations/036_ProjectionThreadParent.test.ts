import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadParent", (it) => {
  it.effect("adds parent_thread_id even when migration ids 33-35 were recorded by another build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });

      // Local state databases written by another build record different
      // migrations under ids 33-35. The migrator keys on id, so this build's
      // parent-thread migration must use a fresh id or it is silently skipped.
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES
          (33, '2026-08-10 15:23:53', 'Automations'),
          (34, '2026-08-10 15:23:53', 'AutomationPreferences'),
          (35, '2026-08-21 21:24:25', 'ProjectionProjectArchive')
      `;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(columns.some((column) => column.name === "parent_thread_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.isTrue(indexes.some((index) => index.name === "idx_projection_threads_parent"));

      // The query that failed at startup must now prepare successfully.
      const rows = yield* sql`
        SELECT thread_id, parent_thread_id
        FROM projection_threads
        WHERE parent_thread_id IS NULL
        LIMIT 1
      `;
      assert.isArray(rows);
    }),
  );
});
