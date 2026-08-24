import type { SpatialDomain, WaveProblem, WaveProblemInput } from "../types";
import { createWaveProblem } from "./problem";

export type WavePresetId =
  | "gaussian-split"
  | "square-wave"
  | "fixed-end"
  | "standing-wave"
  | "mixed-boundaries"
  | "boundary-driven";

/** Domain choices exposed by the product editor and shipped preset matrix. */
export type ProductDomainKind = Exclude<SpatialDomain["kind"], "left-half-line">;

export interface WavePreset {
  id: WavePresetId;
  name: string;
  description: string;
  input: WaveProblemInput;
}

export const DEFAULT_WAVE_PRESET_ID: WavePresetId = "gaussian-split";

export const WAVE_PRESETS: readonly WavePreset[] = Object.freeze([
  {
    id: "gaussian-split",
    name: "Gaussian Pulse",
    description: "A stationary Gaussian separates into equal left- and right-moving pulses.",
    input: {
      c: 1,
      T: 8,
      domain: { kind: "infinite" },
      view: { xMin: -6, xMax: 6 },
      f: [
        {
          id: "gaussian-f",
          expression: "exp(-4 * x^2)",
          lower: "-inf",
          upper: "inf"
        }
      ],
      g: [
        {
          id: "gaussian-g",
          expression: "0",
          lower: "-inf",
          upper: "inf"
        }
      ],
      boundaries: {}
    }
  },
  {
    id: "square-wave",
    name: "Square Wave",
    description: "A centered square displacement separates into two sharp traveling pulses.",
    input: {
      c: 1,
      T: 4 * Math.PI,
      domain: { kind: "infinite" },
      view: { xMin: -2 * Math.PI, xMax: 2 * Math.PI },
      f: [
        {
          id: "square-infinite-f",
          expression: "1",
          lower: "-pi / 4",
          upper: "pi / 4"
        }
      ],
      g: [
        {
          id: "square-infinite-g",
          expression: "0",
          lower: "-inf",
          upper: "inf"
        }
      ],
      boundaries: {}
    }
  },
  {
    id: "fixed-end",
    name: "One-Sided Pulse",
    description: "A left-moving pulse reflects from u(0,t)=0 with inverted sign.",
    input: {
      c: 1,
      T: 16,
      domain: { kind: "right-half-line", left: 0 },
      view: { xMin: 0, xMax: 9 },
      f: [
        {
          id: "fixed-f",
          expression: "exp(-4 * (x - 3)^2)",
          lower: 0,
          upper: "inf"
        }
      ],
      g: [
        {
          id: "fixed-g",
          expression: "-8 * (x - 3) * exp(-4 * (x - 3)^2)",
          lower: 0,
          upper: "inf"
        }
      ],
      boundaries: {
        left: { kind: "dirichlet", expression: "0" }
      }
    }
  },
  {
    id: "standing-wave",
    name: "Finite standing wave",
    description: "A normal mode between two fixed endpoints.",
    input: {
      c: 1,
      T: 2 * Math.PI,
      domain: { kind: "finite", left: 0, right: Math.PI },
      view: { xMin: 0, xMax: Math.PI },
      f: [
        {
          id: "standing-f",
          expression: "sin(2 * x)",
          lower: 0,
          upper: "pi"
        }
      ],
      g: [
        { id: "standing-g", expression: "0", lower: 0, upper: "pi" }
      ],
      boundaries: {
        left: { kind: "dirichlet", expression: "0" },
        right: { kind: "dirichlet", expression: "0" }
      }
    }
  },
  {
    id: "mixed-boundaries",
    name: "Mixed boundaries",
    description: "A mode fixed on the left and free on the right.",
    input: {
      c: 1,
      T: 4 * Math.PI,
      domain: { kind: "finite", left: 0, right: Math.PI },
      view: { xMin: 0, xMax: Math.PI },
      f: [
        {
          id: "mixed-f",
          expression: "sin(x / 2)",
          lower: 0,
          upper: "pi"
        }
      ],
      g: [
        { id: "mixed-g", expression: "0", lower: 0, upper: "pi" }
      ],
      boundaries: {
        left: { kind: "dirichlet", expression: "0" },
        right: { kind: "neumann", expression: "0" }
      }
    }
  },
  {
    id: "boundary-driven",
    name: "Forced Wave",
    description: "A decaying oscillation enters an initially quiet half-line.",
    input: {
      c: 1,
      T: 20,
      domain: { kind: "right-half-line", left: 0 },
      view: { xMin: 0, xMax: 9 },
      f: [
        { id: "driven-f", expression: "0", lower: 0, upper: "inf" }
      ],
      g: [
        { id: "driven-g", expression: "0", lower: 0, upper: "inf" }
      ],
      boundaries: {
        left: {
          kind: "dirichlet",
          expression: "sin(pi * t) * exp(-0.35 * t)"
        }
      }
    }
  }
]);

export const PRESET_DEFINITIONS = WAVE_PRESETS;

export function getWavePreset(id: WavePresetId | string): WavePreset | undefined {
  return WAVE_PRESETS.find((preset) => preset.id === id);
}

export function getWavePresetInput(
  id: WavePresetId | string = DEFAULT_WAVE_PRESET_ID,
  domainKind?: ProductDomainKind
): WaveProblemInput {
  const preset = getWavePreset(id);
  if (!preset) throw new Error(`Unknown wave problem preset "${id}".`);
  return cloneInput(
    domainKind === undefined
      ? preset.input
      : createDomainVariant(preset.id, domainKind)
  );
}

export function getWavePresetProblem(
  id: WavePresetId | string = DEFAULT_WAVE_PRESET_ID,
  domainKind?: ProductDomainKind
): WaveProblem {
  return createWaveProblem(getWavePresetInput(id, domainKind));
}

export const getDefaultWaveProblem = (): WaveProblem =>
  getWavePresetProblem(DEFAULT_WAVE_PRESET_ID);

/**
 * Build a complete initial-boundary value problem for a preset in the chosen
 * domain. These are whole variants rather than domain-only patches: interval
 * coverage, endpoint data, view bounds, and propagation direction must change
 * together when the domain changes.
 */
function createDomainVariant(
  id: WavePresetId,
  domainKind: ProductDomainKind
): WaveProblemInput {
  switch (id) {
    case "gaussian-split":
      return gaussianSplitVariant(domainKind);
    case "square-wave":
      return squareWaveVariant(domainKind);
    case "fixed-end":
      return fixedEndVariant(domainKind);
    case "standing-wave":
      return standingWaveVariant(domainKind);
    case "mixed-boundaries":
      return mixedBoundariesVariant(domainKind);
    case "boundary-driven":
      return boundaryDrivenVariant(domainKind);
  }
}

function squareWaveVariant(
  domainKind: ProductDomainKind
): WaveProblemInput {
  if (domainKind === "infinite") {
    return unboundedProblem(
      { kind: "infinite" },
      { xMin: -2 * Math.PI, xMax: 2 * Math.PI },
      4 * Math.PI,
      "1",
      "0",
      "square-infinite",
      { lower: "-pi / 4", upper: "pi / 4" }
    );
  }

  if (domainKind === "right-half-line") {
    return {
      ...unboundedProblem(
        { kind: "right-half-line", left: 0 },
        { xMin: 0, xMax: 3 * Math.PI },
        4 * Math.PI,
        "1",
        "0",
        "square-right",
        { lower: "5 * pi / 4", upper: "7 * pi / 4" }
      ),
      boundaries: { left: { kind: "neumann", expression: "0" } }
    };
  }

  return {
    c: 1,
    T: 4 * Math.PI,
    domain: { kind: "finite", left: 0, right: 2 * Math.PI },
    view: { xMin: 0, xMax: 2 * Math.PI },
    f: [
      {
        id: "square-finite-f-left",
        expression: "0",
        lower: 0,
        upper: "3 * pi / 4"
      },
      {
        id: "square-finite-f-middle",
        expression: "1",
        lower: "3 * pi / 4",
        upper: "5 * pi / 4"
      },
      {
        id: "square-finite-f-right",
        expression: "0",
        lower: "5 * pi / 4",
        upper: "2 * pi"
      }
    ],
    g: [
      {
        id: "square-finite-g",
        expression: "0",
        lower: 0,
        upper: "2 * pi"
      }
    ],
    boundaries: {
      left: { kind: "neumann", expression: "0" },
      right: { kind: "neumann", expression: "0" }
    }
  };
}

function gaussianSplitVariant(
  domainKind: ProductDomainKind
): WaveProblemInput {
  if (domainKind === "infinite") {
    return unboundedProblem(
      { kind: "infinite" },
      { xMin: -6, xMax: 6 },
      8,
      "exp(-4 * x^2)",
      "0",
      "gaussian"
    );
  }
  if (domainKind === "right-half-line") {
    return {
      ...unboundedProblem(
        { kind: "right-half-line", left: 0 },
        { xMin: 0, xMax: 9 },
        8,
        "exp(-4 * (x - 3)^2)",
        "0",
        "gaussian-right",
        { lower: 1, upper: 5 }
      ),
      boundaries: { left: { kind: "neumann", expression: "0" } }
    };
  }
  return finiteProblem({
    T: 2 * Math.PI,
    f: "sin(x) * exp(-4 * (x - pi / 2)^2)",
    g: "0",
    left: { kind: "dirichlet", expression: "0" },
    right: { kind: "dirichlet", expression: "0" },
    id: "gaussian-finite"
  });
}

function fixedEndVariant(domainKind: ProductDomainKind): WaveProblemInput {
  if (domainKind === "infinite") {
    return unboundedProblem(
      { kind: "infinite" },
      { xMin: -6, xMax: 9 },
      6,
      "exp(-4 * (x - 3)^2)",
      "-8 * (x - 3) * exp(-4 * (x - 3)^2)",
      "fixed-incident"
    );
  }
  if (domainKind === "finite") {
    return longFinitePulse("dirichlet", "fixed-finite", 16);
  }
  return {
    ...unboundedProblem(
      { kind: "right-half-line", left: 0 },
      { xMin: 0, xMax: 9 },
      16,
      "exp(-4 * (x - 3)^2)",
      "-8 * (x - 3) * exp(-4 * (x - 3)^2)",
      "fixed-right"
    ),
    boundaries: { left: { kind: "dirichlet", expression: "0" } }
  };
}

function standingWaveVariant(
  domainKind: ProductDomainKind
): WaveProblemInput {
  if (domainKind === "infinite") {
    return unboundedProblem(
      { kind: "infinite" },
      { xMin: -Math.PI, xMax: Math.PI },
      2 * Math.PI,
      "sin(2 * x)",
      "0",
      "standing-infinite"
    );
  }
  if (domainKind === "right-half-line") {
    return {
      ...unboundedProblem(
        { kind: "right-half-line", left: 0 },
        { xMin: 0, xMax: Math.PI },
        2 * Math.PI,
        "sin(2 * x)",
        "0",
        "standing-right"
      ),
      boundaries: { left: { kind: "dirichlet", expression: "0" } }
    };
  }
  return finiteProblem({
    T: 2 * Math.PI,
    f: "sin(2 * x)",
    g: "0",
    left: { kind: "dirichlet", expression: "0" },
    right: { kind: "dirichlet", expression: "0" },
    id: "standing-finite"
  });
}

function mixedBoundariesVariant(
  domainKind: ProductDomainKind
): WaveProblemInput {
  if (domainKind === "infinite") {
    return unboundedProblem(
      { kind: "infinite" },
      { xMin: -Math.PI, xMax: Math.PI },
      4 * Math.PI,
      "sin(x / 2)",
      "0",
      "mixed-infinite"
    );
  }
  if (domainKind === "right-half-line") {
    return {
      ...unboundedProblem(
        { kind: "right-half-line", left: 0 },
        { xMin: 0, xMax: 2 * Math.PI },
        4 * Math.PI,
        "sin(x / 2)",
        "0",
        "mixed-right"
      ),
      boundaries: { left: { kind: "dirichlet", expression: "0" } }
    };
  }
  return finiteProblem({
    T: 4 * Math.PI,
    f: "sin(x / 2)",
    g: "0",
    left: { kind: "dirichlet", expression: "0" },
    right: { kind: "neumann", expression: "0" },
    id: "mixed-finite"
  });
}

function boundaryDrivenVariant(
  domainKind: ProductDomainKind
): WaveProblemInput {
  if (domainKind === "infinite") {
    return unboundedProblem(
      { kind: "infinite" },
      { xMin: -6, xMax: 6 },
      6,
      "exp(-4 * (x + 3)^2)",
      "8 * (x + 3) * exp(-4 * (x + 3)^2)",
      "driven-analogue"
    );
  }
  const drive = {
    kind: "dirichlet" as const,
    expression: "sin(pi * t) * exp(-0.35 * t)"
  };
  if (domainKind === "right-half-line") {
    return {
      ...unboundedProblem(
        { kind: "right-half-line", left: 0 },
        { xMin: 0, xMax: 9 },
        20,
        "0",
        "0",
        "driven-right"
      ),
      boundaries: { left: drive }
    };
  }
  return finiteProblem({
    T: 20,
    f: "0",
    g: "0",
    left: drive,
    right: { kind: "dirichlet", expression: "0" },
    id: "driven-finite"
  });
}

function unboundedProblem(
  domain: Exclude<SpatialDomain, { kind: "finite" }>,
  view: WaveProblemInput["view"],
  T: number,
  f: string,
  g: string,
  id: string,
  support?: { lower: string | number; upper: string | number }
): WaveProblemInput {
  const bounds = support ?? domainPieceBounds(domain);
  return {
    c: 1,
    T,
    domain,
    view,
    f: [{ id: `${id}-f`, expression: f, ...bounds }],
    g: [{ id: `${id}-g`, expression: g, ...domainPieceBounds(domain) }],
    boundaries: {}
  };
}

function domainPieceBounds(
  domain: Exclude<SpatialDomain, { kind: "finite" }>
): { lower: string | number; upper: string | number } {
  if (domain.kind === "infinite") return { lower: "-inf", upper: "inf" };
  if (domain.kind === "right-half-line") {
    return { lower: domain.left, upper: "inf" };
  }
  return { lower: "-inf", upper: domain.right };
}

function finiteProblem(options: {
  T: number;
  f: string;
  g: string;
  left: NonNullable<WaveProblemInput["boundaries"]["left"]>;
  right: NonNullable<WaveProblemInput["boundaries"]["right"]>;
  id: string;
}): WaveProblemInput {
  return {
    c: 1,
    T: options.T,
    domain: { kind: "finite", left: 0, right: Math.PI },
    view: { xMin: 0, xMax: Math.PI },
    f: [
      {
        id: `${options.id}-f`,
        expression: options.f,
        lower: 0,
        upper: "pi"
      }
    ],
    g: [
      {
        id: `${options.id}-g`,
        expression: options.g,
        lower: 0,
        upper: "pi"
      }
    ],
    boundaries: { left: options.left, right: options.right }
  };
}

function longFinitePulse(
  boundaryKind: "dirichlet" | "neumann",
  id: string,
  T = 6
): WaveProblemInput {
  return {
    c: 1,
    T,
    domain: { kind: "finite", left: 0, right: 9 },
    view: { xMin: 0, xMax: 9 },
    f: [
      {
        id: `${id}-f`,
        expression: "exp(-4 * (x - 3)^2)",
        lower: 0,
        upper: 9
      }
    ],
    g: [
      {
        id: `${id}-g`,
        expression: "-8 * (x - 3) * exp(-4 * (x - 3)^2)",
        lower: 0,
        upper: 9
      }
    ],
    boundaries: {
      left: { kind: boundaryKind, expression: "0" },
      right: { kind: boundaryKind, expression: "0" }
    }
  };
}

function cloneInput(input: WaveProblemInput): WaveProblemInput {
  return {
    c: input.c,
    T: input.T,
    domain:
      input.domain.kind === "infinite"
        ? { kind: "infinite" }
        : input.domain.kind === "right-half-line"
          ? { kind: "right-half-line", left: input.domain.left }
          : input.domain.kind === "left-half-line"
            ? { kind: "left-half-line", right: input.domain.right }
            : {
                kind: "finite",
                left: input.domain.left,
                right: input.domain.right
              },
    view: { ...input.view },
    f: input.f.map((piece) => ({ ...piece })),
    g: input.g.map((piece) => ({ ...piece })),
    boundaries: {
      ...(input.boundaries.left
        ? { left: { ...input.boundaries.left } }
        : {}),
      ...(input.boundaries.right
        ? { right: { ...input.boundaries.right } }
        : {})
    }
  };
}
