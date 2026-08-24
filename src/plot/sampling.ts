import type { WaveSolutionGrid } from "../types";
import { clamp } from "./svg";

export interface GridBracket {
  lower: number;
  upper: number;
  fraction: number;
}

export interface NormalizedSurfaceRange {
  min: number;
  max: number;
}

export function validateSolutionGrid(grid: WaveSolutionGrid): void {
  if (grid.x.length < 2 || grid.t.length < 1) {
    throw new Error("A wave solution grid needs at least two x samples and one time sample.");
  }
  if (grid.values.length < grid.x.length * grid.t.length) {
    throw new Error("The wave solution values do not cover every (x, t) sample.");
  }
  const expectedValueCount = grid.x.length * grid.t.length;
  for (let index = 0; index < expectedValueCount; index += 1) {
    if (!Number.isFinite(Number(grid.values[index]))) {
      throw new Error("The wave solution contains a non-finite value.");
    }
  }
  assertStrictlyIncreasing(grid.x, "x");
  if (grid.t.length > 1) {
    assertStrictlyIncreasing(grid.t, "t");
  }
}

function assertStrictlyIncreasing(values: ArrayLike<number>, label: string): void {
  let previous = Number(values[0]);
  if (!Number.isFinite(previous)) {
    throw new Error(`The ${label} grid contains a non-finite sample.`);
  }
  for (let index = 1; index < values.length; index += 1) {
    const current = Number(values[index]);
    if (!Number.isFinite(current) || current <= previous) {
      throw new Error(`The ${label} grid must be finite and strictly increasing.`);
    }
    previous = current;
  }
}

export function normalizedSurfaceRange(grid: WaveSolutionGrid): NormalizedSurfaceRange {
  let minimum = Number(grid.surfaceRange.min);
  let maximum = Number(grid.surfaceRange.max);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
    minimum = Number.POSITIVE_INFINITY;
    maximum = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < grid.values.length; index += 1) {
      const value = Number(grid.values[index]);
      if (Number.isFinite(value)) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    return { min: -1, max: 1 };
  }
  minimum = Math.min(minimum, 0);
  maximum = Math.max(maximum, 0);
  if (maximum - minimum < 1e-9) {
    const pad = Math.max(1, Math.abs(maximum)) * 0.1;
    return { min: minimum - pad, max: maximum + pad };
  }
  return { min: minimum, max: maximum };
}

/** Locate value in a sorted grid, clamping beyond either endpoint. */
export function bracket(values: ArrayLike<number>, value: number): GridBracket {
  const last = values.length - 1;
  if (last <= 0 || value <= Number(values[0])) {
    return { lower: 0, upper: 0, fraction: 0 };
  }
  if (value >= Number(values[last])) {
    return { lower: last, upper: last, fraction: 0 };
  }

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (Number(values[middle]) <= value) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const lowerValue = Number(values[low]);
  const upperValue = Number(values[high]);
  return {
    lower: low,
    upper: high,
    fraction: clamp((value - lowerValue) / (upperValue - lowerValue), 0, 1)
  };
}

export function clampGridTime(grid: WaveSolutionGrid, time: number): number {
  const minimum = Number(grid.t[0]);
  const maximum = Number(grid.t[grid.t.length - 1]);
  return clamp(Number.isFinite(time) ? time : minimum, minimum, maximum);
}

export function sampleSlice(grid: WaveSolutionGrid, time: number): Float32Array {
  const xCount = grid.x.length;
  const result = new Float32Array(xCount);
  const timeBracket = bracket(grid.t, clampGridTime(grid, time));
  const lowerOffset = timeBracket.lower * xCount;
  const upperOffset = timeBracket.upper * xCount;
  const mix = timeBracket.fraction;
  for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
    const lower = finiteValue(grid.values[lowerOffset + xIndex]);
    const upper = finiteValue(grid.values[upperOffset + xIndex], lower);
    result[xIndex] = lower + (upper - lower) * mix;
  }
  return result;
}

export function sampleSolutionGrid(
  grid: WaveSolutionGrid,
  x: number,
  time: number
): number {
  const xBracket = bracket(grid.x, x);
  const timeBracket = bracket(grid.t, time);
  const xCount = grid.x.length;
  const lowerLeft = finiteValue(grid.values[timeBracket.lower * xCount + xBracket.lower]);
  const lowerRight = finiteValue(
    grid.values[timeBracket.lower * xCount + xBracket.upper],
    lowerLeft
  );
  const upperLeft = finiteValue(
    grid.values[timeBracket.upper * xCount + xBracket.lower],
    lowerLeft
  );
  const upperRight = finiteValue(
    grid.values[timeBracket.upper * xCount + xBracket.upper],
    upperLeft
  );
  const lower = lowerLeft + (lowerRight - lowerLeft) * xBracket.fraction;
  const upper = upperLeft + (upperRight - upperLeft) * xBracket.fraction;
  return lower + (upper - lower) * timeBracket.fraction;
}

export function nearestGridIndex(values: ArrayLike<number>, value: number): number {
  const location = bracket(values, value);
  if (location.lower === location.upper) {
    return location.lower;
  }
  return location.fraction < 0.5 ? location.lower : location.upper;
}

function finiteValue(value: number | undefined, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
