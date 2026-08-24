/// <reference lib="webworker" />

import { solveWaveProblem } from "../math/solver";
import type { WaveWorkerRequest, WaveWorkerResponse } from "../types";

const workerScope: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<unknown>): void => {
  const request = event.data;
  if (!isRecord(request) || request.type !== "solve") {
    if (isRecord(request) && isRevision(request.revision)) {
      postError(request.revision, "The wave worker received a malformed request.");
      return;
    }
    throw new Error("The wave worker received a malformed request.");
  }
  if (!isRevision(request.revision)) {
    throw new Error("The wave worker received an invalid revision.");
  }

  try {
    const typedRequest = request as unknown as WaveWorkerRequest;
    const result = solveWaveProblem(typedRequest.problem, {
      revision: typedRequest.revision,
      ...(typedRequest.xSamples === undefined
        ? {}
        : { xSamples: typedRequest.xSamples }),
      ...(typedRequest.tSamples === undefined
        ? {}
        : { tSamples: typedRequest.tSamples })
    });
    const response: WaveWorkerResponse = { type: "result", result };
    workerScope.postMessage(response, [
      result.x.buffer,
      result.t.buffer,
      result.values.buffer
    ]);
  } catch (caught) {
    postError(
      request.revision,
      caught instanceof Error ? caught.message : "Wave solution failed."
    );
  }
};

function postError(revision: number, message: string): void {
  const response: WaveWorkerResponse = {
    type: "error",
    revision,
    message: message.slice(0, 4_096)
  };
  workerScope.postMessage(response);
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export {};
