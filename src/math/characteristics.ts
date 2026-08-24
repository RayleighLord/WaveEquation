import type {
  BoundaryHit,
  CharacteristicPoint,
  CharacteristicTrace,
  InitialFootpoint,
  WaveProblem,
  WaveSolutionGrid
} from "../types";
import {
  domainBoundary,
  MAX_REFLECTIONS,
  revalidateWaveProblem
} from "./problem";
import {
  createWaveEvaluator,
  sampleSolution,
  type WaveEvaluator
} from "./solver";

interface TraceAccumulator {
  points: CharacteristicPoint[];
  hits: BoundaryHit[];
  footpoint: InitialFootpoint;
}

/** Trace both complete backward characteristics, including every reflection. */
export function traceCharacteristics(
  problem: WaveProblem,
  grid: WaveSolutionGrid,
  x: number,
  t: number
): CharacteristicTrace {
  const accepted = revalidateWaveProblem(problem);
  assertCompatibleGrid(accepted, grid);
  if (!Number.isFinite(x) || !Number.isFinite(t)) {
    throw new Error("The selected characteristic point must be finite.");
  }
  const xMinimum = grid.x[0] as number;
  const xMaximum = grid.x[grid.x.length - 1] as number;
  const tMinimum = grid.t[0] as number;
  const tMaximum = grid.t[grid.t.length - 1] as number;
  const tolerance = 1e-10 * Math.max(1, Math.abs(xMinimum), Math.abs(xMaximum));
  if (x < xMinimum - tolerance || x > xMaximum + tolerance) {
    throw new Error("The selected x-coordinate lies outside the displayed surface.");
  }
  if (t < tMinimum - tolerance || t > tMaximum + tolerance) {
    throw new Error("The selected time lies outside the displayed surface.");
  }

  const selectedX = clamp(x, xMinimum, xMaximum);
  const selectedT = clamp(t, tMinimum, tMaximum);
  let evaluator: WaveEvaluator | null = null;
  const getEvaluator = (): WaveEvaluator => {
    evaluator ??= createWaveEvaluator(accepted);
    return evaluator;
  };
  const point: CharacteristicPoint = {
    x: selectedX,
    t: selectedT,
    u: sampleLiftedSolution(grid, getEvaluator, selectedX, selectedT)
  };
  const left = traceOnePath(
    accepted,
    grid,
    getEvaluator,
    point,
    -1,
    "left"
  );
  const right = traceOnePath(
    accepted,
    grid,
    getEvaluator,
    point,
    1,
    "right"
  );
  return {
    point,
    left: { direction: -1, points: left.points },
    right: { direction: 1, points: right.points },
    hits: [...left.hits, ...right.hits].sort((a, b) => b.t - a.t),
    footpoints: [left.footpoint, right.footpoint]
  };
}

function traceOnePath(
  problem: WaveProblem,
  grid: WaveSolutionGrid,
  getEvaluator: () => WaveEvaluator,
  start: CharacteristicPoint,
  initialDirection: -1 | 1,
  path: "left" | "right"
): TraceAccumulator {
  const points: CharacteristicPoint[] = [{ ...start }];
  const hits: BoundaryHit[] = [];
  let currentX = start.x;
  let currentT = start.t;
  let direction: -1 | 1 = initialDirection;
  let reflections = 0;
  const timeStep =
    ((grid.t[grid.t.length - 1] as number) - (grid.t[0] as number)) /
    (grid.t.length - 1);
  const epsilon = 1e-11 * Math.max(1, problem.T);

  while (currentT > epsilon) {
    const side = direction < 0 ? "left" : "right";
    const boundaryX = domainBoundary(problem.domain, side);
    if (boundaryX === undefined) {
      const targetX = currentX + direction * problem.c * currentT;
      appendLiftedSegment(
        points,
        grid,
        getEvaluator,
        currentX,
        currentT,
        targetX,
        0,
        timeStep
      );
      currentX = targetX;
      currentT = 0;
      break;
    }

    const distance =
      direction < 0 ? currentX - boundaryX : boundaryX - currentX;
    if (distance < -epsilon) {
      throw new Error("A characteristic escaped the physical domain.");
    }
    const travelTime = Math.max(0, distance / problem.c);
    if (travelTime > currentT + epsilon) {
      const targetX = currentX + direction * problem.c * currentT;
      appendLiftedSegment(
        points,
        grid,
        getEvaluator,
        currentX,
        currentT,
        targetX,
        0,
        timeStep
      );
      currentX = targetX;
      currentT = 0;
      break;
    }

    const hitTime = Math.max(0, currentT - travelTime);
    appendLiftedSegment(
      points,
      grid,
      getEvaluator,
      currentX,
      currentT,
      boundaryX,
      hitTime,
      timeStep
    );
    currentX = boundaryX;
    currentT = hitTime;
    const hitPoint = points[points.length - 1] as CharacteristicPoint;
    hits.push({
      ...hitPoint,
      side,
      path,
      index: points.length - 1
    });
    if (currentT <= epsilon) {
      currentT = 0;
      const finalPoint = points[points.length - 1] as CharacteristicPoint;
      finalPoint.t = 0;
      break;
    }
    reflections += 1;
    if (reflections > MAX_REFLECTIONS) {
      throw new Error(
        `A characteristic exceeded the ${MAX_REFLECTIONS}-reflection limit.`
      );
    }
    direction = direction === -1 ? 1 : -1;
  }

  if (currentT > 0) {
    currentX += direction * problem.c * currentT;
    currentT = 0;
    appendLiftedSegment(
      points,
      grid,
      getEvaluator,
      (points[points.length - 1] as CharacteristicPoint).x,
      (points[points.length - 1] as CharacteristicPoint).t,
      currentX,
      0,
      timeStep
    );
  }
  const last = points[points.length - 1] as CharacteristicPoint;
  const footpoint: InitialFootpoint = {
    x: last.x,
    t: 0,
    u: last.u,
    path
  };
  return { points, hits, footpoint };
}

function appendLiftedSegment(
  points: CharacteristicPoint[],
  grid: WaveSolutionGrid,
  getEvaluator: () => WaveEvaluator,
  fromX: number,
  fromT: number,
  toX: number,
  toT: number,
  gridTimeStep: number
): void {
  const duration = Math.abs(fromT - toT);
  const subdivisions = Math.max(
    1,
    Math.ceil(duration / Math.max(gridTimeStep, Number.EPSILON))
  );
  for (let index = 1; index <= subdivisions; index += 1) {
    const fraction = index / subdivisions;
    const x = mix(fromX, toX, fraction);
    const t = index === subdivisions ? toT : mix(fromT, toT, fraction);
    points.push({
      x,
      t,
      u: sampleLiftedSolution(grid, getEvaluator, x, t)
    });
  }
}

function sampleLiftedSolution(
  grid: WaveSolutionGrid,
  getEvaluator: () => WaveEvaluator,
  x: number,
  t: number
): number {
  const xMinimum = grid.x[0] as number;
  const xMaximum = grid.x[grid.x.length - 1] as number;
  const tMinimum = grid.t[0] as number;
  const tMaximum = grid.t[grid.t.length - 1] as number;
  if (
    x >= xMinimum &&
    x <= xMaximum &&
    t >= tMinimum &&
    t <= tMaximum
  ) {
    return sampleSolution(grid, x, t);
  }
  return getEvaluator().evaluate(x, t);
}

function assertCompatibleGrid(
  problem: WaveProblem,
  grid: WaveSolutionGrid
): void {
  if (grid.problemSignature !== problem.signature) {
    throw new Error("Characteristics require a grid for the accepted wave problem.");
  }
  if (
    !(grid.x instanceof Float64Array) ||
    !(grid.t instanceof Float64Array) ||
    !(grid.values instanceof Float32Array) ||
    grid.x.length < 2 ||
    grid.t.length < 2 ||
    grid.values.length !== grid.x.length * grid.t.length
  ) {
    throw new Error("Characteristics received a malformed solution grid.");
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function mix(left: number, right: number, fraction: number): number {
  return left + (right - left) * fraction;
}
