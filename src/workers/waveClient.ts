import {
  DEFAULT_T_SAMPLES,
  DEFAULT_X_SAMPLES,
  MAX_T_SAMPLES,
  MAX_X_SAMPLES,
  MIN_GRID_SAMPLES
} from "../math/solver";
import type {
  ProblemNotice,
  SolveWaveOptions,
  WaveProblem,
  WaveSolutionGrid,
  WaveWorkerRequest
} from "../types";

export interface WaveWorkerClientCallbacks {
  onResult: (result: WaveSolutionGrid) => void;
  onError: (revision: number, message: string) => void;
}

export type WaveWorkerFactory = () => Worker;

interface PendingRequest {
  revision: number;
  problemSignature: string;
  xSamples: number;
  tSamples: number;
  xMin: number;
  xMax: number;
  T: number;
}

const MAX_WORKER_ERROR_LENGTH = 4_096;

/** Owns one worker and accepts results only for the latest requested revision. */
export class WaveWorkerClient {
  private worker: Worker | null = null;
  private revision = 0;
  private pending: PendingRequest | null = null;
  private disposed = false;
  private workerStartError: string | null = null;

  constructor(
    private readonly callbacks: WaveWorkerClientCallbacks,
    private readonly workerFactory: WaveWorkerFactory = () =>
      new Worker(new URL("./wave.worker.ts", import.meta.url), { type: "module" })
  ) {}

  solve(problem: WaveProblem, options: Omit<SolveWaveOptions, "revision"> = {}): number {
    this.revision += 1;
    const revision = this.revision;
    if (this.disposed) return revision;
    const xSamples = options.xSamples ?? DEFAULT_X_SAMPLES;
    const tSamples = options.tSamples ?? DEFAULT_T_SAMPLES;
    const sampleError = validateSampleCounts(xSamples, tSamples);
    if (sampleError) {
      this.pending = null;
      this.callbacks.onError(revision, sampleError);
      return revision;
    }
    const request: WaveWorkerRequest = {
      type: "solve",
      revision,
      problem,
      xSamples,
      tSamples
    };
    this.pending = {
      revision,
      problemSignature: problem.signature,
      xSamples,
      tSamples,
      xMin: problem.view.xMin,
      xMax: problem.view.xMax,
      T: problem.T
    };
    const worker = this.ensureWorker();
    if (!worker) {
      const pending = this.pending;
      this.pending = null;
      if (pending) {
        this.callbacks.onError(
          pending.revision,
          this.workerStartError ?? "The wave worker could not start."
        );
      }
      return revision;
    }
    try {
      worker.postMessage(request);
    } catch (caught) {
      this.failWorker(
        worker,
        `The wave worker could not accept the request: ${messageOf(caught)}`
      );
    }
    return revision;
  }

  /** Alias retained for controllers that name worker operations compute(). */
  compute(problem: WaveProblem, options: Omit<SolveWaveOptions, "revision"> = {}): number {
    return this.solve(problem, options);
  }

  get currentRevision(): number {
    return this.revision;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = null;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = this.workerFactory();
    } catch (caught) {
      this.workerStartError = `The wave worker could not start: ${messageOf(caught)}`;
      return null;
    }
    this.workerStartError = null;
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<unknown>): void => {
      if (this.worker !== worker || this.disposed) return;
      const response = event.data;
      if (!isRecord(response) || typeof response.type !== "string") {
        this.failWorker(worker, "The wave worker returned malformed data.");
        return;
      }
      if (response.type === "result") {
        const revision = isRecord(response.result)
          ? response.result.revision
          : undefined;
        if (!isRevision(revision)) {
          this.failWorker(worker, "The wave worker returned malformed data.");
          return;
        }
        if (revision < this.revision) return;
        const pending = this.pending;
        if (
          revision > this.revision ||
          !pending ||
          !isResultForRequest(response.result, pending)
        ) {
          this.failWorker(worker, "The wave worker returned malformed data.");
          return;
        }
        this.pending = null;
        this.callbacks.onResult(response.result);
        return;
      }
      if (response.type !== "error" || !isRevision(response.revision)) {
        this.failWorker(worker, "The wave worker returned malformed data.");
        return;
      }
      if (response.revision < this.revision) return;
      const pending = this.pending;
      if (
        response.revision > this.revision ||
        !pending ||
        pending.revision !== response.revision ||
        typeof response.message !== "string" ||
        response.message.length > MAX_WORKER_ERROR_LENGTH
      ) {
        this.failWorker(worker, "The wave worker returned malformed data.");
        return;
      }
      this.pending = null;
      this.callbacks.onError(response.revision, response.message);
    };
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      const detail = event.message ? ` ${event.message}` : "";
      this.failWorker(
        worker,
        `The wave worker stopped unexpectedly.${detail}`
      );
    };
    worker.onmessageerror = (): void => {
      this.failWorker(worker, "The wave worker returned unreadable data.");
    };
    return worker;
  }

  private failWorker(worker: Worker, message: string): void {
    if (this.worker !== worker || this.disposed) return;
    this.worker = null;
    worker.terminate();
    const pending = this.pending;
    this.pending = null;
    if (pending) this.callbacks.onError(pending.revision, message);
  }
}

function isResultForRequest(
  value: unknown,
  pending: PendingRequest
): value is WaveSolutionGrid {
  if (
    !isRecord(value) ||
    value.revision !== pending.revision ||
    value.problemSignature !== pending.problemSignature ||
    !(value.x instanceof Float64Array) ||
    !(value.t instanceof Float64Array) ||
    !(value.values instanceof Float32Array) ||
    value.x.length !== pending.xSamples ||
    value.t.length !== pending.tSamples ||
    value.values.length !== pending.xSamples * pending.tSamples ||
    !sameEndpoint(value.x[0], pending.xMin) ||
    !sameEndpoint(value.x[value.x.length - 1], pending.xMax) ||
    !sameEndpoint(value.t[0], 0) ||
    !sameEndpoint(value.t[value.t.length - 1], pending.T) ||
    !strictlyIncreasingFinite(value.x) ||
    !strictlyIncreasingFinite(value.t) ||
    !allFinite(value.values) ||
    !isSurfaceRange(value.surfaceRange) ||
    !isTimings(value.timings) ||
    !Number.isInteger(value.reflectionCount) ||
    (value.reflectionCount as number) < 0 ||
    (value.reflectionCount as number) > 64 ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(isProblemNotice)
  ) {
    return false;
  }
  return true;
}

function validateSampleCounts(xSamples: number, tSamples: number): string | null {
  if (
    !Number.isInteger(xSamples) ||
    xSamples < MIN_GRID_SAMPLES ||
    xSamples > MAX_X_SAMPLES
  ) {
    return `xSamples must be an integer from ${MIN_GRID_SAMPLES} to ${MAX_X_SAMPLES}.`;
  }
  if (
    !Number.isInteger(tSamples) ||
    tSamples < MIN_GRID_SAMPLES ||
    tSamples > MAX_T_SAMPLES
  ) {
    return `tSamples must be an integer from ${MIN_GRID_SAMPLES} to ${MAX_T_SAMPLES}.`;
  }
  return null;
}

function strictlyIncreasingFinite(values: Float64Array): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    if (!Number.isFinite(value)) return false;
    if (index > 0 && !(value > (values[index - 1] as number))) return false;
  }
  return true;
}

function allFinite(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

function isSurfaceRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.min === "number" &&
    Number.isFinite(value.min) &&
    typeof value.max === "number" &&
    Number.isFinite(value.max) &&
    value.min < value.max
  );
}

function isTimings(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNonnegative(value.totalMs) &&
    isFiniteNonnegative(value.integrationMs) &&
    isFiniteNonnegative(value.samplingMs)
  );
}

function isProblemNotice(value: unknown): value is ProblemNotice {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.severity === "warning" &&
    typeof value.message === "string" &&
    value.message.length <= MAX_WORKER_ERROR_LENGTH &&
    (value.path === undefined || typeof value.path === "string")
  );
}

function sameEndpoint(value: unknown, expected: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value - expected) <= 1e-12 * Math.max(1, Math.abs(expected))
  );
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Unknown worker error.";
}
