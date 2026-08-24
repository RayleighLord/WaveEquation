import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  axisTicks,
  axisValueToInputSource,
  axisValueToLatex,
  axisValueToText,
  SnapshotRenderer,
  SpaceTimeRenderer
} from "../plot";
import type { CharacteristicTrace, WaveSolutionGrid } from "../types";

describe("pi-aware plot notation", () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => null)
    });
  });

  afterEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: originalGetContext
    });
    document.body.replaceChildren();
  });

  it("formats familiar rational multiples of pi without changing decimal defaults", () => {
    expect(axisValueToLatex(Math.PI / 2)).toBe("1.57");
    expect(axisValueToLatex(0, "pi")).toBe("0");
    expect(axisValueToLatex(Math.PI, "pi")).toBe(String.raw`\pi`);
    expect(axisValueToLatex(-Math.PI / 2, "pi")).toBe(String.raw`-\frac{\pi}{2}`);
    expect(axisValueToLatex(3 * Math.PI / 4, "pi")).toBe(
      String.raw`\frac{3\pi}{4}`
    );
    expect(axisValueToText(-3 * Math.PI / 2, "pi")).toBe("−3π/2");
    expect(axisValueToInputSource(Math.PI, "pi")).toBe("pi");
    expect(axisValueToInputSource(-3 * Math.PI / 2, "pi"))
      .toBe("-3 * pi / 2");
    expect(axisValueToInputSource(3 * Math.PI / 4, "pi"))
      .toBe("3 * pi / 4");
    expect(axisValueToInputSource(0.799 * Math.PI, "pi"))
      .toBe("0.799 * pi");

    expect(axisTicks(0, 4 * Math.PI, 6, "pi").map((value) => value / Math.PI))
      .toEqual([0, 1, 2, 3, 4]);
    expect(axisTicks(-Math.PI, Math.PI, 6, "pi").map((value) =>
      Number((value / Math.PI).toFixed(12))
    )).toEqual([
      -1,
      -0.666666666667,
      -0.333333333333,
      0,
      0.333333333333,
      0.666666666667,
      1
    ]);
  });

  it("switches the retained snapshot grid and accessible footpoints to pi notation", () => {
    const renderer = new SnapshotRenderer(sizedHost(800, 260));
    renderer.setSolution(makePiGrid());
    expect(snapshotXSources(renderer)).toEqual(["0", "0.5", "1", "1.5", "2", "2.5", "3"]);

    renderer.setCharacteristics(makePiTrace());
    renderer.setAxisNotation("pi");

    expect(renderer.svg.dataset.xAxisNotation).toBe("pi");
    const sources = snapshotXSources(renderer);
    expect(sources[0]).toBe("0");
    expect(sources).toContain(String.raw`\frac{\pi}{2}`);
    expect(sources.at(-1)).toBe(String.raw`\pi`);
    expect(renderer.svg.querySelector("desc")?.textContent).toContain("red eta at x π/4");
    expect(renderer.svg.querySelector("desc")?.textContent).toContain("purple xi at x 3π/4");
    renderer.dispose();
  });

  it("aligns 3D pi grids and labels and formats eta and xi without expansions", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    renderer.setSolution(makePiGrid());
    renderer.setAxisNotation({ x: "pi", t: "pi" });

    expect(host.dataset.xAxisNotation).toBe("pi");
    expect(host.dataset.tAxisNotation).toBe("pi");
    expect(host.dataset.characteristicNotation).toBe("pi");
    const floor = renderer.scene.getObjectByName("x-t-grid") as THREE.LineSegments;
    expect((floor.userData.ticks.t as number[]).map((value) => value / Math.PI))
      .toEqual([0, 1, 2, 3, 4]);
    expect(labelSources(renderer, "t-axis-tick-")).toEqual([
      String.raw`\pi`,
      String.raw`2\pi`,
      String.raw`3\pi`,
      String.raw`4\pi`
    ]);
    expect(labelSources(renderer, "x-axis-tick-")).toContain(String.raw`\pi`);

    renderer.setCharacteristics(makePiTrace());
    const eta = renderer.scene.getObjectByName(
      "characteristic-left-initial-footpoint-label"
    ) as CSS2DObject;
    const xi = renderer.scene.getObjectByName(
      "characteristic-right-initial-footpoint-label"
    ) as CSS2DObject;
    expect(eta.element.dataset.latexSource).toBe(String.raw`\eta=\frac{\pi}{4}`);
    expect(xi.element.dataset.latexSource).toBe(String.raw`\xi=\frac{3\pi}{4}`);
    expect(`${eta.element.dataset.latexSource}${xi.element.dataset.latexSource}`)
      .not.toMatch(/x[+-]t/);
    renderer.dispose();
  });
});

function sizedHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
  document.body.append(host);
  return host;
}

function snapshotXSources(renderer: SnapshotRenderer): string[] {
  return Array.from(
    renderer.svg.querySelectorAll<SVGForeignObjectElement>(".snapshot-x-tick")
  ).map((label) => label.querySelector<HTMLElement>(".snapshot-latex-label")
    ?.dataset.latexSource ?? "");
}

function labelSources(renderer: SpaceTimeRenderer, prefix: string): string[] {
  const labels = renderer.scene.getObjectByName("axis-labels") as THREE.Group;
  return labels.children
    .filter((child) => child.name.startsWith(prefix))
    .map((child) => (child as CSS2DObject).element.dataset.latexSource ?? "");
}

function makePiGrid(): WaveSolutionGrid {
  return {
    revision: 12,
    problemSignature: "pi-axis-grid",
    x: new Float64Array([0, Math.PI / 2, Math.PI]),
    t: new Float64Array([0, 2 * Math.PI, 4 * Math.PI]),
    values: new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0
    ]),
    surfaceRange: { min: 0, max: 1 },
    warnings: [],
    timings: { totalMs: 1, integrationMs: 0.25, samplingMs: 0.75 },
    reflectionCount: 0
  };
}

function makePiTrace(): CharacteristicTrace {
  return {
    point: { x: Math.PI / 2, t: Math.PI / 4, u: 0.5 },
    left: {
      direction: -1,
      points: [
        { x: Math.PI / 2, t: Math.PI / 4, u: 0.5 },
        { x: Math.PI / 4, t: 0, u: 0.25 }
      ]
    },
    right: {
      direction: 1,
      points: [
        { x: Math.PI / 2, t: Math.PI / 4, u: 0.5 },
        { x: 3 * Math.PI / 4, t: 0, u: 0.25 }
      ]
    },
    hits: [],
    footpoints: [
      { path: "left", x: Math.PI / 4, t: 0, u: 0.25 },
      { path: "right", x: 3 * Math.PI / 4, t: 0, u: 0.25 }
    ]
  };
}
