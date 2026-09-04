import { describe, expect, it } from "vitest";

import {
  ACCEPTED_SPATIAL_OVERSAMPLE,
  ACCEPTED_TIME_OVERSAMPLE,
  MAX_SURFACE_T_INTERVALS,
  REFERENCE_SPATIAL_SPACING,
  REFERENCE_TIME_SPACING,
  adaptiveAcceptedSampleCounts,
  adaptiveSurfaceSampleCounts,
  createWaveProblem,
  getWavePresetProblem,
  hasSpatialJump,
  samplingResolutionNotices,
  solveWaveProblem,
  waveProblemMayHaveDiscontinuousDisplacement,
  type ProductDomainKind,
  type WavePresetId
} from "../math";

const DOMAINS: readonly ProductDomainKind[] = [
  "infinite",
  "right-half-line",
  "finite"
];

const EXPECTED = {
  "gaussian-split": [[513, 161], [513, 161], [513, 129]],
  "square-wave": [[1025, 401], [1025, 401], [1025, 401]],
  "fixed-end": [[641, 121], [513, 321], [513, 321]],
  "standing-wave": [[513, 129], [513, 129], [513, 129]],
  "mixed-boundaries": [[513, 257], [513, 257], [513, 257]],
  "boundary-driven": [[513, 121], [513, 401], [513, 401]]
} as const satisfies Record<WavePresetId, readonly (readonly [number, number])[]>;

describe("adaptive wave-surface resolution", () => {
  it("plans cut resolution for single-expression and boundary-generated steps", () => {
    const initial = createWaveProblem({
      c: 1, T: 2, domain: { kind: "infinite" }, view: { xMin: -2, xMax: 2 },
      f: [{ id: "f", expression: "sign(x)", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "0", lower: "-inf", upper: "inf" }], boundaries: {}
    });
    const driven = createWaveProblem({
      c: 1, T: 2, domain: { kind: "right-half-line", left: 0 }, view: { xMin: 0, xMax: 4 },
      f: [{ id: "f", expression: "0", lower: 0, upper: "inf" }],
      g: [{ id: "g", expression: "0", lower: 0, upper: "inf" }],
      boundaries: { left: { kind: "dirichlet", expression: "(1 + sign(t - 1)) / 2" } }
    });
    for (const problem of [initial, driven]) {
      expect(waveProblemMayHaveDiscontinuousDisplacement(problem)).toBe(true);
      expect(adaptiveAcceptedSampleCounts(problem).xSamples).toBe(1025);
      expect(hasSpatialJump(solveWaveProblem(problem, { xSamples: 33, tSamples: 33 }))).toBe(true);
    }
  });

  it("does not misclassify spatially uniform time changes as jumps", () => {
    const problem = createWaveProblem({
      c: 1, T: 2, domain: { kind: "infinite" }, view: { xMin: -2, xMax: 2 },
      f: [{ id: "f", expression: "0", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "100", lower: "-inf", upper: "inf" }], boundaries: {}
    });
    expect(hasSpatialJump(solveWaveProblem(problem, { xSamples: 17, tSamples: 3 }))).toBe(false);
  });

  it("warns about narrow shifted displacement without duplicating notices", () => {
    const problem = createWaveProblem({
      c: 1, T: 8, domain: { kind: "infinite" }, view: { xMin: -6, xMax: 6 },
      f: [{ id: "f", expression: "exp(-1000000 * (x - 0.01)^2) + exp(-1000000 * (x + 0.01)^2)", lower: "-inf", upper: "inf" }],
      g: [{ id: "g", expression: "0", lower: "-inf", upper: "inf" }], boundaries: {}
    });
    const notices = samplingResolutionNotices(problem, 12 / 512, 0.05);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: "sampling-resolution", path: "f" });
    expect(samplingResolutionNotices(problem, 0.00001, 0.05)).toHaveLength(0);
  });

  it("uses the deterministic source count matrix for all 18 example variants", () => {
    for (const [preset, expectedDomains] of Object.entries(EXPECTED) as Array<
      [WavePresetId, typeof EXPECTED[WavePresetId]]
    >) {
      DOMAINS.forEach((domain, index) => {
        const problem = getWavePresetProblem(preset, domain);
        const counts = adaptiveAcceptedSampleCounts(problem);
        expect([counts.xSamples, counts.tSamples], `${preset}/${domain}`)
          .toEqual(expectedDomains[index]);
        expect(counts.xSamples % 2).toBe(1);
        expect(counts.tSamples % 2).toBe(1);
      });
    }
  });

  it("preserves exact stride-two render subsets including both endpoints", () => {
    for (const preset of Object.keys(EXPECTED) as WavePresetId[]) {
      for (const domain of DOMAINS) {
        const problem = getWavePresetProblem(preset, domain);
        const topology = waveProblemMayHaveDiscontinuousDisplacement(problem)
          ? "stepped"
          : "smooth";
        const source = adaptiveAcceptedSampleCounts(problem);
        const surface = adaptiveSurfaceSampleCounts(
          problem.T,
          problem.view.xMin,
          problem.view.xMax,
          topology
        );
        expect(source.xSamples - 1).toBe(
          (surface.xSamples - 1) * ACCEPTED_SPATIAL_OVERSAMPLE
        );
        expect(source.tSamples - 1).toBe(
          (surface.tSamples - 1) * ACCEPTED_TIME_OVERSAMPLE
        );
      }
    }
  });

  it("distinguishes true displacement jumps from truncated smooth tails", () => {
    expect(waveProblemMayHaveDiscontinuousDisplacement(
      getWavePresetProblem("gaussian-split", "right-half-line")
    )).toBe(false);
    for (const domain of DOMAINS) {
      expect(waveProblemMayHaveDiscontinuousDisplacement(
        getWavePresetProblem("square-wave", domain)
      )).toBe(true);
    }
  });

  it("keeps uncapped physical spacing no coarser than the reference surface", () => {
    const gaussian = getWavePresetProblem("gaussian-split", "infinite");
    const surface = adaptiveSurfaceSampleCounts(
      gaussian.T,
      gaussian.view.xMin,
      gaussian.view.xMax,
      "smooth"
    );
    expect(
      (gaussian.view.xMax - gaussian.view.xMin) / (surface.xSamples - 1)
    ).toBeLessThanOrEqual(REFERENCE_SPATIAL_SPACING);
    expect(gaussian.T / (surface.tSamples - 1))
      .toBeLessThanOrEqual(REFERENCE_TIME_SPACING);
  });

  it("grows monotonically with T and exposes the temporal cap", () => {
    const counts = [3, 8, 12, 20, 40].map((T) =>
      adaptiveSurfaceSampleCounts(T, -6, 6, "smooth").tSamples
    );
    expect(counts).toEqual([...counts].sort((left, right) => left - right));
    expect(counts.at(-1)).toBe(MAX_SURFACE_T_INTERVALS + 1);
  });
});
