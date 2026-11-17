/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Run independent aggregate keys on separate bounded workers, while
 * preserving FIFO within each key. A stalled provider operation for one
 * thread should not block unrelated threads behind the same global queue.
 *
 * Deterministic sharding uses a fixed number of queues/fibers (rather than
 * spawning unbounded per-thread workers), and every worker is scope-bound.
 * Hash collisions may share a lane but never violate per-key ordering.
 */
export const makePartitionedDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  keyForItem: (item: A) => string,
  partitions = 4,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const count = Math.max(1, Math.floor(partitions));
    const workers = yield* Effect.forEach(
      Array.from({ length: count }, (_unused, index) => index),
      () => makeDrainableWorker(process),
      { concurrency: "unbounded" },
    );

    const partitionFor = (key: string): number => {
      let hash = 0;
      for (let index = 0; index < key.length; index += 1) {
        hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
      }
      return (hash >>> 0) % count;
    };

    return {
      enqueue: (item: A) => workers[partitionFor(keyForItem(item))]!.enqueue(item),
      drain: Effect.forEach(workers, (worker) => worker.drain, {
        concurrency: "unbounded",
        discard: true,
      }),
    } satisfies DrainableWorker<A>;
  });
