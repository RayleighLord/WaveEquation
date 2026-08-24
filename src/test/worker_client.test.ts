import { describe, expect, it } from "vitest";
import { getWavePresetProblem } from "../math/presets";
import { solveWaveProblem } from "../math/solver";
import type { WaveSolutionGrid } from "../types";
import { WaveWorkerClient } from "../workers/waveClient";

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe("WaveWorkerClient", () => {
  it("ignores stale results and accepts only the latest revision", () => {
    const worker = new FakeWorker();
    const results: WaveSolutionGrid[] = [];
    const errors: Array<[number, string]> = [];
    const client = new WaveWorkerClient(
      {
        onResult: (result) => results.push(result),
        onError: (revision, message) => errors.push([revision, message])
      },
      () => worker as unknown as Worker
    );
    const problem = getWavePresetProblem();
    expect(client.solve(problem, { xSamples: 9, tSamples: 5 })).toBe(1);
    expect(client.solve(problem, { xSamples: 9, tSamples: 5 })).toBe(2);
    worker.emit({
      type: "result",
      result: solveWaveProblem(problem, {
        revision: 1,
        xSamples: 9,
        tSamples: 5
      })
    });
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
    const latest = solveWaveProblem(problem, {
      revision: 2,
      xSamples: 9,
      tSamples: 5
    });
    worker.emit({ type: "result", result: latest });
    expect(results).toEqual([latest]);
    expect(errors).toHaveLength(0);
  });

  it("terminates a worker that returns malformed current data", () => {
    const worker = new FakeWorker();
    const errors: Array<[number, string]> = [];
    const client = new WaveWorkerClient(
      {
        onResult: () => undefined,
        onError: (revision, message) => errors.push([revision, message])
      },
      () => worker as unknown as Worker
    );
    const problem = getWavePresetProblem();
    client.solve(problem, { xSamples: 9, tSamples: 5 });
    const valid = solveWaveProblem(problem, {
      revision: 1,
      xSamples: 9,
      tSamples: 5
    });
    const malformed = { ...valid, values: new Float64Array(valid.values) };
    worker.emit({ type: "result", result: malformed });
    expect(worker.terminated).toBe(true);
    expect(errors[0]?.[0]).toBe(1);
    expect(errors[0]?.[1]).toMatch(/malformed/);
  });

  it("reports invalid sample counts without starting a worker", () => {
    const worker = new FakeWorker();
    const errors: Array<[number, string]> = [];
    const client = new WaveWorkerClient(
      {
        onResult: () => undefined,
        onError: (revision, message) => errors.push([revision, message])
      },
      () => worker as unknown as Worker
    );
    client.solve(getWavePresetProblem(), { xSamples: 1 });
    expect(worker.requests).toHaveLength(0);
    expect(errors[0]?.[1]).toMatch(/xSamples/);
  });
});
