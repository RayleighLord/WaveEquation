import { describe, expect, it } from "vitest";
import { niceSurfaceRange, solveWaveProblem } from "../math/solver";
import { getWavePresetProblem } from "../math/presets";

describe("pleasant solution surface ranges", () => {
  it("uses zero as the exact floor for a nonnegative solution", () => {
    const grid = solveWaveProblem(getWavePresetProblem("gaussian-split"), {
      xSamples: 65,
      tSamples: 33
    });

    expect(grid.surfaceRange).toEqual({ min: 0, max: 1 });
    expect(Math.min(...grid.values)).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [0, 0, { min: 0, max: 1 }],
    [0.02, 0.97, { min: 0, max: 1 }],
    [0, 1.08, { min: 0, max: 1.2 }],
    [0, 1.4, { min: 0, max: 1.6 }],
    [-0.75, -0.02, { min: -0.8, max: 0 }],
    [-0.33, 1.08, { min: -0.4, max: 1.2 }]
  ] as const)(
    "rounds [%s, %s] outward to five attractive ticks",
    (minimum, maximum, expected) => {
      expect(niceSurfaceRange(minimum, maximum)).toEqual(expected);
    }
  );

  it("treats only scale-relative negative noise as zero", () => {
    expect(niceSurfaceRange(-1e-12, 1)).toEqual({ min: 0, max: 1 });

    const tinySigned = niceSurfaceRange(-1e-12, 1e-12);
    expect(tinySigned.min).toBeLessThanOrEqual(-1e-12);
    expect(tinySigned.max).toBeGreaterThanOrEqual(1e-12);
  });

  it("never clips genuine signed extrema", () => {
    for (const [minimum, maximum] of [
      [-3.7, -0.001],
      [-8.1, 0.2],
      [-0.01, 42.3],
      [-6.7e-5, 9.2e-4]
    ] as const) {
      const range = niceSurfaceRange(minimum, maximum);
      expect(range.min).toBeLessThanOrEqual(minimum);
      expect(range.max).toBeGreaterThanOrEqual(maximum);
      expect(range.max).toBeGreaterThan(range.min);
    }
  });
});
