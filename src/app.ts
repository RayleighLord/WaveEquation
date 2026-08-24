import {
  evaluateFiniteConstantExpression,
  sampleSolution,
  traceCharacteristics,
  waveProblemMayHaveDiscontinuousDisplacement,
  type WavePresetId
} from "./math";
import {
  SnapshotRenderer,
  SpaceTimeRenderer,
  type AxisValueNotation,
  type SurfaceTopology
} from "./plot";
import {
  axisValueToInputSource,
  axisValueToLatex,
  renderLatex
} from "./plot/latex";
import type {
  CharacteristicTrace,
  ProblemNotice,
  WaveProblem,
  WaveSolutionGrid
} from "./types";
import {
  ProblemEditor,
  WaveAppController,
  type WaveAppViewModel
} from "./ui";

const DRAFT_DEBOUNCE_MS = 260;
const PLAYBACK_DURATION_MS = 12_000;
const TIME_SLIDER_STEPS = 1_000;
const APP_START_MARK = "wave:app-start";

export interface CharacteristicPointInputBounds {
  xMin: number;
  xMax: number;
  T: number;
}

export type CharacteristicPointInputResult =
  | { ok: true; x: number; t: number }
  | { ok: false; field: "x" | "t"; message: string };

/** Parse a manually entered characteristic point without runtime code generation. */
export function parseCharacteristicPointInput(
  xSource: string,
  tSource: string,
  bounds: CharacteristicPointInputBounds
): CharacteristicPointInputResult {
  const x = parseFiniteConstantPointCoordinate(xSource, "x");
  if (!x.ok) return x;
  const t = parseFiniteConstantPointCoordinate(tSource, "t");
  if (!t.ok) return t;

  if (!isWithinInclusiveTolerance(x.value, bounds.xMin, bounds.xMax)) {
    return {
      ok: false,
      field: "x",
      message: `Choose x between ${formatNumber(bounds.xMin)} and ${formatNumber(bounds.xMax)}.`
    };
  }
  if (!isWithinInclusiveTolerance(t.value, 0, bounds.T)) {
    return {
      ok: false,
      field: "t",
      message: `Choose t between 0 and ${formatNumber(bounds.T)}.`
    };
  }
  return {
    ok: true,
    x: clamp(x.value, bounds.xMin, bounds.xMax),
    t: clamp(t.value, 0, bounds.T)
  };
}

export function startApp(): void {
  performance.mark(APP_START_MARK);

  const root = document.documentElement;
  const shell = getElement<HTMLElement>("app-shell");
  const surfaceHost = getElement<HTMLElement>("surface-plot");
  const snapshotHost = getElement<HTMLElement>("snapshot-plot");
  const surfaceDescription = getElement<HTMLElement>("surface-description");
  const snapshotDescription = getElement<HTMLElement>("snapshot-description");
  const loading = getElement<HTMLElement>("solve-loading");
  const webglNotice = getElement<HTMLElement>("webgl-notice");
  const sourceStatus = getElement<HTMLElement>("source-status");
  const warningsList = getElement<HTMLElement>("problem-warnings");
  const problemTitle = getElement<HTMLElement>("problem-title");
  const problemFormula = getElement<HTMLElement>("problem-formula-math");
  const problemToggle = getElement<HTMLButtonElement>("problem-toggle");
  const problemToggleLabel = problemToggle.querySelector<HTMLElement>("[data-problem-toggle-label]");
  const problemClose = getElement<HTMLButtonElement>("problem-close");
  const problemMenu = getElement<HTMLElement>("problem-menu");
  const playbackButton = getElement<HTMLButtonElement>("playback-button");
  const playbackLabel = playbackButton.querySelector<HTMLElement>("[data-playback-label]");
  const timeSlider = getElement<HTMLInputElement>("time-slider");
  const timeOutput = getElement<HTMLOutputElement>("time-output");
  const timeTicks = getElement<HTMLElement>("time-ticks");
  const characteristicsButton = getElement<HTMLButtonElement>("characteristics-button");
  const characteristicsLabel = characteristicsButton.querySelector<HTMLElement>("span");
  const characteristicsEntry = getElement<HTMLElement>("characteristics-entry");
  const characteristicPointForm = getElement<HTMLFormElement>("characteristic-point-form");
  const characteristicXInput = getElement<HTMLInputElement>("characteristic-x-input");
  const characteristicTInput = getElement<HTMLInputElement>("characteristic-t-input");
  const characteristicEntryFeedback = getElement<HTMLElement>("characteristic-entry-feedback");
  const chooseCharacteristicOnCurve = getElement<HTMLButtonElement>("choose-characteristic-on-curve");
  const resetCameraButton = getElement<HTMLButtonElement>("reset-camera-button");
  const restartButton = getElement<HTMLButtonElement>("restart-button");
  const uiToggle = getElement<HTMLButtonElement>("ui-toggle");
  const uiLabel = uiToggle.querySelector<HTMLElement>("[data-ui-label]");
  const restoreUi = getElement<HTMLButtonElement>("restore-ui");
  const interactionStatus = getElement<HTMLElement>("interaction-status");
  const uiChrome = Array.from(shell.querySelectorAll<HTMLElement>(".ui-chrome"));

  renderStaticLatex(shell);
  renderTimeOutput(timeOutput, 0, "Time");
  createTimeTicks(timeTicks, Number(timeSlider.getAttribute("aria-valuemax") ?? 3));

  root.dataset.geometryReady = "false";
  root.dataset.currentTime = "0";
  root.dataset.playback = "paused";
  root.dataset.problemOpen = "true";
  root.dataset.characteristics = "off";
  root.dataset.characteristicEntry = "closed";
  root.dataset.frameSample = "0";
  root.dataset.webgl = "pending";
  root.dataset.traceStage = "idle";
  shell.dataset.uiHidden = "false";
  document.body.dataset.uiHidden = "false";

  let currentResult: WaveSolutionGrid | null = null;
  let acceptedProblem: WaveProblem | null = null;
  let currentTime = 0;
  let playing = false;
  let lastAnimationTimestamp: number | null = null;
  let animationFrame = 0;
  let renderFrame = 0;
  let characteristicComputeFrame = 0;
  let characteristicSurfaceFrame = 0;
  let characteristicSurfaceRenderFrame = 0;
  let characteristicLabelRenderFrame = 0;
  let characteristicFinalizeFrame = 0;
  let characteristicSurfacePrepared = false;
  let characteristicRequest = 0;
  let draftTimer = 0;
  let selectedX: number | null = null;
  let characteristicTrace: CharacteristicTrace | null = null;
  let renderedTrace: CharacteristicTrace | null = null;
  let lastCharacteristicTime = Number.NEGATIVE_INFINITY;
  let characteristicMode: "off" | "selecting" | "active" = "off";
  let acceptedAxisNotation: { x: AxisValueNotation; t: AxisValueNotation } = {
    x: "decimal",
    t: "decimal"
  };
  let problemOpen = true;
  let uiHidden = false;
  let firstSurfacePaint = false;

  const surfaceRenderer = new SpaceTimeRenderer(surfaceHost, {
    fallbackElement: webglNotice,
    onInteractionStart: () => setPlaying(false),
    onTimeChange: (time) => {
      setPlaying(false);
      setTime(time, "The time plane moved.");
    }
  });
  const snapshotRenderer = new SnapshotRenderer(snapshotHost, {
    onPointSelect: (x, trigger) => {
      if (characteristicMode === "off") return;
      activateCharacteristicPoint(x, currentTime);
      const message = trigger === "keyboard"
        ? "Characteristic point selected with the keyboard."
        : "Characteristic point selected on the snapshot.";
      interactionStatus.textContent = message;
      setCharacteristicEntryFeedback("Tracing the point selected on the curve.", "ready");
    }
  });
  root.dataset.webgl = String(surfaceRenderer.webglAvailable);
  webglNotice.hidden = surfaceRenderer.webglAvailable;

  const controller = new WaveAppController();
  const editor = new ProblemEditor({
    onPreset: (id: WavePresetId | "custom") => {
      setPlaying(false);
      if (id !== "custom") cancelDraftCommit();
      controller.selectPreset(id);
    },
    onScalar: (field, value) => {
      setPlaying(false);
      controller.setScalarField(field, value);
      scheduleDraftCommit();
    },
    onPieceInput: (source, id, field, value) => {
      setPlaying(false);
      controller.setPieceField(source, id, field, value);
      scheduleDraftCommit();
    },
    onPieceAdd: (source) => {
      setPlaying(false);
      cancelDraftCommit();
      if (controller.addPiece(source)) {
        window.requestAnimationFrame(() => editor.focusLast(source));
        scheduleDraftCommit();
      }
    },
    onPieceRemove: (source, id) => {
      setPlaying(false);
      cancelDraftCommit();
      controller.removePiece(source, id);
      scheduleDraftCommit();
    },
    onBoundary: (side, field, value) => {
      setPlaying(false);
      controller.setBoundaryField(side, field, value);
      scheduleDraftCommit();
    }
  });

  const unsubscribe = controller.subscribe((viewModel) => {
    editor.render(viewModel);
    renderProblemState(viewModel);
    if (viewModel.result && viewModel.result !== currentResult && viewModel.acceptedProblem) {
      acceptSolution(
        viewModel.acceptedProblem,
        viewModel.result,
        axisNotationFromDraft(viewModel.draft),
        surfaceTopologyForSolution(viewModel.acceptedProblem, viewModel.result)
      );
    }
  });

  function renderProblemState(viewModel: WaveAppViewModel): void {
    problemTitle.textContent = viewModel.problemName;
    sourceStatus.className = `status-chip is-${viewModel.status}`;
    sourceStatus.textContent = viewModel.statusMessage;
    sourceStatus.setAttribute("aria-label", `Problem status: ${viewModel.statusMessage}`);
    renderNotices(warningsList, viewModel.errors, viewModel.warnings);
    loading.hidden = currentResult !== null || viewModel.status !== "solving";
    surfaceHost.setAttribute(
      "aria-busy",
      String(currentResult === null && viewModel.status === "solving")
    );
  }

  function acceptSolution(
    problem: WaveProblem,
    result: WaveSolutionGrid,
    axisNotation: { x: AxisValueNotation; t: AxisValueNotation },
    surfaceTopology: SurfaceTopology
  ): void {
    const hadRenderedTrace = renderedTrace !== null;
    cancelCharacteristicRefresh();
    acceptedProblem = problem;
    currentResult = result;
    selectedX = null;
    characteristicTrace = null;
    renderedTrace = null;
    lastCharacteristicTime = Number.NEGATIVE_INFINITY;
    characteristicMode = "off";
    characteristicsButton.setAttribute("aria-pressed", "false");
    closeCharacteristicEntry();
    if (characteristicsLabel) characteristicsLabel.textContent = "Characteristics";
    root.dataset.characteristics = "off";
    root.dataset.solveMs = result.timings.totalMs.toFixed(3);
    root.dataset.samplingPolicy = "adaptive-wave-v1";
    root.dataset.solverXSamples = String(result.x.length);
    root.dataset.solverTSamples = String(result.t.length);
    root.dataset.geometryReady = "false";
    if (hadRenderedTrace) {
      surfaceRenderer.setCharacteristics(null, { deferRender: true });
      snapshotRenderer.setCharacteristics(null);
    }
    acceptedAxisNotation = axisNotation;
    const deferredPresentation = { defer: true } as const;
    surfaceRenderer.setSurfaceTopology(surfaceTopology, deferredPresentation);
    surfaceRenderer.setAxisNotation(axisNotation, deferredPresentation);
    snapshotRenderer.setAxisNotation(axisNotation.x, deferredPresentation);
    const physicalBoundaries = physicalBoundaryPositions(problem);
    surfaceRenderer.setBoundaryPositions(physicalBoundaries, deferredPresentation);
    snapshotRenderer.setBoundaryPositions(physicalBoundaries, deferredPresentation);
    const validatedSolution = { validated: true } as const;
    surfaceRenderer.setSolution(result, validatedSolution);
    snapshotRenderer.setSolution(result, validatedSolution);
    renderProblemFormula(problem);
    createTimeTicks(timeTicks, problem.T);
    timeSlider.setAttribute("aria-valuemin", "0");
    timeSlider.setAttribute("aria-valuemax", String(problem.T));
    loading.hidden = true;
    surfaceHost.setAttribute("aria-busy", "false");
    resetEvolution();
    // Publish the revision only after both retained renderers own the new
    // solution and playback has synchronously returned to paused t=0.
    root.dataset.acceptedRevision = String(result.revision);
  }

  function resetEvolution(): void {
    cancelCharacteristicRefresh();
    currentTime = 0;
    timeSlider.value = "0";
    lastAnimationTimestamp = null;
    setPlaying(false);
    scheduleRender();
  }

  function setTime(time: number, announcement?: string): void {
    if (!acceptedProblem) return;
    currentTime = clamp(time, 0, acceptedProblem.T);
    timeSlider.value = String(Math.round((currentTime / acceptedProblem.T) * TIME_SLIDER_STEPS));
    lastAnimationTimestamp = null;
    if (currentTime >= acceptedProblem.T) setPlaying(false);
    else updatePlaybackUi();
    scheduleRender();
    if (announcement) {
      interactionStatus.textContent = `${announcement} Time ${formatCurrentTime(currentTime)}.`;
    }
  }

  function renderCurrentTime(): void {
    if (!currentResult || !acceptedProblem) return;
    surfaceRenderer.setTime(currentTime);
    snapshotRenderer.setTime(currentTime);
    snapshotRenderer.setSelectedX(selectedX);

    const traceStep = acceptedProblem.T / 120;
    const shouldRefreshTrace =
      !playing ||
      characteristicTrace === null ||
      Math.abs(currentTime - lastCharacteristicTime) >= traceStep;
    if (
      characteristicMode === "active" &&
      selectedX !== null &&
      shouldRefreshTrace
    ) {
      scheduleCharacteristicRefresh();
    }

    const formattedTime = formatCurrentTime(currentTime);
    renderTimeOutput(timeOutput, currentTime, "Time");
    timeSlider.setAttribute("aria-valuenow", String(currentTime));
    timeSlider.setAttribute("aria-valuetext", `time ${formattedTime}`);
    root.dataset.currentTime = String(currentTime);
    root.dataset.geometryReady = "true";
    root.dataset.frameSample = String(Number(root.dataset.frameSample ?? "0") + 1);

    updateDescriptions();
    if (!firstSurfacePaint) {
      firstSurfacePaint = true;
      performance.mark("wave:first-surface-painted");
      performance.measure(
        "wave:first-surface-paint",
        APP_START_MARK,
        "wave:first-surface-painted"
      );
    }
  }

  function updateDescriptions(): void {
    if (!currentResult || !acceptedProblem) return;
    const domain = describeDomain(acceptedProblem);
    surfaceDescription.textContent =
      `A three-dimensional turquoise solution surface for the wave equation on ${domain}. ` +
      `The gold cross-section plane is at time ${formatNumber(currentTime)}.` +
      (characteristicTrace
        ? ` Two complete backward characteristic paths with ${characteristicTrace.hits.length} boundary events are visible.`
        : "");
    const pointValue = selectedX === null
      ? null
      : sampleSolution(currentResult, selectedX, currentTime);
    snapshotDescription.textContent =
      `Snapshot of u as a function of x at time ${formatNumber(currentTime)}.` +
      (pointValue === null
        ? ""
        : ` The selected point is x ${formatNumber(selectedX as number)}, u ${formatNumber(pointValue)}.`);
  }

  function setPlaying(next: boolean): void {
    playing = Boolean(next && currentResult && acceptedProblem);
    lastAnimationTimestamp = null;
    updatePlaybackUi();
    if (playing) scheduleAnimation();
    else cancelAnimation();
  }

  function scheduleRender(): void {
    if (renderFrame !== 0) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      renderCurrentTime();
    });
  }

  /**
   * Keep first-use characteristic work below one long main-thread task by
   * separating mathematics, Three.js preparation, WebGL submission, CSS2D
   * label layout, and retained SVG/final state updates across five frames.
   */
  function scheduleCharacteristicRefresh(): void {
    if (
      characteristicComputeFrame !== 0 ||
      characteristicSurfaceFrame !== 0 ||
      characteristicSurfaceRenderFrame !== 0 ||
      characteristicLabelRenderFrame !== 0 ||
      characteristicFinalizeFrame !== 0 ||
      characteristicMode !== "active" ||
      selectedX === null ||
      !acceptedProblem ||
      !currentResult
    ) return;

    const request = ++characteristicRequest;
    root.dataset.traceRequest = String(request);
    root.dataset.traceStage = "scheduled";
    const problem = acceptedProblem;
    const result = currentResult;
    const x = selectedX;
    const time = currentTime;
    characteristicComputeFrame = window.requestAnimationFrame(() => {
      characteristicComputeFrame = 0;
      let nextTrace: CharacteristicTrace;
      try {
        const started = performance.now();
        nextTrace = traceCharacteristics(problem, result, x, time);
        root.dataset.traceComputeMs = (performance.now() - started).toFixed(3);
        root.dataset.traceStage = "computed";
      } catch (error) {
        root.dataset.traceStage = "error";
        interactionStatus.textContent = error instanceof Error
          ? error.message
          : "The characteristic paths could not be traced.";
        return;
      }
      if (request !== characteristicRequest || characteristicMode !== "active") return;

      characteristicSurfaceFrame = window.requestAnimationFrame(() => {
        characteristicSurfaceFrame = 0;
        if (request !== characteristicRequest || characteristicMode !== "active") return;
        const started = performance.now();
        surfaceRenderer.setCharacteristics(nextTrace, { deferRender: true });
        characteristicSurfacePrepared = true;
        const prepareMs = (performance.now() - started).toFixed(3);
        root.dataset.traceSurfacePrepareMs = prepareMs;
        // Retain the former aggregate hook for existing diagnostics.
        root.dataset.traceSurfaceMs = prepareMs;
        root.dataset.traceStage = "three-prepared";

        characteristicSurfaceRenderFrame = window.requestAnimationFrame(() => {
          characteristicSurfaceRenderFrame = 0;
          if (request !== characteristicRequest || characteristicMode !== "active") return;
          const started = performance.now();
          surfaceRenderer.renderPreparedWebGLFrame();
          const webglMs = (performance.now() - started).toFixed(3);
          root.dataset.traceSurfaceWebglMs = webglMs;
          // Retain the former aggregate render hook for existing diagnostics.
          root.dataset.traceSurfaceRenderMs = webglMs;
          root.dataset.traceStage = "webgl-rendered";

          characteristicLabelRenderFrame = window.requestAnimationFrame(() => {
            characteristicLabelRenderFrame = 0;
            if (request !== characteristicRequest || characteristicMode !== "active") return;
            const started = performance.now();
            surfaceRenderer.renderPreparedLabelFrame();
            root.dataset.traceSurfaceLabelsMs = (performance.now() - started).toFixed(3);
            root.dataset.traceStage = "labels-rendered";

            characteristicFinalizeFrame = window.requestAnimationFrame(() => {
              characteristicFinalizeFrame = 0;
              if (request !== characteristicRequest || characteristicMode !== "active") return;
              const started = performance.now();
              snapshotRenderer.setCharacteristics(nextTrace);
              root.dataset.traceSnapshotMs = (performance.now() - started).toFixed(3);
              characteristicSurfacePrepared = false;
              characteristicTrace = nextTrace;
              renderedTrace = nextTrace;
              lastCharacteristicTime = time;
              root.dataset.characteristics = "active";
              root.dataset.traceStage = "complete";
              if (!characteristicsEntry.hidden) {
                setCharacteristicEntryFeedback("Characteristics are shown for the selected point.", "ready");
              }
              updateDescriptions();
              if (Math.abs(currentTime - time) >= problem.T / 120) {
                scheduleCharacteristicRefresh();
              }
            });
          });
        });
      });
    });
  }

  function cancelCharacteristicRefresh(): void {
    const hadPendingFrame =
      characteristicComputeFrame !== 0 ||
      characteristicSurfaceFrame !== 0 ||
      characteristicSurfaceRenderFrame !== 0 ||
      characteristicLabelRenderFrame !== 0 ||
      characteristicFinalizeFrame !== 0;
    characteristicRequest += 1;
    if (characteristicComputeFrame !== 0) {
      window.cancelAnimationFrame(characteristicComputeFrame);
      characteristicComputeFrame = 0;
    }
    if (characteristicSurfaceFrame !== 0) {
      window.cancelAnimationFrame(characteristicSurfaceFrame);
      characteristicSurfaceFrame = 0;
    }
    if (characteristicSurfaceRenderFrame !== 0) {
      window.cancelAnimationFrame(characteristicSurfaceRenderFrame);
      characteristicSurfaceRenderFrame = 0;
    }
    if (characteristicLabelRenderFrame !== 0) {
      window.cancelAnimationFrame(characteristicLabelRenderFrame);
      characteristicLabelRenderFrame = 0;
    }
    if (characteristicFinalizeFrame !== 0) {
      window.cancelAnimationFrame(characteristicFinalizeFrame);
      characteristicFinalizeFrame = 0;
    }
    if (characteristicSurfacePrepared) {
      const started = performance.now();
      characteristicSurfacePrepared = false;
      surfaceRenderer.setCharacteristics(renderedTrace);
      root.dataset.traceRollbackMs = (performance.now() - started).toFixed(3);
      root.dataset.traceStage = "rolled-back";
    } else if (hadPendingFrame) {
      root.dataset.traceStage = "cancelled";
    }
  }

  function openCharacteristicEntry(): void {
    if (!acceptedProblem || !currentResult) {
      interactionStatus.textContent = "Wait for the accepted solution before selecting characteristics.";
      return;
    }
    characteristicsEntry.hidden = false;
    characteristicsEntry.inert = false;
    characteristicsButton.setAttribute("aria-expanded", "true");
    root.dataset.characteristicEntry = "open";
    const xMinimum = currentResult.x[0] as number;
    const xMaximum = currentResult.x[currentResult.x.length - 1] as number;
    characteristicXInput.value = formatPointInputValue(
      clamp(selectedX ?? 0, xMinimum, xMaximum),
      acceptedAxisNotation.x
    );
    characteristicTInput.value = formatPointInputValue(
      currentTime,
      acceptedAxisNotation.t
    );
    validateCharacteristicEntry();
    characteristicXInput.focus();
    characteristicXInput.select();
  }

  function closeCharacteristicEntry(): void {
    characteristicsEntry.hidden = true;
    characteristicsEntry.inert = true;
    characteristicsButton.setAttribute("aria-expanded", "false");
    characteristicXInput.setAttribute("aria-invalid", "false");
    characteristicTInput.setAttribute("aria-invalid", "false");
    root.dataset.characteristicEntry = "closed";
  }

  function validateCharacteristicEntry(): CharacteristicPointInputResult | null {
    if (!acceptedProblem || !currentResult) {
      characteristicXInput.setAttribute("aria-invalid", "false");
      characteristicTInput.setAttribute("aria-invalid", "false");
      setCharacteristicEntryFeedback("The accepted solution is not ready yet.", "error");
      return null;
    }
    const validation = parseCharacteristicPointInput(
      characteristicXInput.value,
      characteristicTInput.value,
      {
        xMin: currentResult.x[0] as number,
        xMax: currentResult.x[currentResult.x.length - 1] as number,
        T: acceptedProblem.T
      }
    );
    characteristicXInput.setAttribute(
      "aria-invalid",
      String(!validation.ok && validation.field === "x")
    );
    characteristicTInput.setAttribute(
      "aria-invalid",
      String(!validation.ok && validation.field === "t")
    );
    setCharacteristicEntryFeedback(
      validation.ok ? "Ready to trace." : validation.message,
      validation.ok ? "ready" : "error"
    );
    return validation;
  }

  function setCharacteristicEntryFeedback(
    message: string,
    tone: "ready" | "error" | "info"
  ): void {
    characteristicEntryFeedback.textContent = message;
    characteristicEntryFeedback.dataset.tone = tone;
  }

  function activateCharacteristicPoint(
    x: number,
    time: number,
    syncEntry = true
  ): void {
    setPlaying(false);
    cancelCharacteristicRefresh();
    selectedX = x;
    lastCharacteristicTime = Number.NEGATIVE_INFINITY;
    characteristicMode = "active";
    characteristicsButton.setAttribute("aria-pressed", "true");
    if (characteristicsLabel) characteristicsLabel.textContent = "Clear characteristics";
    setTime(time);
    if (syncEntry) {
      characteristicXInput.value = formatPointInputValue(x, acceptedAxisNotation.x);
      characteristicTInput.value = formatPointInputValue(time, acceptedAxisNotation.t);
    }
    scheduleRender();
  }

  function updatePlaybackUi(): void {
    const ended = Boolean(acceptedProblem && currentTime >= acceptedProblem.T && !playing);
    const label = ended ? "Replay" : playing ? "Pause" : "Play";
    playbackButton.setAttribute("aria-pressed", String(playing));
    playbackButton.setAttribute(
      "aria-label",
      ended ? "Replay evolution" : playing ? "Pause evolution" : "Play evolution"
    );
    if (playbackLabel) playbackLabel.textContent = label;
    root.dataset.playback = ended ? "ended" : playing ? "playing" : "paused";
  }

  function scheduleAnimation(): void {
    if (animationFrame !== 0 || !playing || document.hidden) return;
    animationFrame = window.requestAnimationFrame(animate);
  }

  function cancelAnimation(): void {
    if (animationFrame !== 0) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
  }

  function animate(timestamp: number): void {
    animationFrame = 0;
    if (!playing || !acceptedProblem || document.hidden) return;
    if (lastAnimationTimestamp === null) {
      lastAnimationTimestamp = timestamp;
    } else {
      const delta = clamp(timestamp - lastAnimationTimestamp, 0, 100);
      lastAnimationTimestamp = timestamp;
      currentTime = Math.min(
        acceptedProblem.T,
        currentTime + (delta / PLAYBACK_DURATION_MS) * acceptedProblem.T
      );
      timeSlider.value = String(
        Math.round((currentTime / acceptedProblem.T) * TIME_SLIDER_STEPS)
      );
    }
    renderCurrentTime();
    if (currentTime >= acceptedProblem.T) {
      playing = false;
      lastAnimationTimestamp = null;
      updatePlaybackUi();
      interactionStatus.textContent = "The evolution reached its final time.";
      return;
    }
    scheduleAnimation();
  }

  function scheduleDraftCommit(): void {
    cancelDraftCommit();
    draftTimer = window.setTimeout(() => {
      draftTimer = 0;
      controller.commitDraft();
    }, DRAFT_DEBOUNCE_MS);
  }

  function cancelDraftCommit(): void {
    if (draftTimer !== 0) {
      window.clearTimeout(draftTimer);
      draftTimer = 0;
    }
  }

  function setProblemOpen(next: boolean): void {
    problemOpen = next;
    problemMenu.hidden = !next;
    problemMenu.inert = !next;
    problemToggle.setAttribute("aria-expanded", String(next));
    problemToggle.setAttribute("aria-label", next ? "Collapse wave problem editor" : "Expand wave problem editor");
    if (problemToggleLabel) problemToggleLabel.textContent = next ? "Close problem" : "Edit problem";
    root.dataset.problemOpen = String(next);
  }

  function setUiHidden(next: boolean): void {
    uiHidden = next;
    for (const element of uiChrome) element.inert = next;
    shell.classList.toggle("is-ui-hidden", next);
    shell.dataset.uiHidden = String(next);
    document.body.dataset.uiHidden = String(next);
    uiToggle.setAttribute("aria-pressed", String(next));
    uiToggle.setAttribute("aria-label", next ? "Show interface" : "Hide interface");
    if (uiLabel) uiLabel.textContent = next ? "Show UI" : "Hide UI";
    const restoreHadFocus = document.activeElement === restoreUi;
    restoreUi.hidden = !next;
    if (next) restoreUi.focus();
    else if (restoreHadFocus) uiToggle.focus();
  }

  timeSlider.addEventListener("input", () => {
    if (!acceptedProblem) return;
    setPlaying(false);
    setTime((Number(timeSlider.value) / TIME_SLIDER_STEPS) * acceptedProblem.T);
  });
  playbackButton.addEventListener("click", () => {
    if (!acceptedProblem) return;
    if (currentTime >= acceptedProblem.T) {
      currentTime = 0;
      timeSlider.value = "0";
      scheduleRender();
      setPlaying(true);
      return;
    }
    setPlaying(!playing);
  });
  restartButton.addEventListener("click", () => {
    resetEvolution();
    interactionStatus.textContent = "The evolution restarted at time zero and is paused.";
  });
  resetCameraButton.addEventListener("click", () => {
    surfaceRenderer.resetCamera();
    interactionStatus.textContent = "The three-dimensional camera was reset.";
  });
  characteristicsButton.addEventListener("click", () => {
    if (characteristicMode === "off") {
      if (!acceptedProblem || !currentResult) {
        interactionStatus.textContent = "Wait for the accepted solution before selecting characteristics.";
        return;
      }
      setPlaying(false);
      cancelCharacteristicRefresh();
      characteristicMode = "selecting";
      selectedX = null;
      characteristicTrace = null;
      lastCharacteristicTime = Number.NEGATIVE_INFINITY;
      root.dataset.characteristics = "selecting";
      characteristicsButton.setAttribute("aria-pressed", "true");
      if (characteristicsLabel) characteristicsLabel.textContent = "Cancel characteristics";
      openCharacteristicEntry();
      interactionStatus.textContent = "Enter a point, or select one on the snapshot curve with the pointer or arrow keys.";
      return;
    }
    characteristicMode = "off";
    cancelCharacteristicRefresh();
    selectedX = null;
    characteristicTrace = null;
    lastCharacteristicTime = Number.NEGATIVE_INFINITY;
    root.dataset.characteristics = "off";
    characteristicsButton.setAttribute("aria-pressed", "false");
    closeCharacteristicEntry();
    if (characteristicsLabel) characteristicsLabel.textContent = "Characteristics";
    surfaceRenderer.setCharacteristics(null);
    snapshotRenderer.setSelectedX(null);
    snapshotRenderer.setCharacteristics(null);
    renderedTrace = null;
    interactionStatus.textContent = "Characteristics cleared.";
  });
  for (const input of [characteristicXInput, characteristicTInput]) {
    input.addEventListener("input", () => validateCharacteristicEntry());
  }
  characteristicPointForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const validation = validateCharacteristicEntry();
    if (!validation || !validation.ok) {
      if (validation?.field === "x") characteristicXInput.focus();
      else if (validation?.field === "t") characteristicTInput.focus();
      interactionStatus.textContent = validation?.message ?? "The characteristic point is not valid.";
      return;
    }
    activateCharacteristicPoint(validation.x, validation.t, false);
    setCharacteristicEntryFeedback("Tracing the entered point.", "ready");
    interactionStatus.textContent = "Tracing characteristics from the entered point.";
  });
  chooseCharacteristicOnCurve.addEventListener("click", () => {
    snapshotRenderer.svg.focus();
    setCharacteristicEntryFeedback("Use the pointer or the left and right arrow keys on the curve.", "info");
    interactionStatus.textContent = "Choose a point on the snapshot curve with the pointer or arrow keys.";
  });
  characteristicPointForm.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    characteristicsButton.click();
    characteristicsButton.focus();
  });
  problemToggle.addEventListener("click", () => setProblemOpen(!problemOpen));
  problemClose.addEventListener("click", () => {
    setProblemOpen(false);
    problemToggle.focus();
  });
  uiToggle.addEventListener("click", () => setUiHidden(!uiHidden));
  restoreUi.addEventListener("click", () => setUiHidden(false));

  document.addEventListener("visibilitychange", () => {
    lastAnimationTimestamp = null;
    if (document.hidden) cancelAnimation();
    else if (playing) scheduleAnimation();
  });
  window.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target)) return;
    if (event.key === " ") {
      event.preventDefault();
      playbackButton.click();
    } else if (event.key.toLowerCase() === "r") {
      restartButton.click();
    } else if (event.key.toLowerCase() === "h") {
      (uiHidden ? restoreUi : uiToggle).click();
    } else if (event.key === "Escape" && characteristicMode !== "off") {
      characteristicsButton.click();
    }
  });
  window.addEventListener("resize", () => {
    surfaceRenderer.resize();
    snapshotRenderer.resize();
  });
  window.addEventListener("beforeunload", () => {
    cancelAnimation();
    cancelCharacteristicRefresh();
    if (renderFrame !== 0) window.cancelAnimationFrame(renderFrame);
    cancelDraftCommit();
    unsubscribe();
    controller.dispose();
    surfaceRenderer.dispose();
    snapshotRenderer.dispose();
  });

  // Compact screens begin with the large problem form collapsed.
  setProblemOpen(!window.matchMedia("(max-width: 700px)").matches);

  function renderProblemFormula(problem: WaveProblem): void {
    renderLatex(
      problemFormula,
      problemFormulaLatex(problem),
      { displayMode: true }
    );
  }
}

/** TeX source for the symbolic homogeneous wave equation shown in the problem card. */
export function waveEquationLatex(): string {
  return String.raw`u_{tt}-u_{xx}=0`;
}

/** TeX source used by the accepted-problem card. */
export function problemFormulaLatex(problem: WaveProblem): string {
  const domain = domainLatex(problem);
  const lines = [
    String.raw`${waveEquationLatex()},\qquad (x,t)\in ${domain}\times(0,T]`,
    String.raw`u(x,0)=f(x),\qquad u_t(x,0)=g(x)`
  ];
  const boundaryConditions: string[] = [];
  if (problem.boundaries.left) {
    boundaryConditions.push(boundaryLatex("left", problem.boundaries.left.kind));
  }
  if (problem.boundaries.right) {
    boundaryConditions.push(boundaryLatex("right", problem.boundaries.right.kind));
  }
  if (boundaryConditions.length > 0) {
    lines.push(boundaryConditions.join(String.raw`,\qquad `));
  }
  return String.raw`\begin{cases}${lines.join(String.raw`\\`)}\end{cases}`;
}

function renderNotices(
  container: HTMLElement,
  errors: readonly ProblemNotice[],
  warnings: readonly ProblemNotice[]
): void {
  container.replaceChildren();
  for (const notice of [...errors, ...warnings]) {
    const item = document.createElement("li");
    item.className = errors.includes(notice) ? "is-error" : "is-warning";
    item.textContent = notice.message;
    container.append(item);
  }
  container.hidden = container.childElementCount === 0;
}

export function createTimeTicks(container: HTMLElement, maximum: number): void {
  container.replaceChildren();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const tick = document.createElement("span");
    tick.className = "time-tick";
    tick.style.left = `${fraction * 100}%`;
    renderLatex(tick, axisValueToLatex(maximum * fraction));
    container.append(tick);
  }
}

/** Render static variables and formula hints marked up with `data-latex`. */
export function renderStaticLatex(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-latex]")) {
    const source = element.dataset.latex;
    if (source !== undefined) renderLatex(element, source);
  }
}

/** Retained KaTeX update for the native time outputs. */
export function renderTimeOutput(
  output: HTMLOutputElement,
  time: number,
  accessiblePrefix: string
): void {
  const formatted = formatCurrentTime(time);
  output.setAttribute("aria-label", `${accessiblePrefix} ${formatted}`);
  renderLatex(output, String.raw`t=${formatted}`);
}

function domainLatex(problem: WaveProblem): string {
  const domain = problem.domain;
  if (domain.kind === "infinite") return String.raw`\mathbb{R}`;
  if (domain.kind === "right-half-line") {
    return String.raw`[a,\infty)`;
  }
  if (domain.kind === "left-half-line") {
    return String.raw`(-\infty,b]`;
  }
  return String.raw`[a,b]`;
}

function physicalBoundaryPositions(problem: WaveProblem): number[] {
  const domain = problem.domain;
  if (domain.kind === "infinite") return [];
  if (domain.kind === "right-half-line") return [domain.left];
  if (domain.kind === "left-half-line") return [domain.right];
  return [domain.left, domain.right];
}

function axisNotationFromDraft(
  draft: WaveAppViewModel["draft"]
): { x: AxisValueNotation; t: AxisValueNotation } {
  const spatialSources = [draft.xMin, draft.xMax];
  if (draft.domainKind === "right-half-line" || draft.domainKind === "finite") {
    spatialSources.push(draft.domainLeft);
  }
  if (draft.domainKind === "finite") {
    spatialSources.push(draft.domainRight);
  }
  return {
    x: spatialSources.some(containsPiSource) ? "pi" : "decimal",
    t: containsPiSource(draft.T) ? "pi" : "decimal"
  };
}

function containsPiSource(source: string): boolean {
  return /(?:\bpi\b|π)/i.test(source);
}

function surfaceTopologyForSolution(
  problem: WaveProblem,
  solution: WaveSolutionGrid
): SurfaceTopology {
  if (waveProblemMayHaveDiscontinuousDisplacement(problem)) return "stepped";
  const threshold =
    (solution.surfaceRange.max - solution.surfaceRange.min) * 0.2;
  for (let xIndex = 0; xIndex < solution.x.length - 1; xIndex += 1) {
    if (
      Math.abs(
        Number(solution.values[xIndex + 1]) -
        Number(solution.values[xIndex])
      ) >= threshold
    ) {
      return "stepped";
    }
  }
  return "smooth";
}

function boundaryLatex(
  side: "left" | "right",
  kind: "dirichlet" | "neumann"
): string {
  const endpoint = side === "left" ? "a" : "b";
  const suffix = side === "left" ? "L" : "R";
  return kind === "dirichlet"
    ? String.raw`u(${endpoint},t)=h_${suffix}(t)`
    : String.raw`u_x(${endpoint},t)=q_${suffix}(t)`;
}

function describeDomain(problem: WaveProblem): string {
  const domain = problem.domain;
  if (domain.kind === "infinite") {
    return `the infinite line, viewed from ${formatNumber(problem.view.xMin)} to ${formatNumber(problem.view.xMax)}`;
  }
  if (domain.kind === "right-half-line") return `the half-line x at least ${formatNumber(domain.left)}`;
  if (domain.kind === "left-half-line") return `the half-line x at most ${formatNumber(domain.right)}`;
  return `the interval ${formatNumber(domain.left)} to ${formatNumber(domain.right)}`;
}

function parseFiniteConstantPointCoordinate(
  source: string,
  field: "x" | "t"
):
  | { ok: true; value: number }
  | { ok: false; field: "x" | "t"; message: string } {
  if (source.trim().length === 0) {
    return {
      ok: false,
      field,
      message: `Enter a value for ${field}.`
    };
  }
  try {
    return { ok: true, value: evaluateFiniteConstantExpression(source) };
  } catch {
    // Keep the compact live message stable while the user is mid-edit.
  }
  return {
    ok: false,
    field,
    message: `Enter ${field} as a finite constant expression, such as pi / 2.`
  };
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 1e-3 || absolute >= 1e4)) return value.toExponential(2);
  return String(Number(value.toFixed(3)));
}

function formatPointInputValue(
  value: number,
  notation: AxisValueNotation
): string {
  return axisValueToInputSource(value, notation);
}

function isWithinInclusiveTolerance(
  value: number,
  minimum: number,
  maximum: number
): boolean {
  const tolerance = 64 * Number.EPSILON * Math.max(
    1,
    Math.abs(value),
    Math.abs(minimum),
    Math.abs(maximum)
  );
  return value >= minimum - tolerance && value <= maximum + tolerance;
}

export function formatCurrentTime(value: number): string {
  return value.toFixed(3);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}.`);
  return element as T;
}
