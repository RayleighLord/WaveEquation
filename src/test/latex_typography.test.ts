import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTimeTicks,
  formatCurrentTime,
  problemFormulaLatex,
  renderStaticLatex,
  renderTimeOutput,
  waveEquationLatex
} from "../app";
import { createWaveProblem } from "../math";
import { SnapshotRenderer } from "../plot/SnapshotRenderer";
import type {
  BoundaryKind,
  SpatialDomain,
  WaveProblemInput
} from "../types";
import type { WaveAppViewModel } from "../ui/controller";
import { boundaryDataSymbolLatex, ProblemEditor } from "../ui/problem-editor";
import { makeGrid } from "./plot_fixtures";

afterEach(() => {
  document.body.replaceChildren();
});

describe("KaTeX interface typography", () => {
  it("keeps the problem-card mathematics at the requested twenty-percent enlargement", () => {
    const styles = readFileSync("src/styles/main.css", "utf8");
    expect(styles).toContain("font-size: clamp(0.684rem, 0.852vw, 0.828rem);");
    expect(styles).toContain("font-size: clamp(0.768rem, 3.24vw, 1.056rem);");
  });

  it("renders every snapshot tick and axis label as retained KaTeX in SVG foreign objects", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.setSolution(makeGrid());

    const ticks = renderer.svg.querySelectorAll(".snapshot-tick");
    const axisLabels = renderer.svg.querySelectorAll(".snapshot-axis-label");
    expect(ticks).toHaveLength(16);
    expect(axisLabels).toHaveLength(2);
    expect(renderer.svg.querySelectorAll("foreignObject.snapshot-tick .katex")).toHaveLength(16);
    expect(renderer.svg.querySelectorAll("foreignObject.snapshot-axis-label .katex")).toHaveLength(2);
    expect(renderer.svg.querySelectorAll(".snapshot-axes > text")).toHaveLength(0);

    const retainedAxisLabel = axisLabels[0]?.querySelector(".katex");
    renderer.setTime(0.5);
    expect(axisLabels[0]?.querySelector(".katex")).toBe(retainedAxisLabel);
    renderer.dispose();
  });

  it("hydrates all static variable labels declared by the page with real KaTeX", () => {
    const html = readFileSync("index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    renderStaticLatex(page);

    const selectors = [
      "label[for='final-time-input'] [data-latex]",
      "label[for='domain-left-input'] [data-latex]",
      "label[for='domain-right-input'] [data-latex]",
      "label[for='view-x-min-input'] [data-latex]",
      "label[for='view-x-max-input'] [data-latex]",
      "[data-piece-editor='displacement'] .math-hint",
      "[data-piece-editor='velocity'] .math-hint",
      "#left-boundary-fields legend [data-latex]",
      "#right-boundary-fields legend [data-latex]",
      "#left-boundary-symbol",
      "#right-boundary-symbol",
      "#problem-formula-math",
      "label[for='time-slider'] [data-latex]"
    ];
    for (const selector of selectors) {
      expect(page.querySelector(`${selector} .katex`), selector).not.toBeNull();
    }

    expect(page.querySelector("#snapshot-time-output")).toBeNull();
    expect(page.querySelector("#wave-speed-input")).toBeNull();
    expect(page.querySelector("#domain-select option[value='left-half-line']")).toBeNull();
    expect(
      Array.from(page.querySelectorAll("#domain-select option")).map((option) => option.textContent)
    ).toEqual(["Infinite", "Semi-infinite", "Finite"]);
    expect(
      Array.from(page.querySelectorAll("#preset-select option")).map((option) => option.textContent)
    ).toEqual([
      "Gaussian Pulse",
      "Square Wave",
      "One-Sided Pulse",
      "Finite standing wave",
      "Mixed boundaries",
      "Forced Wave",
      "Custom"
    ]);
    expect(page.querySelector<HTMLOptionElement>("#preset-select option[value='custom']")?.disabled)
      .toBe(false);
    expect(page.querySelector<HTMLInputElement>("#domain-left-input")?.type).toBe("text");
    expect(page.querySelector<HTMLInputElement>("#domain-right-input")?.type).toBe("text");
    expect(page.querySelector<HTMLInputElement>("#final-time-input")?.type).toBe("text");
    expect(page.querySelector<HTMLInputElement>("#view-x-min-input")?.type).toBe("text");
    expect(page.querySelector<HTMLInputElement>("#view-x-max-input")?.type).toBe("text");
    expect(page.querySelectorAll("[title]")).toHaveLength(0);
    expect(page.querySelector("#restart-button")?.getAttribute("aria-keyshortcuts")).toBe("R");
    expect(page.querySelector("#ui-toggle")?.getAttribute("aria-keyshortcuts")).toBe("H");
    const viewBoundsRow = page.querySelector(".view-bounds-row");
    expect(viewBoundsRow?.parentElement?.classList.contains("field-grid--domain")).toBe(true);
    expect(Array.from(viewBoundsRow?.children ?? []).map((field) => field.getAttribute("for")))
      .toEqual(["view-x-min-input", "view-x-max-input"]);
    const timeOutput = page.querySelector("#time-output");
    expect(timeOutput?.getAttribute("aria-label")).toBe("Time 0.000");
    expect(page.querySelector("#time-slider")?.getAttribute("aria-valuetext"))
      .toBe("time 0.000");
    expect(page.querySelector("#problem-menu .eyebrow")).toBeNull();
    const problemFormula = page.querySelector("#problem-formula");
    expect(problemFormula?.parentElement?.id).toBe("problem-control");
    expect(problemFormula?.previousElementSibling?.classList.contains("problem-control__header"))
      .toBe(true);
    expect(problemFormula?.nextElementSibling?.id).toBe("problem-menu");
    expect(problemFormula?.classList.contains("view-controls-companion")).toBe(false);
    expect(page.querySelector("#left-boundary-type option[value='dirichlet']")?.textContent)
      .toBe("Dirichlet");
    expect(page.querySelector("#left-boundary-type option[value='neumann']")?.textContent)
      .toBe("Neumann");
    expect(page.querySelector("#right-boundary-type option[value='dirichlet']")?.textContent)
      .toBe("Dirichlet");
    expect(page.querySelector("#right-boundary-type option[value='neumann']")?.textContent)
      .toBe("Neumann");
    expect(page.querySelector("#snapshot-section .snapshot-heading")).toBeNull();
    expect(page.querySelector("#snapshot-title")?.classList.contains("visually-hidden")).toBe(
      true
    );
  });

  it("uses retained KaTeX for time ticks and the native time output", () => {
    const ticks = document.createElement("div");
    createTimeTicks(ticks, 3);
    expect(ticks.querySelectorAll(".time-tick .katex")).toHaveLength(5);

    const mainTime = document.createElement("output");
    renderTimeOutput(mainTime, 0.75, "Time");
    expect(mainTime.querySelector(".katex")).not.toBeNull();
    expect(mainTime.getAttribute("aria-label")).toBe("Time 0.750");
    expect(mainTime.dataset.latexSource).toBe("t=0.750");

    const retainedTime = mainTime.querySelector(".katex");
    renderTimeOutput(mainTime, 0.75, "Time");
    expect(mainTime.querySelector(".katex")).toBe(retainedTime);

    renderTimeOutput(mainTime, 1, "Time");
    expect(mainTime.getAttribute("aria-label")).toBe("Time 1.000");
    expect(mainTime.dataset.latexSource).toBe("t=1.000");
    expect(formatCurrentTime(0.00418)).toBe("0.004");
  });

  it("keeps both view bounds in one two-column row for every domain layout", () => {
    const styles = readFileSync("src/styles/main.css", "utf8");
    expect(styles).toMatch(
      /\.view-bounds-row\s*\{[^}]*display:\s*grid;[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s
    );
  });

  it("uses the same symbolic boundary-data names in the editor and problem card", () => {
    expect(waveEquationLatex()).toBe(String.raw`u_{tt}-u_{xx}=0`);
    expect(boundaryDataSymbolLatex("left", "dirichlet")).toBe(String.raw`h_L(t)`);
    expect(boundaryDataSymbolLatex("left", "neumann")).toBe(String.raw`q_L(t)`);
    expect(boundaryDataSymbolLatex("right", "dirichlet")).toBe(String.raw`h_R(t)`);
    expect(boundaryDataSymbolLatex("right", "neumann")).toBe(String.raw`q_R(t)`);
  });

  it("updates the rendered boundary-data labels when either condition kind changes", () => {
    const html = readFileSync("index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    document.body.innerHTML = page.body.innerHTML;
    renderStaticLatex(document);
    const editor = new ProblemEditor({
      onPreset: () => undefined,
      onScalar: () => undefined,
      onPieceInput: () => undefined,
      onPieceAdd: () => undefined,
      onPieceRemove: () => undefined,
      onBoundary: () => undefined
    });

    editor.render(makeEditorView("neumann", "dirichlet"));
    expect(document.querySelector<HTMLElement>("#left-boundary-symbol")?.dataset.latexSource)
      .toBe(String.raw`q_L(t)`);
    expect(document.querySelector<HTMLElement>("#right-boundary-symbol")?.dataset.latexSource)
      .toBe(String.raw`h_R(t)`);
    expect(document.querySelector<HTMLInputElement>("#left-boundary-expression")?.ariaLabel)
      .toBe("Left boundary data q sub L of t");

    editor.render(makeEditorView("dirichlet", "neumann"));
    expect(document.querySelector<HTMLElement>("#left-boundary-symbol")?.dataset.latexSource)
      .toBe(String.raw`h_L(t)`);
    expect(document.querySelector<HTMLElement>("#right-boundary-symbol")?.dataset.latexSource)
      .toBe(String.raw`q_R(t)`);
    expect(document.querySelector<HTMLInputElement>("#right-boundary-expression")?.ariaLabel)
      .toBe("Right boundary data q sub R of t");
  });

  it("forwards an explicit Custom example selection without replacing the editor", () => {
    const html = readFileSync("index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    document.body.innerHTML = page.body.innerHTML;
    const selections: string[] = [];
    new ProblemEditor({
      onPreset: (id) => selections.push(id),
      onScalar: () => undefined,
      onPieceInput: () => undefined,
      onPieceAdd: () => undefined,
      onPieceRemove: () => undefined,
      onBoundary: () => undefined
    });
    const select = document.querySelector<HTMLSelectElement>("#preset-select")!;
    select.value = "custom";
    select.dispatchEvent(new Event("change"));
    expect(selections).toEqual(["custom"]);
  });

  it.each(SYMBOLIC_PROBLEM_CASES)(
    "renders exact symbolic TeX for $name",
    ({ domain, boundaries, expected }) => {
      const source = problemFormulaLatex(makeSymbolicProblem(domain, boundaries));
      expect(source).toBe(expected);
      expect(source).not.toContain("1.75");
      expect(source).not.toContain("8.5");
    }
  );
});

interface SymbolicProblemCase {
  name: string;
  domain: SpatialDomain;
  boundaries: { left?: BoundaryKind; right?: BoundaryKind };
  expected: string;
}

const SYMBOLIC_PROBLEM_CASES: readonly SymbolicProblemCase[] = [
  {
    name: "the infinite line",
    domain: { kind: "infinite" },
    boundaries: {},
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in \mathbb{R}\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\end{cases}`
  },
  {
    name: "a right half-line with Dirichlet data",
    domain: { kind: "right-half-line", left: 2 },
    boundaries: { left: "dirichlet" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in [a,\infty)\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u(a,t)=h_L(t)\end{cases}`
  },
  {
    name: "a right half-line with Neumann data",
    domain: { kind: "right-half-line", left: 2 },
    boundaries: { left: "neumann" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in [a,\infty)\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u_x(a,t)=q_L(t)\end{cases}`
  },
  {
    name: "a left half-line with Dirichlet data",
    domain: { kind: "left-half-line", right: 9 },
    boundaries: { right: "dirichlet" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in (-\infty,b]\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u(b,t)=h_R(t)\end{cases}`
  },
  {
    name: "a left half-line with Neumann data",
    domain: { kind: "left-half-line", right: 9 },
    boundaries: { right: "neumann" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in (-\infty,b]\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u_x(b,t)=q_R(t)\end{cases}`
  },
  {
    name: "a finite interval with Dirichlet-Dirichlet data",
    domain: { kind: "finite", left: 2, right: 9 },
    boundaries: { left: "dirichlet", right: "dirichlet" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in [a,b]\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u(a,t)=h_L(t),\qquad u(b,t)=h_R(t)\end{cases}`
  },
  {
    name: "a finite interval with Dirichlet-Neumann data",
    domain: { kind: "finite", left: 2, right: 9 },
    boundaries: { left: "dirichlet", right: "neumann" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in [a,b]\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u(a,t)=h_L(t),\qquad u_x(b,t)=q_R(t)\end{cases}`
  },
  {
    name: "a finite interval with Neumann-Dirichlet data",
    domain: { kind: "finite", left: 2, right: 9 },
    boundaries: { left: "neumann", right: "dirichlet" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in [a,b]\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u_x(a,t)=q_L(t),\qquad u(b,t)=h_R(t)\end{cases}`
  },
  {
    name: "a finite interval with Neumann-Neumann data",
    domain: { kind: "finite", left: 2, right: 9 },
    boundaries: { left: "neumann", right: "neumann" },
    expected: String.raw`\begin{cases}u_{tt}-u_{xx}=0,\qquad (x,t)\in [a,b]\times(0,T]\\u(x,0)=f(x),\qquad u_t(x,0)=g(x)\\u_x(a,t)=q_L(t),\qquad u_x(b,t)=q_R(t)\end{cases}`
  }
];

function makeSymbolicProblem(
  domain: SpatialDomain,
  kinds: { left?: BoundaryKind; right?: BoundaryKind }
) {
  const lower = domain.kind === "right-half-line" || domain.kind === "finite"
    ? domain.left
    : "-inf";
  const upper = domain.kind === "left-half-line" || domain.kind === "finite"
    ? domain.right
    : "inf";
  const boundaries: WaveProblemInput["boundaries"] = {};
  if (kinds.left) boundaries.left = { kind: kinds.left, expression: "0" };
  if (kinds.right) boundaries.right = { kind: kinds.right, expression: "0" };
  return createWaveProblem({
    c: 1.75,
    T: 8.5,
    domain,
    view: {
      xMin: domain.kind === "right-half-line" || domain.kind === "finite" ? domain.left : -4,
      xMax: domain.kind === "left-half-line" || domain.kind === "finite" ? domain.right : 10
    },
    f: [{ id: "symbolic-f", expression: "0", lower, upper }],
    g: [{ id: "symbolic-g", expression: "0", lower, upper }],
    boundaries
  });
}

function makeEditorView(
  left: BoundaryKind,
  right: BoundaryKind
): WaveAppViewModel {
  return {
    draft: {
      domainKind: "finite",
      T: "3",
      xMin: "0",
      xMax: "4",
      domainLeft: "0",
      domainRight: "4",
      f: [{ id: "editor-f", expression: "0", lower: "0", upper: "4" }],
      g: [{ id: "editor-g", expression: "0", lower: "0", upper: "4" }],
      boundaries: {
        left: { kind: left, expression: "0" },
        right: { kind: right, expression: "0" }
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

function sizedHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
  document.body.append(host);
  return host;
}
