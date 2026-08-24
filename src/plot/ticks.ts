const NICE_TICK_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

/** Numeric presentation used by an axis and its aligned grid. */
export type AxisValueNotation = "decimal" | "pi";

// These steps keep the most familiar subdivisions of pi available without
// producing labels such as 0.785 or 1.57. The larger powers also make the
// generator useful for time horizons spanning many complete periods.
const PI_STEP_MULTIPLIERS = [
  1 / 24,
  1 / 12,
  1 / 8,
  1 / 6,
  1 / 4,
  1 / 3,
  1 / 2,
  1,
  2,
  4,
  8,
  16
] as const;

/**
 * Return evenly spaced ticks on a pleasant decimal grid contained in the
 * supplied interval. The step is selected from 1, 2, 2.5, or 5 times a power
 * of ten, so labels remain readable without special-casing particular domains.
 */
export function niceAxisTicks(
  minimum: number,
  maximum: number,
  targetIntervals = 6
): number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
    return [];
  }

  const intervalTarget = Math.max(1, Math.floor(targetIntervals));
  const roughStep = (maximum - minimum) / intervalTarget;
  const exponent = Math.floor(Math.log10(roughStep));
  const power = 10 ** exponent;
  const normalizedStep = roughStep / power;
  const multiplier =
    NICE_TICK_MULTIPLIERS.find((candidate) => candidate >= normalizedStep - 1e-12) ?? 10;
  const step = multiplier * power;
  const tolerance = Math.max(
    step * 1e-10,
    Number.EPSILON * Math.max(Math.abs(minimum), Math.abs(maximum), 1) * 16
  );
  const firstIndex = Math.ceil((minimum - tolerance) / step);
  const lastIndex = Math.floor((maximum + tolerance) / step);
  const ticks: number[] = [];

  for (let index = firstIndex; index <= lastIndex && ticks.length < 100; index += 1) {
    const rounded = Number((index * step).toPrecision(12));
    ticks.push(Object.is(rounded, -0) ? 0 : rounded);
  }
  return ticks;
}

/**
 * Return an evenly spaced grid whose step is a familiar rational multiple of
 * pi. This is deliberately opt-in: decimal axes retain `niceAxisTicks` until
 * the accepted problem says its source bounds were written using pi.
 */
export function nicePiAxisTicks(
  minimum: number,
  maximum: number,
  targetIntervals = 6
): number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
    return [];
  }

  const intervalTarget = Math.max(1, Math.floor(targetIntervals));
  const roughMultiplier = (maximum - minimum) / (Math.PI * intervalTarget);
  let stepMultiplier = PI_STEP_MULTIPLIERS.find(
    (candidate) => candidate >= roughMultiplier - 1e-12
  );
  if (stepMultiplier === undefined) {
    stepMultiplier = 16;
    while (stepMultiplier < roughMultiplier - 1e-12) {
      stepMultiplier *= 2;
    }
  }

  const step = stepMultiplier * Math.PI;
  const tolerance = Math.max(
    step * 1e-10,
    Number.EPSILON * Math.max(Math.abs(minimum), Math.abs(maximum), 1) * 16
  );
  const firstIndex = Math.ceil((minimum - tolerance) / step);
  const lastIndex = Math.floor((maximum + tolerance) / step);
  const ticks: number[] = [];

  for (let index = firstIndex; index <= lastIndex && ticks.length < 100; index += 1) {
    const value = index * step;
    ticks.push(index === 0 || Object.is(value, -0) ? 0 : value);
  }
  return ticks;
}

/** Choose the aligned tick generator for the requested presentation. */
export function axisTicks(
  minimum: number,
  maximum: number,
  targetIntervals = 6,
  notation: AxisValueNotation = "decimal"
): number[] {
  return notation === "pi"
    ? nicePiAxisTicks(minimum, maximum, targetIntervals)
    : niceAxisTicks(minimum, maximum, targetIntervals);
}
