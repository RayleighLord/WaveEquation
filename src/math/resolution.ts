import type { ProblemNotice, SpatialDomain, WaveProblem, WaveSolutionGrid } from "../types";
import { evaluateExpression } from "./expression";
import { expressionFeatures, expressionMayJump } from "./features";

/** The original smooth default resolved 12 spatial units with 256 intervals. */
export const REFERENCE_SPATIAL_SPACING = 12 / 256;
/** Keep a traveling feature near one retained spatial cell per time row. */
export const REFERENCE_TIME_SPACING = 0.05;
export const SURFACE_INTERVAL_QUANTUM = 8;
export const MIN_SMOOTH_SURFACE_X_INTERVALS = 256;
export const MAX_SURFACE_X_INTERVALS = 512;
export const MIN_SMOOTH_SURFACE_T_INTERVALS = 80;
export const MIN_CUT_SURFACE_X_INTERVALS = 512;
export const MIN_CUT_SURFACE_T_INTERVALS = 160;
export const MAX_SURFACE_T_INTERVALS = 400;
export const ACCEPTED_SPATIAL_OVERSAMPLE = 2;
export const ACCEPTED_TIME_OVERSAMPLE = 1;

export type ResolutionTopology = "smooth" | "stepped";

export interface AdaptiveSurfaceSampleCounts {
  xSamples: number;
  tSamples: number;
}

/**
 * Preserve physical surface spacing as view bounds and final time change.
 *
 * Smooth grids never become coarser than the original Gaussian view. Cut
 * grids additionally require enough temporal rows that a c=1 characteristic
 * moves by at most one rendered spatial cell per row, up to the geometry cap.
 * Intervals are rounded in stable groups of eight and counts remain odd.
 */
export function adaptiveSurfaceSampleCounts(
  finalTime: number,
  xMinimum: number,
  xMaximum: number,
  topology: ResolutionTopology
): AdaptiveSurfaceSampleCounts {
  const span = finitePositiveSpan(xMinimum, xMaximum);
  const time = Number.isFinite(finalTime) && finalTime > 0 ? finalTime : 0;
  const smoothXRequired = Math.ceil(span / REFERENCE_SPATIAL_SPACING);
  const xMinimumIntervals = topology === "stepped"
    ? MIN_CUT_SURFACE_X_INTERVALS
    : MIN_SMOOTH_SURFACE_X_INTERVALS;
  const xIntervals = quantizedIntervals(
    Math.max(xMinimumIntervals, smoothXRequired),
    xMinimumIntervals,
    MAX_SURFACE_X_INTERVALS
  );

  const smoothTRequired = Math.ceil(time / REFERENCE_TIME_SPACING);
  const characteristicRequired = topology === "stepped"
    ? Math.ceil((time * xIntervals) / span)
    : 0;
  const tMinimumIntervals = topology === "stepped"
    ? MIN_CUT_SURFACE_T_INTERVALS
    : MIN_SMOOTH_SURFACE_T_INTERVALS;
  const tIntervals = quantizedIntervals(
    Math.max(tMinimumIntervals, smoothTRequired, characteristicRequired),
    tMinimumIntervals,
    MAX_SURFACE_T_INTERVALS
  );
  return { xSamples: xIntervals + 1, tSamples: tIntervals + 1 };
}

/** Accepted grids are exact stride-two supersets of their surface plan. */
export function adaptiveAcceptedSampleCounts(
  problem: WaveProblem,
  discontinuityHint = waveProblemMayHaveDiscontinuousDisplacement(problem)
): AdaptiveSurfaceSampleCounts {
  const surface = adaptiveSurfaceSampleCounts(
    problem.T,
    problem.view.xMin,
    problem.view.xMax,
    discontinuityHint ? "stepped" : "smooth"
  );
  return {
    xSamples: (surface.xSamples - 1) * ACCEPTED_SPATIAL_OVERSAMPLE + 1,
    tSamples: (surface.tSamples - 1) * ACCEPTED_TIME_OVERSAMPLE + 1
  };
}

/** Conservative pre-solve hint: jumps in g do not make u itself discontinuous. */
export function waveProblemMayHaveDiscontinuousDisplacement(
  problem: WaveProblem
): boolean {
  const pieces = problem.f.pieces;
  if (pieces.some((piece) => expressionMayJump(piece.ast))) return true;
  if (Object.values(problem.boundaries).some((boundary) =>
    boundary?.kind === "dirichlet" && expressionMayJump(boundary.ast)
  )) return true;
  const bounds = physicalBounds(problem.domain);
  const candidates = new Set<number>();
  for (const piece of pieces) {
    if (Number.isFinite(piece.lower) && piece.lower > bounds.lower) {
      candidates.add(piece.lower);
    }
    if (Number.isFinite(piece.upper) && piece.upper < bounds.upper) {
      candidates.add(piece.upper);
    }
  }
  if (candidates.size === 0) return false;

  let scale = 0;
  for (let index = 0; index <= 64; index += 1) {
    const x = problem.view.xMin +
      ((problem.view.xMax - problem.view.xMin) * index) / 64;
    scale = Math.max(scale, Math.abs(evaluateInitialDisplacement(problem, x)));
  }
  const jumpTolerance = Math.max(1e-8, scale * 1e-4);
  for (const boundary of candidates) {
    const epsilon = Math.max(
      1,
      Math.abs(boundary),
      problem.view.xMax - problem.view.xMin
    ) * 1e-8;
    const left = evaluateInitialDisplacement(problem, boundary - epsilon);
    const right = evaluateInitialDisplacement(problem, boundary + epsilon);
    if (Math.abs(right - left) > jumpTolerance) return true;
  }
  return false;
}

/** Temporal differences never establish a spatial jump. */
export function hasSpatialJump(grid: WaveSolutionGrid): boolean {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let largestJump = 0;
  const width = grid.x.length;
  for (let index = 0; index < grid.values.length; index += 1) {
    const value = grid.values[index] as number;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    if (index % width !== 0) {
      largestJump = Math.max(largestJump, Math.abs(value - (grid.values[index - 1] as number)));
    }
  }
  const range = maximum - minimum;
  return range > 0 && largestJump >= 0.2 * range;
}

/** At most one actionable notice per data field, even for many pieces. */
export function samplingResolutionNotices(
  problem: WaveProblem,
  xSpacing: number,
  timeSpacing: number
): ProblemNotice[] {
  const warnings: ProblemNotice[] = [];
  for (const label of ["f", "g"] as const) {
    const unresolved = problem[label].pieces.some((piece) => expressionFeatures(piece.ast).some(
      (feature) => feature.width < 4 * xSpacing &&
        (feature.center === undefined ||
          (feature.center >= piece.lower && feature.center <= piece.upper &&
           feature.center >= problem.view.xMin - problem.c * problem.T &&
           feature.center <= problem.view.xMax + problem.c * problem.T))
    ));
    if (unresolved) warnings.push({
      code: "sampling-resolution",
      severity: "warning",
      message: `The initial ${label === "f" ? "displacement" : "velocity"} contains a feature that may be too narrow for the current grid. Reduce the visible range or describe its support with interval bounds.`,
      path: label
    });
  }
  for (const side of ["left", "right"] as const) {
    const boundary = problem.boundaries[side];
    if (boundary && expressionFeatures(boundary.ast).some((feature) =>
      feature.width < 4 * Math.max(timeSpacing, xSpacing / problem.c) &&
      (feature.center === undefined || (feature.center >= 0 && feature.center <= problem.T))
    )) warnings.push({
      code: "sampling-resolution",
      severity: "warning",
      message: `The ${side} boundary data contain a feature that may be too fast for the current grid. Reduce the final time or visible range.`,
      path: `boundaries.${side}.expression`
    });
  }
  if (timeSpacing > REFERENCE_TIME_SPACING * (1 + 1e-12) ||
      xSpacing * ACCEPTED_SPATIAL_OVERSAMPLE > REFERENCE_SPATIAL_SPACING * (1 + 1e-12)) {
    warnings.push({
      code: "sampling-resolution",
      severity: "warning",
      message: "The display resolution limit has been reached. Small or rapidly moving features may be missed; reduce the final time or visible range."
    });
  }
  return warnings;
}

function evaluateInitialDisplacement(problem: WaveProblem, x: number): number {
  const piece = problem.f.pieces.find(
    ({ lower, upper }) => x >= lower && x <= upper
  );
  return piece ? evaluateExpression(piece.ast, { x }) : 0;
}

function finitePositiveSpan(minimum: number, maximum: number): number {
  const span = maximum - minimum;
  return Number.isFinite(span) && span > 0 ? span : 1;
}

function quantizedIntervals(
  required: number,
  minimum: number,
  maximum: number
): number {
  const rounded = Math.ceil(required / SURFACE_INTERVAL_QUANTUM) *
    SURFACE_INTERVAL_QUANTUM;
  return Math.max(minimum, Math.min(maximum, rounded));
}

function physicalBounds(domain: SpatialDomain): { lower: number; upper: number } {
  if (domain.kind === "infinite") {
    return { lower: Number.NEGATIVE_INFINITY, upper: Number.POSITIVE_INFINITY };
  }
  if (domain.kind === "right-half-line") {
    return { lower: domain.left, upper: Number.POSITIVE_INFINITY };
  }
  if (domain.kind === "left-half-line") {
    return { lower: Number.NEGATIVE_INFINITY, upper: domain.right };
  }
  return { lower: domain.left, upper: domain.right };
}
