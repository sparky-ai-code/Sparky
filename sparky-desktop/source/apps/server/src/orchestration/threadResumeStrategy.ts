/**
 * The event store uses a global sequence for all threads. Replaying a stale
 * thread cursor across hours of unrelated activity causes unnecessary SQLite
 * reads and can accumulate live events while the replay is in flight.
 */
export const THREAD_DETAIL_REPLAY_MAX_EVENTS = 1_000;

/** Return a bounded global event count, or null to load a fresh projection. */
export function threadDetailReplayLimit(
  afterSequence: number,
  latestSequence: number,
): number | null {
  const gap = latestSequence - afterSequence;
  return Number.isSafeInteger(gap) && gap >= 0 && gap <= THREAD_DETAIL_REPLAY_MAX_EVENTS
    ? gap
    : null;
}
