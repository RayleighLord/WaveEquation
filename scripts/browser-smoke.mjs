import assert from "node:assert/strict";

import {
  artifactDirectory,
  launchChromium,
  monitorBrowserErrors,
  prepareArtifacts,
  startPreview,
  stopPreview
} from "./browser-utils.mjs";

const port = Number(
  process.env.BROWSER_SMOKE_PORT ?? 30_000 + (process.pid % 20_000)
);
const EXPECTED_ADAPTIVE_SOURCE_COUNTS = {
  "gaussian-split/infinite": [513, 161],
  "gaussian-split/right-half-line": [513, 161],
  "gaussian-split/finite": [513, 129],
  "square-wave/infinite": [1025, 401],
  "square-wave/right-half-line": [1025, 401],
  "square-wave/finite": [1025, 401],
  "fixed-end/infinite": [641, 121],
  "fixed-end/right-half-line": [513, 321],
  "fixed-end/finite": [513, 321],
  "standing-wave/infinite": [513, 129],
  "standing-wave/right-half-line": [513, 129],
  "standing-wave/finite": [513, 129],
  "mixed-boundaries/infinite": [513, 257],
  "mixed-boundaries/right-half-line": [513, 257],
  "mixed-boundaries/finite": [513, 257],
  "boundary-driven/infinite": [513, 121],
  "boundary-driven/right-half-line": [513, 401],
  "boundary-driven/finite": [513, 401]
};
const PREFERRED_PRESET_DOMAINS = {
  "gaussian-split": "infinite",
  "square-wave": "infinite",
  "fixed-end": "right-half-line",
  "standing-wave": "finite",
  "mixed-boundaries": "finite",
  "boundary-driven": "right-half-line"
};
const { baseUrl, child: preview } = await startPreview({
  externalUrl: process.env.BROWSER_SMOKE_URL,
  port
});

await prepareArtifacts();

let browser;
let context;
let page;

try {
  browser = await launchChromium();
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "no-preference"
  });
  page = await context.newPage();
  const browserErrors = [];
  monitorBrowserErrors(page, browserErrors);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await assertHealthyInitialRender(page);
  await assertAdaptiveTimeResolution(page);
  await assertLowerHemisphereOrbit(page);
  await assertProblemEditor(page);
  await assertPlaybackAndScrubbing(page);
  await assertCharacteristics(page);
  await assertUiAndResponsiveLayout(page);
  await assertReducedMotionStart(browser, baseUrl);
  await assertWebglFallback(browser, baseUrl);

  assert.deepEqual(
    browserErrors,
    [],
    `Unexpected browser errors:\n${browserErrors.join("\n")}`
  );
  console.log("Browser smoke checks passed.");
} catch (error) {
  if (page !== undefined) {
    await page
      .screenshot({
        path: new URL("browser-smoke-failure.png", artifactDirectory).pathname,
        fullPage: true
      })
      .catch(() => undefined);
  }
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  await stopPreview(preview);
}

async function assertHealthyInitialRender(page) {
  assert.equal(await page.title(), "Wave Equation");
  await waitForAcceptedSolution(page);

  assert.equal(await page.locator("#app-title").count(), 1);
  assert.equal(await page.locator("#app-title").evaluate((node) => node.tagName), "H1");
  assert.equal(await page.locator("#surface-plot").getAttribute("aria-busy"), "false");
  assert.equal(await page.locator(".snapshot-svg").count(), 1);
  assert.ok(
    ((await page.locator(".snapshot-curve").getAttribute("d")) ?? "").length > 20,
    "The synchronized snapshot curve did not render."
  );
  assert.ok(
    (await page.locator(".wave-surface-canvas, #webgl-notice:visible, #surface-plot .webgl-notice:visible").count()) > 0,
    "The surface needs either a WebGL canvas or an accessible fallback."
  );
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-axis-orientation"),
    "t-horizontal-x-depth-u-vertical",
    "The 3D scene must keep t horizontal, x in depth, and u vertical."
  );
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-default-view"),
    "low-oblique-u-left-t-left-edge"
  );
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-time-axis-edge"),
    "x-min",
    "The t axis must stay on the opposite, x-min spatial edge."
  );
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-axis-arrows"),
    "3",
    "Every 3D axis must retain its positive-direction arrowhead."
  );
  assert.equal(await page.locator("#surface-plot").getAttribute("data-mesh-x-samples"), "257");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-mesh-t-samples"), "161");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-mesh-vertices"), "41377");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-mesh-triangles"), "81920");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-opacity"), "1");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-transparency"), "0");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-transparent"), "false");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-side"), "double");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-material"), "lambert-lit");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-lighting"), "hemisphere-key-underfill");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-underside-fill"), "true");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-pass"), "single");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-webgl-antialias"), "false");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-webgl-resolution-scale"), "0.9");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-grid-visible"), null);
  if ((await page.locator(".wave-surface-canvas").count()) > 0) {
    const canvas = page.locator(".wave-surface-canvas");
    assert.equal(await canvas.getAttribute("data-surface-opacity"), "1");
    assert.equal(await canvas.getAttribute("data-surface-transparency"), "0");
    assert.equal(await canvas.getAttribute("data-surface-transparent"), "false");
    assert.equal(await canvas.getAttribute("data-surface-side"), "double");
    assert.equal(await canvas.getAttribute("data-surface-material"), "lambert-lit");
    assert.equal(await canvas.getAttribute("data-surface-lighting"), "hemisphere-key-underfill");
    assert.equal(await canvas.getAttribute("data-surface-underside-fill"), "true");
    assert.equal(await canvas.getAttribute("data-surface-pass"), "single");
    assert.equal(await canvas.getAttribute("data-webgl-antialias"), "false");
    assert.equal(await canvas.getAttribute("data-webgl-resolution-scale"), "0.9");
    assert.equal(
      await canvas.evaluate((element) => {
        const context = element.getContext("webgl2") ?? element.getContext("webgl");
        return context?.getContextAttributes()?.antialias ?? null;
      }),
      false,
      "The CI-safe renderer must not allocate a multisampled WebGL framebuffer."
    );
    assert.ok(
      Math.abs(
        await canvas.evaluate((element) =>
          element.width /
          element.getBoundingClientRect().width /
          Math.min(window.devicePixelRatio || 1, 2)
        ) - 0.9
      ) < 0.02,
      "The WebGL drawing buffer must retain its measured 0.9 resolution scale."
    );
    assert.equal(await canvas.getAttribute("data-surface-grid-visible"), null);
    assert.equal(await canvas.getAttribute("data-x-samples"), "513");
    assert.equal(await canvas.getAttribute("data-t-samples"), "161");
    assert.ok(
      (await page.locator(".space-time-label-layer .space-time-math-label .katex").count()) >= 18,
      "Every 3D axis tick and name should be typeset with KaTeX."
    );
  }
  assert.equal(
    await page.locator("foreignObject.snapshot-tick .katex").count(),
    18,
    "Every snapshot tick should be typeset with KaTeX."
  );
  assert.equal(
    await page.locator("foreignObject.snapshot-axis-label .katex").count(),
    2,
    "Both snapshot axis names should be typeset with KaTeX."
  );
  const snapshotAxisArrows = await page.evaluate(() => {
    const svg = document.querySelector(".snapshot-svg");
    const xAxis = svg?.querySelector(".snapshot-axis-x");
    const uAxis = svg?.querySelector(".snapshot-axis-u");
    const marker = (axis) => {
      const markerEnd = axis?.getAttribute("marker-end") ?? "";
      const id = markerEnd.match(/^url\(#(.+)\)$/)?.[1] ?? "";
      return {
        markerEnd,
        id,
        axisName: id ? svg?.querySelector(`#${id}`)?.getAttribute("data-snapshot-axis-marker") ?? "" : "",
        arrowPath: id ? svg?.querySelector(`#${id} .snapshot-axis-arrow`)?.getAttribute("d") ?? "" : ""
      };
    };
    const xGridPositions = [...(svg?.querySelectorAll(".snapshot-grid-line-x") ?? [])]
      .map((line) => Number(line.getAttribute("x1")));
    const uGridPositions = [...(svg?.querySelectorAll(".snapshot-grid-line-u") ?? [])]
      .map((line) => Number(line.getAttribute("y1")));
    const xLabel = svg?.querySelector(".snapshot-x-axis-label");
    const xLabelRight = Number(xLabel?.getAttribute("x")) + Number(xLabel?.getAttribute("width"));
    return {
      x: marker(xAxis),
      u: marker(uAxis),
      x1: Number(xAxis?.getAttribute("x1")),
      x2: Number(xAxis?.getAttribute("x2")),
      dataRight: Math.max(...xGridPositions),
      dataTop: Math.min(...uGridPositions),
      xLabelRight,
      svgWidth: svg?.viewBox.baseVal.width ?? 0,
      uY1: Number(uAxis?.getAttribute("y1")),
      uY2: Number(uAxis?.getAttribute("y2"))
    };
  });
  assert.match(snapshotAxisArrows.x.markerEnd, /^url\(#wave-snapshot-x-axis-arrow-\d+\)$/);
  assert.match(snapshotAxisArrows.u.markerEnd, /^url\(#wave-snapshot-u-axis-arrow-\d+\)$/);
  assert.notEqual(snapshotAxisArrows.x.id, snapshotAxisArrows.u.id);
  assert.equal(snapshotAxisArrows.x.axisName, "x");
  assert.equal(snapshotAxisArrows.u.axisName, "u");
  assert.ok(snapshotAxisArrows.x.arrowPath.length > 0);
  assert.ok(snapshotAxisArrows.u.arrowPath.length > 0);
  assert.ok(snapshotAxisArrows.x2 > snapshotAxisArrows.x1, "Snapshot x arrow must point right.");
  assert.equal(snapshotAxisArrows.x2 - snapshotAxisArrows.dataRight, 16);
  assert.equal(snapshotAxisArrows.xLabelRight, snapshotAxisArrows.x2 - 3);
  assert.ok(snapshotAxisArrows.x2 < snapshotAxisArrows.svgWidth);
  assert.ok(snapshotAxisArrows.uY2 < snapshotAxisArrows.uY1, "Snapshot u arrow must point up.");
  assert.equal(snapshotAxisArrows.dataTop - snapshotAxisArrows.uY2, 16);
  assert.equal(await page.locator("#time-ticks .time-tick .katex").count(), 5);
  assert.equal(await page.locator("#time-output .katex").count(), 1);
  assert.equal(await page.locator("#snapshot-time-output").count(), 0);
  assert.equal(await page.locator(".snapshot-heading").count(), 0);
  assert.deepEqual(
    await page.locator("foreignObject.snapshot-x-tick .snapshot-latex-label").evaluateAll(
      (labels) => labels.map((label) => label.getAttribute("data-latex-source"))
    ),
    ["-6", "-5", "-4", "-3", "-2", "-1", "0", "1", "2", "3", "4", "5", "6"],
    "The default snapshot x grid should use evenly spaced one-unit ticks."
  );
  assert.deepEqual(
    await page.locator(".space-time-math-label--x-axis-tick").evaluateAll(
      (labels) => labels.map((label) => label.getAttribute("data-latex-source"))
    ),
    ["-6", "-4", "-2", "0", "2", "4", "6"]
  );
  const visibleTimeAxisTickSources = await page
    .locator(".space-time-math-label--t-axis-tick")
    .evaluateAll((labels) =>
      labels.map((label) => label.getAttribute("data-latex-source"))
    );
  assert.equal(
    visibleTimeAxisTickSources.length,
    4,
    "The redundant t = 0 label should be elided at the shared 3D origin."
  );
  assert.deepEqual(
    visibleTimeAxisTickSources,
    ["2", "4", "6", "8"],
    "Visible default t labels should use an even two-unit grid while the origin label remains renderer-owned."
  );
  const floorAxisTickAnchors = await page.evaluate(() => {
    const percentageAnchor = (label) => {
      const match = label.style.transform.match(
        /^translate\(\s*(-?[\d.]+)%\s*,\s*(-?[\d.]+)%\s*\)/
      );
      return match ? [Number(match[1]), Number(match[2])] : [Number.NaN, Number.NaN];
    };
    return {
      t: [...document.querySelectorAll(".space-time-math-label--t-axis-tick")].map(
        percentageAnchor
      ),
      x: [...document.querySelectorAll(".space-time-math-label--x-axis-tick")].map(
        percentageAnchor
      )
    };
  });
  assert.ok(
    floorAxisTickAnchors.t.every(([horizontal, vertical]) =>
      horizontal === -100 && vertical === -50
    ),
    "Every t tick must retain right-edge anchoring for full left-side clearance."
  );
  assert.ok(
    floorAxisTickAnchors.x.every(([, vertical]) => vertical === -50) &&
      floorAxisTickAnchors.t.every(([, vertical]) => vertical === -50),
    "The t and x ticks must share the same vertically centered below-axis convention."
  );
  assert.equal(await page.locator(".snapshot-grid-line-x").count(), 13);
  assert.deepEqual(
    await page.locator(".space-time-math-label--u-axis-tick").evaluateAll((labels) =>
      labels.map((label) => label.getAttribute("data-latex-source"))
    ),
    ["0", "0.25", "0.5", "0.75", "1"],
    "The nonnegative default solution should use the pleasant u range 0 through 1."
  );
  assert.deepEqual(
    await page.locator("foreignObject.snapshot-u-tick .snapshot-latex-label").evaluateAll((labels) =>
      labels.map((label) => label.getAttribute("data-latex-source"))
    ),
    ["0", "0.25", "0.5", "0.75", "1"]
  );
  const snapshotAxisLabelPlacement = await page.evaluate(() => {
    const svg = document.querySelector(".snapshot-svg");
    const xAxis = svg?.querySelector(".snapshot-axis-x");
    const uAxis = svg?.querySelector(".snapshot-axis-u");
    const uAxisX = Number(uAxis?.getAttribute("x1"));
    const plotLeft = Number(xAxis?.getAttribute("x1"));
    const plotRight = Number(xAxis?.getAttribute("x2"));
    const box = (label) => {
      const left = Number(label.getAttribute("x"));
      const width = Number(label.getAttribute("width"));
      return { left, right: left + width };
    };
    const uTickBoxes = [...(svg?.querySelectorAll("foreignObject.snapshot-u-tick") ?? [])]
      .map(box);
    const uName = [...(svg?.querySelectorAll("foreignObject.snapshot-axis-label") ?? [])]
      .find((label) =>
        label.querySelector(".snapshot-latex-label")?.getAttribute("data-latex-source") ===
          "u(x,t)"
      );
    const uNameBox = uName ? box(uName) : null;
    const xTickCenters = [
      ...(svg?.querySelectorAll("foreignObject.snapshot-x-tick") ?? [])
    ].map((label) => {
      const bounds = box(label);
      return (bounds.left + bounds.right) / 2;
    });
    const xGridPositions = [
      ...(svg?.querySelectorAll(".snapshot-grid-line-x") ?? [])
    ].map((line) => Number(line.getAttribute("x1")));
    return {
      plotLeft,
      plotRight,
      uAxisX,
      uTickGaps: uTickBoxes.map(({ right }) => uAxisX - right),
      uTickLeftEdgeDistances: uTickBoxes.map(({ right }) => right - plotLeft),
      uNameRightGap: uNameBox ? uNameBox.left - uAxisX : Number.NaN,
      uNameRightClearance: uNameBox ? plotRight - uNameBox.right : Number.NaN,
      xTickAlignmentErrors: xTickCenters.map((center, index) =>
        Math.abs(center - (xGridPositions[index] ?? Number.NaN))
      )
    };
  });
  assert.ok(
    snapshotAxisLabelPlacement.uAxisX > snapshotAxisLabelPlacement.plotLeft &&
      snapshotAxisLabelPlacement.uAxisX < snapshotAxisLabelPlacement.plotRight,
    "The default snapshot u axis should pass through the visible x=0 position."
  );
  assert.ok(
    snapshotAxisLabelPlacement.uTickGaps.every((gap) => gap >= 6 && gap <= 32),
    "Every snapshot u tick label should sit just left of the central u axis."
  );
  assert.ok(
    snapshotAxisLabelPlacement.uTickLeftEdgeDistances.every((distance) => distance > 100),
    "Snapshot u tick labels must follow the central u axis instead of the left plot border."
  );
  assert.equal(
    snapshotAxisLabelPlacement.uNameRightGap,
    18,
    "The u(x,t) label should use the enlarged right gap from the central u axis."
  );
  assert.ok(
    snapshotAxisLabelPlacement.uNameRightClearance >= 0,
    "The u(x,t) label must remain within the snapshot at desktop width."
  );
  assert.ok(
    snapshotAxisLabelPlacement.xTickAlignmentErrors.every((error) => error < 0.01),
    "Moving the u labels must not move the snapshot x tick labels off their grid lines."
  );
  const plotPresentation = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const shell = getComputedStyle(document.querySelector("#app-shell"));
    const surface = getComputedStyle(document.querySelector("#surface-section"));
    const snapshot = getComputedStyle(document.querySelector("#snapshot-section"));
    const stage = document.querySelector("#wave-stage")?.getBoundingClientRect();
    const spaceTick = getComputedStyle(
      document.querySelector(".space-time-math-label--u-axis-tick")
    );
    const spaceAxis = getComputedStyle(
      document.querySelector(".space-time-math-label--axis-name")
    );
    const snapshotTick = getComputedStyle(
      document.querySelector("foreignObject.snapshot-u-tick .katex")
    );
    const snapshotAxis = getComputedStyle(
      document.querySelector("foreignObject.snapshot-axis-label .katex")
    );
    const surfaceBounds = document.querySelector("#surface-section")?.getBoundingClientRect();
    const clippedSpaceLabels = surfaceBounds
      ? [...document.querySelectorAll(".space-time-math-label")].filter((label) => {
          const bounds = label.getBoundingClientRect();
          return bounds.left < surfaceBounds.left - 1 ||
            bounds.right > surfaceBounds.right + 1 ||
            bounds.top < surfaceBounds.top - 1 ||
            bounds.bottom > surfaceBounds.bottom + 1;
        }).length
      : -1;
    return {
      bodyBackground: body.backgroundColor,
      shellBackground: shell.backgroundColor,
      surfaceBackgroundImage: surface.backgroundImage,
      surfaceBorder: Number.parseFloat(surface.borderTopWidth),
      surfaceRadius: Number.parseFloat(surface.borderTopLeftRadius),
      snapshotBorder: Number.parseFloat(snapshot.borderTopWidth),
      stageLeft: stage?.left ?? 0,
      spaceTickSize: Number.parseFloat(spaceTick.fontSize),
      spaceAxisSize: Number.parseFloat(spaceAxis.fontSize),
      snapshotTickSize: Number.parseFloat(snapshotTick.fontSize),
      snapshotAxisSize: Number.parseFloat(snapshotAxis.fontSize),
      clippedSpaceLabels
    };
  });
  assert.equal(plotPresentation.bodyBackground, "rgb(0, 0, 0)");
  assert.equal(plotPresentation.shellBackground, "rgb(0, 0, 0)");
  assert.equal(plotPresentation.surfaceBackgroundImage, "none");
  assert.equal(plotPresentation.surfaceBorder, 0);
  assert.equal(plotPresentation.surfaceRadius, 0);
  assert.equal(plotPresentation.snapshotBorder, 0);
  assert.ok(plotPresentation.stageLeft >= 40, "Desktop plots should leave a modest left gutter.");
  assert.ok(plotPresentation.spaceTickSize >= 17);
  assert.ok(plotPresentation.spaceAxisSize >= 25);
  assert.ok(plotPresentation.snapshotTickSize >= 17);
  assert.ok(plotPresentation.snapshotAxisSize >= 22);
  assert.equal(plotPresentation.clippedSpaceLabels, 0);
  const compactChrome = await page.evaluate(() => {
    const menu = document.querySelector("#problem-menu");
    const field = document.querySelector("#problem-menu input, #problem-menu select");
    const time = document.querySelector("#time-control");
    const play = document.querySelector("#playback-button");
    const slider = document.querySelector("#time-slider");
    const output = document.querySelector("#time-output");
    const timeTick = document.querySelector("#time-ticks .time-tick");
    const menuStyle = menu ? getComputedStyle(menu) : null;
    const formula = document.querySelector("#problem-formula");
    const problemControl = document.querySelector("#problem-control");
    const problemHeader = document.querySelector(".problem-control__header");
    const formulaBounds = formula?.getBoundingClientRect();
    const controlBounds = problemControl?.getBoundingClientRect();
    const headerBounds = problemHeader?.getBoundingClientRect();
    const menuBounds = menu?.getBoundingClientRect();
    const formulaMathBounds = formula
      ?.querySelector(".katex")
      ?.getBoundingClientRect();
    const inlineMath = document.querySelector("#problem-menu .inline-math .katex");
    const mathHint = document.querySelector("#problem-menu .math-hint .katex");
    const center = (element) => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? bounds.top + bounds.height / 2 : Number.NaN;
    };
    return {
      menuWidth: menu?.getBoundingClientRect().width ?? 0,
      fieldHeight: field?.getBoundingClientRect().height ?? 0,
      menuBackground: menuStyle?.backgroundColor ?? "",
      menuBorder: menuStyle?.borderTopColor ?? "",
      formulaHeight: formula?.getBoundingClientRect().height ?? 0,
      formulaTop: formulaBounds?.top ?? 0,
      formulaBottom: formulaBounds?.bottom ?? 0,
      formulaRight: formulaBounds?.right ?? 0,
      formulaLeft: formulaBounds?.left ?? 0,
      formulaClientWidth: formula?.clientWidth ?? 0,
      formulaScrollWidth: formula?.scrollWidth ?? 0,
      formulaMathLeft: formulaMathBounds?.left ?? 0,
      formulaMathRight: formulaMathBounds?.right ?? 0,
      controlLeft: controlBounds?.left ?? 0,
      controlRight: controlBounds?.right ?? 0,
      headerBottom: headerBounds?.bottom ?? 0,
      menuTop: menuBounds?.top ?? 0,
      formulaParent: formula?.parentElement?.id ?? "",
      formulaPrevious: formula?.previousElementSibling?.className ?? "",
      formulaNext: formula?.nextElementSibling?.id ?? "",
      viewportWidth: window.innerWidth,
      inlineMathSize: inlineMath ? Number.parseFloat(getComputedStyle(inlineMath).fontSize) : 0,
      mathHintSize: mathHint ? Number.parseFloat(getComputedStyle(mathHint).fontSize) : 0,
      timeHeight: time?.getBoundingClientRect().height ?? 0,
      playCenter: center(play),
      sliderCenter: center(slider),
      outputCenter: center(output),
      outputFontSize: output ? Number.parseFloat(getComputedStyle(output).fontSize) : 0,
      tickFontSize: timeTick ? Number.parseFloat(getComputedStyle(timeTick).fontSize) : 0,
      outputClientWidth: output?.clientWidth ?? 0,
      outputScrollWidth: output?.scrollWidth ?? 0
    };
  });
  assert.ok(compactChrome.menuWidth <= 320);
  assert.ok(compactChrome.fieldHeight <= 38);
  assert.equal(compactChrome.menuBackground, "rgba(7, 12, 20, 0.82)");
  assert.equal(compactChrome.menuBorder, "rgba(158, 176, 255, 0.17)");
  assert.equal(await page.locator("#problem-menu .eyebrow").count(), 0);
  assert.equal((await page.locator("#problem-menu").textContent())?.includes("Initial-boundary value problem"), false);
  assert.ok(compactChrome.formulaHeight <= 72, "The default symbolic problem card should stay compact.");
  assert.equal(compactChrome.formulaParent, "problem-control");
  assert.match(compactChrome.formulaPrevious, /problem-control__header/);
  assert.equal(compactChrome.formulaNext, "problem-menu");
  assert.ok(
    compactChrome.formulaTop >= compactChrome.headerBottom + 4,
    "The symbolic problem card should sit below the Wave Equation title row."
  );
  assert.ok(
    compactChrome.menuTop >= compactChrome.formulaBottom + 4,
    "The problem editor should sit below the symbolic problem card."
  );
  assert.ok(
    Math.abs(compactChrome.formulaLeft - compactChrome.controlLeft) < 1.5 &&
      Math.abs(compactChrome.formulaRight - compactChrome.controlRight) < 1.5,
    "The symbolic problem card should align with the left problem-control stack."
  );
  assert.ok(
    compactChrome.formulaRight < compactChrome.viewportWidth / 2,
    "The symbolic problem card should remain in the left desktop control column."
  );
  assert.ok(
    compactChrome.formulaScrollWidth <= compactChrome.formulaClientWidth &&
      compactChrome.formulaMathLeft >= compactChrome.formulaLeft &&
      compactChrome.formulaMathRight <= compactChrome.formulaRight,
    "The default symbolic problem must fit inside the left card without clipping."
  );
  assert.ok(compactChrome.inlineMathSize >= 9.5, "Editor inline mathematics should not be undersized.");
  assert.ok(compactChrome.mathHintSize >= 11, "Editor function hints should not be undersized.");
  assert.ok(compactChrome.timeHeight <= 70);
  assert.ok(Math.abs(compactChrome.playCenter - compactChrome.sliderCenter) <= 8);
  assert.ok(Math.abs(compactChrome.playCenter - compactChrome.outputCenter) <= 8);
  assert.ok(Math.abs(compactChrome.outputFontSize - 19.2) < 0.05, "Time output must be 1.2rem.");
  assert.ok(Math.abs(compactChrome.tickFontSize - 13.2) < 0.05, "Time ticks must be 0.825rem.");
  assert.ok(compactChrome.outputClientWidth >= compactChrome.outputScrollWidth);
  assert.equal(await page.locator("#problem-formula-math .katex").count(), 1);
  const problemLatex = await page
    .locator('#problem-formula-math annotation[encoding="application/x-tex"]')
    .textContent();
  assert.match(problemLatex ?? "", /u_\{tt\}-u_\{xx\}=0/);
  assert.doesNotMatch(problemLatex ?? "", /c\^2|c_?\{/);
  assert.match(problemLatex ?? "", /\\mathbb\{R\}\\times\(0,T\]/);
  assert.match(problemLatex ?? "", /u\(x,0\)=f\(x\)/);
  assert.doesNotMatch(problemLatex ?? "", /1\}\^\{2\}|1\^2|3\.141|12\.6/);
  assert.match(
    (await page.locator("#problem-formula-math").textContent()) ?? "",
    /u.*tt|uₜₜ|wave/i
  );
  assert.equal(await page.locator("#preset-select").inputValue(), "gaussian-split");
  assert.equal(await rootDataset(page, "playback"), "paused");
  assert.equal(Number(await rootDataset(page, "currentTime")), 0);
  assert.equal((await page.locator("#playback-button").textContent())?.trim(), "Play");
  assert.equal(await page.locator("#playback-button").getAttribute("aria-label"), "Play evolution");
  assert.equal(await rootDataset(page, "geometryReady"), "true");
  assert.equal(await rootDataset(page, "samplingPolicy"), "adaptive-wave-v1");
  assert.equal(await rootDataset(page, "solverXSamples"), "513");
  assert.equal(await rootDataset(page, "solverTSamples"), "161");
  assert.ok(Number(await rootDataset(page, "acceptedRevision")) > 0);
  assert.ok(Number.isFinite(Number(await rootDataset(page, "solveMs"))));

  const geometry = await page.evaluate(() => {
    const stage = document.querySelector("#wave-stage")?.getBoundingClientRect();
    const surface = document.querySelector("#surface-section")?.getBoundingClientRect();
    const snapshot = document.querySelector("#snapshot-section")?.getBoundingClientRect();
    return stage && surface && snapshot
      ? {
          stageLeft: stage.left,
          stageWidth: stage.width,
          surfaceTop: surface.top,
          surfaceBottom: surface.bottom,
          surfaceHeight: surface.height,
          snapshotLeft: snapshot.left,
          snapshotWidth: snapshot.width,
          snapshotTop: snapshot.top,
          snapshotHeight: snapshot.height,
          viewportHeight: window.innerHeight
        }
      : null;
  });
  assert.ok(geometry, "Both plot panels need measurable geometry.");
  assert.ok(geometry.surfaceHeight / geometry.viewportHeight > 0.58);
  assert.ok(geometry.surfaceHeight / geometry.viewportHeight < 0.68);
  assert.ok(geometry.snapshotHeight / geometry.viewportHeight > 0.26);
  assert.ok(geometry.snapshotTop > geometry.surfaceBottom);
  assert.ok(
    Math.abs(geometry.snapshotWidth / geometry.stageWidth - 1 / 2) < 0.005,
    "Desktop snapshot should occupy half of the stage width."
  );
  assert.ok(
    Math.abs(
      geometry.snapshotLeft + geometry.snapshotWidth / 2 -
        (geometry.stageLeft + geometry.stageWidth / 2)
    ) < 1.5,
    "Desktop snapshot should be horizontally centered in the stage."
  );

  const slider = await page.locator("#time-slider").evaluate((input) => ({
    type: input instanceof HTMLInputElement ? input.type : "",
    minimum: Number(input.getAttribute("aria-valuemin")),
    maximum: Number(input.getAttribute("aria-valuemax"))
  }));
  assert.equal(slider.type, "range");
  assert.equal(slider.minimum, 0);
  assert.ok(slider.maximum > 0);
}

async function assertAdaptiveTimeResolution(page) {
  const finalTime = page.locator("#final-time-input");
  const initialRevision = Number(await rootDataset(page, "acceptedRevision"));
  await finalTime.fill("20");
  await page.waitForFunction(
    (revision) => Number(document.documentElement.dataset.acceptedRevision) > revision,
    initialRevision,
    { timeout: 10_000 }
  );
  assert.equal(await page.locator("#preset-select").inputValue(), "gaussian-split");
  assert.equal(await rootDataset(page, "solverXSamples"), "513");
  assert.equal(await rootDataset(page, "solverTSamples"), "401");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-mesh-x-samples"), "257");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-mesh-t-samples"), "401");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-topology"), "smooth");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-stepped-surface-top-faces"), "0");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-stepped-surface-wall-faces"), "0");
  await assertAcceptedPausedAtStart(page);
  const adaptiveRevision = Number(await rootDataset(page, "acceptedRevision"));
  await finalTime.fill("8");
  await page.waitForFunction(
    (revision) => Number(document.documentElement.dataset.acceptedRevision) > revision,
    adaptiveRevision,
    { timeout: 10_000 }
  );
  assert.equal(await rootDataset(page, "solverTSamples"), "161");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-mesh-t-samples"), "161");
  await assertAcceptedPausedAtStart(page);
}

async function assertLowerHemisphereOrbit(page) {
  const surface = page.locator("#surface-plot");
  const canvas = page.locator(".wave-surface-canvas");
  if ((await canvas.count()) === 0) {
    return;
  }

  assert.equal(await surface.getAttribute("data-lower-hemisphere-orbit"), "enabled");
  const minimumPolarAngle = Number(
    await surface.getAttribute("data-orbit-min-polar-angle")
  );
  const maximumPolarAngle = Number(
    await surface.getAttribute("data-orbit-max-polar-angle")
  );
  assert.ok(
    minimumPolarAngle > 0 &&
      minimumPolarAngle < Math.PI / 2 &&
      maximumPolarAngle > Math.PI / 2 &&
      maximumPolarAngle < Math.PI,
    "Orbit limits must span both sides of the u=0 floor while guarding the poles."
  );
  assert.ok(
    Math.abs(minimumPolarAngle + maximumPolarAngle - Math.PI) < 1e-12,
    "Upper- and lower-hemisphere orbit limits should use symmetric pole guards."
  );
  assert.equal(await surface.getAttribute("data-camera-hemisphere"), "above");
  assert.equal(await surface.getAttribute("data-camera-default"), "true");

  const bounds = await canvas.boundingBox();
  assert.ok(bounds, "The WebGL canvas needs measurable geometry for orbit interaction.");
  const retainedTriangleCount = await surface.getAttribute("data-mesh-triangles");

  // Begin well away from the floating controls and try several horizontal
  // positions in case the selected-time plane happens to cover one ray. An
  // upward primary-button drag increases OrbitControls' polar angle and must
  // be able to cross the floor into the lower hemisphere.
  for (const xFraction of [0.9, 0.76, 0.62]) {
    await page.mouse.move(
      bounds.x + bounds.width * xFraction,
      bounds.y + bounds.height * 0.88
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * xFraction,
      bounds.y + bounds.height * 0.16,
      { steps: 12 }
    );
    await page.mouse.up();
    if ((await surface.getAttribute("data-camera-hemisphere")) === "below") {
      break;
    }
  }

  assert.equal(
    await surface.getAttribute("data-camera-hemisphere"),
    "below",
    "Dragging the empty 3D scene upward must carry the camera below the u=0 floor."
  );
  assert.equal(await surface.getAttribute("data-camera-default"), "false");
  assert.equal(await surface.getAttribute("data-mesh-triangles"), retainedTriangleCount);
  assert.equal(
    await canvas.evaluate((element) => {
      const context =
        element.getContext("webgl2") ?? element.getContext("webgl");
      return context !== null && !context.isContextLost();
    }),
    true,
    "The WebGL surface must remain drawable from the lower hemisphere."
  );
  await assertSurfaceRenderingContract(page, "below the u=0 floor");

  await page.locator("#reset-camera-button").click();
  await page.waitForFunction(
    () => {
      const plot = document.querySelector("#surface-plot");
      return plot?.getAttribute("data-camera-hemisphere") === "above" &&
        plot.getAttribute("data-camera-default") === "true";
    },
    undefined,
    { timeout: 4_000 }
  );
  await assertSurfaceRenderingContract(page, "after resetting the camera");
}

async function assertSurfaceRenderingContract(page, viewDescription) {
  const expected = {
    "data-surface-opacity": "1",
    "data-surface-transparency": "0",
    "data-surface-transparent": "false",
    "data-surface-side": "double",
    "data-surface-material": "lambert-lit",
    "data-surface-lighting": "hemisphere-key-underfill",
    "data-surface-underside-fill": "true",
    "data-surface-pass": "single",
    "data-webgl-antialias": "false",
    "data-webgl-resolution-scale": "0.9",
    "data-surface-topology": "smooth",
    "data-surface-wall-material": "none"
  };

  for (const selector of ["#surface-plot", ".wave-surface-canvas"]) {
    const target = page.locator(selector);
    for (const [attribute, value] of Object.entries(expected)) {
      assert.equal(
        await target.getAttribute(attribute),
        value,
        `${selector} must retain ${attribute} ${viewDescription}.`
      );
    }
    assert.equal(
      await target.getAttribute("data-surface-grid-visible"),
      null,
      `${selector} must not expose a removed surface grid ${viewDescription}.`
    );
  }
}

async function assertProblemEditor(page) {
  await assertAcceptedPausedAtStart(page);
  assert.equal(await page.locator("#problem-menu").isVisible(), true);
  assert.equal(await rootDataset(page, "problemOpen"), "true");
  await page.locator("#problem-close").click();
  await expectRootDataset(page, "problemOpen", "false");
  assert.equal(await page.locator("#problem-menu").isHidden(), true);
  assert.equal(await page.locator("#problem-formula").isVisible(), true);
  assert.equal(await page.locator("#problem-formula").evaluate((formula) => formula.parentElement?.id), "problem-control");
  await page.locator("#problem-toggle").click();
  await expectRootDataset(page, "problemOpen", "true");
  assert.equal(await page.locator("#problem-menu").isVisible(), true);
  assert.equal(await page.locator("#problem-toggle").getAttribute("aria-expanded"), "true");

  for (const selector of [
    "#domain-select",
    "#final-time-input",
    "#view-x-min-input",
    "#view-x-max-input",
    "#displacement-piece-list",
    "#velocity-piece-list"
  ]) {
    assert.equal(await page.locator(selector).count(), 1, `${selector} is missing.`);
  }
  assert.equal(await page.locator("#wave-speed-input").count(), 0);
  assert.equal(await page.locator("#problem-menu .eyebrow").count(), 0);
  for (const selector of ["#final-time-input", "#view-x-min-input", "#view-x-max-input", "#domain-left-input", "#domain-right-input"]) {
    assert.equal(await page.locator(selector).getAttribute("type"), "text");
  }
  assert.deepEqual(
    await page.locator("#left-boundary-type option").allTextContents(),
    ["Dirichlet", "Neumann"]
  );
  assert.deepEqual(
    await page.locator("#right-boundary-type option").allTextContents(),
    ["Dirichlet", "Neumann"]
  );

  const shippedPresets = [
    "gaussian-split",
    "square-wave",
    "fixed-end",
    "standing-wave",
    "mixed-boundaries",
    "boundary-driven"
  ];
  const expectedPresets = [...shippedPresets, "custom"];
  assert.deepEqual(
    await page.locator("#preset-select option").evaluateAll((options) =>
      options.map((option) => option.value)
    ),
    expectedPresets
  );
  assert.deepEqual(
    await page.locator("#preset-select option").allTextContents(),
    [
      "Gaussian Pulse",
      "Square Wave",
      "One-Sided Pulse",
      "Finite standing wave",
      "Mixed boundaries",
      "Forced Wave",
      "Custom"
    ]
  );
  assert.equal(await page.locator("#preset-select option[value='custom']").isEnabled(), true);

  const domainValues = ["infinite", "right-half-line", "finite"];
  assert.deepEqual(
    await page.locator("#domain-select option").evaluateAll((options) =>
      options.map((option) => option.value)
    ),
    domainValues
  );
  assert.deepEqual(
    await page.locator("#domain-select option").allTextContents(),
    ["Infinite", "Semi-infinite", "Finite"]
  );
  for (const [presetIndex, preset] of shippedPresets.entries()) {
    if ((await page.locator("#preset-select").inputValue()) !== preset) {
      console.log(`Checking preset: ${preset}`);
      await selectPresetAndWait(page, preset);
    } else {
      assert.equal(
        await page.locator("#domain-select").inputValue(),
        PREFERRED_PRESET_DOMAINS[preset]
      );
      await assertAcceptedPausedAtStart(page);
    }
    for (const domain of domainValues) {
      await selectDomainAndWait(page, domain);
      assert.equal(await page.locator("#preset-select").inputValue(), preset);
      assert.equal(await page.locator("#domain-select").inputValue(), domain);
      assert.match((await page.locator("#source-status").textContent()) ?? "", /ready/i);
      assert.ok((await page.locator(".piece-row").count()) <= 32);
      const source = await page.locator("#problem-formula-math").getAttribute("data-latex-source");
      assert.match(source ?? "", /u_\{tt\}-u_\{xx\}=0/);
      assert.doesNotMatch(source ?? "", /c\^2/);
      const leftVisible = domain === "right-half-line" || domain === "finite";
      const rightVisible = domain === "finite";
      assert.equal(await page.locator("#left-boundary-fields").isVisible(), leftVisible);
      assert.equal(await page.locator("#right-boundary-fields").isVisible(), rightVisible);
      if (leftVisible) {
        const symbol = await page.locator("#left-boundary-symbol").getAttribute("data-latex-source");
        assert.ok(symbol && source?.includes(symbol));
      }
      if (rightVisible) {
        const symbol = await page.locator("#right-boundary-symbol").getAttribute("data-latex-source");
        assert.ok(symbol && source?.includes(symbol));
      }
      if (domain === "infinite") assert.match(source ?? "", /\\mathbb\{R\}/);
      if (domain === "right-half-line") assert.match(source ?? "", /\[a,\\infty\)/);
      if (domain === "finite") {
        assert.match(source ?? "", /\[a,b\]/);
        assert.equal(
          (source?.match(/\\\\/g) ?? []).length,
          2,
          "Both finite boundary conditions should share one compact formula row."
        );
        const leftSymbol = await page.locator("#left-boundary-symbol").getAttribute("data-latex-source");
        const rightSymbol = await page.locator("#right-boundary-symbol").getAttribute("data-latex-source");
        assert.ok(leftSymbol && rightSymbol && source?.includes(`${leftSymbol}`) && source.includes(`${rightSymbol}`));
      }
      const expectedBoundaryCount = domain === "infinite" ? 0 : domain === "finite" ? 2 : 1;
      await assertPhysicalBoundaryPresentation(page, expectedBoundaryCount);
      await assertAxisNotationPresentation(page, domain);
      await assertSurfaceTopologyPresentation(page, preset, domain);
      const viewBounds = await page.evaluate(() => {
        const minimum = document.querySelector("#view-x-min-input")?.getBoundingClientRect();
        const maximum = document.querySelector("#view-x-max-input")?.getBoundingClientRect();
        return {
          topDifference: minimum && maximum ? Math.abs(minimum.top - maximum.top) : Infinity,
          heightDifference: minimum && maximum ? Math.abs(minimum.height - maximum.height) : Infinity
        };
      });
      assert.ok(
        viewBounds.topDifference < 0.5 && viewBounds.heightDifference < 0.5,
        "View x_min and x_max must remain on the same row for every domain."
      );
      await assertPresetPiSources(page, preset, domain);
    }

    // Exercise the actual transition the next preset must interrupt: every
    // example may be played explicitly, but choosing another example always
    // accepts its natural domain at t=0 in the paused state.
    await page.locator("#playback-button").click();
    await expectRootDataset(page, "playback", "playing");
    const startedTime = Number(await rootDataset(page, "currentTime"));
    await page.waitForFunction(
      (time) => Number(document.documentElement.dataset.currentTime) > time,
      startedTime,
      { timeout: 2_000 }
    );
    if (presetIndex === shippedPresets.length - 1) {
      await page.locator("#playback-button").click();
      await expectRootDataset(page, "playback", "paused");
    }
  }

  await assertFormulaFitsProblemStack(page, "finite problem");

  await selectPresetAndWait(page, "standing-wave");
  if ((await page.locator("#domain-select").inputValue()) !== "finite") {
    await selectDomainAndWait(page, "finite");
  }
  await assertAcceptedPausedAtStart(page);
  const acceptedRevision = Number(await rootDataset(page, "acceptedRevision"));
  await page.locator("#final-time-input").fill("2 * pi");
  await page.locator("#view-x-min-input").fill("sin(pi)");
  await page.locator("#view-x-max-input").fill("pi");
  await page.locator("#domain-left-input").fill("sin(pi)");
  await page.locator("#domain-right-input").fill("pi");
  await page.waitForFunction(
    (revision) => Number(document.documentElement.dataset.acceptedRevision) > revision,
    acceptedRevision,
    { timeout: 10_000 }
  );
  await assertAcceptedPausedAtStart(page);
  assert.equal(await page.locator("#final-time-input").inputValue(), "2 * pi");
  assert.equal(await page.locator("#view-x-min-input").inputValue(), "sin(pi)");
  assert.equal(await page.locator("#view-x-max-input").inputValue(), "pi");
  assert.equal(await page.locator("#domain-left-input").inputValue(), "sin(pi)");
  assert.equal(await page.locator("#domain-right-input").inputValue(), "pi");
  assert.equal(await page.locator("#preset-select").inputValue(), "standing-wave");
  await assertAcceptedPausedAtStart(page);
  const scalarRevision = Number(await rootDataset(page, "acceptedRevision"));
  const scalarCurve = await page.locator(".snapshot-curve").getAttribute("d");
  const scalarSources = await page.locator("#problem-form input").evaluateAll((inputs) =>
    inputs.map((input) => input.value)
  );
  await page.locator("#preset-select").selectOption("custom");
  assert.equal(await page.locator("#preset-select").inputValue(), "custom");
  assert.equal(Number(await rootDataset(page, "acceptedRevision")), scalarRevision);
  assert.equal(await page.locator(".snapshot-curve").getAttribute("d"), scalarCurve);
  assert.deepEqual(
    await page.locator("#problem-form input").evaluateAll((inputs) =>
      inputs.map((input) => input.value)
    ),
    scalarSources
  );
  assert.match((await page.locator("#source-status").textContent()) ?? "", /ready/i);

  await page.locator("#domain-right-input").fill("x");
  await page.waitForFunction(
    () => document.querySelector("#source-status")?.classList.contains("is-invalid"),
    undefined,
    { timeout: 4_000 }
  );
  assert.equal(Number(await rootDataset(page, "acceptedRevision")), scalarRevision);
  assert.equal(await page.locator(".snapshot-curve").getAttribute("d"), scalarCurve);
  assert.equal(await page.locator(".snapshot-svg").getAttribute("data-boundary-count"), "2");
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-physical-boundary-trace-count"),
    "2",
    "An invalid boundary draft must retain the accepted finite-domain traces."
  );

  await page.locator("#domain-right-input").fill("pi");
  await page.waitForFunction(
    (revision) => Number(document.documentElement.dataset.acceptedRevision) > revision,
    scalarRevision,
    { timeout: 10_000 }
  );
  await assertAcceptedPausedAtStart(page);
  await selectPresetAndWait(page, "standing-wave");
  const functionRevision = Number(await rootDataset(page, "acceptedRevision"));
  const displacementExpression = page
    .locator(".piece-row[data-source='f'] .piece-expression")
    .first();
  await displacementExpression.evaluate((input) => {
    window.__waveFocusedEditorInput = input;
  });
  await displacementExpression.click();
  await displacementExpression.press("Control+A");
  await displacementExpression.pressSequentially("sin(3 * x)", { delay: 12 });
  await assertFocusedEditorInput(page, displacementExpression, "sin(3 * x)");
  await page.waitForFunction(
    (revision) => Number(document.documentElement.dataset.acceptedRevision) > revision,
    functionRevision,
    { timeout: 10_000 }
  );
  await assertAcceptedPausedAtStart(page);
  await assertFocusedEditorInput(page, displacementExpression, "sin(3 * x)");
  const continuedRevision = Number(await rootDataset(page, "acceptedRevision"));
  await page.keyboard.type(" + sin(5 * x)", { delay: 12 });
  await assertFocusedEditorInput(
    page,
    displacementExpression,
    "sin(3 * x) + sin(5 * x)"
  );
  await page.waitForFunction(
    (revision) => Number(document.documentElement.dataset.acceptedRevision) > revision,
    continuedRevision,
    { timeout: 10_000 }
  );
  await assertAcceptedPausedAtStart(page);
  await assertFocusedEditorInput(
    page,
    displacementExpression,
    "sin(3 * x) + sin(5 * x)"
  );
  assert.equal(await page.locator("#preset-select").inputValue(), "custom");
  await selectPresetAndWait(page, "gaussian-split");
  if ((await page.locator("#domain-select").inputValue()) !== "infinite") {
    await selectDomainAndWait(page, "infinite");
  }
}

async function assertPhysicalBoundaryPresentation(page, expectedCount) {
  const presentation = await page.evaluate(() => {
    const snapshot = document.querySelector(".snapshot-svg");
    const markers = [...document.querySelectorAll(".snapshot-boundary-marker")];
    const surface = document.querySelector("#surface-plot");
    const canvas = document.querySelector(".wave-surface-canvas");
    return {
      snapshotCount: Number(snapshot?.getAttribute("data-boundary-count")),
      visibleSnapshotCount: Number(snapshot?.getAttribute("data-visible-boundary-count")),
      markerCount: markers.length,
      markerFills: markers.map((marker) => marker.getAttribute("fill")),
      markerVisibility: markers.map((marker) => marker.getAttribute("visibility")),
      surfaceCount: Number(surface?.getAttribute("data-physical-boundary-trace-count")),
      canvasCount: Number(canvas?.getAttribute("data-physical-boundary-trace-count")),
      traceSurface: surface?.getAttribute("data-physical-boundary-trace-surface"),
      traceColor: surface?.getAttribute("data-physical-boundary-trace-color"),
      traceWidth: surface?.getAttribute("data-physical-boundary-trace-width")
    };
  });
  assert.equal(presentation.snapshotCount, expectedCount);
  assert.equal(presentation.visibleSnapshotCount, expectedCount);
  assert.equal(presentation.markerCount, expectedCount);
  assert.deepEqual(presentation.markerFills, Array(expectedCount).fill("#ffffff"));
  assert.deepEqual(presentation.markerVisibility, Array(expectedCount).fill("visible"));
  assert.equal(presentation.surfaceCount, expectedCount);
  assert.equal(presentation.canvasCount, expectedCount);
  assert.equal(presentation.traceSurface, "true");
  assert.equal(presentation.traceColor, "#ffffff");
  assert.equal(presentation.traceWidth, "0.055");
}

async function assertAxisNotationPresentation(page, domain) {
  const notation = await page.evaluate((domainKind) => {
    const source = (selector) => document.querySelector(selector)?.value ?? "";
    const hasPi = (value) => /(?:\bpi\b|π)/i.test(value);
    const spatialSources = [source("#view-x-min-input"), source("#view-x-max-input")];
    if (domainKind === "right-half-line" || domainKind === "finite") {
      spatialSources.push(source("#domain-left-input"));
    }
    if (domainKind === "finite") spatialSources.push(source("#domain-right-input"));
    return {
      expectedX: spatialSources.some(hasPi) ? "pi" : "decimal",
      expectedT: hasPi(source("#final-time-input")) ? "pi" : "decimal",
      snapshotX: document.querySelector(".snapshot-svg")?.getAttribute("data-x-axis-notation"),
      surfaceX: document.querySelector("#surface-plot")?.getAttribute("data-x-axis-notation"),
      surfaceT: document.querySelector("#surface-plot")?.getAttribute("data-t-axis-notation"),
      characteristic: document.querySelector("#surface-plot")?.getAttribute("data-characteristic-notation"),
      snapshotSources: [...document.querySelectorAll(".snapshot-x-tick .snapshot-latex-label")]
        .map((label) => label.getAttribute("data-latex-source") ?? ""),
      surfaceXSources: [...document.querySelectorAll(".space-time-math-label--x-axis-tick")]
        .map((label) => label.getAttribute("data-latex-source") ?? ""),
      surfaceTSources: [...document.querySelectorAll(".space-time-math-label--t-axis-tick")]
        .map((label) => label.getAttribute("data-latex-source") ?? "")
    };
  }, domain);
  assert.equal(notation.snapshotX, notation.expectedX);
  assert.equal(notation.surfaceX, notation.expectedX);
  assert.equal(notation.surfaceT, notation.expectedT);
  assert.equal(notation.characteristic, notation.expectedX);
  const hasPiLabel = (sources) => sources.some((source) => source.includes("\\pi"));
  assert.equal(hasPiLabel(notation.snapshotSources), notation.expectedX === "pi");
  assert.equal(hasPiLabel(notation.surfaceXSources), notation.expectedX === "pi");
  assert.equal(hasPiLabel(notation.surfaceTSources), notation.expectedT === "pi");
}

async function assertSurfaceTopologyPresentation(page, preset, domain) {
  const expectedSource = EXPECTED_ADAPTIVE_SOURCE_COUNTS[`${preset}/${domain}`];
  assert.ok(expectedSource, `Missing adaptive counts for ${preset}/${domain}.`);
  const presentation = await page.evaluate(() => {
    const surface = document.querySelector("#surface-plot");
    const canvas = document.querySelector(".wave-surface-canvas");
    return {
      surface: surface?.getAttribute("data-surface-topology"),
      canvas: canvas?.getAttribute("data-surface-topology"),
      wallMaterial: surface?.getAttribute("data-surface-wall-material"),
      topFaces: Number(surface?.getAttribute("data-stepped-surface-top-faces")),
      wallFaces: Number(surface?.getAttribute("data-stepped-surface-wall-faces")),
      meshXSamples: Number(surface?.getAttribute("data-mesh-x-samples")),
      meshTSamples: Number(surface?.getAttribute("data-mesh-t-samples")),
      sourceXSamples: Number(canvas?.getAttribute("data-x-samples")),
      sourceTSamples: Number(canvas?.getAttribute("data-t-samples")),
      vertices: Number(surface?.getAttribute("data-mesh-vertices")),
      triangles: Number(surface?.getAttribute("data-mesh-triangles"))
    };
  });
  assert.ok(
    presentation.surface === "smooth" || presentation.surface === "stepped",
    `Unexpected surface topology ${presentation.surface}.`
  );
  assert.equal(presentation.canvas, presentation.surface);
  assert.equal(presentation.surface, preset === "square-wave" ? "stepped" : "smooth");
  assert.equal(presentation.sourceXSamples, expectedSource[0]);
  assert.equal(presentation.sourceTSamples, expectedSource[1]);
  assert.equal(Number(await rootDataset(page, "solverXSamples")), expectedSource[0]);
  assert.equal(Number(await rootDataset(page, "solverTSamples")), expectedSource[1]);
  assert.equal(presentation.meshXSamples, (expectedSource[0] + 1) / 2);
  assert.equal(presentation.meshTSamples, expectedSource[1]);
  if (presentation.surface === "stepped") {
    assert.equal(presentation.wallMaterial, "basic-unlit");
    assert.ok(presentation.topFaces > 0);
    assert.ok(presentation.wallFaces > 0);
    assert.ok(presentation.vertices > 0);
    assert.ok(presentation.triangles > 0);
  } else {
    assert.equal(presentation.wallMaterial, "none");
    assert.equal(presentation.topFaces, 0);
    assert.equal(presentation.wallFaces, 0);
  }
}

async function assertPlaybackAndScrubbing(page) {
  await assertStableTimeControlColumns(page);
  const slider = page.locator("#time-slider");
  const previousFrame = Number(await rootDataset(page, "frameSample"));
  const previousPath = await page.locator(".snapshot-curve").getAttribute("d");
  const currentTime = Number(await rootDataset(page, "currentTime"));
  const maximumTime = Number(await slider.getAttribute("aria-valuemax"));
  const targetFraction = currentTime <= maximumTime / 2 ? 0.82 : 0.18;
  await slider.evaluate((input, fraction) => {
    input.value = String(Math.round(Number(input.max) * fraction));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, targetFraction);
  await page.waitForFunction(
    (frame) => Number(document.documentElement.dataset.frameSample) > frame,
    previousFrame,
    { timeout: 4_000 }
  );
  assert.ok(Number(await rootDataset(page, "currentTime")) > 0);
  assert.notEqual(await page.locator(".snapshot-curve").getAttribute("d"), previousPath);
  assert.equal(await rootDataset(page, "playback"), "paused");

  await page.locator("#playback-button").click();
  await expectRootDataset(page, "playback", "playing");
  const firstTime = Number(await rootDataset(page, "currentTime"));
  await page.waitForFunction(
    (time) => Number(document.documentElement.dataset.currentTime) > time,
    firstTime,
    { timeout: 2_000 }
  );
  await page.locator("#playback-button").click();
  await expectRootDataset(page, "playback", "paused");

  const restartFrame = Number(await rootDataset(page, "frameSample"));
  await page.locator("#restart-button").click();
  await expectRootDataset(page, "playback", "paused");
  await page.waitForFunction(
    (frame) =>
      Number(document.documentElement.dataset.frameSample) > frame &&
      Number(document.documentElement.dataset.currentTime) === 0,
    restartFrame,
    { timeout: 2_000 }
  );
  await assertAcceptedPausedAtStart(page);
  assert.equal((await page.locator("#playback-button").textContent())?.trim(), "Play");

  await page.locator("#playback-button").click();
  await expectRootDataset(page, "playback", "playing");
  const restartedTime = Number(await rootDataset(page, "currentTime"));
  await page.waitForFunction(
    (time) => Number(document.documentElement.dataset.currentTime) > time,
    restartedTime,
    { timeout: 2_000 }
  );
  await page.locator("#playback-button").click();
  await expectRootDataset(page, "playback", "paused");

  const replayFrame = Number(await rootDataset(page, "frameSample"));
  await slider.evaluate((input) => {
    input.value = input.max;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    (frame) => Number(document.documentElement.dataset.frameSample) > frame,
    replayFrame,
    { timeout: 2_000 }
  );
  await expectRootDataset(page, "playback", "ended");
  assert.equal((await page.locator("#playback-button").textContent())?.trim(), "Replay");
  assert.equal(await page.locator("#playback-button").getAttribute("aria-label"), "Replay evolution");
  await page.locator("#playback-button").click();
  await expectRootDataset(page, "playback", "playing");
  await page.waitForFunction(
    () => Number(document.documentElement.dataset.currentTime) < 0.25,
    undefined,
    { timeout: 2_000 }
  );
  await page.locator("#playback-button").click();
  await expectRootDataset(page, "playback", "paused");
  await page.locator("#reset-camera-button").click();
}

async function assertStableTimeControlColumns(page) {
  const slider = page.locator("#time-slider");
  const measure = () => page.evaluate(() => {
    const bounds = (selector) => {
      const rectangle = document.querySelector(selector)?.getBoundingClientRect();
      return rectangle?.width ?? 0;
    };
    const output = document.querySelector("#time-output");
    return {
      output: bounds("#time-output"),
      slider: bounds(".time-slider-wrap"),
      control: bounds("#time-control"),
      latex: output?.getAttribute("data-latex-source") ?? "",
      ariaValueText: document.querySelector("#time-slider")?.getAttribute("aria-valuetext") ?? "",
      outputFits: output ? output.scrollWidth <= output.clientWidth : false
    };
  });
  const samples = [];
  for (const value of [0, 41, 333, 334, 410, 1_000]) {
    const previousFrame = Number(await rootDataset(page, "frameSample"));
    await slider.evaluate((input, nextValue) => {
      input.value = String(nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await page.waitForFunction(
      (frame) => Number(document.documentElement.dataset.frameSample) > frame,
      previousFrame,
      { timeout: 2_000 }
    );
    samples.push(await measure());
  }
  for (const { latex, ariaValueText } of samples) {
    assert.match(latex, /^t=\d+\.\d{3}$/);
    assert.equal(ariaValueText, `time ${latex.slice(2)}`);
  }
  const resetFrame = Number(await rootDataset(page, "frameSample"));
  await slider.evaluate((input) => {
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    (frame) => Number(document.documentElement.dataset.frameSample) > frame,
    resetFrame,
    { timeout: 2_000 }
  );
  await page.locator("#playback-button").click();
  await expectRootDataset(page, "playback", "playing");
  const earlyTime = await page.evaluate(async () => {
    while (Number(document.documentElement.dataset.currentTime) <= 0) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    document.querySelector("#playback-button")?.click();
    return Number(document.documentElement.dataset.currentTime);
  });
  await expectRootDataset(page, "playback", "paused");
  samples.push(await measure());
  assert.ok(earlyTime > 0 && earlyTime <= 0.07);
  assert.match(samples.at(-1)?.latex ?? "", /^t=0\.\d{3}$/);
  const spread = (values) => Math.max(...values) - Math.min(...values);
  assert.ok(
    spread(samples.map(({ output }) => output)) < 0.01,
    "The current-time output column must not resize for three-decimal values below one."
  );
  assert.ok(
    spread(samples.map(({ slider }) => slider)) < 0.01,
    "The slider must not shift when the formatted current time changes length."
  );
  assert.ok(
    spread(samples.map(({ control }) => control)) < 0.01,
    "The time-control panel must keep a stable outer width."
  );
  assert.ok(samples.every(({ outputFits }) => outputFits));
}

async function assertCharacteristics(page) {
  await selectPresetAndWait(page, "standing-wave");
  if ((await page.locator("#domain-select").inputValue()) !== "finite") {
    await selectDomainAndWait(page, "finite");
  }
  await assertAcceptedPausedAtStart(page);
  await page.locator("#time-slider").fill("137");
  assert.equal(await page.locator(".snapshot-svg").getAttribute("data-x-axis-notation"), "pi");
  assert.equal(await page.locator("#surface-plot").getAttribute("data-t-axis-notation"), "pi");
  await page.locator("#characteristics-button").click();
  await expectRootDataset(page, "characteristics", "selecting");
  assert.equal(await rootDataset(page, "characteristicEntry"), "open");
  assert.equal(await page.locator("#characteristics-entry").isVisible(), true);
  assert.equal(await page.locator("#characteristics-button").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#characteristic-x-input").getAttribute("inputmode"), "text");
  assert.equal(await page.locator("#characteristic-t-input").getAttribute("inputmode"), "text");
  assert.equal(await page.locator("#characteristic-x-input").getAttribute("aria-invalid"), "false");
  assert.equal(await page.locator("#characteristic-t-input").getAttribute("aria-invalid"), "false");
  assert.match(await page.locator("#characteristic-t-input").inputValue(), /\* pi$/);
  assert.match((await page.locator("#characteristic-entry-feedback").textContent()) ?? "", /ready/i);

  const xEntry = page.locator("#characteristic-x-input");
  const tEntry = page.locator("#characteristic-t-input");
  await xEntry.click();
  await xEntry.press("Control+A");
  await xEntry.pressSequentially("log(", { delay: 12 });
  assert.equal(await xEntry.inputValue(), "log(");
  assert.equal(await xEntry.getAttribute("aria-invalid"), "true");
  assert.equal(await xEntry.evaluate((input) => document.activeElement === input), true);
  assert.equal(await xEntry.evaluate((input) => input.selectionStart), 4);
  await xEntry.pressSequentially("2)", { delay: 12 });
  assert.equal(await xEntry.evaluate((input) => document.activeElement === input), true);
  assert.equal(await xEntry.evaluate((input) => input.selectionStart), 6);
  await tEntry.click();
  await tEntry.press("Control+A");
  await tEntry.pressSequentially("pi / 4", { delay: 12 });
  assert.equal(await xEntry.getAttribute("aria-invalid"), "false");
  assert.equal(await tEntry.getAttribute("aria-invalid"), "false");
  assert.match((await page.locator("#characteristic-entry-feedback").textContent()) ?? "", /ready/i);
  await tEntry.press("Enter");
  await expectRootDataset(page, "characteristics", "active");
  await page.waitForFunction(
    () => document.documentElement.dataset.traceStage === "complete",
    undefined,
    { timeout: 4_000 }
  );
  assert.ok(Math.abs(Number(await rootDataset(page, "currentTime")) - Math.PI / 4) < 1e-9);
  assert.equal(await xEntry.inputValue(), "log(2)");
  assert.equal(await tEntry.inputValue(), "pi / 4");

  const logarithmicTraceRequest = await rootDataset(page, "traceRequest");
  await xEntry.click();
  await xEntry.press("Control+A");
  await xEntry.pressSequentially("pi / 2", { delay: 8 });
  await tEntry.click();
  await tEntry.press("Control+A");
  await tEntry.pressSequentially("pi / 2", { delay: 8 });
  await page.locator("#trace-characteristic-point").click();
  await expectRootDataset(page, "characteristics", "active");
  await page.waitForFunction(
    (request) => document.documentElement.dataset.traceRequest !== request,
    logarithmicTraceRequest,
    { timeout: 4_000 }
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.traceStage === "complete",
    undefined,
    { timeout: 4_000 }
  );
  assert.ok(Math.abs(Number(await rootDataset(page, "currentTime")) - Math.PI / 2) < 1e-9);
  assert.equal(await page.locator("#time-output").getAttribute("data-latex-source"), "t=1.571");
  const piCharacteristicLabels = await page
    .locator(".space-time-math-label--footpoint-label")
    .evaluateAll((labels) => labels.map((label) => label.getAttribute("data-latex-source") ?? ""));
  assert.ok(piCharacteristicLabels.includes(String.raw`\eta=0`));
  assert.ok(piCharacteristicLabels.includes(String.raw`\xi=\pi`));
  assert.doesNotMatch(piCharacteristicLabels.join(" "), /1\.57|3\.14|x[+-]t/);
  const traceRequest = await rootDataset(page, "traceRequest");
  await page.locator("#characteristic-x-input").fill("2 * pi");
  assert.equal(await page.locator("#characteristic-x-input").getAttribute("aria-invalid"), "true");
  assert.match((await page.locator("#characteristic-entry-feedback").textContent()) ?? "", /between/i);
  assert.equal(await rootDataset(page, "traceRequest"), traceRequest);
  assert.equal(await rootDataset(page, "characteristics"), "active");
  await page.locator("#characteristics-button").click();
  await expectRootDataset(page, "characteristics", "off");
  assert.equal(await rootDataset(page, "characteristicEntry"), "closed");
  assert.equal(await page.locator("#characteristics-entry").isHidden(), true);

  await selectPresetAndWait(page, "gaussian-split");
  if ((await page.locator("#domain-select").inputValue()) !== "infinite") {
    await selectDomainAndWait(page, "infinite");
  }
  await assertAcceptedPausedAtStart(page);
  await page.locator("#time-slider").fill("500");
  await page.waitForFunction(
    () => Number(document.documentElement.dataset.currentTime) > 0,
    undefined,
    { timeout: 2_000 }
  );
  assert.equal(await rootDataset(page, "playback"), "paused");
  await page.locator("#characteristics-button").click();
  await expectRootDataset(page, "characteristics", "selecting");
  assert.equal(await page.locator("#characteristics-entry").isVisible(), true);
  assert.equal(
    await page.locator("#characteristics-control, #characteristic-output").count(),
    0,
    "Characteristics should not open a separate domain-of-dependence panel."
  );
  await page.locator("#choose-characteristic-on-curve").click();
  assert.equal(
    await page.locator(".snapshot-svg").evaluate((svg) => document.activeElement === svg),
    true
  );

  const hitArea = page.locator(".snapshot-selection-hit-area");
  await hitArea.waitFor({ state: "visible" });
  const bounds = await hitArea.boundingBox();
  assert.ok(bounds, "The snapshot selection target needs measurable geometry.");
  await page.mouse.click(bounds.x + bounds.width * 0.58, bounds.y + bounds.height * 0.48);
  await expectRootDataset(page, "characteristics", "active");
  await page.waitForFunction(
    () => {
      const surface = document.querySelector("#surface-plot");
      return surface?.getAttribute("data-characteristic-floor-paths") === "2" &&
        surface.getAttribute("data-characteristic-surface-paths") === "0";
    },
    undefined,
    { timeout: 4_000 }
  );
  assert.ok((await page.locator(".snapshot-point").count()) >= 1);
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-characteristic-floor-paths"),
    "2"
  );
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-characteristic-surface-paths"),
    "0"
  );
  assert.equal(
    await page.locator("#surface-plot").getAttribute("data-characteristic-marker-layer"),
    "overlay",
    "Characteristic dots must render in the final overlay pass above the opaque surface."
  );
  assert.equal(await page.locator(".snapshot-characteristic-label").count(), 0);
  const characteristicLabels = await page.locator(".space-time-math-label--footpoint-label")
    .evaluateAll((labels) => labels.map((label) => ({
      latex: label.getAttribute("data-latex-source") ?? "",
      color: getComputedStyle(label).color
    })));
  const eta = characteristicLabels.find((label) => label.latex.startsWith("\\eta="));
  const xi = characteristicLabels.find((label) => label.latex.startsWith("\\xi="));
  assert.match(eta?.latex ?? "", /^\\eta=[^=]+$/);
  assert.equal(eta?.color, "rgb(231, 111, 103)");
  assert.match(xi?.latex ?? "", /^\\xi=[^=]+$/);
  assert.equal(xi?.color, "rgb(169, 112, 255)");
  const characteristicPresentationText = await page.evaluate(() => {
    const css2d = [
      ...document.querySelectorAll(
        ".space-time-math-label--boundary-label, .space-time-math-label--footpoint-label"
      )
    ]
      .filter((label) => {
        const style = getComputedStyle(label);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .flatMap((label) => [
        label.getAttribute("data-latex-source") ?? "",
        label.textContent ?? ""
      ]);
    const svgAccessibleText = [
      ...document.querySelectorAll(".snapshot-svg title, .snapshot-svg desc")
    ].map((label) => label.textContent ?? "");
    return [...css2d, ...svgAccessibleText].join("\n");
  });
  assert.doesNotMatch(
    characteristicPresentationText,
    /x\s*(?:[-−]\s*t|\+\s*t)|x\s+(?:minus|plus)\s+t/i,
    "Characteristic labels should name only eta or xi and their constant values."
  );
  assert.equal(await page.locator(".snapshot-footpoint[data-characteristic-family='eta']").getAttribute("fill"), "#e76f67");
  assert.equal(await page.locator(".snapshot-footpoint[data-characteristic-family='xi']").getAttribute("fill"), "#a970ff");
  assert.equal(
    await page.locator(".snapshot-footpoint[data-characteristic-family='eta']")
      .evaluate((marker) => getComputedStyle(marker).fill),
    "rgb(231, 111, 103)"
  );
  assert.equal(
    await page.locator(".snapshot-footpoint[data-characteristic-family='xi']")
      .evaluate((marker) => getComputedStyle(marker).fill),
    "rgb(169, 112, 255)"
  );
  assert.match((await page.locator(".snapshot-svg desc").textContent()) ?? "", /red eta.*purple xi/i);

  await page.locator("#characteristics-button").click();
  await expectRootDataset(page, "characteristics", "off");
}

async function assertUiAndResponsiveLayout(page) {
  await page.locator("#ui-toggle").click();
  await page.locator("#restore-ui").waitFor({ state: "visible" });
  assert.equal(await page.locator("body").getAttribute("data-ui-hidden"), "true");
  await page.locator("#restore-ui").click();
  assert.equal(await page.locator("body").getAttribute("data-ui-hidden"), "false");

  if (await page.locator("#problem-menu").isVisible()) {
    await page.locator("#problem-close").click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const compact = await page.evaluate(() => {
    const shell = document.querySelector("#app-shell");
    const stage = document.querySelector("#wave-stage");
    const stageBounds = stage?.getBoundingClientRect();
    const formula = document.querySelector("#problem-formula")?.getBoundingClientRect();
    const problemHeader = document.querySelector(".problem-control__header")?.getBoundingClientRect();
    const surface = document.querySelector("#surface-section")?.getBoundingClientRect();
    const snapshot = document.querySelector("#snapshot-section")?.getBoundingClientRect();
    const viewControls = document.querySelector("#view-controls")?.getBoundingClientRect();
    const time = document.querySelector("#time-control")?.getBoundingClientRect();
    const timeOutput = document.querySelector("#time-output");
    const timeTick = document.querySelector("#time-ticks .time-tick");
    const snapshotSvg = document.querySelector(".snapshot-svg");
    const snapshotUAxis = snapshotSvg?.querySelector(".snapshot-axis-u");
    const snapshotUName = snapshotSvg?.querySelector(".snapshot-u-axis-label");
    const snapshotUTicks = [
      ...(snapshotSvg?.querySelectorAll("foreignObject.snapshot-u-tick") ?? [])
    ];
    const uAxisX = Number(snapshotUAxis?.getAttribute("x1"));
    const snapshotSvgBounds = snapshotSvg?.getBoundingClientRect();
    const uAxisScreenX = snapshotSvgBounds && snapshotSvg
      ? snapshotSvgBounds.left +
        (uAxisX / snapshotSvg.viewBox.baseVal.width) * snapshotSvgBounds.width
      : Number.NaN;
    const foreignBox = (label) => {
      const left = Number(label?.getAttribute("x"));
      const width = Number(label?.getAttribute("width"));
      return { left, right: left + width };
    };
    const uNameBox = foreignBox(snapshotUName);
    const uTickGlyphBoxes = snapshotUTicks.map((label) =>
      label.querySelector(".katex")?.getBoundingClientRect()
    );
    return {
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      shellDisplay: shell ? getComputedStyle(shell).display : "",
      stagePosition: stage ? getComputedStyle(stage).position : "",
      formulaBottom: formula?.bottom ?? 0,
      formulaTop: formula?.top ?? 0,
      headerBottom: problemHeader?.bottom ?? 0,
      stageTop: stageBounds?.top ?? 0,
      surfaceBottom: surface?.bottom ?? 0,
      stageLeft: stageBounds?.left ?? 0,
      stageWidth: stageBounds?.width ?? 0,
      snapshotLeft: snapshot?.left ?? 0,
      snapshotWidth: snapshot?.width ?? 0,
      snapshotTop: snapshot?.top ?? 0,
      snapshotBottom: snapshot?.bottom ?? 0,
      viewControlsTop: viewControls?.top ?? 0,
      viewControlsBottom: viewControls?.bottom ?? 0,
      timeTop: time?.top ?? 0,
      timeOutputFontSize: timeOutput ? Number.parseFloat(getComputedStyle(timeOutput).fontSize) : 0,
      timeTickFontSize: timeTick ? Number.parseFloat(getComputedStyle(timeTick).fontSize) : 0,
      snapshotSvgWidth: snapshotSvg?.viewBox.baseVal.width ?? 0,
      snapshotUNameGap: uNameBox.left - uAxisX,
      snapshotUNameRight: uNameBox.right,
      snapshotUTickGaps: uTickGlyphBoxes.map((bounds) =>
        bounds ? uAxisScreenX - bounds.right : Number.NaN
      ),
      snapshotUTickLeftClearances: uTickGlyphBoxes.map((bounds) =>
        bounds && snapshotSvgBounds ? bounds.left - snapshotSvgBounds.left : Number.NaN
      ),
      snapshotUTickRightClearances: uTickGlyphBoxes.map((bounds) =>
        bounds && snapshotSvgBounds ? snapshotSvgBounds.right - bounds.right : Number.NaN
      ),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    };
  });
  assert.equal(compact.shellDisplay, "flex");
  assert.equal(compact.stagePosition, "relative");
  assert.ok(compact.formulaTop > compact.headerBottom);
  assert.ok(compact.stageTop > compact.formulaBottom);
  assert.ok(compact.snapshotTop > compact.surfaceBottom);
  assert.ok(compact.viewControlsTop > compact.snapshotBottom);
  assert.ok(compact.timeTop > compact.viewControlsBottom);
  assert.ok(Math.abs(compact.snapshotWidth - compact.stageWidth) < 1);
  assert.ok(Math.abs(compact.snapshotLeft - compact.stageLeft) < 1);
  assert.ok(Math.abs(compact.timeOutputFontSize - 19.2) < 0.05);
  assert.ok(Math.abs(compact.timeTickFontSize - 12) < 0.05);
  assert.equal(
    compact.snapshotUNameGap,
    18,
    "At compact width, u(x,t) should retain the enlarged gap right of the central axis."
  );
  assert.ok(
    compact.snapshotUNameRight <= compact.snapshotSvgWidth,
    "At compact width, the u(x,t) foreign object must remain inside the SVG."
  );
  assert.ok(
    compact.snapshotUTickGaps.every((gap) => gap >= 6 && gap <= 32) &&
      compact.snapshotUTickLeftClearances.every((clearance) => clearance >= -0.5) &&
      compact.snapshotUTickRightClearances.every((clearance) => clearance >= -0.5),
    "At compact width, rendered numeric u labels must remain left of the axis without clipping."
  );
  assert.equal(
    compact.scrollWidth,
    compact.clientWidth,
    "Moving snapshot u labels must not introduce compact horizontal overflow."
  );
  await page.locator("#characteristics-button").click();
  await expectRootDataset(page, "characteristics", "selecting");
  const compactEntry = await page.locator("#characteristics-entry").evaluate((entry) => ({
    visible: !entry.hidden,
    width: entry.getBoundingClientRect().width,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  assert.equal(compactEntry.visible, true);
  assert.ok(Math.abs(compactEntry.width - compact.stageWidth) < 1);
  assert.equal(compactEntry.scrollWidth, compactEntry.clientWidth);
  await page.locator("#characteristics-button").click();
  await expectRootDataset(page, "characteristics", "off");
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function assertFormulaFitsProblemStack(page, description) {
  const layout = await page.locator("#problem-formula").evaluate((formula) => {
    const bounds = formula.getBoundingClientRect();
    const math = formula.querySelector(".katex")?.getBoundingClientRect();
    return {
      parent: formula.parentElement?.id ?? "",
      previous: formula.previousElementSibling?.className ?? "",
      next: formula.nextElementSibling?.id ?? "",
      clientWidth: formula.clientWidth,
      scrollWidth: formula.scrollWidth,
      mathLeft: math?.left ?? bounds.left,
      mathRight: math?.right ?? bounds.right,
      left: bounds.left,
      right: bounds.right
    };
  });
  assert.equal(layout.parent, "problem-control", `${description} should stay in the problem stack.`);
  assert.match(layout.previous, /problem-control__header/);
  assert.equal(layout.next, "problem-menu");
  assert.ok(
    layout.scrollWidth <= layout.clientWidth &&
      layout.mathLeft >= layout.left &&
      layout.mathRight <= layout.right,
    `${description} should fit inside the left symbolic card without clipping.`
  );
}

async function assertReducedMotionStart(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForAcceptedSolution(page);
    assert.equal(await rootDataset(page, "playback"), "paused");
    assert.equal(Number(await rootDataset(page, "currentTime")), 0);
  } finally {
    await context.close();
  }
}

async function assertWebglFallback(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
      if (typeof type === "string" && type.toLowerCase().includes("webgl")) {
        return null;
      }
      return nativeGetContext.call(this, type, ...args);
    };
  });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(document.querySelector(".snapshot-curve")?.getAttribute("d")),
      undefined,
      { timeout: 10_000 }
    );
    assert.equal(await page.locator("#webgl-notice, #surface-plot .webgl-notice").first().isVisible(), true);
    assert.equal(await page.locator(".snapshot-svg").count(), 1);
  } finally {
    await context.close();
  }
}

async function assertPresetPiSources(page, preset, domain) {
  const key = `${preset}/${domain}`;
  const expected = {
    "gaussian-split/infinite": {
      T: "8", xMin: "-6", xMax: "6", fUpper: "inf", gUpper: "inf"
    },
    "gaussian-split/right-half-line": {
      T: "8", xMin: "0", xMax: "9", fUpper: "5", gUpper: "inf"
    },
    "gaussian-split/finite": {
      T: "2 * pi", xMax: "pi", domainRight: "pi", fUpper: "pi", gUpper: "pi",
      expressionFragment: "pi / 2"
    },
    "square-wave/infinite": {
      T: "4 * pi", xMin: "-2 * pi", xMax: "2 * pi", fUpper: "pi / 4", gUpper: "inf"
    },
    "square-wave/right-half-line": {
      T: "4 * pi", xMin: "0", xMax: "3 * pi", fUpper: "7 * pi / 4", gUpper: "inf"
    },
    "square-wave/finite": {
      T: "4 * pi", xMin: "0", xMax: "2 * pi", domainRight: "2 * pi",
      fUpper: "3 * pi / 4", gUpper: "2 * pi"
    },
    "fixed-end/infinite": {
      T: "6", xMin: "-6", xMax: "9", fUpper: "inf", gUpper: "inf"
    },
    "fixed-end/right-half-line": {
      T: "16", xMin: "0", xMax: "9", fUpper: "inf", gUpper: "inf"
    },
    "fixed-end/finite": {
      T: "16", xMin: "0", xMax: "9", domainRight: "9", fUpper: "9", gUpper: "9"
    },
    "standing-wave/infinite": {
      T: "2 * pi", xMin: "-pi", xMax: "pi", fUpper: "inf", gUpper: "inf"
    },
    "standing-wave/right-half-line": {
      T: "2 * pi", xMin: "0", xMax: "pi", fUpper: "inf", gUpper: "inf"
    },
    "standing-wave/finite": {
      T: "2 * pi", xMin: "0", xMax: "pi", domainRight: "pi", fUpper: "pi", gUpper: "pi"
    },
    "mixed-boundaries/infinite": {
      T: "4 * pi", xMin: "-pi", xMax: "pi", fUpper: "inf", gUpper: "inf"
    },
    "mixed-boundaries/right-half-line": {
      T: "4 * pi", xMin: "0", xMax: "2 * pi", fUpper: "inf", gUpper: "inf"
    },
    "mixed-boundaries/finite": {
      T: "4 * pi", xMin: "0", xMax: "pi", domainRight: "pi", fUpper: "pi", gUpper: "pi"
    },
    "boundary-driven/infinite": {
      T: "6", xMin: "-6", xMax: "6", fUpper: "inf", gUpper: "inf"
    },
    "boundary-driven/right-half-line": {
      T: "20", xMin: "0", xMax: "9", fUpper: "inf", gUpper: "inf",
      boundaryFragment: "sin(pi * t)"
    },
    "boundary-driven/finite": {
      T: "20", xMin: "0", xMax: "pi", domainRight: "pi", fUpper: "pi", gUpper: "pi",
      boundaryFragment: "sin(pi * t)"
    }
  }[key];

  const actual = {
    T: await page.locator("#final-time-input").inputValue(),
    xMin: await page.locator("#view-x-min-input").inputValue(),
    xMax: await page.locator("#view-x-max-input").inputValue(),
    domainRight: await page.locator("#domain-right-input").inputValue(),
    fUpper: await page.locator(".piece-row[data-source='f'] .piece-upper").first().inputValue(),
    gUpper: await page.locator(".piece-row[data-source='g'] .piece-upper").first().inputValue()
  };
  assert.doesNotMatch(
    Object.values(actual).join(" "),
    /3\.141592|6\.283185|12\.56637/,
    `${key} should not expose decimal expansions of pi.`
  );
  if (!expected) return;
  for (const [field, source] of Object.entries(expected)) {
    if (field === "expressionFragment" || field === "boundaryFragment") continue;
    assert.equal(actual[field], source, `${key} ${field} should use an exact pi source.`);
  }
  if (expected.expressionFragment) {
    assert.match(
      await page.locator(".piece-row[data-source='f'] .piece-expression").first().inputValue(),
      new RegExp(expected.expressionFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  }
  if (expected.boundaryFragment) {
    assert.ok(
      (await page.locator("#left-boundary-expression").inputValue()).includes(expected.boundaryFragment)
    );
  }
}

async function selectPresetAndWait(page, preset) {
  const preferredDomain = PREFERRED_PRESET_DOMAINS[preset];
  assert.ok(preferredDomain, `Preset ${preset} needs a preferred domain.`);
  const revision = Number(await rootDataset(page, "acceptedRevision"));
  await page.locator("#preset-select").selectOption(preset);
  await expectRootDataset(page, "playback", "paused");
  try {
    await page.waitForFunction(
      ({ previousRevision, preset, preferredDomain }) =>
        Number(document.documentElement.dataset.acceptedRevision) > previousRevision &&
        document.documentElement.dataset.geometryReady === "true" &&
        document.documentElement.dataset.playback === "paused" &&
        Number(document.documentElement.dataset.currentTime) === 0 &&
        document.querySelector("#preset-select")?.value === preset &&
        document.querySelector("#domain-select")?.value === preferredDomain,
      { previousRevision: revision, preset, preferredDomain },
      { timeout: 10_000 }
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      acceptedRevision: document.documentElement.dataset.acceptedRevision,
      preset: document.querySelector("#preset-select")?.value,
      domain: document.querySelector("#domain-select")?.value,
      playback: document.documentElement.dataset.playback,
      currentTime: document.documentElement.dataset.currentTime,
      status: document.querySelector("#source-status")?.textContent
    }));
    throw new Error(
      `Preset ${preset} did not advance revision ${revision}: ${JSON.stringify(state)}`,
      { cause: error }
    );
  }
  assert.equal(await page.locator("#preset-select").inputValue(), preset);
  assert.equal(await page.locator("#domain-select").inputValue(), preferredDomain);
  await assertAcceptedPausedAtStart(page);
}

async function selectDomainAndWait(page, domain) {
  if ((await page.locator("#domain-select").inputValue()) === domain) {
    await assertAcceptedPausedAtStart(page);
    return;
  }
  const revision = Number(await rootDataset(page, "acceptedRevision"));
  await page.locator("#domain-select").selectOption(domain);
  await expectRootDataset(page, "playback", "paused");
  try {
    await page.waitForFunction(
      ({ revision, domain }) =>
        Number(document.documentElement.dataset.acceptedRevision) > revision &&
        document.documentElement.dataset.geometryReady === "true" &&
        document.documentElement.dataset.playback === "paused" &&
        Number(document.documentElement.dataset.currentTime) === 0 &&
        document.querySelector("#domain-select")?.value === domain,
      { revision, domain },
      { timeout: 10_000 }
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      acceptedRevision: document.documentElement.dataset.acceptedRevision,
      preset: document.querySelector("#preset-select")?.value,
      domain: document.querySelector("#domain-select")?.value,
      playback: document.documentElement.dataset.playback,
      currentTime: document.documentElement.dataset.currentTime,
      status: document.querySelector("#source-status")?.textContent
    }));
    throw new Error(
      `Domain ${domain} did not advance revision ${revision}: ${JSON.stringify(state)}`,
      { cause: error }
    );
  }
  await assertAcceptedPausedAtStart(page);
}

async function assertAcceptedPausedAtStart(page) {
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.geometryReady === "true" &&
      document.documentElement.dataset.playback === "paused" &&
      Number(document.documentElement.dataset.currentTime) === 0,
    undefined,
    { timeout: 4_000 }
  );
  assert.equal(await rootDataset(page, "playback"), "paused");
  assert.equal(Number(await rootDataset(page, "currentTime")), 0);
  assert.equal(await page.locator("#time-slider").inputValue(), "0");
  assert.equal(await page.locator("#time-slider").getAttribute("aria-valuenow"), "0");
  assert.equal(
    await page.locator("#time-output").getAttribute("data-latex-source"),
    "t=0.000"
  );
  assert.equal(
    await page.locator("#playback-button").getAttribute("aria-label"),
    "Play evolution"
  );
  assert.equal(await page.locator("#playback-button").getAttribute("aria-pressed"), "false");
}

async function assertFocusedEditorInput(page, input, expectedValue) {
  const state = await input.evaluate((element) => ({
    value: element.value,
    focused: document.activeElement === element,
    sameElement: window.__waveFocusedEditorInput === element,
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd
  }));
  assert.deepEqual(
    state,
    {
      value: expectedValue,
      focused: true,
      sameElement: true,
      selectionStart: expectedValue.length,
      selectionEnd: expectedValue.length
    },
    "Controlled editor renders must preserve the focused input and its caret."
  );
}

async function waitForAcceptedSolution(page) {
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.geometryReady === "true" &&
      Number(document.documentElement.dataset.acceptedRevision) > 0 &&
      Boolean(document.querySelector(".snapshot-curve")?.getAttribute("d")),
    undefined,
    { timeout: 15_000 }
  );
}

async function rootDataset(page, name) {
  return page.locator("html").getAttribute(
    `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
  );
}

async function expectRootDataset(page, name, value) {
  await page.waitForFunction(
    ({ name, value }) => document.documentElement.dataset[name] === value,
    { name, value },
    { timeout: 4_000 }
  );
}
