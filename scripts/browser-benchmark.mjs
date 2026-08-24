import assert from "node:assert/strict";

import {
  artifactDirectory,
  launchChromium,
  prepareArtifacts,
  startPreview,
  stopPreview
} from "./browser-utils.mjs";

const TARGET_SOLVE_MS = Number(process.env.BENCHMARK_SOLVE_MS ?? 600);
const TARGET_FIRST_SURFACE_MS = Number(
  process.env.BENCHMARK_FIRST_SURFACE_MS ?? 2_500
);
const TARGET_FRAME_MS = Number(process.env.BENCHMARK_FRAME_MS ?? 16.7);
const TARGET_LONG_TASK_MS = Number(process.env.BENCHMARK_LONG_TASK_MS ?? 50);
const INITIAL_RUNS = positiveInteger(process.env.BENCHMARK_INITIAL_RUNS, 3);
const ENFORCE_TARGETS = process.env.BENCHMARK_ENFORCE === "1";
const port = Number(
  process.env.BROWSER_BENCHMARK_PORT ?? 35_000 + (process.pid % 10_000)
);
const { baseUrl, child: preview } = await startPreview({
  externalUrl: process.env.BENCHMARK_URL,
  port
});

await prepareArtifacts();

let browser;
let context;
let page;

try {
  browser = await launchChromium();
  context = await createInstrumentedContext(browser);
  page = await context.newPage();

  const initialSamples = [];
  for (let run = 0; run < INITIAL_RUNS; run += 1) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForAcceptedSolution(page);
    const sample = await page.evaluate(() => ({
      solveMs: Number(document.documentElement.dataset.solveMs),
      firstSurfaceMs: performance.now(),
      acceptedRevision: Number(document.documentElement.dataset.acceptedRevision),
      vertices: document.querySelector(".snapshot-curve")?.getAttribute("d")?.length ?? 0
    }));
    assertFiniteNonNegative(sample.solveMs, "initial worker solve");
    assertFiniteNonNegative(sample.firstSurfaceMs, "first surface paint");
    assert.ok(sample.acceptedRevision > 0);
    assert.ok(sample.vertices > 20);
    initialSamples.push(sample);
  }

  // Use a fresh browser after cold starts so reload cleanup is not attributed
  // to ordinary interaction work.
  await context.close();
  context = undefined;
  await browser.close();
  browser = await launchChromium();
  context = await createInstrumentedContext(browser);
  page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForAcceptedSolution(page);

  const slider = page.locator("#time-slider");
  const sliderMaximum = Number(await slider.getAttribute("max"));
  assert.ok(Number.isFinite(sliderMaximum) && sliderMaximum > 0);
  const values = [0.08, 0.2, 0.36, 0.52, 0.7, 0.9, 0.42, 0.16, 0.63, 0.3]
    .map((fraction) => Math.round(sliderMaximum * fraction));

  await settleRetainedTimeRenderer(page);
  const timeMeasurement = await measureTimeUpdates(page, values);
  const updateSamples = timeMeasurement.samples;
  const timeLongTasks = await takeLongTasks(page, timeMeasurement.finishedAt);

  await openEditor(page);
  const adaptiveMeasurement = await measureScalarCommit(page, "20");
  assert.equal(adaptiveMeasurement.solverXSamples, 513);
  assert.equal(adaptiveMeasurement.solverTSamples, 401);
  const adaptiveLongTasks = await takeLongTasks(page, adaptiveMeasurement.finishedAt);
  await measureScalarCommit(page, "8");
  const presetMeasurement = await measurePresetSelection(page, "standing-wave");
  const presetLongTasks = await takeLongTasks(page, presetMeasurement.finishedAt);
  const steppedPresetMeasurement = await measurePresetSelection(page, "square-wave");
  const steppedPresetLongTasks = await takeLongTasks(
    page,
    steppedPresetMeasurement.finishedAt
  );

  const characteristicMeasurement = await measureCharacteristicSelection(page);
  const characteristicLongTasks = await takeLongTasks(
    page,
    characteristicMeasurement.finishedAt
  );

  if (process.env.BENCHMARK_DEBUG === "1") {
    console.log("Long-task windows", {
      timeLongTasks,
      adaptiveLongTasks,
      presetLongTasks,
      steppedPresetLongTasks,
      characteristicLongTasks
    });
    console.log("Characteristic stages", characteristicMeasurement.stages);
  }

  const solveMedian = median(initialSamples.map(({ solveMs }) => solveMs));
  const firstSurfaceMedian = median(
    initialSamples.map(({ firstSurfaceMs }) => firstSurfaceMs)
  );
  const frameP95 = percentile(
    updateSamples.flatMap(({ frameDurations }) => frameDurations),
    0.95
  );
  const latencyP95 = percentile(
    updateSamples.map(({ latencyMs }) => latencyMs),
    0.95
  );
  const dispatchP95 = percentile(
    updateSamples.map(({ dispatchMs }) => dispatchMs),
    0.95
  );
  const maximumTimeLongTask = maximumDuration(timeLongTasks);
  const maximumAdaptiveLongTask = maximumDuration(adaptiveLongTasks);
  const maximumPresetLongTask = maximumDuration(presetLongTasks);
  const maximumSteppedPresetLongTask = maximumDuration(steppedPresetLongTasks);
  const maximumCharacteristicLongTask = maximumDuration(characteristicLongTasks);

  const report = {
    "worker solve median": solveMedian,
    "first surface median": firstSurfaceMedian,
    "animation callback p95": frameP95,
    "input-to-render p95": latencyP95,
    "input dispatch p95": dispatchP95,
    "maximum time-update long task": maximumTimeLongTask,
    "adaptive T=20 worker solve": adaptiveMeasurement.solveMs,
    "maximum adaptive-resolution long task": maximumAdaptiveLongTask,
    "maximum preset long task": maximumPresetLongTask,
    "maximum stepped-preset long task": maximumSteppedPresetLongTask,
    "maximum characteristic long task": maximumCharacteristicLongTask
  };
  console.log(
    `Browser benchmark: ${INITIAL_RUNS} cold starts and ${updateSamples.length} retained time updates.`
  );
  console.table(
    Object.fromEntries(
      Object.entries(report).map(([name, value]) => [
        name,
        { milliseconds: value.toFixed(3) }
      ])
    )
  );

  const targetMisses = [];
  if (solveMedian >= TARGET_SOLVE_MS) {
    targetMisses.push(
      `worker solve median ${solveMedian.toFixed(3)} ms >= ${TARGET_SOLVE_MS} ms`
    );
  }
  if (firstSurfaceMedian >= TARGET_FIRST_SURFACE_MS) {
    targetMisses.push(
      `first surface median ${firstSurfaceMedian.toFixed(3)} ms >= ${TARGET_FIRST_SURFACE_MS} ms`
    );
  }
  if (frameP95 >= TARGET_FRAME_MS) {
    targetMisses.push(
      `animation callback p95 ${frameP95.toFixed(3)} ms >= ${TARGET_FRAME_MS} ms`
    );
  }
  if (adaptiveMeasurement.solveMs >= TARGET_SOLVE_MS) {
    targetMisses.push(
      `adaptive T=20 worker solve ${adaptiveMeasurement.solveMs.toFixed(3)} ms >= ` +
      `${TARGET_SOLVE_MS} ms`
    );
  }
  for (const [name, duration] of [
    ["time update", maximumTimeLongTask],
    ["adaptive resolution", maximumAdaptiveLongTask],
    ["preset selection", maximumPresetLongTask],
    ["stepped preset selection", maximumSteppedPresetLongTask],
    ["characteristic selection", maximumCharacteristicLongTask]
  ]) {
    if (duration >= TARGET_LONG_TASK_MS) {
      targetMisses.push(
        `${name} long task ${duration.toFixed(3)} ms >= ${TARGET_LONG_TASK_MS} ms`
      );
    }
  }

  if (targetMisses.length === 0) {
    console.log(
      `Reference targets met: solve < ${TARGET_SOLVE_MS} ms, first surface < ` +
        `${TARGET_FIRST_SURFACE_MS} ms, animation callback p95 < ${TARGET_FRAME_MS} ms, ` +
        `and no measured interaction task >= ${TARGET_LONG_TASK_MS} ms.`
    );
  } else if (ENFORCE_TARGETS) {
    throw new Error(`Performance target missed:\n- ${targetMisses.join("\n- ")}`);
  } else {
    console.warn(
      "Performance targets are reference-machine guidance and are not enforced on this host. " +
        "Set BENCHMARK_ENFORCE=1 to enforce them.\n" +
        `- ${targetMisses.join("\n- ")}`
    );
  }
} catch (error) {
  if (page !== undefined) {
    await page
      .screenshot({
        path: new URL("browser-benchmark-failure.png", artifactDirectory).pathname,
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

async function measureTimeUpdates(page, values) {
  // Install the complete sequence, then leave the page alone while it runs.
  // This keeps CDP polling/evaluation tasks out of the Long Task window.
  await page.evaluate((nextValues) => {
    window.__waveTimeBenchmark = null;
    const input = document.querySelector("#time-slider");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("#time-slider must be an input.");
    }
    const root = document.documentElement;
    const samples = [];
    const run = (index) => {
      if (index >= nextValues.length) {
        window.__waveTimeBenchmark = {
          samples,
          finishedAt: performance.now()
        };
        return;
      }
      const value = nextValues[index];
      const previousFrame = Number(root.dataset.frameSample);
      const frameStartIndex = (window.__waveRafDurations ?? []).length;
      const startedAt = performance.now();
      let dispatchMs = 0;
      const observer = new MutationObserver(() => {
        if (Number(root.dataset.frameSample) <= previousFrame) return;
        observer.disconnect();
        samples.push({
          value,
          dispatchMs,
          latencyMs: performance.now() - startedAt,
          frameDurations: (window.__waveRafDurations ?? [])
            .slice(frameStartIndex)
            .map(({ duration }) => duration)
        });
        window.requestAnimationFrame(() => run(index + 1));
      });
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["data-frame-sample"]
      });
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      dispatchMs = performance.now() - startedAt;
    };
    window.setTimeout(() => {
      window.__waveResetLongTasks?.();
      window.requestAnimationFrame(() => run(0));
    }, 0);
  }, values);
  await nodePause(1_200);
  const measurement = await page.evaluate(() => window.__waveTimeBenchmark);
  assert.ok(measurement, "The in-page time-update benchmark did not finish.");
  assert.equal(measurement.samples.length, values.length);
  for (const sample of measurement.samples) {
    const value = sample.value;
    assertFiniteNonNegative(sample.dispatchMs, `time value ${value} dispatch`);
    assertFiniteNonNegative(sample.latencyMs, `time value ${value} latency`);
    assert.ok(sample.frameDurations.length > 0);
    sample.frameDurations.forEach((duration) =>
      assertFiniteNonNegative(duration, `time value ${value} frame`)
    );
  }
  return measurement;
}

async function settleRetainedTimeRenderer(page) {
  await page.evaluate(async () => {
    const input = document.querySelector("#time-slider");
    if (!(input instanceof HTMLInputElement)) return;
    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  });
}

async function measurePresetSelection(page, preset) {
  await page.evaluate((nextPreset) => {
    window.__wavePresetBenchmark = null;
    const select = document.querySelector("#preset-select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("#preset-select must be a select element.");
    }
    const root = document.documentElement;
    const previousRevision = Number(root.dataset.acceptedRevision);
    window.setTimeout(() => {
      window.__waveResetLongTasks?.();
      window.setTimeout(() => {
        const startedAt = performance.now();
        const observer = new MutationObserver(() => {
          if (Number(root.dataset.acceptedRevision) <= previousRevision) return;
          observer.disconnect();
          window.__wavePresetBenchmark = {
            latencyMs: performance.now() - startedAt,
            finishedAt: performance.now(),
            revision: Number(root.dataset.acceptedRevision)
          };
        });
        observer.observe(root, {
          attributes: true,
          attributeFilter: ["data-accepted-revision"]
        });
        select.value = nextPreset;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, 0);
    }, 0);
  }, preset);
  await nodePause(1_200);
  const measurement = await page.evaluate(() => ({
    result: window.__wavePresetBenchmark,
    status: document.querySelector("#source-status")?.textContent,
    preset: document.querySelector("#preset-select")?.value
  }));
  assert.ok(
    measurement.result,
    `Preset benchmark did not finish: ${measurement.preset}, ${measurement.status}`
  );
  return measurement.result;
}

async function measureScalarCommit(page, source) {
  await page.evaluate((nextSource) => {
    window.__waveScalarBenchmark = null;
    const input = document.querySelector("#final-time-input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("#final-time-input must be an input element.");
    }
    const root = document.documentElement;
    const previousRevision = Number(root.dataset.acceptedRevision);
    window.setTimeout(() => {
      window.__waveResetLongTasks?.();
      const startedAt = performance.now();
      const observer = new MutationObserver(() => {
        if (Number(root.dataset.acceptedRevision) <= previousRevision) return;
        observer.disconnect();
        window.__waveScalarBenchmark = {
          latencyMs: performance.now() - startedAt,
          finishedAt: performance.now(),
          solveMs: Number(root.dataset.solveMs),
          solverXSamples: Number(root.dataset.solverXSamples),
          solverTSamples: Number(root.dataset.solverTSamples)
        };
      });
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["data-accepted-revision"]
      });
      input.value = nextSource;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 0);
  }, source);
  await nodePause(1_400);
  const measurement = await page.evaluate(() => window.__waveScalarBenchmark);
  assert.ok(measurement, `Scalar benchmark did not finish for T=${source}.`);
  return measurement;
}

async function measureCharacteristicSelection(page) {
  await page.evaluate(() => {
    window.__waveCharacteristicBenchmark = null;
    const root = document.documentElement;
    const button = document.querySelector("#characteristics-button");
    const hitArea = document.querySelector(".snapshot-selection-hit-area");
    if (!(button instanceof HTMLButtonElement) || !(hitArea instanceof SVGGraphicsElement)) {
      throw new Error("Characteristic controls are unavailable.");
    }
    window.setTimeout(() => {
      button.click();
      window.requestAnimationFrame(() => {
        // Opening the compact KaTeX-rich menu and choosing a curve point are
        // separate user gestures. Let the browser paint the opened menu once,
        // then start a fresh observation window for the point gesture itself.
        window.requestAnimationFrame(() => {
          window.__waveResetLongTasks?.();
          window.setTimeout(() => {
            const bounds = hitArea.getBoundingClientRect();
            const startedAt = performance.now();
            const observer = new MutationObserver(() => {
              if (root.dataset.characteristics !== "active") return;
              observer.disconnect();
              window.__waveCharacteristicBenchmark = {
                latencyMs: performance.now() - startedAt,
                finishedAt: performance.now(),
                stages: {
                  computeMs: Number(root.dataset.traceComputeMs),
                  prepareMs: Number(root.dataset.traceSurfacePrepareMs),
                  webglMs: Number(root.dataset.traceSurfaceWebglMs),
                  labelsMs: Number(root.dataset.traceSurfaceLabelsMs),
                  snapshotMs: Number(root.dataset.traceSnapshotMs)
                }
              };
            });
            observer.observe(root, {
              attributes: true,
              attributeFilter: ["data-characteristics"]
            });
            hitArea.dispatchEvent(new PointerEvent("pointerdown", {
              bubbles: true,
              pointerId: 1,
              pointerType: "mouse",
              clientX: bounds.left + bounds.width * 0.55,
              clientY: bounds.top + bounds.height * 0.5
            }));
          }, 0);
        });
      });
    }, 0);
  });
  await nodePause(800);
  const measurement = await page.evaluate(() => window.__waveCharacteristicBenchmark);
  assert.ok(measurement, "The characteristic benchmark did not finish.");
  return measurement;
}

async function createInstrumentedContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce"
  });
  await context.addInitScript(() => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.__waveRafDurations = [];
    window.__waveLongTasks = [];
    window.__waveLongTaskCutoff = 0;
    window.requestAnimationFrame = (callback) =>
      nativeRequestAnimationFrame((timestamp) => {
        const startedAt = performance.now();
        try {
          callback(timestamp);
        } finally {
          window.__waveRafDurations.push({
            startedAt,
            duration: performance.now() - startedAt
          });
        }
      });

    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < (window.__waveLongTaskCutoff ?? 0)) continue;
          window.__waveLongTasks.push({
            startedAt: entry.startTime,
            duration: entry.duration,
            cutoff: window.__waveLongTaskCutoff ?? 0
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      window.__waveLongTaskObserver = observer;
    }
    window.__waveResetLongTasks = () => {
      window.__waveLongTaskObserver?.takeRecords();
      window.__waveLongTaskCutoff = performance.now();
      window.__waveLongTasks = [];
    };
  });
  return context;
}

async function openEditor(page) {
  if (await page.locator("#problem-menu").isHidden()) {
    await page.locator("#problem-toggle").click();
    await page.locator("#problem-menu").waitFor({ state: "visible" });
  }
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

async function takeLongTasks(page, finishedAt) {
  return page.evaluate((measurementEnd) => {
    const cutoff = window.__waveLongTaskCutoff ?? 0;
    for (const entry of window.__waveLongTaskObserver?.takeRecords() ?? []) {
      if (entry.startTime < cutoff || entry.startTime >= measurementEnd) continue;
      window.__waveLongTasks.push({
        startedAt: entry.startTime,
        duration: entry.duration,
        cutoff
      });
    }
    return (window.__waveLongTasks ?? []).filter(
      ({ startedAt }) => startedAt >= cutoff && startedAt < measurementEnd
    );
  }, finishedAt);
}

function nodePause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function maximumDuration(tasks) {
  return Math.max(0, ...tasks.map(({ duration }) => duration));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertFiniteNonNegative(value, label) {
  assert.ok(Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative.`);
}

function median(values) {
  return percentile(values, 0.5);
}

function percentile(values, ratio) {
  assert.ok(values.length > 0, "A percentile needs at least one sample.");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[rank];
}
