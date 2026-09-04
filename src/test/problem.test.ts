import { describe, expect, it } from "vitest";
import {
  createWaveProblem,
  evaluatePiecewise,
  validateWaveProblem
} from "../math/problem";
import {
  getWavePreset,
  getWavePresetInput,
  getWavePresetProblem,
  WAVE_PRESETS
} from "../math/presets";
import { solveWaveProblem } from "../math/solver";
import type { WaveProblemInput } from "../types";
import type { ProductDomainKind } from "../math/presets";

const DOMAIN_KINDS: readonly ProductDomainKind[] = [
  "infinite",
  "right-half-line",
  "finite"
];

describe("wave problem validation", () => {
  it("reports non-finite compatibility probes as structured errors", () => {
    const input: WaveProblemInput = {
      c: 1, T: 1,
      domain: { kind: "right-half-line", left: 0 },
      view: { xMin: 0, xMax: 1 },
      f: [{ id: "f", expression: "1 / (x - 0.00001)", lower: 0, upper: "inf" }],
      g: [{ id: "g", expression: "0", lower: 0, upper: "inf" }],
      boundaries: { left: { kind: "neumann", expression: "0" } }
    };
    const result = validateWaveProblem(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-expression", path: "f" })
    ]));
  });

  it("keeps finite weak corner data explorable", () => {
    const input = finiteInput();
    input.f = [{ id: "f", expression: "sqrt(x)", lower: 0, upper: 1 }];
    input.boundaries = {
      left: { kind: "neumann", expression: "0" },
      right: { kind: "dirichlet", expression: "1" }
    };
    const result = validateWaveProblem(input);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "neumann-compatibility" })
    ]));
  });

  it("does not probe outside a short boundary time interval", () => {
    const input = finiteInput();
    input.T = 1e-10;
    input.f = [{ id: "f", expression: "0", lower: 0, upper: 1 }];
    input.boundaries.left = { kind: "dirichlet", expression: "sqrt(t * (0.0000000001 - t))" };
    expect(validateWaveProblem(input).ok).toBe(true);
  });

  it("ships the requested example catalogue and domain-specific final times", () => {
    expect(WAVE_PRESETS.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "gaussian-split", name: "Gaussian Pulse" },
      { id: "square-wave", name: "Square Wave" },
      { id: "fixed-end", name: "One-Sided Pulse" },
      { id: "standing-wave", name: "Finite standing wave" },
      { id: "mixed-boundaries", name: "Mixed boundaries" },
      { id: "boundary-driven", name: "Forced Wave" }
    ]);
    expect(getWavePreset("free-end")).toBeUndefined();

    const expectedTimes = {
      "gaussian-split": [8, 8, 2 * Math.PI],
      "square-wave": [4 * Math.PI, 4 * Math.PI, 4 * Math.PI],
      "fixed-end": [6, 16, 16],
      "standing-wave": [2 * Math.PI, 2 * Math.PI, 2 * Math.PI],
      "mixed-boundaries": [4 * Math.PI, 4 * Math.PI, 4 * Math.PI],
      "boundary-driven": [6, 20, 20]
    } as const;
    for (const preset of WAVE_PRESETS) {
      const times = DOMAIN_KINDS.map((domain) =>
        getWavePresetInput(preset.id, domain).T
      );
      expect(times, preset.id).toEqual(expectedTimes[preset.id]);
    }
  });

  it("accepts every shipped preset", () => {
    for (const preset of WAVE_PRESETS) {
      const result = validateWaveProblem(getWavePresetInput(preset.id));
      expect(result.ok, preset.id).toBe(true);
      expect(getWavePresetProblem(preset.id).signature).toContain("wave-v1");
    }
  });

  it("validates and solves every shipped preset in every domain", () => {
    for (const preset of WAVE_PRESETS) {
      for (const domainKind of DOMAIN_KINDS) {
        const input = getWavePresetInput(preset.id, domainKind);
        const validation = validateWaveProblem(input);
        expect(validation.ok, `${preset.id}/${domainKind}`).toBe(true);
        if (!validation.ok) continue;
        expect(validation.problem.domain.kind).toBe(domainKind);
        expect(validation.problem.c).toBe(1);

        const grid = solveWaveProblem(validation.problem, {
          xSamples: 17,
          tSamples: 9
        });
        expect(grid.values.length, `${preset.id}/${domainKind}`).toBe(17 * 9);
        expect(
          Array.from(grid.values).every(Number.isFinite),
          `${preset.id}/${domainKind}`
        ).toBe(true);
      }
    }
  });

  it("returns isolated domain variants without changing preset metadata", () => {
    const metadataKind = WAVE_PRESETS.find(
      (preset) => preset.id === "fixed-end"
    )?.input.domain.kind;
    const finite = getWavePresetInput("fixed-end", "finite");
    finite.f[0]!.expression = "0";
    const again = getWavePresetInput("fixed-end", "finite");

    expect(metadataKind).toBe("right-half-line");
    expect(again.domain.kind).toBe("finite");
    expect(again.f[0]?.expression).not.toBe("0");
  });

  it("keeps pi-based finite preset bounds exact and round-trippable", () => {
    for (const id of ["standing-wave", "mixed-boundaries"] as const) {
      const input = getWavePresetInput(id);
      expect(input.f.map((piece) => piece.upper)).toEqual(["pi"]);
      expect(input.g.map((piece) => piece.upper)).toEqual(["pi"]);
      expect(validateWaveProblem(input).ok).toBe(true);
    }
  });

  it("ships a square wave with coherent exact-pi domain variants", () => {
    const infinite = getWavePresetInput("square-wave", "infinite");
    expect(infinite.T).toBe(4 * Math.PI);
    expect(infinite.view).toEqual({
      xMin: -2 * Math.PI,
      xMax: 2 * Math.PI
    });
    expect(infinite.f).toMatchObject([
      { expression: "1", lower: "-pi / 4", upper: "pi / 4" }
    ]);
    expect(infinite.boundaries).toEqual({});

    const halfLine = getWavePresetInput("square-wave", "right-half-line");
    expect(halfLine.T).toBe(4 * Math.PI);
    expect(halfLine.domain).toEqual({ kind: "right-half-line", left: 0 });
    expect(halfLine.view.xMax).toBe(3 * Math.PI);
    expect(halfLine.f).toMatchObject([
      {
        expression: "1",
        lower: "5 * pi / 4",
        upper: "7 * pi / 4"
      }
    ]);
    expect(halfLine.boundaries.left?.kind).toBe("neumann");

    const finite = getWavePresetInput("square-wave", "finite");
    expect(finite.T).toBe(4 * Math.PI);
    expect(finite.domain).toEqual({
      kind: "finite",
      left: 0,
      right: 2 * Math.PI
    });
    expect(finite.f.map(({ expression, lower, upper }) => ({
      expression,
      lower,
      upper
    }))).toEqual([
      { expression: "0", lower: 0, upper: "3 * pi / 4" },
      {
        expression: "1",
        lower: "3 * pi / 4",
        upper: "5 * pi / 4"
      },
      { expression: "0", lower: "5 * pi / 4", upper: "2 * pi" }
    ]);
    expect(finite.g[0]?.upper).toBe("2 * pi");
    expect(finite.boundaries.left?.kind).toBe("neumann");
    expect(finite.boundaries.right?.kind).toBe("neumann");

    for (const input of [infinite, halfLine, finite]) {
      expect(validateWaveProblem(input).ok).toBe(true);
    }
  });

  it("requires complete, ordered coverage on a finite interval", () => {
    const input = finiteInput();
    input.f = [
      { id: "f-left", expression: "x", lower: 0, upper: 0.4 },
      { id: "f-right", expression: "x", lower: 0.5, upper: 1 }
    ];
    const result = validateWaveProblem(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((item) => item.code === "piece-gap")).toBe(true);
  });

  it("treats omitted regions as zero on unbounded domains", () => {
    const problem = createWaveProblem({
      c: 1,
      T: 1,
      domain: { kind: "infinite" },
      view: { xMin: -3, xMax: 3 },
      f: [{ id: "compact", expression: "1 - x^2", lower: -1, upper: 1 }],
      g: [{ id: "zero", expression: "0", lower: -1, upper: 1 }],
      boundaries: {}
    });
    expect(evaluatePiecewise(problem.f, 0)).toBe(1);
    expect(evaluatePiecewise(problem.f, 2)).toBe(0);
  });

  it("rejects a direct Dirichlet corner contradiction", () => {
    const input = finiteInput();
    input.f = [{ id: "f", expression: "1", lower: 0, upper: 1 }];
    const result = validateWaveProblem(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((item) => item.code === "dirichlet-corner")).toBe(true);
    }
  });

  it("reports higher-order compatibility as a warning", () => {
    const input: WaveProblemInput = {
      c: 1,
      T: 1,
      domain: { kind: "right-half-line", left: 0 },
      view: { xMin: 0, xMax: 2 },
      f: [{ id: "f", expression: "0", lower: 0, upper: "inf" }],
      g: [{ id: "g", expression: "0", lower: 0, upper: "inf" }],
      boundaries: {
        left: { kind: "dirichlet", expression: "t" }
      }
    };
    const result = validateWaveProblem(input);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((item) => item.code === "dirichlet-compatibility")).toBe(true);
  });

  it("rejects finite problems beyond the complete reflection cap", () => {
    const input = finiteInput();
    input.T = 65;
    const result = validateWaveProblem(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((item) => item.code === "reflection-limit")).toBe(true);
    }
  });
});

function finiteInput(): WaveProblemInput {
  return {
    c: 1,
    T: 1,
    domain: { kind: "finite", left: 0, right: 1 },
    view: { xMin: 0, xMax: 1 },
    f: [{ id: "f", expression: "sin(pi * x)", lower: 0, upper: 1 }],
    g: [{ id: "g", expression: "0", lower: 0, upper: 1 }],
    boundaries: {
      left: { kind: "dirichlet", expression: "0" },
      right: { kind: "dirichlet", expression: "0" }
    }
  };
}
