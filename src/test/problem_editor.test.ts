import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EditablePiece,
  PieceDraftField,
  PieceSource,
  WaveAppViewModel
} from "../ui/controller";
import { ProblemEditor } from "../ui/problem-editor";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ProblemEditor retained input interaction", () => {
  it("links validation to fields without changing focus, caret, or existing descriptions", () => {
    hydrateProblemEditorShell();
    const editor = new ProblemEditor(emptyCallbacks());
    const view = makeEditorView();
    editor.render(view);
    const input = document.querySelector<HTMLInputElement>('#displacement-piece-list .piece-expression')!;
    input.focus();
    input.setSelectionRange(1, 1);
    const originalDescriptions = input.getAttribute("aria-describedby")!;
    editor.render({ ...view, status: "invalid", errors: [{
      code: "invalid-expression", severity: "error", message: "Use only x here.", path: "f[0].expression"
    }] });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(1);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const feedbackId = input.getAttribute("aria-describedby")!.split(" ").find((id) => id !== originalDescriptions)!;
    expect(document.getElementById(feedbackId)?.textContent).toBe("Use only x here.");
    editor.render(view);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.getAttribute("aria-describedby")).toBe(originalDescriptions);
    expect(document.getElementById(feedbackId)?.hidden).toBe(true);
    expect(document.activeElement).toBe(input);
    editor.dispose();
  });

  it("links scalar and boundary errors and focuses errors only on explicit request", () => {
    hydrateProblemEditorShell();
    const editor = new ProblemEditor(emptyCallbacks());
    const view = makeEditorView();
    editor.render(view);
    const T = document.getElementById("final-time-input")!;
    const boundary = document.getElementById("left-boundary-expression")!;
    boundary.focus();
    editor.render({ ...view, status: "invalid", errors: [
      { code: "invalid-number", severity: "error", message: "Enter a constant time.", path: "T" },
      { code: "invalid-expression", severity: "error", message: "Use only t.", path: "boundaries.left.expression" }
    ] });
    expect(T.getAttribute("aria-invalid")).toBe("true");
    expect(boundary.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(boundary);
    editor.focusFirstError();
    expect(document.activeElement).toBe(T);
    editor.dispose();
  });

  it("switches the observation with the preset domain and removes listeners on disposal", () => {
    hydrateProblemEditorShell();
    const callbacks = emptyCallbacks();
    const editor = new ProblemEditor(callbacks);
    const view = makeEditorView();
    editor.render({ ...view, presetId: "gaussian-split", draft: { ...view.draft, domainKind: "infinite" } });
    expect(document.getElementById("example-observation")?.textContent).toBe("");
    expect(document.getElementById("example-observation")?.hidden).toBe(true);
    editor.render({ ...view, presetId: "gaussian-split", draft: { ...view.draft, domainKind: "right-half-line" } });
    expect(document.getElementById("example-observation")?.textContent).toContain("Neumann");
    const input = document.getElementById("final-time-input")!;
    input.dispatchEvent(new Event("input"));
    expect(callbacks.onScalar).toHaveBeenCalledTimes(1);
    editor.dispose();
    input.dispatchEvent(new Event("input"));
    expect(callbacks.onScalar).toHaveBeenCalledTimes(1);
  });

  it("moves focus to a neighboring retained interval after removing a row", () => {
    hydrateProblemEditorShell();
    let view = makeEditorView();
    view.draft.f.push({ id: "second-f", expression: "0", lower: "4", upper: "8" });
    const editor = new ProblemEditor({ ...emptyCallbacks(), onPieceRemove: (source, id) => {
      view = { ...view, draft: { ...view.draft, [source]: view.draft[source].filter((piece) => piece.id !== id) } };
      editor.render(view);
    } });
    editor.render(view);
    const neighbor = document.querySelector<HTMLInputElement>('[data-piece-id="second-f"] .piece-expression');
    const remove = document.querySelector<HTMLButtonElement>('#displacement-piece-list .remove-piece-button')!;
    remove.focus();
    remove.click();
    expect(document.activeElement).toBe(neighbor);
    expect(document.querySelectorAll('#displacement-piece-list .piece-row')).toHaveLength(1);
    editor.dispose();
  });

  it.each([
    ["f", "expression", ".piece-expression", "+1"],
    ["f", "lower", ".piece-lower", ".5"],
    ["f", "upper", ".piece-upper", " * pi"],
    ["g", "expression", ".piece-expression", "+x"],
    ["g", "lower", ".piece-lower", ".5"],
    ["g", "upper", ".piece-upper", " * pi"]
  ] as const)(
    "keeps focus and the caret in the %s %s field while its controlled draft renders",
    (source, field, selector, insertion) => {
      hydrateProblemEditorShell();
      let viewModel = makeEditorView();
      let editor: ProblemEditor;
      editor = new ProblemEditor({
        onPreset: vi.fn(),
        onScalar: vi.fn(),
        onPieceInput: (
          nextSource: PieceSource,
          id: string,
          nextField: PieceDraftField,
          value: string
        ) => {
          const pieces = viewModel.draft[nextSource].map((piece) =>
            piece.id === id ? { ...piece, [nextField]: value } : piece
          );
          viewModel = {
            ...viewModel,
            draft: { ...viewModel.draft, [nextSource]: pieces }
          };
          editor.render(viewModel);
        },
        onPieceAdd: vi.fn(),
        onPieceRemove: vi.fn(),
        onBoundary: vi.fn()
      });
      editor.render(viewModel);

      const container = document.getElementById(
        source === "f" ? "displacement-piece-list" : "velocity-piece-list"
      );
      const input = container?.querySelector<HTMLInputElement>(selector);
      expect(input).not.toBeNull();
      const retainedRow = input?.closest(".piece-row");
      const initialLength = input?.value.length ?? 0;
      input?.focus();
      input?.setRangeText(insertion, initialLength, initialLength, "end");
      input?.dispatchEvent(new Event("input", { bubbles: true }));

      const expectedCaret = initialLength + insertion.length;
      expect(document.activeElement).toBe(input);
      expect(input?.selectionStart).toBe(expectedCaret);
      expect(input?.selectionEnd).toBe(expectedCaret);
      expect(container?.querySelector(".piece-row")).toBe(retainedRow);
      expect(viewModel.draft[source][0]?.[field]).toBe(input?.value);
    }
  );
});

function emptyCallbacks() {
  return {
    onPreset: vi.fn(), onScalar: vi.fn(), onPieceInput: vi.fn(),
    onPieceAdd: vi.fn(), onPieceRemove: vi.fn(), onBoundary: vi.fn()
  };
}

function hydrateProblemEditorShell(): void {
  const html = readFileSync("index.html", "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = page.body.innerHTML;
}

function makeEditorView(): WaveAppViewModel {
  const f: EditablePiece[] = [
    { id: "editor-f", expression: "4*x", lower: "0", upper: "4" }
  ];
  const g: EditablePiece[] = [
    { id: "editor-g", expression: "0", lower: "0", upper: "4" }
  ];
  return {
    draft: {
      domainKind: "finite",
      T: "3",
      xMin: "0",
      xMax: "4",
      domainLeft: "0",
      domainRight: "4",
      f,
      g,
      boundaries: {
        left: { kind: "dirichlet", expression: "0" },
        right: { kind: "dirichlet", expression: "0" }
      }
    },
    presetId: "custom",
    problemName: "Custom problem",
    status: "editing",
    statusMessage: "Editing…",
    errors: [],
    warnings: [],
    acceptedProblem: null,
    result: null,
    pendingRevision: null
  };
}
