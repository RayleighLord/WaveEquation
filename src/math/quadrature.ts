import type {
  ExpressionPiece,
  PiecewiseExpression
} from "../types";
import { compileExpression } from "./expression";
import { expressionIntegrationBreakpoints, expressionIsZero } from "./features";

export interface QuadratureOptions {
  absoluteTolerance?: number;
  relativeTolerance?: number;
  maximumDepth?: number;
  /** Known feature locations; these partition the integral before refinement. */
  breakpoints?: readonly number[];
}

type QuadratureTolerances = Required<Omit<QuadratureOptions, "breakpoints">>;

interface CompiledPiece {
  piece: ExpressionPiece;
  evaluate: (x: number) => number;
  breakpoints: readonly number[];
}

const DEFAULT_ABSOLUTE_TOLERANCE = 1e-9;
const DEFAULT_RELATIVE_TOLERANCE = 1e-8;
const DEFAULT_MAXIMUM_DEPTH = 16;
const PRECOMPUTE_SINGLE_PANEL_MAX_WIDTH = 0.01;
const MAX_LAZY_CACHE_ENTRIES = 4096;

/** Cached, piece-aware numerical antiderivative used by the d'Alembert solver. */
export class PiecewiseAntiderivative {
  private readonly pieces: CompiledPiece[];
  private readonly cache = new Map<number, number>();
  private readonly options: QuadratureTolerances;
  private readonly identicallyZero: boolean;
  private preparedCoordinates = new Float64Array(0);
  private preparedValues = new Float64Array(0);
  private elapsed = 0;

  constructor(
    expression: PiecewiseExpression,
    readonly anchor: number,
    options: QuadratureOptions = {}
  ) {
    if (!Number.isFinite(anchor)) {
      throw new Error("The antiderivative anchor must be finite.");
    }
    this.pieces = expression.pieces.map((piece) => ({
      piece,
      evaluate: compileExpression(piece.ast, "x"),
      breakpoints: expressionIntegrationBreakpoints(piece.ast)
    }));
    this.options = {
      absoluteTolerance:
        options.absoluteTolerance ?? DEFAULT_ABSOLUTE_TOLERANCE,
      relativeTolerance:
        options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE,
      maximumDepth: options.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH
    };
    this.identicallyZero = expression.pieces.every((piece) =>
      expressionIsZero(piece.ast)
    );
    this.cache.set(anchor, 0);
  }

  /**
   * Compute a cumulative table across all requested coordinates. This turns a
   * surface solve into one ordered integration sweep instead of one complete
   * anchor-to-coordinate quadrature per grid value.
   */
  precompute(coordinates: Iterable<number>): void {
    if (this.identicallyZero) return;
    const ordered = [this.anchor];
    for (const coordinate of coordinates) {
      if (!Number.isFinite(coordinate)) {
        throw new Error("Antiderivative precomputation coordinates must be finite.");
      }
      ordered.push(coordinate);
    }
    ordered.sort((left, right) => left - right);
    const unique = ordered.filter(
      (value, index) => index === 0 || value !== ordered[index - 1]
    );
    this.preparedCoordinates = Float64Array.from(unique);
    this.cache.clear();
    this.cache.set(this.anchor, 0);
    const started = now();
    const anchorIndex = unique.indexOf(this.anchor);
    const values = new Float64Array(unique.length);
    for (let index = anchorIndex + 1; index < unique.length; index += 1) {
      const lower = unique[index - 1] as number;
      const upper = unique[index] as number;
      values[index] =
        (values[index - 1] as number) +
        integrateCompiledPiecewise(
          this.pieces,
          lower,
          upper,
          this.options,
          upper - lower <= PRECOMPUTE_SINGLE_PANEL_MAX_WIDTH ? 1 : 8
        );
    }
    for (let index = anchorIndex - 1; index >= 0; index -= 1) {
      const lower = unique[index] as number;
      const upper = unique[index + 1] as number;
      values[index] =
        (values[index + 1] as number) -
        integrateCompiledPiecewise(
          this.pieces,
          lower,
          upper,
          this.options,
          upper - lower <= PRECOMPUTE_SINGLE_PANEL_MAX_WIDTH ? 1 : 8
        );
    }
    this.preparedValues = values;
    this.elapsed += now() - started;
  }

  at(x: number): number {
    if (!Number.isFinite(x)) {
      throw new Error("The antiderivative can only be sampled at finite x.");
    }
    const cached = this.cache.get(x);
    if (cached !== undefined) return cached;
    if (this.identicallyZero) {
      return 0;
    }
    const prepared = preparedCoordinateIndex(this.preparedCoordinates, x);
    if (prepared.exact) {
      return this.preparedValues[prepared.index] as number;
    }
    const started = now();
    const baseCoordinate = prepared.index < 0
      ? this.anchor
      : this.preparedCoordinates[prepared.index] as number;
    const baseValue = prepared.index < 0
      ? 0
      : this.preparedValues[prepared.index] as number;
    const value = baseValue + integrateCompiledPiecewise(
      this.pieces,
      baseCoordinate,
      x,
      this.options
    );
    this.elapsed += now() - started;
    if (this.cache.size >= MAX_LAZY_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value as number);
    }
    this.cache.set(x, value);
    return value;
  }

  integral(from: number, to: number): number {
    return this.at(to) - this.at(from);
  }

  get elapsedMs(): number {
    return this.elapsed;
  }
}

function preparedCoordinateIndex(
  coordinates: Float64Array,
  value: number
): { exact: boolean; index: number } {
  if (coordinates.length === 0) return { exact: false, index: -1 };
  let lower = 0;
  let upper = coordinates.length - 1;
  while (upper - lower > 1) {
    const middle = (lower + upper) >>> 1;
    if ((coordinates[middle] as number) <= value) lower = middle;
    else upper = middle;
  }
  if (coordinates[lower] === value) return { exact: true, index: lower };
  if (coordinates[upper] === value) return { exact: true, index: upper };
  const nearest = Math.abs(value - (coordinates[lower] as number)) <=
    Math.abs((coordinates[upper] as number) - value)
    ? lower
    : upper;
  return { exact: false, index: nearest };
}

export function integratePiecewise(
  expression: PiecewiseExpression,
  from: number,
  to: number,
  options: QuadratureOptions = {}
): number {
  const compiled = expression.pieces.map((piece) => ({
    piece,
    evaluate: compileExpression(piece.ast, "x"),
    breakpoints: expressionIntegrationBreakpoints(piece.ast)
  }));
  return integrateCompiledPiecewise(compiled, from, to, {
    absoluteTolerance:
      options.absoluteTolerance ?? DEFAULT_ABSOLUTE_TOLERANCE,
    relativeTolerance: options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE,
    maximumDepth: options.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH
  });
}

/** Refinement-checked quadrature for a single finite interval. */
export function integrateFunction(
  evaluate: (value: number) => number,
  from: number,
  to: number,
  options: QuadratureOptions = {}
): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error("Quadrature endpoints must be finite.");
  }
  if (from === to) return 0;
  const direction = from < to ? 1 : -1;
  const lower = Math.min(from, to);
  const upper = Math.max(from, to);
  const checked = (value: number): number => {
    const result = evaluate(value);
    if (!Number.isFinite(result)) {
      throw new Error(`Quadrature integrand is not finite at ${value}.`);
    }
    return result;
  };
  return direction * integratePartitioned(checked, lower, upper, {
    absoluteTolerance:
      options.absoluteTolerance ?? DEFAULT_ABSOLUTE_TOLERANCE,
    relativeTolerance: options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE,
    maximumDepth: options.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH
  }, options.breakpoints ?? []);
}

function integrateCompiledPiecewise(
  pieces: readonly CompiledPiece[],
  from: number,
  to: number,
  options: QuadratureTolerances,
  initialPanelCount = 8
): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error("Quadrature endpoints must be finite.");
  }
  if (from === to) return 0;
  const direction = from < to ? 1 : -1;
  const lower = Math.min(from, to);
  const upper = Math.max(from, to);
  let total = 0;
  for (const compiled of pieces) {
    const segmentLower = Math.max(lower, compiled.piece.lower);
    const segmentUpper = Math.min(upper, compiled.piece.upper);
    if (!(segmentLower < segmentUpper)) continue;
    total += integratePartitioned(
      checkedEvaluator(compiled),
      segmentLower,
      segmentUpper,
      options,
      compiled.breakpoints,
      initialPanelCount
    );
  }
  return direction * total;
}

function integratePartitioned(
  evaluate: (x: number) => number,
  lower: number,
  upper: number,
  options: QuadratureTolerances,
  breakpoints: readonly number[],
  initialPanelCount = 8
): number {
  let from = lower;
  let total = 0;
  for (const point of breakpoints) {
    if (point <= from || point >= upper) continue;
    total += integrateFiniteSegment(interiorEvaluator(evaluate, from, point), from, point, options, initialPanelCount);
    from = point;
  }
  return total + integrateFiniteSegment(interiorEvaluator(evaluate, from, upper), from, upper, options, initialPanelCount);
}

/** The value assigned at an isolated jump must not change its integral. */
function interiorEvaluator(evaluate: (x: number) => number, lower: number, upper: number): (x: number) => number {
  const inset = Math.min((upper - lower) / 4,
    4 * Number.EPSILON * Math.max(Math.abs(lower), Math.abs(upper)));
  return (x) => evaluate(x === lower ? lower + inset : x === upper ? upper - inset : x);
}

function checkedEvaluator(compiled: CompiledPiece): (x: number) => number {
  return (x: number): number => {
    const value = compiled.evaluate(x);
    if (!Number.isFinite(value)) {
      throw new Error(
        `Quadrature for piece "${compiled.piece.id}" is not finite at x=${x}.`
      );
    }
    return value;
  };
}

function integrateFiniteSegment(
  evaluate: (x: number) => number,
  lower: number,
  upper: number,
  options: QuadratureTolerances,
  initialPanelCount = 8
): number {
  if (initialPanelCount === 1) {
    const middle = (lower + upper) / 2;
    const leftValue = evaluate(lower);
    const middleValue = evaluate(middle);
    const rightValue = evaluate(upper);
    const refined = simpson(
      lower,
      upper,
      leftValue,
      middleValue,
      rightValue
    );
    const coarse = ((upper - lower) / 2) * (leftValue + rightValue);
    const tolerance = options.absoluteTolerance +
      options.relativeTolerance * Math.abs(refined);
    // Independent noncoincident probes prevent a sinusoid sampled at its zeros
    // from appearing flat to both the trapezoid and Simpson rules.
    const independent = gaussThree(evaluate, lower, upper, middleValue);
    if (Math.max(Math.abs(refined - coarse) / 3, Math.abs(refined - independent)) <= tolerance) return refined;
    return adaptiveSimpson(
      evaluate,
      lower,
      upper,
      leftValue,
      middleValue,
      rightValue,
      refined,
      options.absoluteTolerance,
      options.relativeTolerance,
      options.maximumDepth,
      independent
    );
  }
  // Starting with eight panels avoids accepting a coincidentally flat first
  // Simpson panel for common oscillatory inputs. Every panel is then refined.
  const panelCount = initialPanelCount;
  const width = (upper - lower) / panelCount;
  let result = 0;
  for (let panel = 0; panel < panelCount; panel += 1) {
    const left = lower + panel * width;
    const right = panel === panelCount - 1 ? upper : left + width;
    const middle = (left + right) / 2;
    const leftValue = evaluate(left);
    const middleValue = evaluate(middle);
    const rightValue = evaluate(right);
    const whole = simpson(left, right, leftValue, middleValue, rightValue);
    result += adaptiveSimpson(
      evaluate,
      left,
      right,
      leftValue,
      middleValue,
      rightValue,
      whole,
      options.absoluteTolerance / panelCount,
      options.relativeTolerance,
      options.maximumDepth,
      gaussThree(evaluate, left, right, middleValue)
    );
  }
  return result;
}

function adaptiveSimpson(
  evaluate: (x: number) => number,
  left: number,
  right: number,
  leftValue: number,
  middleValue: number,
  rightValue: number,
  whole: number,
  absoluteTolerance: number,
  relativeTolerance: number,
  depth: number,
  independent?: number
): number {
  const middle = (left + right) / 2;
  const leftMiddle = (left + middle) / 2;
  const rightMiddle = (middle + right) / 2;
  const leftMiddleValue = evaluate(leftMiddle);
  const rightMiddleValue = evaluate(rightMiddle);
  const leftIntegral = simpson(
    left,
    middle,
    leftValue,
    leftMiddleValue,
    middleValue
  );
  const rightIntegral = simpson(
    middle,
    right,
    middleValue,
    rightMiddleValue,
    rightValue
  );
  const refined = leftIntegral + rightIntegral;
  const errorEstimate = Math.abs(refined - whole) / 15;
  const tolerance = absoluteTolerance + relativeTolerance * Math.abs(refined);
  if (errorEstimate <= tolerance &&
      (independent === undefined || Math.abs(refined - independent) <= tolerance)) {
    return refined + (refined - whole) / 15;
  }
  if (depth <= 0) {
    throw new Error(
      "Quadrature did not converge; split the expression into smaller pieces."
    );
  }
  return (
    adaptiveSimpson(
      evaluate,
      left,
      middle,
      leftValue,
      leftMiddleValue,
      middleValue,
      leftIntegral,
      absoluteTolerance / 2,
      relativeTolerance,
      depth - 1
    ) +
    adaptiveSimpson(
      evaluate,
      middle,
      right,
      middleValue,
      rightMiddleValue,
      rightValue,
      rightIntegral,
      absoluteTolerance / 2,
      relativeTolerance,
      depth - 1
    )
  );
}

function gaussThree(
  evaluate: (x: number) => number,
  left: number,
  right: number,
  middleValue: number
): number {
  const half = (right - left) / 2;
  const middle = left + half;
  const offset = half * Math.sqrt(3 / 5);
  return half * ((5 / 9) * (evaluate(middle - offset) + evaluate(middle + offset)) +
    (8 / 9) * middleValue);
}

function simpson(
  left: number,
  right: number,
  leftValue: number,
  middleValue: number,
  rightValue: number
): number {
  return ((right - left) / 6) * (leftValue + 4 * middleValue + rightValue);
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
