import type {
  BoundaryDraftField,
  BoundarySide,
  EditablePiece,
  PieceDraftField,
  PieceSource,
  ScalarDraftField,
  WaveAppViewModel
} from "./controller";
import type { WavePresetId } from "../math";
import { renderLatex } from "../plot/latex";

interface PieceRow {
  row: HTMLDivElement;
  expression: HTMLInputElement;
  lower: HTMLInputElement;
  upper: HTMLInputElement;
  remove: HTMLButtonElement;
}

export interface ProblemEditorCallbacks {
  onPreset: (id: WavePresetId | "custom") => void;
  onScalar: (field: ScalarDraftField, value: string) => void;
  onPieceInput: (
    source: PieceSource,
    id: string,
    field: PieceDraftField,
    value: string
  ) => void;
  onPieceAdd: (source: PieceSource) => void;
  onPieceRemove: (source: PieceSource, id: string) => void;
  onBoundary: (
    side: BoundarySide,
    field: BoundaryDraftField,
    value: string
  ) => void;
}

/** Retained editor for the two piecewise initial-data functions. */
export class ProblemEditor {
  private readonly rows: Record<PieceSource, Map<string, PieceRow>> = {
    f: new Map(),
    g: new Map()
  };
  private readonly preset = getElement<HTMLSelectElement>("preset-select");
  private readonly domain = getElement<HTMLSelectElement>("domain-select");
  private readonly T = getElement<HTMLInputElement>("final-time-input");
  private readonly xMin = getElement<HTMLInputElement>("view-x-min-input");
  private readonly xMax = getElement<HTMLInputElement>("view-x-max-input");
  private readonly domainLeft = getElement<HTMLInputElement>("domain-left-input");
  private readonly domainRight = getElement<HTMLInputElement>("domain-right-input");
  private readonly domainLeftField = getElement<HTMLElement>("domain-left-field");
  private readonly domainRightField = getElement<HTMLElement>("domain-right-field");
  private readonly leftFields = getElement<HTMLElement>("left-boundary-fields");
  private readonly rightFields = getElement<HTMLElement>("right-boundary-fields");
  private readonly leftType = getElement<HTMLSelectElement>("left-boundary-type");
  private readonly rightType = getElement<HTMLSelectElement>("right-boundary-type");
  private readonly leftExpression = getElement<HTMLInputElement>("left-boundary-expression");
  private readonly rightExpression = getElement<HTMLInputElement>("right-boundary-expression");
  private readonly leftSymbol = getElement<HTMLElement>("left-boundary-symbol");
  private readonly rightSymbol = getElement<HTMLElement>("right-boundary-symbol");
  private readonly containers: Record<PieceSource, HTMLElement> = {
    f: getElement<HTMLElement>("displacement-piece-list"),
    g: getElement<HTMLElement>("velocity-piece-list")
  };

  constructor(private readonly callbacks: ProblemEditorCallbacks) {
    // The shell contains progressively enhanced example fields; the retained
    // editor owns these lists once JavaScript starts.
    this.containers.f.replaceChildren();
    this.containers.g.replaceChildren();
    this.preset.addEventListener("change", () => {
      callbacks.onPreset(this.preset.value as WavePresetId | "custom");
    });
    this.bindInput(this.domain, "domainKind");
    this.bindInput(this.T, "T");
    this.bindInput(this.xMin, "xMin");
    this.bindInput(this.xMax, "xMax");
    this.bindInput(this.domainLeft, "domainLeft");
    this.bindInput(this.domainRight, "domainRight");

    getElement<HTMLButtonElement>("add-displacement-piece").addEventListener("click", () =>
      callbacks.onPieceAdd("f")
    );
    getElement<HTMLButtonElement>("add-velocity-piece").addEventListener("click", () =>
      callbacks.onPieceAdd("g")
    );
    this.bindBoundary(this.leftType, "left", "kind");
    this.bindBoundary(this.rightType, "right", "kind");
    this.bindBoundary(this.leftExpression, "left", "expression");
    this.bindBoundary(this.rightExpression, "right", "expression");
  }

  render(viewModel: WaveAppViewModel): void {
    const { draft } = viewModel;
    this.sync(this.preset, viewModel.presetId);
    this.sync(this.domain, draft.domainKind);
    this.sync(this.T, draft.T);
    this.sync(this.xMin, draft.xMin);
    this.sync(this.xMax, draft.xMax);
    this.sync(this.domainLeft, draft.domainLeft);
    this.sync(this.domainRight, draft.domainRight);
    this.sync(this.leftType, draft.boundaries.left.kind);
    this.sync(this.rightType, draft.boundaries.right.kind);
    this.sync(this.leftExpression, draft.boundaries.left.expression);
    this.sync(this.rightExpression, draft.boundaries.right.expression);
    this.renderBoundarySymbol("left", draft.boundaries.left.kind);
    this.renderBoundarySymbol("right", draft.boundaries.right.kind);
    this.renderPieces("f", draft.f);
    this.renderPieces("g", draft.g);

    const showLeft = draft.domainKind === "right-half-line" || draft.domainKind === "finite";
    const showRight = draft.domainKind === "finite";
    this.leftFields.hidden = !showLeft;
    this.leftFields.inert = !showLeft;
    this.rightFields.hidden = !showRight;
    this.rightFields.inert = !showRight;
    this.domainLeftField.hidden = !showLeft;
    this.domainLeftField.inert = !showLeft;
    this.domainRightField.hidden = !showRight;
    this.domainRightField.inert = !showRight;
  }

  focusLast(source: PieceSource): void {
    Array.from(this.rows[source].values()).at(-1)?.expression.focus();
  }

  private bindInput(element: HTMLInputElement | HTMLSelectElement, field: ScalarDraftField): void {
    element.addEventListener("input", () => this.callbacks.onScalar(field, element.value));
    if (element instanceof HTMLSelectElement) {
      element.addEventListener("change", () => this.callbacks.onScalar(field, element.value));
    }
  }

  private bindBoundary(
    element: HTMLInputElement | HTMLSelectElement,
    side: BoundarySide,
    field: BoundaryDraftField
  ): void {
    const event = element instanceof HTMLSelectElement ? "change" : "input";
    element.addEventListener(event, () => this.callbacks.onBoundary(side, field, element.value));
  }

  private renderBoundarySymbol(
    side: BoundarySide,
    kind: "dirichlet" | "neumann"
  ): void {
    const symbol = side === "left" ? this.leftSymbol : this.rightSymbol;
    const input = side === "left" ? this.leftExpression : this.rightExpression;
    renderLatex(symbol, boundaryDataSymbolLatex(side, kind));
    const family = kind === "dirichlet" ? "h" : "q";
    const suffix = side === "left" ? "L" : "R";
    input.setAttribute(
      "aria-label",
      `${side === "left" ? "Left" : "Right"} boundary data ${family} sub ${suffix} of t`
    );
  }

  private renderPieces(source: PieceSource, pieces: readonly EditablePiece[]): void {
    const rows = this.rows[source];
    const active = new Set(pieces.map((piece) => piece.id));
    for (const [id, row] of rows) {
      if (!active.has(id)) {
        row.row.remove();
        rows.delete(id);
      }
    }
    pieces.forEach((piece, index) => {
      let row = rows.get(piece.id);
      if (!row) {
        row = this.createPieceRow(source, piece);
        rows.set(piece.id, row);
      }
      // Moving an already-positioned retained row detaches its focused input
      // in current browsers. Reconcile only rows whose actual order changed so
      // ordinary controlled renders preserve both focus and the caret.
      const rowAtIndex = this.containers[source].children.item(index);
      if (rowAtIndex !== row.row) {
        this.containers[source].insertBefore(row.row, rowAtIndex);
      }
      this.sync(row.expression, piece.expression);
      this.sync(row.lower, piece.lower);
      this.sync(row.upper, piece.upper);
      row.remove.disabled = pieces.length <= 1;
      row.remove.setAttribute(
        "aria-label",
        `Remove ${source === "f" ? "displacement" : "velocity"} interval ${index + 1}`
      );
    });
  }

  private createPieceRow(source: PieceSource, piece: EditablePiece): PieceRow {
    const row = document.createElement("div");
    row.className = "piece-row";
    row.dataset.pieceId = piece.id;
    row.dataset.source = source;
    const expression = createInput(
      "piece-expression",
      `${source === "f" ? "Initial displacement" : "Initial velocity"} expression`,
      piece.expression
    );
    const lower = createInput("piece-lower", "Interval lower bound", piece.lower);
    const upper = createInput("piece-upper", "Interval upper bound", piece.upper);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-piece-button";
    remove.textContent = "×";
    row.append(
      wrapInput(expression, source === "f" ? "f(x)" : "g(x)"),
      wrapInput(lower, "From"),
      wrapInput(upper, "To"),
      remove
    );
    for (const [field, input] of [
      ["expression", expression],
      ["lower", lower],
      ["upper", upper]
    ] as const) {
      input.addEventListener("input", () =>
        this.callbacks.onPieceInput(source, piece.id, field, input.value)
      );
    }
    remove.addEventListener("click", () => this.callbacks.onPieceRemove(source, piece.id));
    return { row, expression, lower, upper, remove };
  }

  private sync(element: HTMLInputElement | HTMLSelectElement, value: string): void {
    if (document.activeElement !== element && element.value !== value) element.value = value;
  }
}

/** Symbol shared by a boundary-data editor field and the accepted-problem card. */
export function boundaryDataSymbolLatex(
  side: BoundarySide,
  kind: "dirichlet" | "neumann"
): string {
  const family = kind === "dirichlet" ? "h" : "q";
  const suffix = side === "left" ? "L" : "R";
  return String.raw`${family}_${suffix}(t)`;
}

function createInput(className: string, ariaLabel: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = className;
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("aria-label", ariaLabel);
  return input;
}

function wrapInput(input: HTMLInputElement, labelText: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "piece-field";
  const caption = document.createElement("span");
  caption.className = "mobile-field-label";
  caption.textContent = labelText;
  label.append(caption, input);
  return label;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}.`);
  return element as T;
}
