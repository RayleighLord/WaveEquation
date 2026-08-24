import { describe, expect, it } from "vitest";
import { traceCharacteristics } from "../math/characteristics";
import { createWaveProblem } from "../math/problem";
import { sampleSolution, solveWaveProblem } from "../math/solver";

describe("characteristic tracing", () => {
  it("draws complete reflected paths to the initial line", () => {
    const problem = createWaveProblem({
      c: 1,
      T: 3,
      domain: { kind: "finite", left: 0, right: 1 },
      view: { xMin: 0, xMax: 1 },
      f: [{ id: "f", expression: "sin(pi * x)", lower: 0, upper: 1 }],
      g: [{ id: "g", expression: "0", lower: 0, upper: 1 }],
      boundaries: {
        left: { kind: "dirichlet", expression: "0" },
        right: { kind: "dirichlet", expression: "0" }
      }
    });
    const grid = solveWaveProblem(problem, { xSamples: 81, tSamples: 121 });
    const trace = traceCharacteristics(problem, grid, 0.25, 2.4);
    expect(trace.left.points[0]).toEqual(trace.point);
    expect(trace.right.points[0]).toEqual(trace.point);
    expect(trace.left.points.at(-1)?.t).toBe(0);
    expect(trace.right.points.at(-1)?.t).toBe(0);
    expect(trace.hits.length).toBeGreaterThanOrEqual(4);
    expect(trace.footpoints).toHaveLength(2);
    expect(trace.footpoints.every((point) => point.t === 0)).toBe(true);
    for (const path of [trace.left, trace.right]) {
      for (let index = 1; index < path.points.length; index += 1) {
        const before = path.points[index - 1] as (typeof path.points)[number];
        const after = path.points[index] as (typeof path.points)[number];
        expect(after.t).toBeLessThanOrEqual(before.t);
        const dt = before.t - after.t;
        expect(Math.abs(after.x - before.x)).toBeCloseTo(problem.c * dt, 8);
      }
      for (const point of path.points) {
        expect(point.u).toBeCloseTo(sampleSolution(grid, point.x, point.t), 7);
      }
    }
  });

  it("uses unbroken rays when the domain has no boundary", () => {
    const problem = createWaveProblem({
      c: 2,
      T: 1,
      domain: { kind: "infinite" },
      view: { xMin: -3, xMax: 3 },
      f: [{ id: "f", expression: "exp(-x^2)", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "0", lower: "-inf", upper: "inf" }],
      boundaries: {}
    });
    const grid = solveWaveProblem(problem, { xSamples: 61, tSamples: 41 });
    const trace = traceCharacteristics(problem, grid, 0.2, 0.75);
    expect(trace.hits).toHaveLength(0);
    expect(trace.left.points.at(-1)?.x).toBeCloseTo(-1.3);
    expect(trace.right.points.at(-1)?.x).toBeCloseTo(1.7);
  });
});
