import type { WaveProblem, WaveSolutionGrid } from "../types";
import { createWaveEvaluator, type WaveEvaluator } from "../math/solver";
import { clampGridTime, sampleSlice, sampleSolutionGrid } from "./sampling";

export interface SampledProfile {
  /** Repeated x coordinates encode the two sides of a vertical jump. */
  x: Float64Array;
  values: Float32Array;
}

/** One accepted solution owns one sampler shared by both synchronized plots. */
export interface ProfileSampler {
  readonly grid: WaveSolutionGrid;
  sample(time: number): SampledProfile;
  initial(): SampledProfile;
  valueAt(x: number, time: number): number;
}

export function createProfileSampler(
  problem: WaveProblem,
  grid: WaveSolutionGrid,
  topology: "smooth" | "stepped"
): ProfileSampler {
  let evaluator: WaveEvaluator | null = null;
  const exact = (x: number, time: number): number => {
    evaluator ??= createWaveEvaluator(problem);
    return evaluator.evaluate(x, time);
  };
  let cachedTime = Number.NaN;
  let cached: SampledProfile;
  let initial: SampledProfile | null = null;
  const minimumX = Number(grid.x[0]);
  const maximumX = Number(grid.x[grid.x.length - 1]);
  const sample = (requestedTime: number): SampledProfile => {
    const time = clampGridTime(grid, requestedTime);
    if (time === cachedTime) return cached;
    if (topology === "smooth") {
      cached = { x: grid.x, values: sampleSlice(grid, time) };
    } else {
      // Interpolating time rows mixes opposite sides of a moving front and
      // invents intermediate plateaus. Evaluate this time once instead; both
      // plots reuse it. Only candidate fronts need additional evaluations.
      evaluator ??= createWaveEvaluator(problem);
      evaluator.prepareSurface(grid.x, new Float64Array([time]));
      const values = Float32Array.from(grid.x, (x) => exact(x, time));
      const xOutput: number[] = [];
      const valueOutput: number[] = [];
      const scale = Math.max(1e-12, grid.surfaceRange.max - grid.surfaceRange.min);
      const threshold = scale * 0.02;
      for (let index = 0; index < grid.x.length; index += 1) {
        const rightX = Number(grid.x[index]);
        const rightValue = Number(values[index]);
        if (index > 0) {
          let left = Number(grid.x[index - 1]);
          let right = rightX;
          let leftValue = Number(values[index - 1]);
          let candidateRightValue = rightValue;
          const originalDifference = Math.abs(rightValue - leftValue);
          if (originalDifference >= threshold) {
            // A genuine jump retains a finite difference under refinement;
            // a resolved steep smooth slope loses it. Keep smooth samples as
            // sampled instead of converting every large derivative to a wall.
            for (let refinement = 0; refinement < 28; refinement += 1) {
              const middle = (left + right) / 2;
              if (middle === left || middle === right) break;
              const middleValue = exact(middle, time);
              if (Math.abs(middleValue - leftValue) >= Math.abs(candidateRightValue - middleValue)) {
                right = middle;
                candidateRightValue = middleValue;
              } else {
                left = middle;
                leftValue = middleValue;
              }
              if (Math.abs(candidateRightValue - leftValue) < originalDifference * 0.45) break;
            }
            if (Math.abs(candidateRightValue - leftValue) >= originalDifference * 0.45) {
              const front = (left + right) / 2;
              xOutput.push(front, front);
              valueOutput.push(leftValue, candidateRightValue);
            }
          }
        }
        xOutput.push(rightX);
        valueOutput.push(rightValue);
      }
      cached = { x: new Float64Array(xOutput), values: new Float32Array(valueOutput) };
    }
    cachedTime = time;
    return cached;
  };
  return {
    grid,
    sample,
    initial: () => {
      if (!initial) {
        const profile = sample(0);
        initial = { x: profile.x.slice(), values: profile.values.slice() };
      }
      return initial;
    },
    valueAt: (x, requestedTime) => {
      const time = clampGridTime(grid, requestedTime);
      const position = Math.max(minimumX, Math.min(maximumX, x));
      return topology === "stepped"
        ? exact(position, time)
        : sampleSolutionGrid(grid, position, time);
    }
  };
}
