import assert from "node:assert/strict";
import { artifactDirectory, monitorBrowserErrors } from "./browser-utils.mjs";

async function ready(page, previous = 0) {
  await page.waitForFunction(previous =>
    document.documentElement.dataset.geometryReady === "true" &&
    Number(document.documentElement.dataset.acceptedRevision) > previous &&
    document.querySelector("#source-status").classList.contains("is-ready"),
  previous, { timeout: 15_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export async function assertReviewRegressions(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  monitorBrowserErrors(page, errors);
  try {
    await page.goto(baseUrl);
    await ready(page);
    await page.locator("#characteristics-button").focus();
    await page.keyboard.press("Space");
    assert.equal(await page.locator("html").getAttribute("data-characteristics"), "selecting");
    assert.equal(await page.locator("html").getAttribute("data-playback"), "paused");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("html").getAttribute("data-characteristics"), "off");
    await page.locator(".snapshot-svg").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(".snapshot-point").getAttribute("visibility"), "hidden");

    await page.locator("#characteristics-button").click();
    await page.locator("#characteristic-t-input").fill("1.25");
    await page.evaluate(() => {
      const root = document.documentElement;
      const observer = new MutationObserver(() => {
        if (root.dataset.traceStage !== "three-prepared") return;
        observer.disconnect();
        const slider = document.querySelector("#time-slider");
        slider.value = String(Number(slider.value) + 1);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
      observer.observe(root, { attributes: true, attributeFilter: ["data-trace-stage"] });
    });
    await page.getByRole("button", { name: "Trace", exact: true }).click();
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset;
      return state.traceStage === "complete" && Number(state.currentTime) > 1.25 && state.traceTime === state.currentTime;
    });
    await page.locator("#playback-button").click();
    await page.waitForFunction(() => Number(document.documentElement.dataset.currentTime) > 1.4);
    await page.locator("#playback-button").click();
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset;
      return state.playback === "paused" && state.traceStage === "complete" && state.traceTime === state.currentTime;
    });
    await page.locator("#characteristics-button").click();
    await page.locator("#restart-button").click();
    await page.waitForFunction(() => document.documentElement.dataset.currentTime === "0");

    await page.locator("#final-time-input").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const focus = await page.locator("#final-time-input").evaluate(input => ({
      focused: document.activeElement === input,
      width: parseFloat(getComputedStyle(input).outlineWidth),
      style: getComputedStyle(input).outlineStyle
    }));
    assert.ok(focus.focused && focus.width >= 2 && focus.style !== "none");

    const previous = Number(await page.locator("html").getAttribute("data-accepted-revision"));
    const oldCurve = await page.locator(".snapshot-curve").getAttribute("d");
    const bound = page.locator("#displacement-piece-list .piece-lower").first();
    await bound.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("1/", { delay: 50 });
    await page.locator("#add-displacement-piece").click();
    assert.equal(await bound.getAttribute("aria-invalid"), "true");
    assert.ok(await bound.evaluate(input => input === document.activeElement));
    assert.equal(Number(await page.locator("html").getAttribute("data-accepted-revision")), previous);
    assert.equal(await page.locator(".snapshot-curve").getAttribute("d"), oldCurve);
    assert.equal(await page.locator("#displacement-piece-list .piece-row").count(), 1);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("-inf", { delay: 50 });
    await ready(page, previous);

    await page.locator("#initial-profile-toggle").check();
    const initial = page.locator(".snapshot-initial-curve");
    assert.equal(await initial.count(), 1);
    assert.ok((await initial.getAttribute("d"))?.length > 20);
    const initialPath = await initial.getAttribute("d");
    await page.locator("#time-slider").focus();
    await page.keyboard.press("ArrowRight");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await initial.getAttribute("d"), initialPath);
    await page.locator("#initial-profile-toggle").uncheck();

    await page.locator("#preset-select").selectOption("boundary-driven");
    await ready(page, previous + 1);
    const drivenRevision = Number(await page.locator("html").getAttribute("data-accepted-revision"));
    await page.locator("#final-time-input").fill("2");
    await page.locator("#view-x-max-input").fill("4");
    await page.locator("#displacement-piece-list .piece-expression").fill("0");
    await page.locator("#velocity-piece-list .piece-expression").fill("0");
    await page.locator("#left-boundary-expression").fill("(1+sign(t-1))/2");
    await ready(page, drivenRevision);
    assert.equal(await page.locator("#surface-plot").getAttribute("data-surface-topology"), "stepped");
    assert.equal(await page.locator("html").getAttribute("data-solver-x-samples"), "1025");
    assert.equal(await page.locator("html").getAttribute("data-solver-t-samples"), "257");

    // Use a fresh default problem when assessing default camera containment.
    await page.goto(baseUrl);
    await ready(page);
    await page.locator("#problem-close").click();
    await page.screenshot({ path: new URL("implementation-desktop.png", artifactDirectory).pathname });
    for (const width of [320, 390, 700, 760, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: width < 761 ? 844 : 900 });
      await page.locator("#reset-camera-button").click();
      await ready(page);
      const clipped = await page.locator("#surface-plot").evaluate(host => {
        const container = host.getBoundingClientRect();
        return [...host.querySelectorAll(".space-time-math-label")].filter(label => {
          const bounds = label.getBoundingClientRect();
          return bounds.width && (bounds.left < container.left - 1 || bounds.right > container.right + 1 ||
            bounds.top < container.top - 1 || bounds.bottom > container.bottom + 1);
        }).map(label => label.textContent);
      });
      assert.deepEqual(clipped, [], `Default 3D labels clipped at ${width}px: ${clipped.join(", ")}`);
      for (const [id, name] of [["restart-button", "Restart"], ["reset-camera-button", "Reset view"], ["characteristics-button", "Characteristics"]]) {
        assert.equal(await page.getByRole("button", { name, exact: true }).getAttribute("id"), id);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await assertPlaneDrag(page);
    assert.deepEqual(errors, [], `Review regressions produced browser errors: ${errors.join("\n")}`);
  } finally {
    await context.close();
  }

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mobile = await touch.newPage();
  const mobileErrors = [];
  monitorBrowserErrors(mobile, mobileErrors);
  try {
    await mobile.goto(baseUrl);
    await ready(mobile);
    await mobile.getByRole("button", { name: "Play evolution", exact: true }).tap();
    await mobile.waitForFunction(() => Number(document.documentElement.dataset.currentTime) > 0);
    await mobile.getByRole("button", { name: "Pause evolution", exact: true }).tap();
    await mobile.getByRole("button", { name: "Restart", exact: true }).tap();
    await mobile.waitForFunction(() => document.documentElement.dataset.currentTime === "0");
    await mobile.screenshot({ path: new URL("implementation-mobile.png", artifactDirectory).pathname, fullPage: true });
    assert.deepEqual(mobileErrors, []);
  } finally {
    await touch.close();
  }
}

export async function assertPlaneDrag(page) {
  const host = page.locator("#surface-plot");
  const box = await host.boundingBox();
  const grab = await host.evaluate(element => ({ x: Number(element.dataset.timePlaneGrabX), y: Number(element.dataset.timePlaneGrabY) }));
  assert.ok(box && Number.isFinite(grab.x) && Number.isFinite(grab.y));
  const before = Number(await page.locator("html").getAttribute("data-current-time"));
  await page.mouse.move(box.x + grab.x, box.y + grab.y);
  await page.mouse.down();
  await page.mouse.move(box.x + grab.x + 110, box.y + grab.y - 45, { steps: 20 });
  await page.mouse.up();
  await page.waitForFunction(before => Number(document.documentElement.dataset.currentTime) !== before, before);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("html").getAttribute("data-playback"), "paused");
  const times = await page.evaluate(() => [
    document.documentElement.dataset.currentTime,
    document.querySelector("#surface-plot").dataset.currentTime,
    document.querySelector(".snapshot-svg").dataset.currentTime
  ].map(Number));
  assert.ok(times.every(time => Math.abs(time - times[0]) < 1e-5), "Plane and snapshot must share the final drag time.");
}
