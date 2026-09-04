import { describe, expect, it } from "vitest";
import { createWaveProblem } from "../math/problem";
import { solveWaveProblem } from "../math/solver";
import { createProfileSampler, sampleSlice } from "../plot";

function profileFor(expression: string, topology: "smooth" | "stepped" = "stepped") {
  const problem = createWaveProblem({
    c: 1, T: 1, domain: { kind: "infinite" }, view: { xMin: -2, xMax: 2 },
    f: [{ id: "f", expression, lower: "-inf", upper: "inf" }],
    g: [{ id: "g", expression: "0", lower: "-inf", upper: "inf" }], boundaries: {}
  });
  const grid = solveWaveProblem(problem, { xSamples: 401, tSamples: 21 });
  return { grid, sampler: createProfileSampler(problem, grid, topology) };
}

describe("shared wave profiles", () => {
  it("moves exact fronts between time rows without inventing intermediate plateaus", () => {
    const { sampler } = profileFor("(1 + sign(x)) / 2");
    const time = 0.371;
    const profile = sampler.sample(time);
    expect(new Set(profile.values)).toEqual(new Set([0, 0.5, 1]));
    const fronts = Array.from(profile.x).filter((x, index) => index > 0 && x === profile.x[index - 1]);
    expect(fronts).toHaveLength(2);
    expect(fronts[0]).toBeCloseTo(-time, 8);
    expect(fronts[1]).toBeCloseTo(time, 8);
    expect(sampler.valueAt(time - 0.001, time)).toBe(0.5);
    expect(sampler.valueAt(time + 0.001, time)).toBe(1);
    expect(sampler.sample(time)).toBe(profile);
    const later = sampler.sample(0.419);
    const laterFronts = Array.from(later.x).filter((x, index) => index > 0 && x === later.x[index - 1]);
    expect(laterFronts[0]).toBeCloseTo(-0.419, 8);
    expect(laterFronts[1]).toBeCloseTo(0.419, 8);
  });

  it("preserves smooth interpolation and caches an unchanged initial comparison", () => {
    const { grid, sampler } = profileFor("exp(-x^2)", "smooth");
    const initial = sampler.initial();
    const profile = sampler.sample(0.371);
    expect(profile.x).toBe(grid.x);
    expect(profile.values).toEqual(sampleSlice(grid, 0.371));
    expect(sampler.initial()).toBe(initial);
    expect(initial.values).toEqual(sampleSlice(grid, 0));
  });

  it("does not replace steep but continuous variation with vertical jump vertices", () => {
    const { grid, sampler } = profileFor("tanh(100 * x)");
    const profile = sampler.sample(0.371);
    expect(profile.x.length).toBe(grid.x.length);
    for (let index = 0; index < profile.x.length; index += 1) {
      const x = Number(profile.x[index]);
      expect(profile.values[index]).toBeCloseTo((Math.tanh(100 * (x - 0.371)) + Math.tanh(100 * (x + 0.371))) / 2, 6);
    }
  });
});
