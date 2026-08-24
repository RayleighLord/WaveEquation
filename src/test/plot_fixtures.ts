import type { WaveSolutionGrid } from "../types";

export function makeGrid(): WaveSolutionGrid {
  return {
    revision: 7,
    problemSignature: "plot-fixture",
    x: new Float64Array([0, 1, 2]),
    t: new Float64Array([0, 1]),
    values: new Float32Array([
      0, 1, 0,
      1, 0, -1
    ]),
    surfaceRange: { min: -1, max: 1 },
    warnings: [],
    timings: { totalMs: 1, integrationMs: 0.25, samplingMs: 0.75 },
    reflectionCount: 0
  };
}
