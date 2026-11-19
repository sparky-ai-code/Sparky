import { ThreadId } from "@sparky/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert, it } from "@effect/vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

it.layer(OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
))("persisted subagent projections", (it) => {
  it.effect("hydrates parent relationships in detail and shell queries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, parent_thread_id, title, model_selection_json,
          runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, deleted_at
        ) VALUES (
          'subagent-child', 'example-project', 'subagent-parent', 'Child',
          '{"instanceId":"sparky","model":"gpt-6"}',
          'approval-required', 'default', NULL, NULL, NULL,
          NULL, 0, 0, 0, '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z', NULL
        )
      `;
      const childId = ThreadId.make("subagent-child");
      const shell = yield* query.getThreadShellById(childId);
      const detail = yield* query.getThreadDetailById(childId);
      assert.equal(shell._tag, "Some");
      assert.equal(detail._tag, "Some");
      if (shell._tag === "Some" && detail._tag === "Some") {
        assert.equal(shell.value.parentThreadId, ThreadId.make("subagent-parent"));
        assert.equal(detail.value.parentThreadId, ThreadId.make("subagent-parent"));
      }
    }),
  );
});
