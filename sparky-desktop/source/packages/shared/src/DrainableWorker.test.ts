import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makePartitionedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makePartitionedDrainableWorker", () => {
  it.live("runs distinct threads independently but keeps one thread in FIFO order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const otherFinished = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();

        const worker = yield* makePartitionedDrainableWorker(
          (event: { readonly threadId: string; readonly action: string }) =>
            Effect.gen(function* () {
              if (event.action === "first") {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              } else if (event.action === "second") {
                yield* Deferred.succeed(secondStarted, undefined);
              }
              processed.push(event.action);
              if (event.action === "other") {
                yield* Deferred.succeed(otherFinished, undefined);
              }
            }),
          (event) => event.threadId,
          4,
        );

        yield* worker.enqueue({ threadId: "a", action: "first" });
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue({ threadId: "a", action: "second" });
        yield* worker.enqueue({ threadId: "b", action: "other" });
        yield* Effect.forkChild(
          worker.drain.pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
        );

        // Thread b is on a different lane and finishes even though thread a
        // remains blocked. The second event for thread a must wait for first.
        yield* Deferred.await(otherFinished);
        expect(processed).toEqual(["other"]);
        expect(yield* Deferred.isDone(secondStarted)).toBe(false);
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);
        yield* Deferred.await(drained);
        expect(processed).toEqual(["other", "first", "second"]);
      }),
    ),
  );
});
