import {
  ServerProcessResourceHistoryFailureTag,
  type ServerProcessResourceHistoryBucket,
  type ServerProcessResourceHistoryFailureTag as ServerProcessResourceHistoryFailureTagType,
  type ServerProcessResourceHistoryInput,
  type ServerProcessResourceHistoryResult,
  type ServerProcessResourceHistorySummary,
} from "@sparky/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

const SAMPLE_INTERVAL_MS = 5_000;
// Avoid spawning ps/PowerShell continuously when the diagnostics view is closed.
const SAMPLING_IDLE_TIMEOUT_MS = 60_000;

export function shouldSampleProcessResources(lastReadAtMs: number, nowMs: number): boolean {
  return lastReadAtMs > 0 && nowMs - lastReadAtMs <= SAMPLING_IDLE_TIMEOUT_MS;
}
const RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_SAMPLES = 20_000;

export interface ProcessResourceSample {
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
  readonly processKey: string;
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly depth: number;
  readonly isServerRoot: boolean;
}

export class ProcessResourceSamplingError extends Schema.TaggedErrorClass<ProcessResourceSamplingError>()(
  "ProcessResourceSamplingError",
  {
    failureTag: ServerProcessResourceHistoryFailureTag,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sample process resources (${this.failureTag}).`;
  }
}

interface MonitorState {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly lastFailure: ProcessResourceSamplingError | null;
}

export class ProcessResourceMonitor extends Context.Service<
  ProcessResourceMonitor,
  {
    readonly readHistory: (
      input: ServerProcessResourceHistoryInput,
    ) => Effect.Effect<ServerProcessResourceHistoryResult>;
  }
>()("t3/diagnostics/ProcessResourceMonitor") {}

function dateTimeFromMillis(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function sampleKey(row: Pick<ProcessDiagnostics.ProcessRow, "pid" | "command">): string {
  return `${row.pid}:${row.command}`;
}

function findServerRootRow(
  rows: ReadonlyArray<ProcessDiagnostics.ProcessRow>,
  serverPid: number,
): ProcessDiagnostics.ProcessRow | null {
  return rows.find((row) => row.pid === serverPid) ?? null;
}

export function collectMonitoredSamples(input: {
  readonly rows: ReadonlyArray<ProcessDiagnostics.ProcessRow>;
  readonly serverPid: number;
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
}): ReadonlyArray<ProcessResourceSample> {
  const rows = input.rows.filter(
    (row) => !ProcessDiagnostics.isDiagnosticsQueryProcess(row, input.serverPid),
  );
  const root = findServerRootRow(rows, input.serverPid);
  const descendants = ProcessDiagnostics.buildDescendantEntries(rows, input.serverPid);
  const samples: ProcessResourceSample[] = [];

  if (root) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(root),
      pid: root.pid,
      ppid: root.ppid,
      command: root.command,
      cpuPercent: root.cpuPercent,
      rssBytes: root.rssBytes,
      depth: 0,
      isServerRoot: true,
    });
  }

  for (const process of descendants) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(process),
      pid: process.pid,
      ppid: process.ppid,
      command: process.command,
      cpuPercent: process.cpuPercent,
      rssBytes: process.rssBytes,
      depth: process.depth + 1,
      isServerRoot: false,
    });
  }

  return samples;
}

function trimSamples(
  samples: ReadonlyArray<ProcessResourceSample>,
  nowMs: number,
): ReadonlyArray<ProcessResourceSample> {
  const minSampledAtMs = nowMs - RETENTION_MS;
  const retained = samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  return retained.length <= MAX_RETAINED_SAMPLES
    ? retained
    : retained.slice(retained.length - MAX_RETAINED_SAMPLES);
}

function summarizeProcesses(
  samples: ReadonlyArray<ProcessResourceSample>,
): ReadonlyArray<ServerProcessResourceHistorySummary> {
  const groups = new Map<string, ProcessResourceSample[]>();
  for (const sample of samples) {
    const processSamples = groups.get(sample.processKey) ?? [];
    processSamples.push(sample);
    groups.set(sample.processKey, processSamples);
  }

  return [...groups.entries()]
    .map(([processKey, processSamples]) => {
      const sorted = processSamples.toSorted((left, right) => left.sampledAtMs - right.sampledAtMs);
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const cpuPercentTotal = sorted.reduce((total, sample) => total + sample.cpuPercent, 0);
      const maxCpuPercent = Math.max(...sorted.map((sample) => sample.cpuPercent));
      const maxRssBytes = Math.max(...sorted.map((sample) => sample.rssBytes));
      const cpuSecondsApprox = sorted.reduce(
        (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
        0,
      );

      return {
        processKey,
        pid: latest.pid,
        ppid: latest.ppid,
        command: latest.command,
        depth: latest.depth,
        isServerRoot: latest.isServerRoot,
        firstSeenAt: first.sampledAt,
        lastSeenAt: latest.sampledAt,
        currentCpuPercent: latest.cpuPercent,
        avgCpuPercent: cpuPercentTotal / sorted.length,
        maxCpuPercent,
        cpuSecondsApprox,
        currentRssBytes: latest.rssBytes,
        maxRssBytes,
        sampleCount: sorted.length,
      } satisfies ServerProcessResourceHistorySummary;
    })
    .toSorted((left, right) => right.cpuSecondsApprox - left.cpuSecondsApprox);
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ServerProcessResourceHistoryBucket> {
  const bucketMs = Math.max(1_000, input.bucketMs);
  const windowStartMs = input.nowMs - input.windowMs;
  const bucketCount = Math.ceil(input.windowMs / bucketMs);

  // Aggregate each sampling instant once, rather than filtering the entire
  // history separately for every bucket (O(samples * buckets)).
  const totalsByRead = new Map<number, { cpuPercent: number; rssBytes: number; processCount: number }>();
  for (const sample of input.samples) {
    if (sample.sampledAtMs < windowStartMs || sample.sampledAtMs > input.nowMs) {
      continue;
    }
    const totals = totalsByRead.get(sample.sampledAtMs) ?? {
      cpuPercent: 0,
      rssBytes: 0,
      processCount: 0,
    };
    totals.cpuPercent += sample.cpuPercent;
    totals.rssBytes += sample.rssBytes;
    totals.processCount += 1;
    totalsByRead.set(sample.sampledAtMs, totals);
  }

  const totalsByBucket = Array.from({ length: bucketCount }, () => ({
    readCount: 0,
    cpuTotal: 0,
    maxCpuPercent: 0,
    maxRssBytes: 0,
    maxProcessCount: 0,
  }));
  for (const [sampledAtMs, totals] of totalsByRead) {
    // A sample exactly at nowMs belongs to the final bucket.
    const index = Math.min(bucketCount - 1, Math.floor((sampledAtMs - windowStartMs) / bucketMs));
    const bucket = totalsByBucket[index]!;
    bucket.readCount += 1;
    bucket.cpuTotal += totals.cpuPercent;
    bucket.maxCpuPercent = Math.max(bucket.maxCpuPercent, totals.cpuPercent);
    bucket.maxRssBytes = Math.max(bucket.maxRssBytes, totals.rssBytes);
    bucket.maxProcessCount = Math.max(bucket.maxProcessCount, totals.processCount);
  }

  return totalsByBucket.map((totals, index) => {
    const startedAtMs = windowStartMs + index * bucketMs;
    return {
      startedAt: dateTimeFromMillis(startedAtMs),
      endedAt: dateTimeFromMillis(Math.min(input.nowMs, startedAtMs + bucketMs)),
      avgCpuPercent: totals.readCount > 0 ? totals.cpuTotal / totals.readCount : 0,
      maxCpuPercent: totals.maxCpuPercent,
      maxRssBytes: totals.maxRssBytes,
      maxProcessCount: totals.maxProcessCount,
    };
  });
}

export function aggregateProcessResourceHistory(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly readAt: DateTime.Utc;
  readonly readAtMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly lastFailure: ProcessResourceSamplingError | null;
}): ServerProcessResourceHistoryResult {
  const windowMs = Math.max(1_000, input.windowMs);
  const bucketMs = Math.max(1_000, input.bucketMs);
  const minSampledAtMs = input.readAtMs - windowMs;
  const samples = input.samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  const topProcesses = summarizeProcesses(samples);
  const totalCpuSecondsApprox = samples.reduce(
    (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
    0,
  );

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    retainedSampleCount: input.samples.length,
    totalCpuSecondsApprox,
    buckets: buildBuckets({ samples, nowMs: input.readAtMs, windowMs, bucketMs }),
    topProcesses,
    error: input.lastFailure
      ? Option.some({
          failureTag: input.lastFailure.failureTag,
          message: input.lastFailure.message,
        })
      : Option.none(),
  };
}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make<MonitorState>({ samples: [], lastFailure: null });
  const lastHistoryReadAtMs = yield* Ref.make(0);

  const recordSamplingFailure = (cause: {
    readonly _tag: ServerProcessResourceHistoryFailureTagType;
  }) =>
    Ref.update(state, (current) => ({
      ...current,
      lastFailure: new ProcessResourceSamplingError({
        failureTag: cause._tag,
        cause,
      }),
    }));

  const sampleOnce = Effect.gen(function* () {
    const sampledAt = yield* DateTime.now;
    const sampledAtMs = DateTime.toEpochMillis(sampledAt);
    const rows = yield* ProcessDiagnostics.readProcessRows.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const samples = collectMonitoredSamples({
      rows,
      serverPid: process.pid,
      sampledAt,
      sampledAtMs,
    });
    yield* Ref.update(state, (current) => ({
      samples: trimSamples([...current.samples, ...samples], sampledAtMs),
      lastFailure: null,
    }));
  }).pipe(
    Effect.catchTags({
      ProcessDiagnosticsQueryTimeoutError: recordSamplingFailure,
      ProcessDiagnosticsQueryFailedError: recordSamplingFailure,
      ProcessDiagnosticsServerProcessSignalError: recordSamplingFailure,
      ProcessDiagnosticsNotDescendantError: recordSamplingFailure,
      ProcessDiagnosticsSignalFailedError: recordSamplingFailure,
    }),
  );

  // The monitor service exists for the lifetime of the backend, but process
  // enumeration is needed only while a client is viewing resource history.
  const sampleWhenObserved = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (shouldSampleProcessResources(yield* Ref.get(lastHistoryReadAtMs), nowMs)) {
      yield* sampleOnce;
    }
  });
  yield* Effect.forever(
    sampleWhenObserved.pipe(Effect.andThen(Effect.sleep(SAMPLE_INTERVAL_MS))),
  ).pipe(Effect.forkScoped);

  const readHistory: ProcessResourceMonitor["Service"]["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const readAtMs = DateTime.toEpochMillis(readAt);
      const previousReadAtMs = yield* Ref.get(lastHistoryReadAtMs);
      yield* Ref.set(lastHistoryReadAtMs, readAtMs);
      // Give the first diagnostics request a useful sample immediately; resume
      // periodic collection until the view has been idle for a minute.
      if (!shouldSampleProcessResources(previousReadAtMs, readAtMs)) {
        yield* sampleOnce;
      }
      const current = yield* Ref.get(state);
      return aggregateProcessResourceHistory({
        samples: current.samples,
        readAt,
        readAtMs,
        windowMs: input.windowMs,
        bucketMs: input.bucketMs,
        lastFailure: current.lastFailure,
      });
    });

  return ProcessResourceMonitor.of({ readHistory });
});

export const layer = Layer.effect(ProcessResourceMonitor, make);
