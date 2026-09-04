import { describe, expect, it } from "vitest";
import { createWaveProblem } from "../math/problem";
import {
  integratePiecewise,
  PiecewiseAntiderivative
} from "../math/quadrature";

describe("refinement-checked piecewise quadrature", () => {
  it("does not mistake commensurate sinusoidal samples for a zero integral", () => {
    const problem = velocityProblem("sin(32 * x)^2");
    expect(integratePiecewise(problem.g, 0, Math.PI)).toBeCloseTo(Math.PI / 2, 8);

    const rapidlyOscillating = velocityProblem("sin(2000 * pi * x)^2");
    const prepared = new PiecewiseAntiderivative(rapidlyOscillating.g, 0);
    prepared.precompute(Array.from({ length: 1001 }, (_, index) => index / 1000));
    expect(prepared.at(1)).toBeCloseTo(0.5, 8);
  });

  it.each([0.01, -0.013, 0.377])("resolves a narrow shifted Gaussian at %s", (center) => {
    const problem = velocityProblem(`10000 * exp(-10000000000 * (x - (${center}))^2)`);
    const expected = Math.sqrt(Math.PI) / 10;
    expect(integratePiecewise(problem.g, -1, 1)).toBeCloseTo(expected, 8);
    const prepared = new PiecewiseAntiderivative(problem.g, 0);
    prepared.precompute([-1, -0.5, 0, 0.5, 1]);
    expect(prepared.integral(-1, 1)).toBeCloseTo(expected, 8);
  });
  it("splits the integral at declared piece boundaries", () => {
    const problem = createWaveProblem({
      c: 1,
      T: 1,
      domain: { kind: "infinite" },
      view: { xMin: -2, xMax: 2 },
      f: [{ id: "f", expression: "0", lower: "-inf", upper: "inf" }],
      g: [
        { id: "left", expression: "1 + x", lower: -1, upper: 0 },
        { id: "right", expression: "1 - x", lower: 0, upper: 1 }
      ],
      boundaries: {}
    });
    expect(integratePiecewise(problem.g, -2, 2)).toBeCloseTo(1, 10);
  });

  it("refines oscillatory expressions and builds an equivalent cumulative table", () => {
    const problem = createWaveProblem({
      c: 1,
      T: 1,
      domain: { kind: "infinite" },
      view: { xMin: 0, xMax: Math.PI },
      f: [{ id: "f", expression: "0", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "sin(37 * x)", lower: 0, upper: Math.PI }],
      boundaries: {}
    });
    const exact = 2 / 37;
    expect(integratePiecewise(problem.g, 0, Math.PI)).toBeCloseTo(exact, 8);
    const antiderivative = new PiecewiseAntiderivative(problem.g, 0);
    antiderivative.precompute([Math.PI, Math.PI / 3, 2 * Math.PI / 3]);
    expect(antiderivative.at(Math.PI)).toBeCloseTo(exact, 8);
  });

  it("keeps dense prepared-array lookups refinement-checked and exact", () => {
    const problem = createWaveProblem({
      c: 1,
      T: 1,
      domain: { kind: "infinite" },
      view: { xMin: 0, xMax: Math.PI },
      f: [{ id: "f", expression: "0", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "sin(37 * x)", lower: 0, upper: Math.PI }],
      boundaries: {}
    });
    const coordinates = Array.from(
      { length: 2_001 },
      (_, index) => (Math.PI * index) / 2_000
    );
    const antiderivative = new PiecewiseAntiderivative(problem.g, 0);
    antiderivative.precompute(coordinates);
    const elapsedAfterPreparation = antiderivative.elapsedMs;
    for (const index of [0, 1, 113, 997, 1_777, 2_000]) {
      const x = coordinates[index] as number;
      expect(antiderivative.at(x)).toBeCloseTo((1 - Math.cos(37 * x)) / 37, 8);
    }
    expect(antiderivative.elapsedMs).toBe(elapsedAfterPreparation);
  });

  it("resolves the dense Gaussian-velocity antiderivative", () => {
    const problem = createWaveProblem({
      c: 1,
      T: 1,
      domain: { kind: "right-half-line", left: 0 },
      view: { xMin: 0, xMax: 6 },
      f: [{ id: "f", expression: "0", lower: 0, upper: "inf" }],
      g: [{
        id: "g",
        expression: "-8 * (x - 3) * exp(-4 * (x - 3)^2)",
        lower: 0,
        upper: "inf"
      }],
      boundaries: { left: { kind: "dirichlet", expression: "0" } }
    });
    const coordinates = Array.from({ length: 2_001 }, (_, index) => 6 * index / 2_000);
    const antiderivative = new PiecewiseAntiderivative(problem.g, 0);
    antiderivative.precompute(coordinates);
    for (const index of [0, 127, 1_000, 1_731, 2_000]) {
      const x = coordinates[index] as number;
      const exact = Math.exp(-4 * (x - 3) ** 2) - Math.exp(-36);
      expect(antiderivative.at(x)).toBeCloseTo(exact, 8);
    }
  });
});

function velocityProblem(expression: string) {
  return createWaveProblem({
    c: 1,
    T: 1,
    domain: { kind: "infinite" },
    view: { xMin: -1, xMax: 1 },
    f: [{ id: "f", expression: "0", lower: "-inf", upper: "inf" }],
    g: [{ id: "g", expression, lower: "-inf", upper: "inf" }],
    boundaries: {}
  });
}
