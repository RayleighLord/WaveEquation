import { describe, expect, it } from "vitest";

import {
  bracket,
  normalizedSurfaceRange,
  sampleSlice,
  sampleSolutionGrid,
  validateSolutionGrid
} from "../plot";
import { makeGrid } from "./plot_fixtures";

describe("wave solution grid sampling", () => {
  it("brackets sorted samples and clamps beyond the endpoints", () => {
    const values = new Float64Array([0, 0.5, 2]);
    expect(bracket(values, -1)).toEqual({ lower: 0, upper: 0, fraction: 0 });
    expect(bracket(values, 0.25)).toEqual({ lower: 0, upper: 1, fraction: 0.5 });
    expect(bracket(values, 1.25)).toEqual({ lower: 1, upper: 2, fraction: 0.5 });
    expect(bracket(values, 4)).toEqual({ lower: 2, upper: 2, fraction: 0 });
  });

  it("interpolates row-major solution values in time and space", () => {
    const grid = makeGrid();
    expect([...sampleSlice(grid, 0.5)]).toEqual([0.5, 0.5, -0.5]);
    expect(sampleSolutionGrid(grid, 0.5, 0.5)).toBeCloseTo(0.5, 8);
    expect(sampleSolutionGrid(grid, 1.5, 0.5)).toBeCloseTo(0, 8);
    expect(sampleSolutionGrid(grid, -10, 10)).toBeCloseTo(1, 8);
  });

  it("keeps zero in a fixed surface range and rejects malformed grids", () => {
    const grid = makeGrid();
    grid.surfaceRange = { min: 2, max: 3 };
    expect(normalizedSurfaceRange(grid)).toEqual({ min: 0, max: 3 });

    const malformed = makeGrid();
    malformed.values = new Float32Array([0, 1]);
    expect(() => validateSolutionGrid(malformed)).toThrow(/do not cover every/);

    const unordered = makeGrid();
    unordered.x = new Float64Array([0, 2, 1]);
    expect(() => validateSolutionGrid(unordered)).toThrow(/strictly increasing/);

    const nonFinite = makeGrid();
    nonFinite.values[3] = Number.NaN;
    expect(() => validateSolutionGrid(nonFinite)).toThrow(/non-finite value/);
  });
});
