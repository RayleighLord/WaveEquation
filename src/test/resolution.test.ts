import { describe, expect, it } from "vitest";

import {
  ACCEPTED_SPATIAL_OVERSAMPLE,
  ACCEPTED_TIME_OVERSAMPLE,
  MAX_SURFACE_T_INTERVALS,
  REFERENCE_SPATIAL_SPACING,
  REFERENCE_TIME_SPACING,
  adaptiveAcceptedSampleCounts,
  adaptiveSurfaceSampleCounts,
  getWavePresetProblem,
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
