import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { SnapshotRenderer } from "../plot/SnapshotRenderer";
import { makeGrid } from "./plot_fixtures";

afterEach(() => {
  document.body.replaceChildren();
});

describe("Snapshot presentation", () => {
  it("keeps the plot transparent and gives enlarged KaTeX labels unclipped boxes", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.setSolution(makeGrid());

    expect(renderer.svg.querySelector(".snapshot-background")?.getAttribute("fill")).toBe(
      "transparent"
    );
    expect(renderer.svg.querySelector(".snapshot-curve")?.getAttribute("stroke")).toBe(
      "#4fcbd3"
    );

    const tick = renderer.svg.querySelector("foreignObject.snapshot-tick");
    const axis = renderer.svg.querySelector("foreignObject.snapshot-axis-label");
    expect(tick?.getAttribute("width")).toBe("123");
    expect(tick?.getAttribute("height")).toBe("36");
    expect(axis?.getAttribute("width")).toBe("114");
    expect(axis?.getAttribute("height")).toBe("45");

    renderer.dispose();
  });

  it("centers a half-width desktop plot and enlarges only the time numerals by 1.5x", () => {
    const styles = readFileSync("src/styles/main.css", "utf8");
    const snapshotRule = ruleBody(styles, "#snapshot-section");
    const outputRule = ruleBody(styles, ".time-heading output");
    const tickRule = ruleBody(styles, ".time-ticks");

    expect(snapshotRule).toContain("width: 50%;");
    expect(snapshotRule).toContain("justify-self: center;");
    expect(outputRule).toContain("font-size: 1.2rem;");
    expect(outputRule).toContain("width: 6.25rem;");
    expect(outputRule).toContain("min-width: 6.25rem;");
    expect(outputRule).toContain("max-width: 6.25rem;");
    expect(tickRule).toContain("font-size: 0.825rem;");
    expect(styles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?#snapshot-section\s*\{[^}]*width: 100%;[^}]*justify-self: stretch;/
    );
  });

  it("keeps eta and xi snapshot markers visibly red and purple", () => {
    const styles = readFileSync("src/styles/main.css", "utf8");
    expect(ruleBody(styles, '.snapshot-footpoint[data-characteristic-family="eta"]'))
      .toContain("fill: #e76f67;");
    expect(ruleBody(styles, '.snapshot-footpoint[data-characteristic-family="xi"]'))
      .toContain("fill: #a970ff;");
  });
});

function ruleBody(styles: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function sizedHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
  document.body.append(host);
  return host;
}
