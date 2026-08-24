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
