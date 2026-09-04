export type Operator = "+" | "-" | "*" | "/" | "^";

export type ExpressionVariable = "x" | "t";

/** Structured-clone-safe mathematical expression tree. */
export type ExpressionNode =
  | { type: "number"; value: number; lexeme: string }
  | { type: "variable"; name: ExpressionVariable }
  | { type: "constant"; name: "pi" | "e"; value: number }
  | { type: "unary"; operator: "+" | "-"; argument: ExpressionNode }
  | {
      type: "binary";
      operator: Operator;
      left: ExpressionNode;
      right: ExpressionNode;
    }
  | { type: "function"; name: string; arguments: ExpressionNode[] };

export interface ExpressionPieceDraft {
  id: string;
  expression: string;
  lower: string | number;
  upper: string | number;
}

export interface ExpressionPiece {
  id: string;
  expression: string;
  ast: ExpressionNode;
  latex: string;
  lower: number;
  upper: number;
}

export interface PiecewiseExpression {
  pieces: ExpressionPiece[];
  signature: string;
}

/** Geometry only. Boundary data are stored separately on WaveProblem. */
export type SpatialDomain =
  | { kind: "infinite" }
  /** The physical domain is [left, +infinity). */
  | { kind: "right-half-line"; left: number }
  /** The physical domain is (-infinity, right]. */
  | { kind: "left-half-line"; right: number }
  | { kind: "finite"; left: number; right: number };

export type BoundaryKind = "dirichlet" | "neumann";
export type BoundarySide = "left" | "right";

export interface BoundaryConditionDraft {
  kind: BoundaryKind;
  expression: string;
}

export interface BoundaryCondition extends BoundaryConditionDraft {
  ast: ExpressionNode;
  latex: string;
}

export interface WaveProblemInput {
  c: number;
  T: number;
  domain: SpatialDomain;
  view: { xMin: number; xMax: number };
  f: readonly ExpressionPieceDraft[];
  g: readonly ExpressionPieceDraft[];
  boundaries: {
    left?: BoundaryConditionDraft;
    right?: BoundaryConditionDraft;
  };
}

export type ProblemNoticeCode =
  | "invalid-number"
  | "invalid-domain"
  | "invalid-view"
  | "invalid-expression"
  | "invalid-piece"
  | "piece-gap"
  | "piece-overlap"
  | "missing-boundary"
  | "unexpected-boundary"
  | "dirichlet-corner"
  | "dirichlet-compatibility"
  | "neumann-compatibility"
  | "sampling-resolution"
  | "reflection-limit";

export interface ProblemNotice {
  code: ProblemNoticeCode;
  severity: "warning" | "error";
  message: string;
  path?: string;
}

/** Parsed and validated problem. This is the only problem shape accepted by the solver. */
export interface WaveProblem {
  c: number;
  T: number;
  domain: SpatialDomain;
  view: { xMin: number; xMax: number };
  f: PiecewiseExpression;
  g: PiecewiseExpression;
  boundaries: {
    left?: BoundaryCondition;
    right?: BoundaryCondition;
  };
  signature: string;
  warnings: ProblemNotice[];
}

export type WaveProblemValidationResult =
  | { ok: true; problem: WaveProblem; warnings: ProblemNotice[] }
  | { ok: false; errors: ProblemNotice[]; warnings: ProblemNotice[] };

export interface SurfaceRange {
  min: number;
  max: number;
}

export interface SolverTimings {
  totalMs: number;
  integrationMs: number;
  samplingMs: number;
}

export interface WaveSolutionGrid {
  revision: number;
  problemSignature: string;
  /** Adaptive odd count; accepted grids are twice the rendered x resolution. */
  x: Float64Array;
  /** Adaptive odd count that preserves the reference physical time spacing. */
  t: Float64Array;
  /** Row-major, t-major values: values[timeIndex * x.length + xIndex]. */
  values: Float32Array;
  /** One stable range computed from the whole surface, not the selected snapshot. */
  surfaceRange: SurfaceRange;
  warnings: ProblemNotice[];
  timings: SolverTimings;
  /** Maximum number of boundary reflections used by any sampled dependency path. */
  reflectionCount: number;
}

export interface CharacteristicPoint {
  x: number;
  t: number;
  u: number;
}

export interface CharacteristicPath {
  /** Initial direction in the backward (toward t=0) trace. */
  direction: -1 | 1;
  points: CharacteristicPoint[];
}

export interface BoundaryHit extends CharacteristicPoint {
  side: BoundarySide;
  path: "left" | "right";
  /** Index of this hit in the corresponding path's points array. */
  index: number;
}

export interface InitialFootpoint extends CharacteristicPoint {
  t: 0;
  path: "left" | "right";
}

export interface CharacteristicTrace {
  point: CharacteristicPoint;
  left: CharacteristicPath & { direction: -1 };
  right: CharacteristicPath & { direction: 1 };
  hits: BoundaryHit[];
  footpoints: InitialFootpoint[];
}

export interface SolveWaveOptions {
  revision?: number;
  xSamples?: number;
  tSamples?: number;
}

export interface WaveWorkerRequest {
  type: "solve";
  revision: number;
  problem: WaveProblem;
  xSamples?: number;
  tSamples?: number;
}

export type WaveWorkerResponse =
  | { type: "result"; result: WaveSolutionGrid }
  | { type: "error"; revision: number; message: string };

export interface AppNotice {
  tone: "info" | "warning" | "error";
  text: string;
}
