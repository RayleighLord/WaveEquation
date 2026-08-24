import {
  DEFAULT_WAVE_PRESET_ID,
  adaptiveAcceptedSampleCounts,
  evaluateExpression,
  getWavePreset,
  getWavePresetInput,
  parseExpression,
  validateWaveProblem,
  type ProductDomainKind,
  type WavePresetId
} from "../math";
import type {
  BoundaryConditionDraft,
  ExpressionPieceDraft,
  ProblemNotice,
  SpatialDomain,
  WaveProblem,
  WaveProblemInput,
  WaveSolutionGrid
} from "../types";
import { WaveWorkerClient } from "../workers";

export type ProblemStatus =
  | "editing"
  | "solving"
  | "ready"
  | "invalid"
  | "error";

export interface EditablePiece {
  id: string;
  expression: string;
  lower: string;
  upper: string;
}

export interface WaveProblemDraft {
  domainKind: ProductDomainKind;
  T: string;
  xMin: string;
  xMax: string;
  domainLeft: string;
  domainRight: string;
  f: EditablePiece[];
  g: EditablePiece[];
  boundaries: {
    left: BoundaryConditionDraft;
    right: BoundaryConditionDraft;
  };
}

export interface WaveAppViewModel {
  draft: WaveProblemDraft;
  presetId: WavePresetId | "custom";
  problemName: string;
  status: ProblemStatus;
  statusMessage: string;
  errors: ProblemNotice[];
  warnings: ProblemNotice[];
  acceptedProblem: WaveProblem | null;
  result: WaveSolutionGrid | null;
  pendingRevision: number | null;
}

export type ScalarDraftField =
  | "domainKind"
  | "T"
  | "xMin"
  | "xMax"
  | "domainLeft"
  | "domainRight";
export type PieceSource = "f" | "g";
export type PieceDraftField = "expression" | "lower" | "upper";
export type BoundarySide = "left" | "right";
export type BoundaryDraftField = "kind" | "expression";

type Listener = (viewModel: WaveAppViewModel) => void;

/**
 * Owns editable state, the last accepted problem, and revision-safe worker
 * requests. An invalid draft never clears the visualization.
 */
export class WaveAppController {
  private readonly listeners = new Set<Listener>();
  private readonly worker: WaveWorkerClient;
  private readonly pendingProblems = new Map<number, WaveProblem>();
  private nextPieceId = 1;
  private state: WaveAppViewModel;

  constructor(workerFactory?: () => Worker) {
    const preset = getWavePreset(DEFAULT_WAVE_PRESET_ID);
    const input = getWavePresetInput(DEFAULT_WAVE_PRESET_ID);
    this.state = {
      draft: draftFromInput(input),
      presetId: DEFAULT_WAVE_PRESET_ID,
      problemName: preset?.name ?? "Gaussian Pulse",
      status: "solving",
      statusMessage: "Solving…",
      errors: [],
      warnings: [],
      acceptedProblem: null,
      result: null,
      pendingRevision: null
    };
    this.worker = new WaveWorkerClient(
      {
        onResult: (result) => this.acceptResult(result),
        onError: (revision, message) => this.acceptError(revision, message)
      },
      workerFactory
    );
    this.commitDraft();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getViewModel());
    return () => this.listeners.delete(listener);
  }

  getViewModel(): WaveAppViewModel {
    return cloneViewModel(this.state);
  }

  selectPreset(id: WavePresetId | "custom"): void {
    if (id === "custom") {
      if (this.state.presetId === "custom") return;
      this.state = {
        ...this.state,
        presetId: "custom",
        problemName: "Custom problem"
      };
      this.emit();
      return;
    }
    const preset = getWavePreset(id);
    const input = getWavePresetInput(id);
    this.pendingProblems.clear();
    this.state = {
      ...this.state,
      draft: draftFromInput(input),
      presetId: id,
      problemName: preset?.name ?? "Wave problem",
      status: "solving",
      statusMessage: "Solving…",
      errors: [],
      warnings: [],
      pendingRevision: null
    };
    this.emit();
    this.commitDraft();
  }

  setScalarField(field: ScalarDraftField, value: string): void {
    if (field === "domainKind") {
      // Ignore values outside the product's three exposed domain classes. The
      // numerical layer still understands left-half-line problems, but the
      // editor no longer creates them.
      if (!isDomainKind(value)) return;
      // Native selects can report both input and change for one gesture. The
      // second notification must not turn the freshly switched preset custom.
      if (value === this.state.draft.domainKind) return;
      if (this.state.presetId === "custom") {
        this.markEditing({ ...this.state.draft, domainKind: value }, false);
        return;
      }
      const preset = getWavePreset(this.state.presetId);
      const input = getWavePresetInput(this.state.presetId, value);
      this.pendingProblems.clear();
      this.state = {
        ...this.state,
        draft: draftFromInput(input),
        problemName: preset?.name ?? this.state.problemName,
        status: "editing",
        statusMessage: "Editing…",
        errors: [],
        warnings: [],
        pendingRevision: null
      };
      this.emit();
      return;
    }
    this.markEditing({
      ...this.state.draft,
      [field]: value
    }, false);
  }

  setPieceField(
    source: PieceSource,
    pieceId: string,
    field: PieceDraftField,
    value: string
  ): void {
    const pieces = this.state.draft[source].map((piece) =>
      piece.id === pieceId ? { ...piece, [field]: value } : { ...piece }
    );
    this.markEditing({ ...this.state.draft, [source]: pieces }, true);
  }

  addPiece(source: PieceSource): boolean {
    const pieces = this.state.draft[source].map((piece) => ({ ...piece }));
    if (pieces.length >= 16) {
      this.state = {
        ...this.state,
        status: "invalid",
        statusMessage: "Use at most 16 intervals for each initial function."
      };
      this.emit();
      return false;
    }
    const last = pieces.at(-1);
    if (!last) return false;
    const lower = parseEditableBound(last.lower);
    const upper = parseEditableBound(last.upper);
    const viewMin = tryParseFiniteScalarExpression(this.state.draft.xMin);
    const viewMax = tryParseFiniteScalarExpression(this.state.draft.xMax);
    let split: number;
    if (Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) {
      split = (lower + upper) / 2;
    } else if (!Number.isFinite(lower) && !Number.isFinite(upper)) {
      split = Number.isFinite(viewMin) && Number.isFinite(viewMax)
        ? (viewMin + viewMax) / 2
        : 0;
    } else if (Number.isFinite(lower)) {
      split = Number.isFinite(viewMax) && viewMax > lower ? viewMax : lower + 1;
    } else {
      split = Number.isFinite(viewMin) && viewMin < upper ? viewMin : upper - 1;
    }
    const boundary = formatNumber(split);
    last.upper = boundary;
    pieces.push({
      id: `custom-${source}-${this.nextPieceId++}`,
      expression: last.expression,
      lower: boundary,
      upper: String(this.state.draft[source].at(-1)?.upper ?? boundary)
    });
    this.markEditing({ ...this.state.draft, [source]: pieces }, true);
    return true;
  }

  removePiece(source: PieceSource, pieceId: string): void {
    const original = this.state.draft[source];
    if (original.length <= 1) return;
    const index = original.findIndex((piece) => piece.id === pieceId);
    if (index < 0) return;
    const removed = original[index];
    const pieces = original
      .filter((piece) => piece.id !== pieceId)
      .map((piece) => ({ ...piece }));
    if (removed) {
      if (index === 0 && pieces[0]) pieces[0].lower = removed.lower;
      else {
        const previous = pieces[index - 1];
        if (previous) previous.upper = removed.upper;
      }
    }
    this.markEditing({ ...this.state.draft, [source]: pieces }, true);
  }

  setBoundaryField(
    side: BoundarySide,
    field: BoundaryDraftField,
    value: string
  ): void {
    const boundary = {
      ...this.state.draft.boundaries[side],
      [field]: value
    } as BoundaryConditionDraft;
    this.markEditing({
      ...this.state.draft,
      boundaries: { ...this.state.draft.boundaries, [side]: boundary }
    }, true);
  }

  commitDraft(): boolean {
    let input: WaveProblemInput;
    try {
      input = inputFromDraft(this.state.draft);
    } catch (error) {
      this.rejectDraft(error instanceof Error ? error.message : "Invalid problem input.");
      return false;
    }
    const validation = validateWaveProblem(input);
    if (!validation.ok) {
      this.pendingProblems.clear();
      this.state = {
        ...this.state,
        status: "invalid",
        statusMessage: validation.errors[0]?.message ?? "Invalid wave problem.",
        errors: validation.errors.map((notice) => ({ ...notice })),
        warnings: validation.warnings.map((notice) => ({ ...notice })),
        pendingRevision: null
      };
      this.emit();
      return false;
    }

    const revision = this.worker.currentRevision + 1;
    this.pendingProblems.clear();
    this.pendingProblems.set(revision, validation.problem);
    this.state = {
      ...this.state,
      status: "solving",
      statusMessage: "Solving…",
      errors: [],
      warnings: validation.warnings.map((notice) => ({ ...notice })),
      pendingRevision: revision
    };
    this.emit();
    const submittedRevision = this.worker.solve(
      validation.problem,
      adaptiveAcceptedSampleCounts(validation.problem)
    );
    if (submittedRevision !== revision && this.state.pendingRevision === revision) {
      this.acceptError(revision, "The solver returned an unexpected revision.");
      return false;
    }
    return true;
  }

  dispose(): void {
    this.worker.dispose();
    this.listeners.clear();
    this.pendingProblems.clear();
  }

  private markEditing(draft: WaveProblemDraft, customize: boolean): void {
    this.pendingProblems.clear();
    this.state = {
      ...this.state,
      draft,
      ...(customize
        ? { presetId: "custom" as const, problemName: "Custom problem" }
        : {}),
      status: "editing",
      statusMessage: "Editing…",
      errors: [],
      pendingRevision: null
    };
    this.emit();
  }

  private rejectDraft(message: string): void {
    this.pendingProblems.clear();
    this.state = {
      ...this.state,
      status: "invalid",
      statusMessage: message,
      pendingRevision: null
    };
    this.emit();
  }

  private acceptResult(result: WaveSolutionGrid): void {
    if (result.revision !== this.state.pendingRevision) return;
    const problem = this.pendingProblems.get(result.revision);
    if (!problem || result.problemSignature !== problem.signature) return;
    this.pendingProblems.clear();
    const warnings = result.warnings;
    this.state = {
      ...this.state,
      status: "ready",
      statusMessage: warnings.length ? "Ready with notes" : "Ready",
      acceptedProblem: problem,
      result,
      warnings: warnings.map((notice) => ({ ...notice })),
      errors: [],
      pendingRevision: null
    };
    this.emit();
  }

  private acceptError(revision: number, message: string): void {
    if (revision !== this.state.pendingRevision) return;
    this.pendingProblems.clear();
    this.state = {
      ...this.state,
      status: "error",
      statusMessage: message,
      pendingRevision: null
    };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getViewModel();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function draftFromInput(input: WaveProblemInput): WaveProblemDraft {
  if (input.domain.kind === "left-half-line") {
    throw new Error("The right-bounded half-line is not available in the editor.");
  }
  return {
    domainKind: input.domain.kind,
    T: formatScalarSource(input.T),
    xMin: formatScalarSource(input.view.xMin),
    xMax: formatScalarSource(input.view.xMax),
    domainLeft: formatScalarSource(
      input.domain.kind === "right-half-line" || input.domain.kind === "finite"
        ? input.domain.left
        : input.view.xMin
    ),
    domainRight: formatScalarSource(
      input.domain.kind === "finite" ? input.domain.right : input.view.xMax
    ),
    f: input.f.map(pieceToDraft),
    g: input.g.map(pieceToDraft),
    boundaries: {
      left: { ...(input.boundaries.left ?? { kind: "dirichlet", expression: "0" }) },
      right: { ...(input.boundaries.right ?? { kind: "dirichlet", expression: "0" }) }
    }
  };
}

function pieceToDraft(piece: ExpressionPieceDraft): EditablePiece {
  return {
    id: piece.id,
    expression: piece.expression,
    lower: formatBound(piece.lower),
    upper: formatBound(piece.upper)
  };
}

function inputFromDraft(draft: WaveProblemDraft): WaveProblemInput {
  const T = parseFiniteScalarExpression(
    draft.T,
    "Final time must be a finite constant expression."
  );
  const xMin = parseFiniteScalarExpression(
    draft.xMin,
    "View minimum must be a finite constant expression."
  );
  const xMax = parseFiniteScalarExpression(
    draft.xMax,
    "View maximum must be a finite constant expression."
  );
  const domain: SpatialDomain = draft.domainKind === "infinite"
    ? { kind: "infinite" }
    : draft.domainKind === "right-half-line"
      ? {
          kind: "right-half-line",
          left: parseFiniteScalarExpression(
            draft.domainLeft,
            "Left endpoint must be a finite constant expression."
          )
        }
      : {
          kind: "finite",
          left: parseFiniteScalarExpression(
            draft.domainLeft,
            "Left endpoint must be a finite constant expression."
          ),
          right: parseFiniteScalarExpression(
            draft.domainRight,
            "Right endpoint must be a finite constant expression."
          )
        };

  const boundaries: WaveProblemInput["boundaries"] = {};
  if (domain.kind === "right-half-line" || domain.kind === "finite") {
    boundaries.left = { ...draft.boundaries.left };
  }
  if (domain.kind === "finite") {
    boundaries.right = { ...draft.boundaries.right };
  }

  return {
    c: 1,
    T,
    domain,
    view: { xMin, xMax },
    f: draft.f.map(toPieceInput),
    g: draft.g.map(toPieceInput),
    boundaries
  };
}

function toPieceInput(piece: EditablePiece): ExpressionPieceDraft {
  return {
    id: piece.id,
    expression: piece.expression,
    // Keep symbolic constant bounds such as pi for the safe bound parser in
    // validateWaveProblem; only normalize typographic infinity/minus signs.
    lower: normalizeBoundSource(piece.lower),
    upper: normalizeBoundSource(piece.upper)
  };
}

function normalizeBoundSource(source: string): string {
  return source.trim().replace(/−/g, "-").replace(/∞/g, "inf");
}

function parseEditableBound(source: string): number {
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/−/g, "-")
    .replace(/∞/g, "inf");
  if (["inf", "+inf", "infinity", "+infinity"].includes(normalized)) return Infinity;
  if (["-inf", "-infinity"].includes(normalized)) return -Infinity;
  return parseFiniteScalarExpression(
    source,
    `Invalid interval bound “${source}”.`
  );
}

/** Evaluate a constant-only scalar through the same whitelisted AST as f, g, h and q. */
function parseFiniteScalarExpression(source: string, message: string): number {
  try {
    const ast = parseExpression(source.trim().replace(/−/g, "-"), {
      variable: "none"
    });
    const value = evaluateExpression(ast);
    if (!Number.isFinite(value)) throw new Error(message);
    return value;
  } catch {
    throw new Error(message);
  }
}

function tryParseFiniteScalarExpression(source: string): number {
  try {
    return parseFiniteScalarExpression(source, "Invalid scalar expression.");
  } catch {
    return Number.NaN;
  }
}

function isDomainKind(value: string): value is ProductDomainKind {
  return (
    value === "infinite" ||
    value === "right-half-line" ||
    value === "finite"
  );
}

function formatBound(value: string | number): string {
  if (typeof value === "string") return value;
  if (value === Infinity) return "∞";
  if (value === -Infinity) return "−∞";
  return formatScalarSource(value);
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(15))) : String(value);
}

/** Keep familiar exact multiples of pi readable in editable preset fields. */
function formatScalarSource(value: number): string {
  if (Number.isFinite(value) && value !== 0) {
    const multiple = Math.round(value / Math.PI);
    const tolerance = 1e-12 * Math.max(1, Math.abs(value));
    if (
      multiple !== 0 &&
      Math.abs(value - multiple * Math.PI) <= tolerance
    ) {
      if (multiple === 1) return "pi";
      if (multiple === -1) return "-pi";
      return `${multiple} * pi`;
    }
  }
  return formatNumber(value);
}

function cloneViewModel(state: WaveAppViewModel): WaveAppViewModel {
  return {
    ...state,
    draft: {
      ...state.draft,
      f: state.draft.f.map((piece) => ({ ...piece })),
      g: state.draft.g.map((piece) => ({ ...piece })),
      boundaries: {
        left: { ...state.draft.boundaries.left },
        right: { ...state.draft.boundaries.right }
      }
    },
    errors: state.errors.map((notice) => ({ ...notice })),
    warnings: state.warnings.map((notice) => ({ ...notice }))
  };
}
