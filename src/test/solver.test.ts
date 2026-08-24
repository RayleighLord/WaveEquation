import { describe, expect, it } from "vitest";
import {
  createWaveEvaluator,
  sampleSolution,
  solveWaveProblem
} from "../math/solver";
import { createWaveProblem } from "../math/problem";
import { getWavePresetProblem } from "../math/presets";
import type {
  BoundaryConditionDraft,
  BoundaryKind,
  WaveProblemInput
} from "../types";

describe("semianalytic wave solver", () => {
  it("matches d'Alembert's formula on the infinite line", () => {
    const evaluator = createWaveEvaluator(createWaveProblem({
      c: 1,
      T: 2,
      domain: { kind: "infinite" },
      view: { xMin: -3, xMax: 3 },
      f: [{ id: "f", expression: "cos(x)", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "0", lower: "-inf", upper: "inf" }],
      boundaries: {}
    }));
    for (const [x, t] of [[0.3, 0.7], [-1.2, 1.1], [2, 0.2]] as const) {
      expect(evaluator.evaluate(x, t)).toBeCloseTo(Math.cos(x) * Math.cos(t), 10);
    }
  });

  it("integrates velocity-only initial data", () => {
    const evaluator = createWaveEvaluator(createWaveProblem({
      c: 2,
      T: 2,
      domain: { kind: "infinite" },
      view: { xMin: -2, xMax: 2 },
      f: [{ id: "f", expression: "0", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "1", lower: "-inf", upper: "inf" }],
      boundaries: {}
    }));
    expect(evaluator.evaluate(-0.4, 1.25)).toBeCloseTo(1.25, 9);
  });

  it.each([
    ["dirichlet", "dirichlet", "sin(pi * x)", Math.PI],
    ["neumann", "neumann", "cos(pi * x)", Math.PI],
    ["dirichlet", "neumann", "sin(pi * x / 2)", Math.PI / 2],
    ["neumann", "dirichlet", "cos(pi * x / 2)", Math.PI / 2]
  ] as const)(
    "matches the finite %s/%s eigenmode",
    (leftKind, rightKind, expression, waveNumber) => {
      const problem = eigenmodeProblem(leftKind, rightKind, expression);
      const evaluator = createWaveEvaluator(problem);
      const x = 0.37;
      const t = 1.63;
      const phi =
        expression.startsWith("sin")
          ? Math.sin(waveNumber * x)
          : Math.cos(waveNumber * x);
      expect(evaluator.evaluate(x, t)).toBeCloseTo(
        phi * Math.cos(waveNumber * t),
        8
      );
    }
  );

  it.each([
    ["dirichlet", "dirichlet"],
    ["neumann", "neumann"],
    ["dirichlet", "neumann"],
    ["neumann", "dirichlet"]
  ] as const)(
    "propagates repeated nonzero %s/%s boundary data",
    (leftKind, rightKind) => {
      // u=x+t is an exact homogeneous-wave solution with u_x=1.
      const boundary = (kind: BoundaryKind, side: "left" | "right") => ({
        kind,
        expression:
          kind === "neumann" ? "1" : side === "left" ? "t" : "1 + t"
      });
      const problem = createWaveProblem({
        c: 1,
        T: 3,
        domain: { kind: "finite", left: 0, right: 1 },
        view: { xMin: 0, xMax: 1 },
        f: [{ id: "f", expression: "x", lower: 0, upper: 1 }],
        g: [{ id: "g", expression: "1", lower: 0, upper: 1 }],
        boundaries: {
          left: boundary(leftKind, "left"),
          right: boundary(rightKind, "right")
        }
      });
      expect(createWaveEvaluator(problem).evaluate(0.37, 2.4)).toBeCloseTo(
        2.77,
        8
      );
    }
  );

  it("applies time-dependent Dirichlet and Neumann boundary data", () => {
    const dirichlet = createWaveEvaluator(drivenHalfLine("dirichlet"));
    const neumann = createWaveEvaluator(drivenHalfLine("neumann"));
    const x = 0.25;
    const t = 0.8;
    expect(dirichlet.evaluate(x, t)).toBeCloseTo(Math.sin(t - x), 9);
    expect(neumann.evaluate(x, t)).toBeCloseTo(-(t - x), 8);
    expect(dirichlet.evaluate(1.2, t)).toBeCloseTo(0, 10);
  });

  it("inverts a pulse at a fixed end and preserves it at a free end", () => {
    const fixed = createWaveEvaluator(reflectingRightHalf("dirichlet"));
    const free = createWaveEvaluator(reflectingRightHalf("neumann"));
    // The left-moving unit pulse is centered at x=3 initially. At t=4 its
    // reflected center is x=1.
    expect(fixed.evaluate(1, 4)).toBeLessThan(-0.999);
    expect(free.evaluate(1, 4)).toBeGreaterThan(0.999);
  });

  it("splits the centered square-wave preset into equal traveling pulses", () => {
    const evaluator = createWaveEvaluator(
      getWavePresetProblem("square-wave", "infinite")
    );
    const t = Math.PI / 2;

    expect(evaluator.evaluate(0, 0)).toBeCloseTo(1, 12);
    expect(evaluator.evaluate(Math.PI, 0)).toBeCloseTo(0, 12);
    expect(evaluator.evaluate(0, t)).toBeCloseTo(0, 12);
    expect(evaluator.evaluate(-t, t)).toBeCloseTo(0.5, 12);
    expect(evaluator.evaluate(t, t)).toBeCloseTo(0.5, 12);
  });

  it("reflects correctly from the right endpoint of a left half-line", () => {
    const fixed = createWaveEvaluator(reflectingLeftHalf("dirichlet"));
    const free = createWaveEvaluator(reflectingLeftHalf("neumann"));
    expect(fixed.evaluate(-1, 4)).toBeLessThan(-0.999);
    expect(free.evaluate(-1, 4)).toBeGreaterThan(0.999);
  });

  it("returns a stable row-major grid and interpolates it", () => {
    const problem = getWavePresetProblem("gaussian-split");
    const result = solveWaveProblem(problem, {
      revision: 7,
      xSamples: 65,
      tSamples: 33
    });
    expect(result.revision).toBe(7);
    expect(result.x).toHaveLength(65);
    expect(result.t).toHaveLength(33);
    expect(result.values).toHaveLength(65 * 33);
    expect(result.surfaceRange).toEqual({ min: 0, max: 1 });
    expect(sampleSolution(result, 0, 0)).toBeCloseTo(1, 6);
    expect(sampleSolution(result, 0, 3)).toBeCloseTo(Math.exp(-36), 5);
  });

  it("precomputes nonzero velocity antiderivatives for a full surface", () => {
    const problem = getWavePresetProblem("fixed-end");
    const started = performance.now();
    const result = solveWaveProblem(problem);
    const elapsed = performance.now() - started;
    expect(result.x).toHaveLength(513);
    expect(result.t).toHaveLength(161);
    expect(result.reflectionCount).toBeGreaterThan(0);
    expect(result.timings.integrationMs).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(8_000);
  }, 10_000);

  it("conserves discrete energy for homogeneous finite boundaries", () => {
    const problem = eigenmodeProblem(
      "dirichlet",
      "dirichlet",
      "sin(pi * x)"
    );
    const grid = solveWaveProblem(problem, { xSamples: 257, tSamples: 257 });
    const first = discreteEnergy(grid, 48, problem.c);
    const second = discreteEnergy(grid, 176, problem.c);
    expect(Math.abs(second - first) / first).toBeLessThan(2e-3);
  });
});

function eigenmodeProblem(
  leftKind: BoundaryKind,
  rightKind: BoundaryKind,
  expression: string
) {
  return createWaveProblem({
    c: 1,
    T: 2,
    domain: { kind: "finite", left: 0, right: 1 },
    view: { xMin: 0, xMax: 1 },
    f: [{ id: "f", expression, lower: 0, upper: 1 }],
    g: [{ id: "g", expression: "0", lower: 0, upper: 1 }],
    boundaries: {
      left: { kind: leftKind, expression: "0" },
      right: { kind: rightKind, expression: "0" }
    }
  });
}

function drivenHalfLine(kind: BoundaryKind) {
  const boundary: BoundaryConditionDraft = {
    kind,
    expression: kind === "dirichlet" ? "sin(t)" : "1"
  };
  const input: WaveProblemInput = {
    c: 1,
    T: 2,
    domain: { kind: "right-half-line", left: 0 },
    view: { xMin: 0, xMax: 2 },
    f: [{ id: "f", expression: "0", lower: 0, upper: "inf" }],
    g: [{ id: "g", expression: "0", lower: 0, upper: "inf" }],
    boundaries: { left: boundary }
  };
  return createWaveProblem(input);
}

function reflectingLeftHalf(kind: BoundaryKind) {
  return createWaveProblem({
    c: 1,
    T: 6,
    domain: { kind: "left-half-line", right: 0 },
    view: { xMin: -9, xMax: 0 },
    f: [
      {
        id: "f",
        expression: "exp(-4 * (x + 3)^2)",
        lower: "-inf",
        upper: 0
      }
    ],
    g: [
      {
        id: "g",
        expression: "8 * (x + 3) * exp(-4 * (x + 3)^2)",
        lower: "-inf",
        upper: 0
      }
    ],
    boundaries: { right: { kind, expression: "0" } }
  });
}

function reflectingRightHalf(kind: BoundaryKind) {
  return createWaveProblem({
    c: 1,
    T: 6,
    domain: { kind: "right-half-line", left: 0 },
    view: { xMin: 0, xMax: 9 },
    f: [
      {
        id: "f",
        expression: "exp(-4 * (x - 3)^2)",
        lower: 0,
        upper: "inf"
      }
    ],
    g: [
      {
        id: "g",
        expression: "-8 * (x - 3) * exp(-4 * (x - 3)^2)",
        lower: 0,
        upper: "inf"
      }
    ],
    boundaries: { left: { kind, expression: "0" } }
  });
}

function discreteEnergy(
  grid: ReturnType<typeof solveWaveProblem>,
  timeIndex: number,
  c: number
): number {
  const width = grid.x.length;
  const dx = (grid.x[1] as number) - (grid.x[0] as number);
  const dt = (grid.t[1] as number) - (grid.t[0] as number);
  let total = 0;
  for (let xIndex = 1; xIndex < width - 1; xIndex += 1) {
    const previousTime = grid.values[(timeIndex - 1) * width + xIndex] as number;
    const nextTime = grid.values[(timeIndex + 1) * width + xIndex] as number;
    const left = grid.values[timeIndex * width + xIndex - 1] as number;
    const right = grid.values[timeIndex * width + xIndex + 1] as number;
    const velocity = (nextTime - previousTime) / (2 * dt);
    const slope = (right - left) / (2 * dx);
    total += 0.5 * (velocity * velocity + c * c * slope * slope) * dx;
  }
  return total;
}
