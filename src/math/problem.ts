import type {
  BoundaryCondition,
  BoundaryConditionDraft,
  BoundarySide,
  ExpressionPiece,
  ExpressionPieceDraft,
  PiecewiseExpression,
  ProblemNotice,
  SpatialDomain,
  WaveProblem,
  WaveProblemInput,
  WaveProblemValidationResult
} from "../types";
import {
  compileExpression,
  evaluateExpression,
  parseExpression,
  renderExpressionLatex,
  serializeExpressionAst
} from "./expression";

export const MAX_EXPRESSION_PIECES = 16;
export const MAX_REFLECTIONS = 64;

const DOMAIN_TOLERANCE = 1e-10;
const CORNER_TOLERANCE = 1e-8;
const COMPATIBILITY_TOLERANCE = 2e-4;

export class ProblemValidationError extends Error {
  readonly errors: ProblemNotice[];
  readonly warnings: ProblemNotice[];

  constructor(errors: ProblemNotice[], warnings: ProblemNotice[] = []) {
    super(errors.map((notice) => notice.message).join(" "));
    this.name = "ProblemValidationError";
    this.errors = errors;
    this.warnings = warnings;
  }
}

export function validateWaveProblem(
  input: WaveProblemInput
): WaveProblemValidationResult {
  const errors: ProblemNotice[] = [];
  const warnings: ProblemNotice[] = [];

  if (!isFinitePositive(input?.c)) {
    errors.push(error("invalid-number", "Wave speed c must be a positive finite number.", "c"));
  }
  if (!isFinitePositive(input?.T)) {
    errors.push(error("invalid-number", "Final time T must be a positive finite number.", "T"));
  }

  const domain = validateDomain(input?.domain, errors);
  const view = validateView(input?.view, domain, errors);
  const f = parsePiecewise(input?.f, "f", domain, errors);
  const g = parsePiecewise(input?.g, "g", domain, errors);
  const boundaries = parseBoundaries(input?.boundaries, domain, input?.T, errors);

  if (
    domain?.kind === "finite" &&
    isFinitePositive(input?.c) &&
    isFinitePositive(input?.T)
  ) {
    const possibleReflections = Math.ceil(
      (input.c * input.T) / (domain.right - domain.left)
    );
    if (possibleReflections > MAX_REFLECTIONS) {
      errors.push(
        error(
          "reflection-limit",
          `This time interval may require ${possibleReflections} reflections; reduce c or T so at most ${MAX_REFLECTIONS} are needed.`,
          "T"
        )
      );
    }
  }

  if (domain && f && g) {
    addCompatibilityNotices(
      domain,
      f,
      g,
      boundaries,
      input.c,
      input.T,
      errors,
      warnings
    );
  }

  if (
    errors.length > 0 ||
    !domain ||
    !view ||
    !f ||
    !g
  ) {
    return { ok: false, errors, warnings };
  }

  const problemWithoutSignature = {
    c: input.c,
    T: input.T,
    domain,
    view,
    f,
    g,
    boundaries,
    warnings
  };
  const problem: WaveProblem = {
    ...problemWithoutSignature,
    signature: createProblemSignature(problemWithoutSignature)
  };
  return { ok: true, problem, warnings };
}

export function createWaveProblem(input: WaveProblemInput): WaveProblem {
  const result = validateWaveProblem(input);
  if (!result.ok) {
    throw new ProblemValidationError(result.errors, result.warnings);
  }
  return result.problem;
}

/** Reparse every expression and recompute the signature at a trust boundary. */
export function revalidateWaveProblem(problem: WaveProblem): WaveProblem {
  const expectedSignature = problem?.signature;
  const result = createWaveProblem(waveProblemToInput(problem));
  if (result.signature !== expectedSignature) {
    throw new Error("The wave problem signature does not match its contents.");
  }
  return result;
}

export function waveProblemToInput(problem: WaveProblem): WaveProblemInput {
  const domain = cloneDomain(problem?.domain);
  return {
    c: problem?.c,
    T: problem?.T,
    domain,
    view: {
      xMin: problem?.view?.xMin,
      xMax: problem?.view?.xMax
    },
    f: clonePieces(problem?.f?.pieces),
    g: clonePieces(problem?.g?.pieces),
    boundaries: {
      ...(problem?.boundaries?.left
        ? { left: cloneBoundary(problem.boundaries.left) }
        : {}),
      ...(problem?.boundaries?.right
        ? { right: cloneBoundary(problem.boundaries.right) }
        : {})
    }
  };
}

export function evaluatePiecewise(
  expression: PiecewiseExpression,
  x: number
): number {
  if (!Number.isFinite(x)) throw new Error("x must be finite.");
  const piece = findPiece(expression.pieces, x);
  if (!piece) return 0;
  const value = evaluateExpression(piece.ast, { x });
  if (!Number.isFinite(value)) {
    throw new Error(`Expression piece "${piece.id}" is not finite at x=${x}.`);
  }
  return value;
}

export function compilePiecewise(
  expression: PiecewiseExpression
): (x: number) => number {
  const compiled = expression.pieces.map((piece) => ({
    piece,
    evaluate: compileExpression(piece.ast, "x")
  }));
  return (x: number): number => {
    if (!Number.isFinite(x)) throw new Error("x must be finite.");
    for (let index = 0; index < compiled.length; index += 1) {
      const { piece, evaluate } = compiled[index] as (typeof compiled)[number];
      if (contains(piece, x, index === compiled.length - 1)) {
        const value = evaluate(x);
        if (!Number.isFinite(value)) {
          throw new Error(
            `Expression piece "${piece.id}" is not finite at x=${x}.`
          );
        }
        return value;
      }
    }
    return 0;
  };
}

export function domainBounds(domain: SpatialDomain): {
  lower: number;
  upper: number;
} {
  switch (domain.kind) {
    case "infinite":
      return { lower: Number.NEGATIVE_INFINITY, upper: Number.POSITIVE_INFINITY };
    case "right-half-line":
      return { lower: domain.left, upper: Number.POSITIVE_INFINITY };
    case "left-half-line":
      return { lower: Number.NEGATIVE_INFINITY, upper: domain.right };
    case "finite":
      return { lower: domain.left, upper: domain.right };
  }
}

export function domainBoundary(
  domain: SpatialDomain,
  side: BoundarySide
): number | undefined {
  if (side === "left") {
    return domain.kind === "right-half-line" || domain.kind === "finite"
      ? domain.left
      : undefined;
  }
  return domain.kind === "left-half-line" || domain.kind === "finite"
    ? domain.right
    : undefined;
}

export function renderWaveProblemLatex(problem: WaveProblem): string {
  const domain = renderDomainLatex(problem.domain);
  const lines = [
    `u_{tt}-${formatNumber(problem.c ** 2)}u_{xx}=0,\\qquad (x,t)\\in ${domain}\\times(0,${formatNumber(problem.T)}]`,
    `u(x,0)=${renderPiecewiseLatex(problem.f)},\\qquad u_t(x,0)=${renderPiecewiseLatex(problem.g)}`
  ];
  const left = problem.boundaries.left;
  const leftX = domainBoundary(problem.domain, "left");
  if (left && leftX !== undefined) {
    lines.push(renderBoundaryLatex("left", leftX, left));
  }
  const right = problem.boundaries.right;
  const rightX = domainBoundary(problem.domain, "right");
  if (right && rightX !== undefined) {
    lines.push(renderBoundaryLatex("right", rightX, right));
  }
  return `\\begin{aligned}${lines.join("\\\\[3pt]")}\\end{aligned}`;
}

function validateDomain(
  value: SpatialDomain,
  errors: ProblemNotice[]
): SpatialDomain | null {
  if (!value || typeof value !== "object") {
    errors.push(error("invalid-domain", "Choose a spatial domain.", "domain"));
    return null;
  }
  switch (value.kind) {
    case "infinite":
      return { kind: "infinite" };
    case "right-half-line":
      if (!Number.isFinite(value.left)) {
        errors.push(error("invalid-domain", "The left endpoint must be finite.", "domain.left"));
        return null;
      }
      return { kind: "right-half-line", left: value.left };
    case "left-half-line":
      if (!Number.isFinite(value.right)) {
        errors.push(error("invalid-domain", "The right endpoint must be finite.", "domain.right"));
        return null;
      }
      return { kind: "left-half-line", right: value.right };
    case "finite":
      if (
        !Number.isFinite(value.left) ||
        !Number.isFinite(value.right) ||
        !(value.left < value.right)
      ) {
        errors.push(
          error(
            "invalid-domain",
            "A finite interval needs finite endpoints with left < right.",
            "domain"
          )
        );
        return null;
      }
      return { kind: "finite", left: value.left, right: value.right };
    default:
      errors.push(error("invalid-domain", "Unsupported spatial domain.", "domain.kind"));
      return null;
  }
}

function validateView(
  value: { xMin: number; xMax: number },
  domain: SpatialDomain | null,
  errors: ProblemNotice[]
): { xMin: number; xMax: number } | null {
  if (
    !value ||
    !Number.isFinite(value.xMin) ||
    !Number.isFinite(value.xMax) ||
    !(value.xMin < value.xMax)
  ) {
    errors.push(
      error(
        "invalid-view",
        "The visible x-range needs finite values with xMin < xMax.",
        "view"
      )
    );
    return null;
  }
  if (domain) {
    const bounds = domainBounds(domain);
    if (
      value.xMin < bounds.lower - DOMAIN_TOLERANCE ||
      value.xMax > bounds.upper + DOMAIN_TOLERANCE
    ) {
      errors.push(
        error(
          "invalid-view",
          "The visible x-range must stay inside the physical domain.",
          "view"
        )
      );
      return null;
    }
  }
  return { xMin: value.xMin, xMax: value.xMax };
}

function parsePiecewise(
  drafts: readonly ExpressionPieceDraft[],
  label: "f" | "g",
  domain: SpatialDomain | null,
  errors: ProblemNotice[]
): PiecewiseExpression | null {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    errors.push(
      error(
        "invalid-piece",
        `${label} needs at least one expression piece.`,
        label
      )
    );
    return null;
  }
  if (drafts.length > MAX_EXPRESSION_PIECES) {
    errors.push(
      error(
        "invalid-piece",
        `${label} can contain at most ${MAX_EXPRESSION_PIECES} pieces.`,
        label
      )
    );
    return null;
  }

  const pieces: ExpressionPiece[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const path = `${label}[${index}]`;
    if (!draft || typeof draft !== "object") {
      errors.push(error("invalid-piece", "Malformed expression piece.", path));
      continue;
    }
    const id = typeof draft.id === "string" ? draft.id.trim() : "";
    if (!id || ids.has(id)) {
      errors.push(
        error(
          "invalid-piece",
          id ? `Piece id "${id}" is duplicated.` : "Every piece needs an id.",
          `${path}.id`
        )
      );
      continue;
    }
    ids.add(id);
    let lower: number;
    let upper: number;
    try {
      lower = parseBoundValue(draft.lower);
      upper = parseBoundValue(draft.upper);
      if (!(lower < upper)) {
        throw new Error("The lower bound must be smaller than the upper bound.");
      }
    } catch (caught) {
      errors.push(error("invalid-piece", messageOf(caught), `${path}.bounds`));
      continue;
    }
    try {
      const source = typeof draft.expression === "string" ? draft.expression.trim() : "";
      const ast = parseExpression(source, { variable: "x" });
      const piece: ExpressionPiece = {
        id,
        expression: source,
        ast,
        latex: renderExpressionLatex(ast),
        lower,
        upper
      };
      assertPieceSamplesFinite(piece);
      pieces.push(piece);
    } catch (caught) {
      errors.push(
        error(
          "invalid-expression",
          `${label}: ${messageOf(caught)}`,
          `${path}.expression`
        )
      );
    }
  }

  if (pieces.length !== drafts.length) return null;
  const bounds = domain ? domainBounds(domain) : null;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] as ExpressionPiece;
    const previous = index > 0 ? pieces[index - 1] : undefined;
    if (previous && piece.lower < previous.upper - DOMAIN_TOLERANCE) {
      errors.push(
        error(
          "piece-overlap",
          `${label} pieces must be ordered and cannot overlap.`,
          `${label}[${index}]`
        )
      );
    }
    if (
      bounds &&
      (piece.lower < bounds.lower - DOMAIN_TOLERANCE ||
        piece.upper > bounds.upper + DOMAIN_TOLERANCE)
    ) {
      errors.push(
        error(
          "invalid-piece",
          `${label} piece "${piece.id}" extends outside the physical domain.`,
          `${label}[${index}]`
        )
      );
    }
  }

  if (domain?.kind === "finite") {
    const first = pieces[0] as ExpressionPiece;
    const last = pieces[pieces.length - 1] as ExpressionPiece;
    if (
      !nearlyEqual(first.lower, domain.left, DOMAIN_TOLERANCE) ||
      !nearlyEqual(last.upper, domain.right, DOMAIN_TOLERANCE)
    ) {
      errors.push(
        error(
          "piece-gap",
          `${label} pieces must cover the complete finite interval.`,
          label
        )
      );
    }
    for (let index = 1; index < pieces.length; index += 1) {
      if (
        !nearlyEqual(
          (pieces[index - 1] as ExpressionPiece).upper,
          (pieces[index] as ExpressionPiece).lower,
          DOMAIN_TOLERANCE
        )
      ) {
        errors.push(
          error(
            "piece-gap",
            `${label} pieces must have no gaps on a finite interval.`,
            `${label}[${index}]`
          )
        );
      }
    }
  }

  if (errors.some((notice) => notice.path?.startsWith(label))) return null;
  return {
    pieces,
    signature: pieces
      .map(
        (piece) =>
          `${piece.id}:${encodeNumber(piece.lower)}:${encodeNumber(
            piece.upper
          )}:${serializeExpressionAst(piece.ast)}`
      )
      .join("|")
  };
}

function parseBoundaries(
  drafts: WaveProblemInput["boundaries"],
  domain: SpatialDomain | null,
  T: number,
  errors: ProblemNotice[]
): WaveProblem["boundaries"] {
  const result: WaveProblem["boundaries"] = {};
  const expected = domain ? expectedBoundarySides(domain) : new Set<BoundarySide>();
  for (const side of ["left", "right"] as const) {
    const draft = drafts?.[side];
    const needed = expected.has(side);
    if (!draft && needed) {
      errors.push(
        error(
          "missing-boundary",
          `A ${side} boundary condition is required for this domain.`,
          `boundaries.${side}`
        )
      );
      continue;
    }
    if (draft && !needed) {
      errors.push(
        error(
          "unexpected-boundary",
          `This domain has no ${side} boundary.`,
          `boundaries.${side}`
        )
      );
      continue;
    }
    if (!draft) continue;
    try {
      result[side] = parseBoundary(draft, side, T);
    } catch (caught) {
      errors.push(
        error(
          "invalid-expression",
          messageOf(caught),
          `boundaries.${side}.expression`
        )
      );
    }
  }
  return result;
}

function parseBoundary(
  draft: BoundaryConditionDraft,
  side: BoundarySide,
  T: number
): BoundaryCondition {
  if (draft.kind !== "dirichlet" && draft.kind !== "neumann") {
    throw new Error(`Choose Dirichlet or Neumann data at the ${side} boundary.`);
  }
  const expression =
    typeof draft.expression === "string" ? draft.expression.trim() : "";
  const ast = parseExpression(expression, { variable: "t" });
  const evaluate = compileExpression(ast, "t");
  for (const time of [0, T / 2, T]) {
    const value = evaluate(time);
    if (!Number.isFinite(value)) {
      throw new Error(
        `The ${side} boundary expression is not finite at t=${formatNumber(time)}.`
      );
    }
  }
  return {
    kind: draft.kind,
    expression,
    ast,
    latex: renderExpressionLatex(ast)
  };
}

function addCompatibilityNotices(
  domain: SpatialDomain,
  f: PiecewiseExpression,
  g: PiecewiseExpression,
  boundaries: WaveProblem["boundaries"],
  c: number,
  T: number,
  errors: ProblemNotice[],
  warnings: ProblemNotice[]
): void {
  if (!isFinitePositive(c) || !isFinitePositive(T)) return;
  for (const side of ["left", "right"] as const) {
    const boundary = boundaries[side];
    const endpoint = domainBoundary(domain, side);
    if (!boundary || endpoint === undefined) continue;
    const initialValue = evaluatePiecewise(f, endpoint);
    const initialVelocity = evaluatePiecewise(g, endpoint);
    const boundaryValue = evaluateExpression(boundary.ast, { t: 0 });
    if (boundary.kind === "dirichlet") {
      if (!closeScaled(initialValue, boundaryValue, CORNER_TOLERANCE)) {
        errors.push(
          error(
            "dirichlet-corner",
            `At the ${side} corner, f(${formatNumber(endpoint)})=${formatNumber(
              initialValue
            )} but the Dirichlet value at t=0 is ${formatNumber(boundaryValue)}.`,
            `boundaries.${side}`
          )
        );
      }
      const boundaryVelocity = oneSidedTimeDerivative(boundary, T);
      if (
        !closeScaled(
          initialVelocity,
          boundaryVelocity,
          COMPATIBILITY_TOLERANCE
        )
      ) {
        warnings.push(
          warning(
            "dirichlet-compatibility",
            `The initial velocity and time derivative of the ${side} Dirichlet data do not match at the corner; a weak solution may contain a wavefront.`,
            `boundaries.${side}`
          )
        );
      }
    } else {
      const initialSlope = oneSidedSpatialDerivative(f, endpoint, side, domain);
      if (
        !closeScaled(initialSlope, boundaryValue, COMPATIBILITY_TOLERANCE)
      ) {
        warnings.push(
          warning(
            "neumann-compatibility",
            `The derivative of the initial displacement and the ${side} Neumann data do not match at the corner; a weak solution may contain a wavefront.`,
            `boundaries.${side}`
          )
        );
      }
    }
  }
}

function oneSidedTimeDerivative(
  boundary: BoundaryCondition,
  T: number
): number {
  const evaluate = compileExpression(boundary.ast, "t");
  const step = Math.max(1e-7, Math.min(1e-4, T * 1e-5));
  return (-3 * evaluate(0) + 4 * evaluate(step) - evaluate(2 * step)) / (2 * step);
}

function oneSidedSpatialDerivative(
  expression: PiecewiseExpression,
  endpoint: number,
  side: BoundarySide,
  domain: SpatialDomain
): number {
  const bounds = domainBounds(domain);
  const scale =
    Number.isFinite(bounds.lower) && Number.isFinite(bounds.upper)
      ? bounds.upper - bounds.lower
      : Math.max(1, Math.abs(endpoint));
  const step = Math.max(1e-7, scale * 1e-5);
  if (side === "left") {
    return (
      -3 * evaluatePiecewise(expression, endpoint) +
      4 * evaluatePiecewise(expression, endpoint + step) -
      evaluatePiecewise(expression, endpoint + 2 * step)
    ) / (2 * step);
  }
  return (
    3 * evaluatePiecewise(expression, endpoint) -
    4 * evaluatePiecewise(expression, endpoint - step) +
    evaluatePiecewise(expression, endpoint - 2 * step)
  ) / (2 * step);
}

function parseBoundValue(value: string | number): number {
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new Error("A piece bound cannot be NaN.");
    return value;
  }
  if (typeof value !== "string") throw new Error("Enter a valid piece bound.");
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/−/g, "-")
    .replace(/\s+/g, "");
  if (["-inf", "-infinity", "-∞"].includes(normalized)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (["inf", "+inf", "infinity", "+infinity", "∞", "+∞"].includes(normalized)) {
    return Number.POSITIVE_INFINITY;
  }
  const ast = parseExpression(value, { variable: "none" });
  const result = evaluateExpression(ast);
  if (!Number.isFinite(result)) {
    throw new Error("A finite bound must evaluate to a finite number.");
  }
  return result;
}

function assertPieceSamplesFinite(piece: ExpressionPiece): void {
  const evaluate = compileExpression(piece.ast, "x");
  for (const x of representativePoints(piece.lower, piece.upper)) {
    const value = evaluate(x);
    if (!Number.isFinite(value)) {
      throw new Error(
        `Expression is not finite at x=${formatNumber(x)}.`
      );
    }
  }
}

function representativePoints(lower: number, upper: number): number[] {
  if (Number.isFinite(lower) && Number.isFinite(upper)) {
    return [lower, (lower + upper) / 2, upper];
  }
  if (Number.isFinite(lower)) return [lower, lower + 1, lower + 10];
  if (Number.isFinite(upper)) return [upper - 10, upper - 1, upper];
  return [-1, 0, 1];
}

function expectedBoundarySides(domain: SpatialDomain): Set<BoundarySide> {
  switch (domain.kind) {
    case "infinite":
      return new Set();
    case "right-half-line":
      return new Set(["left"]);
    case "left-half-line":
      return new Set(["right"]);
    case "finite":
      return new Set(["left", "right"]);
  }
}

function createProblemSignature(problem: Omit<WaveProblem, "signature">): string {
  const domain =
    problem.domain.kind === "infinite"
      ? "infinite"
      : problem.domain.kind === "right-half-line"
        ? `right:${encodeNumber(problem.domain.left)}`
        : problem.domain.kind === "left-half-line"
          ? `left:${encodeNumber(problem.domain.right)}`
          : `finite:${encodeNumber(problem.domain.left)}:${encodeNumber(
              problem.domain.right
            )}`;
  const boundary = (side: BoundarySide): string => {
    const value = problem.boundaries[side];
    return value
      ? `${side}:${value.kind}:${serializeExpressionAst(value.ast)}`
      : `${side}:none`;
  };
  return [
    "wave-v1",
    encodeNumber(problem.c),
    encodeNumber(problem.T),
    domain,
    `${encodeNumber(problem.view.xMin)}:${encodeNumber(problem.view.xMax)}`,
    problem.f.signature,
    problem.g.signature,
    boundary("left"),
    boundary("right")
  ].join(";");
}

function findPiece(
  pieces: readonly ExpressionPiece[],
  x: number
): ExpressionPiece | undefined {
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] as ExpressionPiece;
    if (contains(piece, x, index === pieces.length - 1)) return piece;
  }
  return undefined;
}

function contains(
  piece: Pick<ExpressionPiece, "lower" | "upper">,
  x: number,
  isLast: boolean
): boolean {
  return x >= piece.lower && (x < piece.upper || (isLast && x <= piece.upper));
}

function clonePieces(
  pieces: readonly ExpressionPiece[] | undefined
): ExpressionPieceDraft[] {
  if (!Array.isArray(pieces)) return [];
  return pieces.map((piece) => ({
    id: piece?.id,
    expression: piece?.expression,
    lower: piece?.lower,
    upper: piece?.upper
  }));
}

function cloneBoundary(value: BoundaryCondition): BoundaryConditionDraft {
  return { kind: value?.kind, expression: value?.expression };
}

function cloneDomain(value: SpatialDomain): SpatialDomain {
  if (!value || typeof value !== "object") {
    return value as SpatialDomain;
  }
  switch (value.kind) {
    case "infinite":
      return { kind: "infinite" };
    case "right-half-line":
      return { kind: "right-half-line", left: value.left };
    case "left-half-line":
      return { kind: "left-half-line", right: value.right };
    case "finite":
      return { kind: "finite", left: value.left, right: value.right };
    default:
      return value;
  }
}

function renderDomainLatex(domain: SpatialDomain): string {
  switch (domain.kind) {
    case "infinite":
      return "\\mathbb{R}";
    case "right-half-line":
      return `[${formatNumber(domain.left)},\\infty)`;
    case "left-half-line":
      return `(-\\infty,${formatNumber(domain.right)}]`;
    case "finite":
      return `[${formatNumber(domain.left)},${formatNumber(domain.right)}]`;
  }
}

function renderPiecewiseLatex(expression: PiecewiseExpression): string {
  if (expression.pieces.length === 1) {
    return (expression.pieces[0] as ExpressionPiece).latex;
  }
  return `\\begin{cases}${expression.pieces
    .map(
      (piece) =>
        `${piece.latex},&${renderBound(piece.lower)}\\le x\\le ${renderBound(
          piece.upper
        )}`
    )
    .join("\\\\")}\\end{cases}`;
}

function renderBoundaryLatex(
  _side: BoundarySide,
  x: number,
  boundary: BoundaryCondition
): string {
  const left =
    boundary.kind === "dirichlet"
      ? `u(${formatNumber(x)},t)`
      : `u_x(${formatNumber(x)},t)`;
  return `${left}=${boundary.latex}`;
}

function renderBound(value: number): string {
  return value === Number.POSITIVE_INFINITY
    ? "\\infty"
    : value === Number.NEGATIVE_INFINITY
      ? "-\\infty"
      : formatNumber(value);
}

function error(
  code: ProblemNotice["code"],
  message: string,
  path?: string
): ProblemNotice {
  return { code, severity: "error", message, ...(path ? { path } : {}) };
}

function warning(
  code: ProblemNotice["code"],
  message: string,
  path?: string
): ProblemNotice {
  return { code, severity: "warning", message, ...(path ? { path } : {}) };
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function closeScaled(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance * (1 + Math.abs(left) + Math.abs(right));
}

function nearlyEqual(left: number, right: number, tolerance: number): boolean {
  return left === right || Math.abs(left - right) <= tolerance;
}

function encodeNumber(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return "+inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";
  return Object.is(value, -0) ? "0" : String(value);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return renderBound(value);
  if (Math.abs(value) < 1e-13) return "0";
  return Number(value.toPrecision(6)).toString();
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : "Invalid value.";
}
