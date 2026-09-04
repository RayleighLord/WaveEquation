import type {
  BoundaryDraftField,
  BoundarySide,
  EditablePiece,
  PieceDraftField,
  PieceSource,
  ScalarDraftField,
  WaveAppViewModel
} from "./controller";
import { getWavePresetObservation, type WavePresetId } from "../math";
import type { ProblemNotice } from "../types";
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
  private readonly eventController = new AbortController();
  private readonly fieldFeedback = new Map<HTMLInputElement | HTMLSelectElement, HTMLElement>();
  private nextFeedbackId = 0;
  private readonly observation = getElement<HTMLElement>("example-observation");
  private readonly retainedNotice = getElement<HTMLElement>("accepted-problem-notice");
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
    this.listen(this.preset, "change", () => {
      callbacks.onPreset(this.preset.value as WavePresetId | "custom");
    });
    this.bindInput(this.domain, "domainKind");
    this.bindInput(this.T, "T");
    this.bindInput(this.xMin, "xMin");
    this.bindInput(this.xMax, "xMax");
    this.bindInput(this.domainLeft, "domainLeft");
    this.bindInput(this.domainRight, "domainRight");

    this.listen(getElement<HTMLButtonElement>("add-displacement-piece"), "click", () =>
      callbacks.onPieceAdd("f")
    );
    this.listen(getElement<HTMLButtonElement>("add-velocity-piece"), "click", () =>
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
    getElement<HTMLButtonElement>("add-displacement-piece").disabled = draft.f.length >= 16;
    getElement<HTMLButtonElement>("add-velocity-piece").disabled = draft.g.length >= 16;
    this.renderErrors(viewModel.errors, draft);
    const observation = viewModel.presetId === "custom"
      ? ""
      : getWavePresetObservation(viewModel.presetId, draft.domainKind);
    if (this.observation.textContent !== observation) this.observation.textContent = observation;
    this.observation.hidden = observation.length === 0;
    this.retainedNotice.hidden = !viewModel.acceptedProblem ||
      (viewModel.status !== "invalid" && viewModel.status !== "error");
  }

  focusLast(source: PieceSource): void {
    Array.from(this.rows[source].values()).at(-1)?.expression.focus();
  }

  focusFirstError(): void {
    getElement<HTMLElement>("problem-form")
      .querySelector<HTMLInputElement | HTMLSelectElement>('[aria-invalid="true"]')?.focus();
  }

  dispose(): void {
    this.eventController.abort();
    this.fieldFeedback.clear();
    this.rows.f.clear();
    this.rows.g.clear();
  }

  private listen(element: HTMLElement, event: string, listener: () => void): void {
    element.addEventListener(event, listener, { signal: this.eventController.signal });
  }

  private renderErrors(errors: readonly ProblemNotice[], draft: WaveAppViewModel["draft"]): void {
    const messages = new Map<HTMLInputElement | HTMLSelectElement, string[]>();
    const link = (input: HTMLInputElement | HTMLSelectElement, message: string): void => {
      const existing = messages.get(input) ?? [];
      if (!existing.includes(message)) existing.push(message);
      messages.set(input, existing);
    };
    for (const error of errors) {
      const path = error.path ?? "";
      const scalarFields: Record<string, (HTMLInputElement | HTMLSelectElement)[]> = {
        T: [this.T], "view.xMin": [this.xMin], "view.xMax": [this.xMax],
        view: [this.xMin, this.xMax], "domain.left": [this.domainLeft],
        "domain.right": [this.domainRight], "domain.kind": [this.domain],
        domain: draft.domainKind === "finite" ? [this.domainLeft, this.domainRight] : [this.domain]
      };
      for (const input of scalarFields[path] ?? []) link(input, error.message);
      const boundary = /^boundaries\.(left|right)(?:\.(kind|expression))?$/.exec(path);
      if (boundary) {
        const input = boundary[1] === "left"
          ? boundary[2] === "kind" ? this.leftType : this.leftExpression
          : boundary[2] === "kind" ? this.rightType : this.rightExpression;
        link(input, error.message);
      }
      const piecePath = /^(f|g)(?:\[(\d+)\])?(?:\.(expression|lower|upper|bounds))?$/.exec(path);
      if (!piecePath) continue;
      const source = piecePath[1] as PieceSource;
      const index = piecePath[2] === undefined ? null : Number(piecePath[2]);
      draft[source].forEach((piece, pieceIndex) => {
        if (index !== null && index !== pieceIndex) return;
        const row = this.rows[source].get(piece.id);
        if (!row) return;
        const field = piecePath[3];
        const inputs = field === "expression" ? [row.expression]
          : field === "lower" ? [row.lower]
            : field === "upper" ? [row.upper] : [row.lower, row.upper];
        inputs.forEach((input) => link(input, error.message));
      });
    }
    for (const [input, feedback] of this.fieldFeedback) {
      if (!input.isConnected) {
        this.fieldFeedback.delete(input);
        continue;
      }
      if (!messages.has(input)) {
        input.removeAttribute("aria-invalid");
        const descriptions = (input.getAttribute("aria-describedby") ?? "")
          .split(/\s+/).filter((id) => id && id !== feedback.id);
        if (descriptions.length) input.setAttribute("aria-describedby", descriptions.join(" "));
        else input.removeAttribute("aria-describedby");
        feedback.hidden = true;
      }
    }
    for (const [input, message] of messages) {
      let feedback = this.fieldFeedback.get(input);
      if (!feedback) {
        feedback = document.createElement("span");
        feedback.id = `problem-field-error-${this.nextFeedbackId++}`;
        feedback.className = "field-error";
        input.parentElement?.append(feedback);
        this.fieldFeedback.set(input, feedback);
      }
      const text = message.join(" ");
      if (feedback.textContent !== text) feedback.textContent = text;
      feedback.hidden = false;
      input.setAttribute("aria-invalid", "true");
      const descriptions = new Set((input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
      descriptions.add(feedback.id);
      input.setAttribute("aria-describedby", [...descriptions].join(" "));
    }
  }

  private bindInput(element: HTMLInputElement | HTMLSelectElement, field: ScalarDraftField): void {
    this.listen(element, "input", () => this.callbacks.onScalar(field, element.value));
    if (element instanceof HTMLSelectElement) {
      this.listen(element, "change", () => this.callbacks.onScalar(field, element.value));
    }
  }

  private bindBoundary(
    element: HTMLInputElement | HTMLSelectElement,
    side: BoundarySide,
    field: BoundaryDraftField
  ): void {
    const event = element instanceof HTMLSelectElement ? "change" : "input";
    this.listen(element, event, () => this.callbacks.onBoundary(side, field, element.value));
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
      const name = source === "f" ? "Initial displacement" : "Initial velocity";
      row.expression.setAttribute("aria-label", `${name} expression, interval ${index + 1}`);
      row.lower.setAttribute("aria-label", `${name} interval ${index + 1} lower bound`);
      row.upper.setAttribute("aria-label", `${name} interval ${index + 1} upper bound`);
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
    expression.setAttribute("aria-describedby", `${source === "f" ? "displacement" : "velocity"}-syntax-hint`);
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
    expression.parentElement?.classList.add("piece-field--expression");
    for (const [field, input] of [
      ["expression", expression],
      ["lower", lower],
      ["upper", upper]
    ] as const) {
      this.listen(input, "input", () =>
        this.callbacks.onPieceInput(source, piece.id, field, input.value)
      );
    }
    this.listen(remove, "click", () => {
      const ids = [...this.rows[source].keys()];
      const index = ids.indexOf(piece.id);
      const neighbor = ids[index + 1] ?? ids[index - 1];
      this.callbacks.onPieceRemove(source, piece.id);
      if (neighbor) this.rows[source].get(neighbor)?.expression.focus();
    });
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
  if (labelText === "f(x)" || labelText === "g(x)") renderLatex(caption, labelText);
  else caption.textContent = labelText;
  label.append(caption, input);
  return label;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}.`);
  return element as T;
}
