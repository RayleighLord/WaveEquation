import { afterEach, describe, expect, it } from "vitest";

import { niceAxisTicks, SnapshotRenderer } from "../plot";
import { makeGrid } from "./plot_fixtures";

afterEach(() => {
  document.body.replaceChildren();
});

describe("snapshot x-axis ticks", () => {
  it("doubles the default grid density while retaining the shared modest-density grid", () => {
    expect(niceAxisTicks(-6, 6)).toEqual([-6, -4, -2, 0, 2, 4, 6]);
    expect(niceAxisTicks(-6, 6, 12)).toEqual([
      -6,
      -5,
      -4,
      -3,
      -2,
      -1,
      0,
      1,
      2,
      3,
      4,
      5,
      6
    ]);

    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    const grid = makeGrid();
    renderer.setSolution({
      ...grid,
      x: new Float64Array([-6, 0, 6])
    });

    const labels = Array.from(
      renderer.svg.querySelectorAll<HTMLElement>(".snapshot-x-tick [data-latex-source]")
    ).map((label) => label.dataset.latexSource);
    expect(labels).toEqual([
      "-6",
      "-5",
      "-4",
      "-3",
      "-2",
      "-1",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6"
    ]);
    const gridLines = Array.from(
      renderer.svg.querySelectorAll<SVGLineElement>(".snapshot-grid-line-x")
    );
    const tickBoxes = Array.from(
      renderer.svg.querySelectorAll<SVGForeignObjectElement>(".snapshot-x-tick")
    );
    expect(gridLines).toHaveLength(13);
    expect(tickBoxes).toHaveLength(13);
    expect(
      tickBoxes.map((tick, index) =>
        Math.abs(
          Number(tick.getAttribute("x")) + Number(tick.getAttribute("width")) / 2 -
            Number(gridLines[index]?.getAttribute("x1"))
        )
      )
    ).toEqual(new Array(13).fill(0));
    renderer.dispose();
  });

  it("keeps nontrivial ranges on an internal, evenly spaced nice-number grid", () => {
    expect(niceAxisTicks(0.13, 0.91)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(niceAxisTicks(-0.37, 1.08)).toEqual([-0.25, 0, 0.25, 0.5, 0.75, 1]);

    const ticks = niceAxisTicks(1_250, 4_750);
    expect(ticks).toEqual([2_000, 3_000, 4_000]);
    expect(ticks.slice(1).map((tick, index) => tick - Number(ticks[index]))).toEqual([
      1_000,
      1_000
    ]);
  });

  it("uses pleasant decimal ticks rather than fractional-pi labels", () => {
    expect(niceAxisTicks(0, Math.PI)).toEqual([0, 1, 2, 3]);
    expect(niceAxisTicks(0, 4 * Math.PI)).toEqual([0, 2.5, 5, 7.5, 10, 12.5]);
    expect(niceAxisTicks(0, Math.PI, 12)).toEqual([
      0,
      0.5,
      1,
      1.5,
      2,
      2.5,
      3
    ]);
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
