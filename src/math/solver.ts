import type {
  BoundaryCondition,
  SolveWaveOptions,
  SpatialDomain,
  SurfaceRange,
  WaveProblem,
  WaveSolutionGrid
} from "../types";
import { compileExpression } from "./expression";
import { expressionIntegrationBreakpoints, expressionIsZero } from "./features";
import {
  compilePiecewise,
  domainBounds,
  MAX_REFLECTIONS,
  revalidateWaveProblem
} from "./problem";
import {
  integrateFunction,
  PiecewiseAntiderivative
} from "./quadrature";
import { samplingResolutionNotices } from "./resolution";

export const DEFAULT_X_SAMPLES = 513;
export const DEFAULT_T_SAMPLES = 161;
export const MIN_GRID_SAMPLES = 2;
export const MAX_X_SAMPLES = 2_049;
export const MAX_T_SAMPLES = 1_001;

export interface WaveEvaluatorStats {
  maxReflections: number;
  integrationMs: number;
}

export interface WaveEvaluator {
  evaluate: (x: number, t: number) => number;
  /** Right-moving d'Alembert component. */
  F: (coordinate: number) => number;
  /** Left-moving d'Alembert component. */
  G: (coordinate: number) => number;
  /** Precompute all antiderivative values needed by a rectangular surface. */
  prepareSurface: (x: Float64Array, t: Float64Array) => void;
  readonly stats: WaveEvaluatorStats;
}

interface BoundaryRuntime {
  condition: BoundaryCondition;
  value: (time: number) => number;
  integral: CachedAntiderivative | null;
}

interface ReflectionStep {
  side: "left" | "right";
  time: number;
}

interface DependencyPath {
  component: "F" | "G";
  coordinate: number;
  steps: ReflectionStep[];
}

class CachedAntiderivative {
  private readonly cache = new Map<number, number>([[0, 0]]);
  private preparedCoordinates: number[] = [];
  private preparedValues = new Float64Array(0);
  elapsedMs = 0;

  constructor(
    private readonly evaluate: (value: number) => number,
    readonly identicallyZero = false,
    private readonly breakpoints: readonly number[] = []
  ) {}

  precompute(coordinates: Iterable<number>): void {
    if (this.identicallyZero) return;
    const ordered = [0];
    for (const coordinate of coordinates) {
      if (!Number.isFinite(coordinate)) {
        throw new Error("Boundary antiderivative coordinates must be finite.");
      }
      ordered.push(coordinate);
    }
    ordered.sort((left, right) => left - right);
    const unique = ordered.filter(
      (value, index) => index === 0 || value !== ordered[index - 1]
    );
    this.preparedCoordinates = unique;
    const anchorIndex = unique.indexOf(0);
    const values = new Float64Array(unique.length);
    const started = now();
    for (let index = anchorIndex + 1; index < unique.length; index += 1) {
      values[index] =
        (values[index - 1] as number) +
        integrateFunction(
          this.evaluate,
          unique[index - 1] as number,
          unique[index] as number,
          { breakpoints: this.breakpoints }
        );
    }
    for (let index = anchorIndex - 1; index >= 0; index -= 1) {
      values[index] =
        (values[index + 1] as number) -
        integrateFunction(
          this.evaluate,
          unique[index] as number,
          unique[index + 1] as number,
          { breakpoints: this.breakpoints }
        );
    }
    this.elapsedMs += now() - started;
    this.preparedValues = values;
    this.cache.clear();
    this.cache.set(0, 0);
  }

  at(value: number): number {
    const cached = this.cache.get(value);
    if (cached !== undefined) return cached;
    if (this.identicallyZero) return 0;
    const nearby = nearestCoordinateIndex(this.preparedCoordinates, value);
    const baseCoordinate = nearby === undefined ? 0 : this.preparedCoordinates[nearby] as number;
    const baseValue = nearby === undefined ? 0 : this.preparedValues[nearby] as number;
    if (baseCoordinate === value) return baseValue;
    const started = now();
    const result =
      baseValue + integrateFunction(this.evaluate, baseCoordinate, value, { breakpoints: this.breakpoints });
    this.elapsedMs += now() - started;
    if (this.cache.size >= 4096) this.cache.delete(this.cache.keys().next().value as number);
    this.cache.set(value, result);
    return result;
  }
}

/**
 * Build a d'Alembert evaluator. F and G are extended from the initial interval
 * by exact Dirichlet/Neumann reflection identities; no time stepping is used.
 */
export function createWaveEvaluator(problem: WaveProblem): WaveEvaluator {
  const accepted = revalidateWaveProblem(problem);
  const f = compilePiecewise(accepted.f);
  const anchor = antiderivativeAnchor(accepted.domain);
  const velocityIntegral = new PiecewiseAntiderivative(accepted.g, anchor);
  const leftBoundary = accepted.boundaries.left
    ? compileBoundary(accepted.boundaries.left)
    : null;
  const rightBoundary = accepted.boundaries.right
    ? compileBoundary(accepted.boundaries.right)
    : null;
  const bounds = domainBounds(accepted.domain);
  const localScale = Number.isFinite(bounds.lower) && Number.isFinite(bounds.upper)
    ? bounds.upper - bounds.lower
    : accepted.view.xMax - accepted.view.xMin;
  // Translation changes rounding precision, not the physical size of a region
  // that may bypass a boundary. Use a few ULPs rather than 1e-11 of the origin.
  const coordinateTolerance = Math.max(
    32 * Number.EPSILON * localScale,
    4 * Number.EPSILON * Math.max(
      localScale,
      Number.isFinite(bounds.lower) ? Math.abs(bounds.lower) : 0,
      Number.isFinite(bounds.upper) ? Math.abs(bounds.upper) : 0
    )
  );
  let maxReflections = 0;

  const baseF = (coordinate: number): number =>
    0.5 * f(coordinate) -
    velocityIntegral.at(coordinate) / (2 * accepted.c);
  const baseG = (coordinate: number): number =>
    0.5 * f(coordinate) +
    velocityIntegral.at(coordinate) / (2 * accepted.c);

  let leftComponents: { F: number; G: number } | null = null;
  let rightComponents: { F: number; G: number } | null = null;
  const boundaryComponents = (
    side: "left" | "right"
  ): { F: number; G: number } => {
    if (side === "left") {
      if (!Number.isFinite(bounds.lower)) {
        throw new Error("The problem has no finite left boundary.");
      }
      leftComponents ??= { F: baseF(bounds.lower), G: baseG(bounds.lower) };
      return leftComponents;
    }
    if (!Number.isFinite(bounds.upper)) {
      throw new Error("The problem has no finite right boundary.");
    }
    rightComponents ??= { F: baseF(bounds.upper), G: baseG(bounds.upper) };
    return rightComponents;
  };

  const dependencyPath = (
    initialComponent: "F" | "G",
    initialCoordinate: number
  ): DependencyPath => {
    let component = initialComponent;
    let coordinate = initialCoordinate;
    const steps: ReflectionStep[] = [];
    while (
      !isBaseCoordinate(
        coordinate,
        accepted.domain,
        component,
        coordinateTolerance
      )
    ) {
      if (
        component === "F" &&
        Number.isFinite(bounds.lower) &&
        coordinate < bounds.lower - coordinateTolerance
      ) {
        if (!leftBoundary) {
          throw new Error(
            "A dependency path reached a domain with no left boundary."
          );
        }
        steps.push({
          side: "left",
          time: nonnegativeTime(
            (bounds.lower - coordinate) / accepted.c,
            coordinateTolerance
          )
        });
        coordinate = 2 * bounds.lower - coordinate;
        component = "G";
      } else if (
        component === "G" &&
        Number.isFinite(bounds.upper) &&
        coordinate > bounds.upper + coordinateTolerance
      ) {
        if (!rightBoundary) {
          throw new Error(
            "A dependency path reached a domain with no right boundary."
          );
        }
        steps.push({
          side: "right",
          time: nonnegativeTime(
            (coordinate - bounds.upper) / accepted.c,
            coordinateTolerance
          )
        });
        coordinate = 2 * bounds.upper - coordinate;
        component = "F";
      } else {
        throw new Error(
          `An invalid ${component} characteristic coordinate was requested.`
        );
      }
      if (steps.length > MAX_REFLECTIONS) {
        throw new Error(
          `A dependency path exceeded the ${MAX_REFLECTIONS}-reflection limit.`
        );
      }
    }
    maxReflections = Math.max(maxReflections, steps.length);
    return {
      component,
      coordinate: clampToFiniteBoundary(
        coordinate,
        bounds,
        coordinateTolerance
      ),
      steps
    };
  };

  const evaluateDependency = (
    component: "F" | "G",
    coordinate: number
  ): number => {
    const path = dependencyPath(component, coordinate);
    let offset = 0;
    let multiplier = 1;
    for (const step of path.steps) {
      const boundary = step.side === "left" ? leftBoundary : rightBoundary;
      if (!boundary) throw new Error(`Missing ${step.side} boundary data.`);
      if (boundary.condition.kind === "dirichlet") {
        offset += multiplier * boundaryValue(boundary, step.time);
        multiplier *= -1;
      } else {
        const components = boundaryComponents(step.side);
        const correction =
          step.side === "left"
            ? components.F -
              components.G -
              accepted.c * boundaryIntegral(boundary, step.time)
            : components.G -
              components.F +
              accepted.c * boundaryIntegral(boundary, step.time);
        offset += multiplier * correction;
      }
    }
    const base =
      path.component === "F"
        ? baseF(path.coordinate)
        : baseG(path.coordinate);
    return offset + multiplier * base;
  };

  const prepareSurface = (x: Float64Array, t: Float64Array): void => {
    if (
      accepted.g.pieces.every((piece) => expressionIsZero(piece.ast)) &&
      (!leftBoundary?.integral || leftBoundary.integral.identicallyZero) &&
      (!rightBoundary?.integral || rightBoundary.integral.identicallyZero)
    ) return;
    const baseCoordinates = new Set<number>();
    const leftTimes = new Set<number>();
    const rightTimes = new Set<number>();
    for (const time of t) {
      for (const position of x) {
        for (const [component, coordinate] of [
          ["F", position - accepted.c * time],
          ["G", position + accepted.c * time]
        ] as const) {
          const path = dependencyPath(component, coordinate);
          baseCoordinates.add(path.coordinate);
          for (const step of path.steps) {
            if (step.side === "left" && leftBoundary?.integral) {
              leftTimes.add(step.time);
            } else if (step.side === "right" && rightBoundary?.integral) {
              rightTimes.add(step.time);
            }
          }
        }
      }
    }
    velocityIntegral.precompute(baseCoordinates);
    leftBoundary?.integral?.precompute(leftTimes);
    rightBoundary?.integral?.precompute(rightTimes);
  };

  const evaluateF = (coordinate: number): number =>
    evaluateDependency("F", coordinate);
  const evaluateG = (coordinate: number): number =>
    evaluateDependency("G", coordinate);

  const evaluate = (x: number, t: number): number => {
    assertEvaluationPoint(accepted, x, t, coordinateTolerance);
    let result =
      evaluateF(x - accepted.c * t) + evaluateG(x + accepted.c * t);
    // Exact endpoint data avoid cancellation in characteristic coordinates at
    // large translated origins. Paths above still establish reflection stats.
    if (x === bounds.lower && leftBoundary?.condition.kind === "dirichlet") {
      result = boundaryValue(leftBoundary, t);
    } else if (x === bounds.upper && rightBoundary?.condition.kind === "dirichlet") {
      result = boundaryValue(rightBoundary, t);
    }
    if (!Number.isFinite(result)) {
      throw new Error(`The wave solution is not finite at (x,t)=(${x},${t}).`);
    }
    return result;
  };

  const stats: WaveEvaluatorStats = {
    get maxReflections(): number {
      return maxReflections;
    },
    get integrationMs(): number {
      return (
        velocityIntegral.elapsedMs +
        (leftBoundary?.integral?.elapsedMs ?? 0) +
        (rightBoundary?.integral?.elapsedMs ?? 0)
      );
    }
  };

  return {
    evaluate,
    F: evaluateF,
    G: evaluateG,
    prepareSurface,
    stats
  };
}

export function solveWaveProblem(
  problem: WaveProblem,
  options: SolveWaveOptions = {}
): WaveSolutionGrid {
  const started = now();
  const accepted = revalidateWaveProblem(problem);
  const revision = options.revision ?? 0;
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("revision must be a nonnegative integer.");
  }
  const xSamples = validateSampleCount(
    options.xSamples ?? DEFAULT_X_SAMPLES,
    "xSamples",
    MAX_X_SAMPLES
  );
  const tSamples = validateSampleCount(
    options.tSamples ?? DEFAULT_T_SAMPLES,
    "tSamples",
    MAX_T_SAMPLES
  );
  const x = linspace(accepted.view.xMin, accepted.view.xMax, xSamples);
  const t = linspace(0, accepted.T, tSamples);
  const values = new Float32Array(xSamples * tSamples);
  const evaluator = createWaveEvaluator(accepted);
  evaluator.prepareSurface(x, t);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let hasRepresentedValue = false;
  let hasNonzeroValue = false;

  for (let timeIndex = 0; timeIndex < tSamples; timeIndex += 1) {
    const time = t[timeIndex] as number;
    const offset = timeIndex * xSamples;
    for (let xIndex = 0; xIndex < xSamples; xIndex += 1) {
      const value = evaluator.evaluate(x[xIndex] as number, time);
      const represented = Math.fround(value);
      if (!Number.isFinite(represented)) {
        throw new Error("The solution exceeds the supported numeric range. Reduce the amplitude of the initial or boundary data.");
      }
      values[offset + xIndex] = represented;
      hasRepresentedValue ||= represented !== 0;
      hasNonzeroValue ||= value !== 0;
      minimum = Math.min(minimum, represented);
      maximum = Math.max(maximum, represented);
    }
  }

  if (hasNonzeroValue && !hasRepresentedValue) {
    throw new Error("The solution amplitude is below the supported numeric range. Increase the amplitude of the initial or boundary data.");
  }

  const totalMs = now() - started;
  const integrationMs = Math.min(totalMs, evaluator.stats.integrationMs);
  return {
    revision,
    problemSignature: accepted.signature,
    x,
    t,
    values,
    surfaceRange: niceSurfaceRange(minimum, maximum),
    warnings: [
      ...accepted.warnings.map((notice) => ({ ...notice })),
      ...samplingResolutionNotices(
        accepted,
        (accepted.view.xMax - accepted.view.xMin) / (xSamples - 1),
        accepted.T / (tSamples - 1)
      )
    ],
    timings: {
      totalMs,
      integrationMs,
      samplingMs: Math.max(0, totalMs - integrationMs)
    },
    reflectionCount: evaluator.stats.maxReflections
  };
}

export function sampleSolution(
  grid: WaveSolutionGrid,
  x: number,
  t: number
): number {
  if (!Number.isFinite(x) || !Number.isFinite(t)) {
    throw new Error("Solution sample coordinates must be finite.");
  }
  assertGridShape(grid);
  const xBracket = bracket(grid.x, x);
  const tBracket = bracket(grid.t, t);
  const width = grid.x.length;
  const v00 = grid.values[tBracket.lower * width + xBracket.lower] as number;
  const v10 = grid.values[tBracket.lower * width + xBracket.upper] as number;
  const v01 = grid.values[tBracket.upper * width + xBracket.lower] as number;
  const v11 = grid.values[tBracket.upper * width + xBracket.upper] as number;
  const lowerValue = mix(v00, v10, xBracket.fraction);
  const upperValue = mix(v01, v11, xBracket.fraction);
  return mix(lowerValue, upperValue, tBracket.fraction);
}

export function solutionRow(
  grid: WaveSolutionGrid,
  timeIndex: number
): Float32Array {
  assertGridShape(grid);
  if (!Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex >= grid.t.length) {
    throw new Error("timeIndex is outside the solution grid.");
  }
  const start = timeIndex * grid.x.length;
  return grid.values.subarray(start, start + grid.x.length);
}

function compileBoundary(condition: BoundaryCondition): BoundaryRuntime {
  const evaluate = compileExpression(condition.ast, "t");
  const checked = (time: number): number => {
    const result = evaluate(time);
    if (!Number.isFinite(result)) {
      throw new Error(`Boundary data are not finite at t=${time}.`);
    }
    return result;
  };
  return {
    condition,
    value: checked,
    integral:
      condition.kind === "neumann"
        ? new CachedAntiderivative(
          checked,
          expressionIsZero(condition.ast),
          expressionIntegrationBreakpoints(condition.ast)
        )
        : null
  };
}

function boundaryValue(boundary: BoundaryRuntime, time: number): number {
  return boundary.value(time);
}

function boundaryIntegral(boundary: BoundaryRuntime, time: number): number {
  if (!boundary.integral) {
    throw new Error("Only Neumann boundary data have an accumulated integral.");
  }
  return boundary.integral.at(time);
}

function isBaseCoordinate(
  coordinate: number,
  domain: SpatialDomain,
  _component: "F" | "G",
  tolerance: number
): boolean {
  switch (domain.kind) {
    case "infinite":
      return true;
    case "right-half-line":
      return coordinate >= domain.left - tolerance;
    case "left-half-line":
      return coordinate <= domain.right + tolerance;
    case "finite":
      return (
        coordinate >= domain.left - tolerance &&
        coordinate <= domain.right + tolerance
      );
  }
}

function clampToFiniteBoundary(
  coordinate: number,
  bounds: { lower: number; upper: number },
  tolerance: number
): number {
  if (
    Number.isFinite(bounds.lower) &&
    coordinate < bounds.lower &&
    coordinate >= bounds.lower - tolerance
  ) {
    return bounds.lower;
  }
  if (
    Number.isFinite(bounds.upper) &&
    coordinate > bounds.upper &&
    coordinate <= bounds.upper + tolerance
  ) {
    return bounds.upper;
  }
  return coordinate;
}

function assertEvaluationPoint(
  problem: WaveProblem,
  x: number,
  t: number,
  tolerance: number
): void {
  if (!Number.isFinite(x) || !Number.isFinite(t)) {
    throw new Error("Wave solution coordinates must be finite.");
  }
  const timeTolerance = 16 * Number.EPSILON * problem.T;
  if (t < -timeTolerance || t > problem.T + timeTolerance) {
    throw new Error(`t must lie between 0 and ${problem.T}.`);
  }
  const bounds = domainBounds(problem.domain);
  if (x < bounds.lower - tolerance || x > bounds.upper + tolerance) {
    throw new Error("x lies outside the physical domain.");
  }
}

function antiderivativeAnchor(domain: SpatialDomain): number {
  switch (domain.kind) {
    case "infinite":
      return 0;
    case "right-half-line":
      return domain.left;
    case "left-half-line":
      return domain.right;
    case "finite":
      return domain.left;
  }
}

function nonnegativeTime(value: number, tolerance: number): number {
  if (value >= 0) return value;
  if (value >= -tolerance) return 0;
  throw new Error("A reflected boundary time became negative.");
}

function validateSampleCount(
  value: number,
  name: string,
  maximum: number
): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_GRID_SAMPLES ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${MIN_GRID_SAMPLES} to ${maximum}.`
    );
  }
  return value;
}

function linspace(lower: number, upper: number, count: number): Float64Array {
  const result = new Float64Array(count);
  const span = upper - lower;
  for (let index = 0; index < count; index += 1) {
    const product = span * index;
    result[index] =
      index === count - 1 ? upper : lower + (Number.isFinite(product)
        ? product / (count - 1)
        : span * (index / (count - 1)));
  }
  return result;
}

/**
 * Choose outward solution bounds whose five axis ticks have a pleasant,
 * uniform spacing. Values that are negative only at floating-point noise
 * scale are treated as zero so nonnegative waves sit on a true u = 0 floor.
 */
export function niceSurfaceRange(
  minimum: number,
  maximum: number
): SurfaceRange {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new Error("The solution surface has no finite values.");
  }
  if (maximum < minimum) {
    throw new Error("The solution surface range is reversed.");
  }

  const scale = Math.max(Math.abs(minimum), Math.abs(maximum));
  if (scale === 0) {
    return { min: 0, max: 1 };
  }
  const zeroTolerance = scale * 1e-10;
  const hasNegative = minimum < -zeroTolerance;
  const hasPositive = maximum > zeroTolerance;

  if (!hasNegative && !hasPositive) {
    return { min: 0, max: 1 };
  }
  if (!hasNegative) {
    return { min: 0, max: fourTickCeiling(maximum) };
  }
  if (!hasPositive) {
    return { min: -fourTickCeiling(-minimum), max: 0 };
  }

  // Put zero on one of the three interior ticks. Trying each possible zero
  // position preserves asymmetric signed profiles without sacrificing four
  // equal, nicely rounded intervals.
  let best: SurfaceRange | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (let negativeIntervals = 1; negativeIntervals <= 3; negativeIntervals += 1) {
    const positiveIntervals = 4 - negativeIntervals;
    const requiredStep = Math.max(
      -minimum / negativeIntervals,
      maximum / positiveIntervals
    );
    const step = niceStepCeiling(requiredStep);
    const candidate = {
      min: -cleanAxisNumber(negativeIntervals * step, -minimum),
      max: cleanAxisNumber(positiveIntervals * step, maximum)
    };
    const span = candidate.max - candidate.min;
    if (
      candidate.min <= minimum &&
      candidate.max >= maximum &&
      span < bestSpan
    ) {
      best = candidate;
      bestSpan = span;
    }
  }
  return best ?? { min: minimum, max: maximum };
}

const NICE_STEP_MULTIPLIERS = [
  1,
  1.25,
  1.5,
  2,
  2.5,
  3,
  4,
  5,
  6,
  8,
  10
] as const;

function fourTickCeiling(value: number): number {
  const step = niceStepCeiling(value / 4);
  const ceiling = cleanAxisNumber(4 * step, value);
  return Number.isFinite(ceiling) && ceiling >= value ? ceiling : value;
}

function niceStepCeiling(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error("A pleasant axis step requires a positive finite value.");
  }
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return value;
  for (const multiplier of NICE_STEP_MULTIPLIERS) {
    const candidate = multiplier * magnitude;
    if (Number.isFinite(candidate) && candidate >= value) {
      return cleanAxisNumber(candidate, value);
    }
  }
  return value;
}

function cleanAxisNumber(value: number, lowerLimit: number): number {
  const cleaned = Number.parseFloat(value.toPrecision(14));
  return cleaned >= lowerLimit ? cleaned : value;
}

function assertGridShape(grid: WaveSolutionGrid): void {
  if (
    !(grid.x instanceof Float64Array) ||
    !(grid.t instanceof Float64Array) ||
    !(grid.values instanceof Float32Array) ||
    grid.x.length < 2 ||
    grid.t.length < 2 ||
    grid.values.length !== grid.x.length * grid.t.length
  ) {
    throw new Error("Malformed wave solution grid.");
  }
}

function bracket(
  values: Float64Array,
  input: number
): { lower: number; upper: number; fraction: number } {
  if (input <= (values[0] as number)) {
    return { lower: 0, upper: 0, fraction: 0 };
  }
  const last = values.length - 1;
  if (input >= (values[last] as number)) {
    return { lower: last, upper: last, fraction: 0 };
  }
  let lower = 0;
  let upper = last;
  while (upper - lower > 1) {
    const middle = (lower + upper) >>> 1;
    if ((values[middle] as number) <= input) lower = middle;
    else upper = middle;
  }
  const left = values[lower] as number;
  const right = values[upper] as number;
  return { lower, upper, fraction: (input - left) / (right - left) };
}

function mix(left: number, right: number, fraction: number): number {
  return left + (right - left) * fraction;
}

function nearestCoordinateIndex(
  coordinates: readonly number[],
  value: number
): number | undefined {
  if (coordinates.length === 0) return undefined;
  let lower = 0;
  let upper = coordinates.length - 1;
  while (upper - lower > 1) {
    const middle = (lower + upper) >>> 1;
    if ((coordinates[middle] as number) <= value) lower = middle;
    else upper = middle;
  }
  const lowerValue = coordinates[lower] as number;
  const upperValue = coordinates[upper] as number;
  return Math.abs(value - lowerValue) <= Math.abs(upperValue - value)
    ? lower
    : upper;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
