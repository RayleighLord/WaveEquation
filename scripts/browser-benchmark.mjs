import assert from "node:assert/strict";

import {
  artifactDirectory,
  launchChromium,
  monitorBrowserErrors,
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
const TIME_UPDATE_REPEATS = positiveInteger(
  process.env.BENCHMARK_UPDATE_REPEATS,
  1
);
const MEASUREMENT_COMPLETION_TIMEOUT_MS = positiveInteger(
  process.env.BENCHMARK_MEASUREMENT_TIMEOUT_MS,
  15_000
);
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
let benchmarkSignalSequence = 0;
const browserErrors = [];

try {
  browser = await launchChromium();
  const initialSamples = [];
  const warmSamples = [];
  for (let run = 0; run < INITIAL_RUNS; run += 1) {
    context = await createInstrumentedContext(browser);
    page = await context.newPage();
    monitorBrowserErrors(page, browserErrors);
    for (const samples of [initialSamples, warmSamples]) {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await waitForAcceptedSolution(page);
      await page.waitForFunction(() => Number(document.documentElement.dataset.firstPresentationMs) > 0);
      const sample = await page.evaluate(() => ({
        solveMs: Number(document.documentElement.dataset.solveMs),
        firstSurfaceMs: Number(document.documentElement.dataset.firstPresentationMs),
        acceptedRevision: Number(document.documentElement.dataset.acceptedRevision),
        vertices: document.querySelector(".snapshot-curve")?.getAttribute("d")?.length ?? 0
      }));
      assertFiniteNonNegative(sample.solveMs, "initial worker solve");
      assertFiniteNonNegative(sample.firstSurfaceMs, "first presentation opportunity");
      assert.ok(sample.acceptedRevision > 0);
      assert.ok(sample.vertices > 20);
      samples.push(sample);
    }
    await context.close();
    context = undefined;
  }

  // Use a fresh browser after cold starts so reload cleanup is not attributed
  // to ordinary interaction work.
  await browser.close();
  browser = await launchChromium();
  context = await createInstrumentedContext(browser);
  page = await context.newPage();
  monitorBrowserErrors(page, browserErrors);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForAcceptedSolution(page);
  await waitForStableRendererLayout(page);
  console.log("Benchmark environment", {
    browser: browser.version(),
    ...await page.evaluate(() => {
      const canvas = document.querySelector(".wave-surface-canvas");
      const gl = canvas.getContext("webgl2");
      const extension = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        viewport: `${innerWidth}x${innerHeight}`,
        devicePixelRatio,
        renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : "unavailable",
        samples: [document.documentElement.dataset.solverXSamples, document.documentElement.dataset.solverTSamples]
      };
    })
  });

  const slider = page.locator("#time-slider");
  const sliderMaximum = Number(await slider.getAttribute("max"));
  assert.ok(Number.isFinite(sliderMaximum) && sliderMaximum > 0);
  const updateCycle = [0.08, 0.2, 0.36, 0.52, 0.7, 0.9, 0.42, 0.16, 0.63, 0.3]
    .map((fraction) => Math.round(sliderMaximum * fraction));
  const values = Array.from(
    { length: TIME_UPDATE_REPEATS },
    () => updateCycle
  ).flat();

  await settleRetainedTimeRenderer(page);
  const timeMeasurement = await measureTimeUpdates(page, values);
  const updateSamples = timeMeasurement.samples;
  const timeLongTasks = await takeLongTasks(page, timeMeasurement.finishedAt);
  const dragMeasurement = await measurePlaneDrag(page);
  const dragLongTasks = await takeLongTasks(page, dragMeasurement.finishedAt);
  const playbackMeasurement = await measurePlayback(page, "smooth");
  const playbackLongTasks = await takeLongTasks(page, playbackMeasurement.finishedAt);

  await openEditor(page);
  const adaptiveMeasurement = await measureScalarCommit(page, "20");
  assert.equal(adaptiveMeasurement.solverXSamples, 513);
  assert.equal(adaptiveMeasurement.solverTSamples, 401);
  const adaptiveLongTasks = await takeLongTasks(page, adaptiveMeasurement.finishedAt);
  await measureScalarCommit(page, "18", "view-x-max-input");
  assert.equal(Number(await page.locator("html").getAttribute("data-solver-x-samples")), 1025);
  const denseMeasurement = await measureTimeUpdates(page, values);
  const denseLongTasks = await takeLongTasks(page, denseMeasurement.finishedAt);
  await measureScalarCommit(page, "6", "view-x-max-input");
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
  const tracePlaybackMeasurement = await measurePlayback(page, "square with characteristics");
  assert.ok(tracePlaybackMeasurement.traceCompletions > 0,
    "Sustained characteristic playback must finish refreshed traces.");
  const tracePlaybackLongTasks = await takeLongTasks(page, tracePlaybackMeasurement.finishedAt);

  if (process.env.BENCHMARK_DEBUG === "1") {
    console.log("Long-task windows", {
      timeLongTasks,
      adaptiveLongTasks,
      presetLongTasks,
      steppedPresetLongTasks,
      characteristicLongTasks
    });
    console.log("Characteristic stages", characteristicMeasurement.stages);
    console.log("Time update samples", updateSamples);
    console.log("Preset presentation callbacks", await page.evaluate(({ start, end }) => {
      const callbacks = window.__waveRafDurations.filter(frame => frame.startedAt >= start && frame.startedAt <= end);
      return { count: callbacks.length, maximum: Math.max(0, ...callbacks.map(frame => frame.duration)) };
    }, { start: presetMeasurement.finishedAt - presetMeasurement.latencyMs, end: presetMeasurement.finishedAt }));
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
    "cold-context presentation opportunity median": firstSurfaceMedian,
    "warm navigation presentation opportunity median": median(warmSamples.map(sample => sample.firstSurfaceMs)),
    "animation callback p95": frameP95,
    "input-to-submission p95": latencyP95,
    "input dispatch p95": dispatchP95,
    "plane drag callback p95": percentile(dragMeasurement.frameDurations, 0.95),
    "maximum plane drag long task": maximumDuration(dragLongTasks),
    "maximum time-update long task": maximumTimeLongTask,
    "adaptive T=20 worker solve": adaptiveMeasurement.solveMs,
    "maximum adaptive-resolution long task": maximumAdaptiveLongTask,
    "maximum preset long task": maximumPresetLongTask,
    "maximum stepped-preset long task": maximumSteppedPresetLongTask,
    "maximum characteristic long task": maximumCharacteristicLongTask,
    "sustained smooth playback callback p95": percentile(playbackMeasurement.frameDurations, 0.95),
    "sustained trace playback callback p95": percentile(tracePlaybackMeasurement.frameDurations, 0.95),
    "maximum sustained playback long task": maximumDuration(playbackLongTasks),
    "maximum sustained trace long task": maximumDuration(tracePlaybackLongTasks),
    "maximum density submission p95": percentile(denseMeasurement.samples.map(sample => sample.latencyMs), 0.95),
    "maximum density long task": maximumDuration(denseLongTasks)
  };
  console.log(
    `Browser benchmark: ${INITIAL_RUNS} fresh-context and warm navigations, ${updateSamples.length} retained time updates.`
  );
  console.table(
    Object.fromEntries(
      Object.entries(report).map(([name, value]) => [
        name,
        { milliseconds: value.toFixed(3) }
      ])
    )
  );

  assert.deepEqual(browserErrors, [], `Unexpected browser errors:\n${browserErrors.join("\n")}`);
  for (const [name, value] of Object.entries(report)) assertFiniteNonNegative(value, name);
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
  for (const [label, measurement] of [["plane drag", dragMeasurement], ["sustained playback", playbackMeasurement], ["sustained trace playback", tracePlaybackMeasurement]]) {
    const duration = percentile(measurement.frameDurations, 0.95);
    if (duration >= TARGET_FRAME_MS) targetMisses.push(`${label} callback p95 ${duration.toFixed(3)} ms >= ${TARGET_FRAME_MS} ms`);
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
    ["characteristic selection", maximumCharacteristicLongTask],
    ["sustained playback", maximumDuration(playbackLongTasks)],
    ["sustained trace playback", maximumDuration(tracePlaybackLongTasks)],
    ["maximum density", maximumDuration(denseLongTasks)],
    ["plane drag", maximumDuration(dragLongTasks)]
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
  // The page owns the complete sequence and emits one protocol event only
  // after its final frame. The host waits without polling or keeping a pending
  // Runtime.evaluate call inside the Long Task observation window.
  const signal = nextBenchmarkSignal("time");
  const completion = waitForBenchmarkSignal(page, signal, "Time-update benchmark");
  const start = page.evaluate(({ nextValues, signal }) => {
    window.__waveTimeBenchmark = null;
    window.__waveTimeBenchmarkProgress = {
      completed: 0,
      expected: nextValues.length
    };
    const input = document.querySelector("#time-slider");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("#time-slider must be an input.");
    }
    const root = document.documentElement;
    const samples = [];
    let activeObserver = null;
    let cancelled = false;
    window.__waveCancelBenchmark = () => {
      cancelled = true;
      activeObserver?.disconnect();
    };
    const run = (index) => {
      if (cancelled) return;
      if (index >= nextValues.length) {
        window.__waveTimeBenchmark = {
          samples,
          finishedAt: performance.now()
        };
        delete window.__waveCancelBenchmark;
        window.setTimeout(() => console.debug(signal), 0);
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
        activeObserver = null;
        const finishedAt = performance.now();
        samples.push({
          value,
          startedAt,
          finishedAt,
          dispatchMs,
          latencyMs: finishedAt - startedAt,
          frameDurations: (window.__waveRafDurations ?? [])
            .slice(frameStartIndex)
            .map(({ duration }) => duration)
        });
        window.__waveTimeBenchmarkProgress.completed = samples.length;
        window.requestAnimationFrame(() => run(index + 1));
      });
      activeObserver = observer;
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
  }, { nextValues: values, signal });
  await Promise.all([completion, start]);
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
  const signal = nextBenchmarkSignal(`preset-${preset}`);
  const completion = waitForBenchmarkSignal(page, signal, `Preset ${preset}`);
  const start = page.evaluate(({ nextPreset, signal }) => {
    window.__wavePresetBenchmark = null;
    const select = document.querySelector("#preset-select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("#preset-select must be a select element.");
    }
    const root = document.documentElement;
    const previousRevision = Number(root.dataset.acceptedRevision);
    let observer = null;
    let cancelled = false;
    window.__waveCancelBenchmark = () => {
      cancelled = true;
      observer?.disconnect();
    };
    window.setTimeout(() => {
      if (cancelled) return;
      window.__waveResetLongTasks?.();
      window.setTimeout(() => {
        if (cancelled) return;
        const startedAt = performance.now();
        observer = new MutationObserver(() => {
          if (Number(root.dataset.acceptedRevision) <= previousRevision) return;
          observer?.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (cancelled) return;
            window.__wavePresetBenchmark = {
              latencyMs: performance.now() - startedAt,
              finishedAt: performance.now(),
              revision: Number(root.dataset.acceptedRevision)
            };
            delete window.__waveCancelBenchmark;
            window.setTimeout(() => console.debug(signal), 0);
          }));
        });
        observer.observe(root, {
          attributes: true,
          attributeFilter: ["data-accepted-revision"]
        });
        select.value = nextPreset;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, 0);
    }, 0);
  }, { nextPreset: preset, signal });
  await Promise.all([completion, start]);
  const measurement = await page.evaluate(() => window.__wavePresetBenchmark);
  assert.ok(measurement, `Preset benchmark did not finish for ${preset}.`);
  return measurement;
}

async function measureScalarCommit(page, source, fieldId = "final-time-input") {
  const signal = nextBenchmarkSignal(`scalar-${fieldId}-${source}`);
  const completion = waitForBenchmarkSignal(page, signal, `Scalar benchmark for T=${source}`);
  const start = page.evaluate(({ nextSource, signal, fieldId }) => {
    window.__waveScalarBenchmark = null;
    const input = document.getElementById(fieldId);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("#final-time-input must be an input element.");
    }
    const root = document.documentElement;
    const previousRevision = Number(root.dataset.acceptedRevision);
    let observer = null;
    let cancelled = false;
    window.__waveCancelBenchmark = () => {
      cancelled = true;
      observer?.disconnect();
    };
    window.setTimeout(() => {
      if (cancelled) return;
      window.__waveResetLongTasks?.();
      const startedAt = performance.now();
      observer = new MutationObserver(() => {
        if (Number(root.dataset.acceptedRevision) <= previousRevision) return;
        observer?.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (cancelled) return;
          window.__waveScalarBenchmark = {
            latencyMs: performance.now() - startedAt,
            finishedAt: performance.now(),
            solveMs: Number(root.dataset.solveMs),
            solverXSamples: Number(root.dataset.solverXSamples),
            solverTSamples: Number(root.dataset.solverTSamples)
          };
          delete window.__waveCancelBenchmark;
          window.setTimeout(() => console.debug(signal), 0);
        }));
      });
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["data-accepted-revision"]
      });
      input.value = nextSource;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 0);
  }, { nextSource: source, signal, fieldId });
  await Promise.all([completion, start]);
  const measurement = await page.evaluate(() => window.__waveScalarBenchmark);
  assert.ok(measurement, `Scalar benchmark did not finish for T=${source}.`);
  return measurement;
}

async function measureCharacteristicSelection(page) {
  const signal = nextBenchmarkSignal("characteristics");
  const completion = waitForBenchmarkSignal(page, signal, "Characteristic benchmark");
  const start = page.evaluate((signal) => {
    window.__waveCharacteristicBenchmark = null;
    const root = document.documentElement;
    const button = document.querySelector("#characteristics-button");
    const hitArea = document.querySelector(".snapshot-selection-hit-area");
    if (!(button instanceof HTMLButtonElement) || !(hitArea instanceof SVGGraphicsElement)) {
      throw new Error("Characteristic controls are unavailable.");
    }
    let observer = null;
    let cancelled = false;
    window.__waveCancelBenchmark = () => {
      cancelled = true;
      observer?.disconnect();
    };
    window.setTimeout(() => {
      if (cancelled) return;
      button.click();
      window.requestAnimationFrame(() => {
        // Opening the compact KaTeX-rich menu and choosing a curve point are
        // separate user gestures. Let the browser paint the opened menu once,
        // then start a fresh observation window for the point gesture itself.
        window.requestAnimationFrame(() => {
          if (cancelled) return;
          window.__waveResetLongTasks?.();
          window.setTimeout(() => {
            if (cancelled) return;
            const bounds = hitArea.getBoundingClientRect();
            const startedAt = performance.now();
            observer = new MutationObserver(() => {
              if (root.dataset.characteristics !== "active") return;
              observer?.disconnect();
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
              delete window.__waveCancelBenchmark;
              window.setTimeout(() => console.debug(signal), 0);
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
  }, signal);
  await Promise.all([completion, start]);
  const measurement = await page.evaluate(() => window.__waveCharacteristicBenchmark);
  assert.ok(measurement, "The characteristic benchmark did not finish.");
  return measurement;
}

async function measurePlaneDrag(page) {
  const host = page.locator("#surface-plot");
  const box = await host.boundingBox();
  const grab = await host.evaluate(element => ({ x: Number(element.dataset.timePlaneGrabX), y: Number(element.dataset.timePlaneGrabY) }));
  assert.ok(box && Number.isFinite(grab.x) && Number.isFinite(grab.y));
  await page.mouse.move(box.x + grab.x, box.y + grab.y);
  const signal = nextBenchmarkSignal("plane-drag");
  await page.evaluate(signal => {
    const controller = new AbortController();
    let started = false;
    let cancelled = false;
    let frameStart = 0;
    let firstTime = 0;
    let firstWebgl = 0;
    let pointerMoves = 0;
    const root = document.documentElement;
    const host = document.querySelector("#surface-plot");
    window.__waveCancelBenchmark = () => { cancelled = true; controller.abort(); };
    window.addEventListener("pointerdown", () => {
      started = true;
      window.__waveResetLongTasks?.();
      frameStart = window.__waveRafDurations.length;
      firstTime = Number(root.dataset.currentTime);
      firstWebgl = Number(host.dataset.webglFrames);
    }, { once: true, capture: true, signal: controller.signal });
    window.addEventListener("pointermove", () => { if (started) pointerMoves++; }, { signal: controller.signal });
    window.addEventListener("pointerup", () => {
      if (!started) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cancelled) return;
        window.__waveDragBenchmark = {
          finishedAt: performance.now(),
          timeDelta: Number(root.dataset.currentTime) - firstTime,
          webglFrames: Number(host.dataset.webglFrames) - firstWebgl,
          pointerMoves,
          frameDurations: window.__waveRafDurations.slice(frameStart).map(frame => frame.duration)
        };
        controller.abort();
        delete window.__waveCancelBenchmark;
        window.setTimeout(() => console.debug(signal), 0);
      }));
    }, { once: true, signal: controller.signal });
  }, signal);
  const completion = waitForBenchmarkSignal(page, signal, "Native plane drag");
  await page.mouse.down();
  await page.mouse.move(box.x + grab.x + 110, box.y + grab.y - 45, { steps: 40 });
  await page.mouse.up();
  await completion;
  const result = await page.evaluate(() => window.__waveDragBenchmark);
  assert.ok(result.timeDelta !== 0 && result.webglFrames > 0 && result.pointerMoves > 0,
    "Plane dragging must update the actual WebGL time plane.");
  assert.ok(result.webglFrames <= result.pointerMoves + 2, "Dragging should not duplicate WebGL submissions.");
  assert.ok(result.frameDurations.length > 0);
  result.frameDurations.forEach(value => assertFiniteNonNegative(value, "plane drag callback"));
  return result;
}

async function measurePlayback(page, label) {
  const signal = nextBenchmarkSignal(`playback-${label}`);
  const completion = waitForBenchmarkSignal(page, signal, `Playback ${label}`);
  const start = page.evaluate(({ signal }) => {
    let timer;
    let cancelled = false;
    const root = document.documentElement;
    const button = document.querySelector("#playback-button");
    window.__waveCancelBenchmark = () => {
      cancelled = true;
      clearTimeout(timer);
      if (root.dataset.playback === "playing") button.click();
    };
    window.setTimeout(() => {
      if (cancelled) return;
      window.__waveResetLongTasks?.();
      const startedAt = performance.now();
      const initialFrame = Number(root.dataset.frameSample);
      const initialTime = Number(root.dataset.currentTime);
      const frameStart = window.__waveRafDurations.length;
      const initialCompletions = Number(root.dataset.traceCompletedCount);
      button.click();
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (root.dataset.playback === "playing") button.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (cancelled) return;
          window.__wavePlaybackBenchmark = {
            startedAt,
            finishedAt: performance.now(),
            frames: Number(root.dataset.frameSample) - initialFrame,
            timeDelta: Number(root.dataset.currentTime) - initialTime,
            traceCompletions: Number(root.dataset.traceCompletedCount) - initialCompletions,
            frameDurations: window.__waveRafDurations.slice(frameStart).map(frame => frame.duration)
          };
          delete window.__waveCancelBenchmark;
          window.setTimeout(() => console.debug(signal), 0);
        }));
      }, 1600);
    }, 0);
  }, { signal });
  await Promise.all([completion, start]);
  const result = await page.evaluate(() => window.__wavePlaybackBenchmark);
  assert.ok(result.frames > 5 && result.timeDelta > 0, `${label} must actually advance playback.`);
  assert.ok(result.frameDurations.length > 5);
  result.frameDurations.forEach(value => assertFiniteNonNegative(value, `${label} callback`));
  return result;
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
            cutoff: window.__waveLongTaskCutoff ?? 0,
            name: entry.name,
            attribution: [...(entry.attribution ?? [])].map((item) => ({
              name: item.name,
              containerType: item.containerType,
              containerName: item.containerName,
              containerId: item.containerId,
              containerSrc: item.containerSrc
            }))
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
  assert.equal(await page.locator("html").getAttribute("data-webgl"), "true",
    "The 3D benchmark requires WebGL; SVG fallback is tested separately.");
  assert.equal(await page.locator(".wave-surface-canvas").count(), 1);
}

async function waitForStableRendererLayout(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    const signature = () => {
      const surface = document.querySelector("#surface-section")?.getBoundingClientRect();
      const snapshot = document.querySelector("#snapshot-section")?.getBoundingClientRect();
      const canvas = document.querySelector(".wave-surface-canvas");
      return [
        surface?.width ?? 0,
        surface?.height ?? 0,
        snapshot?.width ?? 0,
        snapshot?.height ?? 0,
        canvas?.getAttribute("width") ?? "missing",
        canvas?.getAttribute("height") ?? "missing"
      ].join(":");
    };
    let previous = "";
    let stableFrames = 0;
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      const current = signature();
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 2) return;
    }
    throw new Error(`Renderer layout did not settle: ${previous}.`);
  });
}

async function takeLongTasks(page, finishedAt) {
  return page.evaluate((measurementEnd) => {
    const cutoff = window.__waveLongTaskCutoff ?? 0;
    for (const entry of window.__waveLongTaskObserver?.takeRecords() ?? []) {
      if (entry.startTime < cutoff || entry.startTime >= measurementEnd) continue;
      window.__waveLongTasks.push({
        startedAt: entry.startTime,
        duration: entry.duration,
        cutoff,
        name: entry.name,
        attribution: [...(entry.attribution ?? [])].map((item) => ({
          name: item.name,
          containerType: item.containerType,
          containerName: item.containerName,
          containerId: item.containerId,
          containerSrc: item.containerSrc
        }))
      });
    }
    return (window.__waveLongTasks ?? []).filter(
      ({ startedAt }) => startedAt >= cutoff && startedAt < measurementEnd
    );
  }, finishedAt);
}

function nextBenchmarkSignal(label) {
  benchmarkSignalSequence += 1;
  return `wave-benchmark:${process.pid}:${benchmarkSignalSequence}:${label}`;
}

async function waitForBenchmarkSignal(page, signal, label) {
  try {
    await page.waitForEvent("console", {
      predicate: (message) =>
        message.type() === "debug" && message.text() === signal,
      timeout: MEASUREMENT_COMPLETION_TIMEOUT_MS
    });
  } catch (cause) {
    const state = await page.evaluate(() => {
      window.__waveCancelBenchmark?.();
      delete window.__waveCancelBenchmark;
      return {
        timeUpdates: window.__waveTimeBenchmarkProgress ?? {
          completed: window.__waveTimeBenchmark?.samples?.length ?? 0,
          expected: "unknown"
        },
        frame: document.documentElement.dataset.frameSample ?? "unset",
        geometry: document.documentElement.dataset.geometryReady ?? "unset",
        playback: document.documentElement.dataset.playback ?? "unset",
        revision: document.documentElement.dataset.acceptedRevision ?? "unset",
        preset: document.querySelector("#preset-select")?.value ?? "missing",
        status: document.querySelector("#source-status")?.textContent ?? "missing",
        characteristics: document.documentElement.dataset.characteristics ?? "unset",
        traceStage: document.documentElement.dataset.traceStage ?? "unset"
      };
    });
    throw new Error(
      `${label} did not finish within ${MEASUREMENT_COMPLETION_TIMEOUT_MS} ms: ` +
        JSON.stringify(state),
      { cause }
    );
  }
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
