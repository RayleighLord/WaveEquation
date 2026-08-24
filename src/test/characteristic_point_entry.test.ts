import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseCharacteristicPointInput } from "../app";

describe("manual characteristic point entry", () => {
  const bounds = { xMin: -Math.PI, xMax: Math.PI, T: 2 * Math.PI };

  it("accepts safe constant expressions for both coordinates", () => {
    const result = parseCharacteristicPointInput(
      "-log(e) * pi / 2",
      "log(2)",
      bounds
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.x).toBeCloseTo(-Math.PI / 2);
    expect(result.t).toBeCloseTo(Math.log(2));
  });

  it("accepts harmless floating-point roundoff at an inclusive endpoint", () => {
    const result = parseCharacteristicPointInput(
      "sqrt(2)^2",
      "sqrt(2)^2",
      { xMin: -2, xMax: 2, T: 2 }
    );
    expect(result).toEqual({ ok: true, x: 2, t: 2 });
  });

  it.each([
    ["x", "0", "x"],
    ["1 / 0", "0", "x"],
    ["0", "t", "t"],
    ["0", "sqrt(-1)", "t"]
  ] as const)("rejects unsafe or non-finite point input %s, %s", (x, t, field) => {
    const result = parseCharacteristicPointInput(x, t, bounds);
    expect(result).toMatchObject({ ok: false, field });
    if (result.ok) return;
    expect(result.message).toContain("finite constant expression");
  });

  it("validates x against the accepted solution extent and t against final time", () => {
    expect(parseCharacteristicPointInput("pi + 0.01", "0", bounds)).toMatchObject({
      ok: false,
      field: "x"
    });
    expect(parseCharacteristicPointInput("0", "-0.01", bounds)).toMatchObject({
      ok: false,
      field: "t"
    });
    expect(parseCharacteristicPointInput("0", "2 * pi + 0.01", bounds)).toMatchObject({
      ok: false,
      field: "t"
    });
  });

  it("provides a compact accessible menu without replacing curve selection", () => {
    const html = readFileSync("index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    const button = page.querySelector("#characteristics-button");
    const panel = page.querySelector<HTMLElement>("#characteristics-entry");

    expect(button?.getAttribute("aria-controls")).toBe("characteristics-entry");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hidden).toBe(true);
    expect(panel?.getAttribute("aria-labelledby")).toBe("characteristics-entry-title");
    expect(page.querySelector("#characteristic-point-form")).not.toBeNull();
    expect(page.querySelector("#characteristic-x-input")?.getAttribute("aria-describedby"))
      .toBe("characteristic-entry-feedback");
    expect(page.querySelector("#characteristic-t-input")?.getAttribute("aria-describedby"))
      .toBe("characteristic-entry-feedback");
    expect(page.querySelector("#characteristic-x-input")?.getAttribute("inputmode"))
      .toBe("text");
    expect(page.querySelector("#characteristic-t-input")?.getAttribute("inputmode"))
      .toBe("text");
    expect(page.querySelector("#characteristic-x-input")?.getAttribute("autocapitalize"))
      .toBe("off");
    expect(panel?.textContent).toContain("log(2)");
    expect(page.querySelector("#characteristic-entry-feedback")?.getAttribute("aria-live"))
      .toBe("polite");
    expect(page.querySelector("#choose-characteristic-on-curve")).not.toBeNull();
    expect(page.querySelector("[data-latex='x_*']")).not.toBeNull();
    expect(page.querySelector("[data-latex='t_*']")).not.toBeNull();

    const styles = readFileSync("src/styles/main.css", "utf8");
    expect(styles).toMatch(
      /\.characteristics-entry\s*\{[^}]*position:\s*absolute;[^}]*width:\s*min\(16\.5rem,/s
    );
    expect(styles).toMatch(
      /\.characteristic-point-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s
    );
  });
});
