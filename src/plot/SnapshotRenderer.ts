import type { CharacteristicTrace, WaveSolutionGrid } from "../types";
import {
  clampGridTime,
  nearestGridIndex,
  normalizedSurfaceRange,
  sampleSlice,
  sampleSolutionGrid,
  validateSolutionGrid
} from "./sampling";
import {
  clamp,
  compactNumber,
  createSvgElement,
  formatAxisValue,
  setSvgAttributes
} from "./svg";
import { axisValueToLatex, axisValueToText, renderLatex } from "./latex";
import { axisTicks, type AxisValueNotation } from "./ticks";
import type { ProfileSampler, SampledProfile } from "./profile";

export { niceAxisTicks } from "./ticks";

export type SnapshotSelectionTrigger = "pointer" | "keyboard";
export interface SnapshotPresentationUpdateOptions {
  /** Assign state now; an imminent setSolution call performs the one paint. */
  defer?: boolean;
}
export interface SnapshotSolutionUpdateOptions {
  /** The revision-safe worker client already validated the complete grid. */
  validated?: boolean;
  time?: number;
}

export interface SnapshotRendererOptions {
  ariaLabel?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  minimumWidth?: number;
  minimumHeight?: number;
  onPointSelect?: (x: number, trigger: SnapshotSelectionTrigger) => void;
}

export interface SnapshotRendererFrame {
  solution: WaveSolutionGrid;
  time: number;
  selectedX?: number | null;
  characteristics?: CharacteristicTrace | null;
}

interface SnapshotGeometry {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const AXIS_LABEL_WIDTH = 114;
const U_AXIS_NAME_GAP = 18;
const U_AXIS_NAME_MIN_RIGHT_GAP = 6;
const ETA_CHARACTERISTIC_COLOR = "#e76f67";
const XI_CHARACTERISTIC_COLOR = "#a970ff";
const SNAPSHOT_X_TARGET_INTERVALS = 12;
const X_AXIS_END_EXTENSION = 16;
const U_AXIS_END_EXTENSION = 16;
const X_AXIS_NAME_TIP_GAP = 3;

let nextSnapshotRendererId = 0;

/** Retained SVG renderer for the spatial profile at one selected time. */
export class SnapshotRenderer {
  readonly svg: SVGSVGElement;

  private readonly container: HTMLElement;
  private readonly options: Required<Omit<SnapshotRendererOptions, "onPointSelect">> &
    Pick<SnapshotRendererOptions, "onPointSelect">;
  private readonly descriptionElement: SVGDescElement;
  private readonly background: SVGRectElement;
  private readonly gridLayer: SVGGElement;
  private readonly axisLayer: SVGGElement;
  private readonly footpointLayer: SVGGElement;
  private readonly boundaryLayer: SVGGElement;
  private readonly curve: SVGPathElement;
  private readonly initialCurve: SVGPathElement;
  private readonly initialLegend: SVGGElement;
  private readonly selectionGuide: SVGLineElement;
  private readonly selectedPoint: SVGCircleElement;
  private readonly selectedPointHalo: SVGCircleElement;
  private readonly emptyLabel: SVGTextElement;
  private readonly hitArea: SVGRectElement;
  private readonly resizeObserver: ResizeObserver | null;

  private geometry: SnapshotGeometry;
  private solution: WaveSolutionGrid | null = null;
  private profileSampler: ProfileSampler | null = null;
  private initialProfileVisible = false;
  private selectionEnabled = true;
  private time = 0;
  private selectedX: number | null = null;
  private characteristics: CharacteristicTrace | null = null;
  private xAxisNotation: AxisValueNotation = "decimal";
  private boundaryPositions: number[] = [];
  private boundaryMarkers: SVGCircleElement[] = [];
  private destroyed = false;

  constructor(container: HTMLElement, options: SnapshotRendererOptions = {}) {
    this.container = container;
    this.options = {
      ariaLabel: options.ariaLabel ?? "Wave profile snapshot",
      defaultWidth: options.defaultWidth ?? 1040,
      defaultHeight: options.defaultHeight ?? 300,
      minimumWidth: options.minimumWidth ?? 280,
      minimumHeight: options.minimumHeight ?? 210,
      onPointSelect: options.onPointSelect
    };
    this.geometry = this.measure();

    const id = ++nextSnapshotRendererId;
    const descriptionId = `wave-snapshot-description-${id}`;
    const clipId = `wave-snapshot-clip-${id}`;
    const xAxisArrowId = `wave-snapshot-x-axis-arrow-${id}`;
    const uAxisArrowId = `wave-snapshot-u-axis-arrow-${id}`;

    this.svg = createSvgElement("svg", "snapshot-svg");
    setSvgAttributes(this.svg, {
      role: "application",
      tabindex: 0,
      "aria-label": this.options.ariaLabel,
      "aria-describedby": descriptionId,
      preserveAspectRatio: "none",
      focusable: "true",
      "data-geometry-ready": "false",
      "data-current-time": 0,
      "data-sample-count": 0
    });
    Object.assign(this.svg.style, {
      display: "block",
      width: "100%",
      height: "100%"
    });

    this.descriptionElement = createSvgElement("desc");
    this.descriptionElement.id = descriptionId;
    this.descriptionElement.textContent =
      "A spatial snapshot of u as a function of x. Click the curve or focus this plot and use the arrow keys to select a point.";
    this.svg.append(this.descriptionElement);

    const definitions = createSvgElement("defs");
    const clipPath = createSvgElement("clipPath");
    clipPath.id = clipId;
    const clipRect = createSvgElement("rect");
    clipRect.setAttribute("data-snapshot-clip", "");
    clipPath.append(clipRect);
    const xAxisArrow = this.axisArrowMarker(xAxisArrowId, "x");
    const uAxisArrow = this.axisArrowMarker(uAxisArrowId, "u");
    definitions.append(clipPath, xAxisArrow, uAxisArrow);
    this.svg.append(definitions);

    this.background = createSvgElement("rect", "snapshot-background");
    setSvgAttributes(this.background, {
      fill: "transparent",
      "aria-hidden": "true"
    });
    this.svg.append(this.background);

    this.gridLayer = createSvgElement("g", "snapshot-grid");
    this.gridLayer.setAttribute("aria-hidden", "true");
    this.axisLayer = createSvgElement("g", "snapshot-axes");
    this.axisLayer.setAttribute("aria-hidden", "true");
    this.svg.append(this.gridLayer, this.axisLayer);

    const clippedLayer = createSvgElement("g", "snapshot-clipped-layer");
    clippedLayer.setAttribute("clip-path", `url(#${clipId})`);
    this.footpointLayer = createSvgElement("g", "snapshot-characteristic-projection");
    this.footpointLayer.setAttribute("aria-hidden", "true");
    this.curve = createSvgElement("path", "snapshot-curve");
    this.initialCurve = createSvgElement("path", "snapshot-initial-curve");
    setSvgAttributes(this.initialCurve, {
      fill: "none",
      stroke: "#d6dde7",
      "stroke-width": 2,
      "stroke-dasharray": "6 5",
      "vector-effect": "non-scaling-stroke",
      "pointer-events": "none",
      "aria-label": "Initial displacement f(x)",
      visibility: "hidden"
    });
    clippedLayer.append(this.initialCurve);
    setSvgAttributes(this.curve, {
      fill: "none",
      stroke: "#4fcbd3",
      "stroke-width": 3.25,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
      "shape-rendering": "geometricPrecision",
      "pointer-events": "none"
    });
    this.selectionGuide = createSvgElement("line", "snapshot-selection-guide");
    setSvgAttributes(this.selectionGuide, {
      stroke: "rgba(255, 204, 92, 0.68)",
      "stroke-width": 1.25,
      "stroke-dasharray": "5 5",
      "vector-effect": "non-scaling-stroke",
      "pointer-events": "none",
      visibility: "hidden"
    });
    this.selectedPointHalo = createSvgElement("circle", "snapshot-point-halo");
    setSvgAttributes(this.selectedPointHalo, {
      r: 8,
      fill: "rgba(255, 204, 92, 0.18)",
      stroke: "rgba(255, 224, 147, 0.4)",
      "stroke-width": 1,
      "vector-effect": "non-scaling-stroke",
      "pointer-events": "none",
      visibility: "hidden"
    });
    this.selectedPoint = createSvgElement("circle", "snapshot-point");
    setSvgAttributes(this.selectedPoint, {
      r: 4.2,
      fill: "#ffcf64",
      stroke: "#fff5d1",
      "stroke-width": 1.25,
      "vector-effect": "non-scaling-stroke",
      "pointer-events": "none",
      visibility: "hidden"
    });
    clippedLayer.append(
      this.footpointLayer,
      this.curve,
      this.selectionGuide,
      this.selectedPointHalo,
      this.selectedPoint
    );
    this.svg.append(clippedLayer);

    this.boundaryLayer = createSvgElement("g", "snapshot-boundaries");
    this.boundaryLayer.setAttribute("aria-hidden", "true");
    this.svg.append(this.boundaryLayer);

    this.emptyLabel = createSvgElement("text", "snapshot-empty-label");
    this.emptyLabel.textContent = "The accepted solution snapshot will appear here";
    setSvgAttributes(this.emptyLabel, {
      fill: "rgba(232, 247, 247, 0.58)",
      "text-anchor": "middle",
      "font-family": "Inter, ui-sans-serif, system-ui, sans-serif",
      "font-size": 14
    });
    this.svg.append(this.emptyLabel);

    this.hitArea = createSvgElement("rect", "snapshot-selection-hit-area");
    setSvgAttributes(this.hitArea, {
      fill: "transparent",
      "pointer-events": "all",
      cursor: "crosshair",
      "aria-hidden": "true"
    });
    this.svg.append(this.hitArea);
    this.initialLegend = createSvgElement("g", "snapshot-initial-legend");
    setSvgAttributes(this.initialLegend, {
      visibility: "hidden",
      "pointer-events": "none",
      role: "img",
      "aria-label": "Dashed light curve: initial displacement f(x)"
    });
    const legendLine = createSvgElement("line");
    setSvgAttributes(legendLine, {
      x1: 0, x2: 32, y1: 0, y2: 0,
      stroke: "#d6dde7",
      "stroke-width": 2,
      "stroke-dasharray": "6 5"
    });
    const legendMath = createSvgElement("foreignObject");
    setSvgAttributes(legendMath, { x: 40, y: -18, width: 72, height: 36 });
    const legendContent = document.createElement("span");
    legendContent.className = "snapshot-latex-label snapshot-latex-label--tick";
    legendContent.dataset.anchor = "start";
    renderLatex(legendContent, "f(x)", { ariaHidden: true });
    legendMath.append(legendContent);
    this.initialLegend.append(legendLine, legendMath);
    this.svg.append(this.initialLegend);

    this.svg.dataset.xAxisArrow = xAxisArrowId;
    this.svg.dataset.uAxisArrow = uAxisArrowId;
    this.svg.dataset.boundaryCount = "0";
    this.svg.dataset.visibleBoundaryCount = "0";
    this.svg.dataset.boundaryPositions = "";
    this.svg.dataset.xAxisNotation = this.xAxisNotation;

    this.hitArea.addEventListener("pointerdown", this.handlePointerDown);
    this.svg.addEventListener("keydown", this.handleKeyDown);
    container.append(this.svg);
    this.layout();
    this.renderAxes(-1, 1, -1, 1);

    if (typeof ResizeObserver === "undefined") {
      this.resizeObserver = null;
    } else {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          this.resize(entry.contentRect.width, entry.contentRect.height);
        }
      });
      this.resizeObserver.observe(container);
    }
  }

  update(frame: SnapshotRendererFrame): void {
    if (frame.solution !== this.solution) {
      this.setSolution(frame.solution);
    }
    this.setTime(frame.time);
    this.setSelectedX(frame.selectedX ?? null);
    this.setCharacteristics(frame.characteristics ?? null);
  }

  setSolution(
    solution: WaveSolutionGrid,
    options: SnapshotSolutionUpdateOptions = {}
  ): void {
    if (this.destroyed) {
      return;
    }
    if (!options.validated) validateSolutionGrid(solution);
    this.solution = solution;
    this.time = clampGridTime(solution, options.time ?? this.time);
    if (this.selectedX !== null) {
      this.selectedX = clamp(
        this.selectedX,
        Number(solution.x[0]),
        Number(solution.x[solution.x.length - 1])
      );
    }
    this.paint(true);
  }

  setProfileSampler(
    sampler: ProfileSampler | null,
    options: SnapshotPresentationUpdateOptions = {}
  ): void {
    if (this.destroyed) return;
    this.profileSampler = sampler;
    if (!options.defer && this.solution) this.paint(true);
  }

  setInitialProfileVisible(visible: boolean): void {
    if (this.destroyed) return;
    this.initialProfileVisible = visible;
    this.paintInitialProfile();
    this.updateDescription();
  }

  setSelectionEnabled(enabled: boolean): void {
    if (this.destroyed) return;
    this.selectionEnabled = enabled;
    this.svg.dataset.selectionEnabled = String(enabled);
    this.hitArea.setAttribute("cursor", enabled ? "crosshair" : "default");
    if (!enabled) this.setSelectedX(null);
    this.updateDescription();
  }

  setTime(time: number): void {
    if (this.destroyed) {
      return;
    }
    const nextTime = this.solution
      ? clampGridTime(this.solution, time)
      : Math.max(0, Number.isFinite(time) ? time : 0);
    if (nextTime === this.time) {
      return;
    }
    this.time = nextTime;
    this.paint(false);
  }

  setSelectedX(x: number | null): void {
    if (this.destroyed) {
      return;
    }
    let nextSelectedX: number | null;
    if (x === null || !Number.isFinite(x)) {
      nextSelectedX = null;
    } else if (this.solution) {
      nextSelectedX = clamp(
        x,
        Number(this.solution.x[0]),
        Number(this.solution.x[this.solution.x.length - 1])
      );
    } else {
      nextSelectedX = x;
    }
    if (nextSelectedX === this.selectedX) {
      return;
    }
    this.selectedX = nextSelectedX;
    this.paintSelection();
    this.updateDescription();
  }

  setCharacteristics(characteristics: CharacteristicTrace | null): void {
    if (this.destroyed) {
      return;
    }
    this.characteristics = characteristics;
    this.paintFootpoints();
    this.updateDescription();
  }

  /** Change coordinate labels and their aligned grid without touching samples. */
  setAxisNotation(
    notation: AxisValueNotation,
    options: SnapshotPresentationUpdateOptions = {}
  ): void {
    if (this.destroyed || notation === this.xAxisNotation) {
      return;
    }
    this.xAxisNotation = notation;
    this.svg.dataset.xAxisNotation = notation;
    if (options.defer) return;
    if (this.solution) {
      const range = normalizedSurfaceRange(this.solution);
      this.renderAxes(
        Number(this.solution.x[0]),
        Number(this.solution.x[this.solution.x.length - 1]),
        range.min,
        range.max
      );
    } else {
      this.renderAxes(-1, 1, -1, 1);
    }
    this.updateDescription();
  }

  /**
   * Set the physical finite endpoints that should be identified on the profile.
   * Infinite domains pass an empty list; endpoints outside the accepted view are
   * retained but hidden until they fall inside a later solution view.
   */
  setBoundaryPositions(
    positions: readonly number[],
    options: SnapshotPresentationUpdateOptions = {}
  ): void {
    if (this.destroyed) {
      return;
    }
    this.boundaryPositions = Array.from(positions)
      .map(Number)
      .filter(Number.isFinite)
      .map((position) => (Object.is(position, -0) ? 0 : position))
      .sort((left, right) => left - right)
      .filter((position, index, all) => index === 0 || position !== all[index - 1]);
    if (options.defer) return;
    this.retainBoundaryMarkers();
    this.paintBoundaries();
    this.updateDescription();
  }

  clear(): void {
    this.solution = null;
    this.profileSampler = null;
    this.characteristics = null;
    this.selectedX = null;
    this.boundaryPositions = [];
    this.boundaryMarkers = [];
    this.curve.removeAttribute("d");
    this.initialCurve.removeAttribute("d");
    this.initialCurve.setAttribute("visibility", "hidden");
    this.initialLegend.setAttribute("visibility", "hidden");
    this.footpointLayer.replaceChildren();
    this.boundaryLayer.replaceChildren();
    this.emptyLabel.style.display = "";
    this.hideSelection();
    setSvgAttributes(this.svg, {
      "data-geometry-ready": "false",
      "data-current-time": 0,
      "data-sample-count": 0,
      "data-selected-x": null,
      "data-boundary-count": 0,
      "data-visible-boundary-count": 0,
      "data-boundary-positions": ""
    });
    this.renderAxes(-1, 1, -1, 1);
    this.updateDescription();
  }

  resize(width?: number, height?: number): void {
    if (this.destroyed) {
      return;
    }
    this.geometry = this.measure(width, height);
    this.layout();
    if (this.solution) {
      this.paint(true);
    } else {
      this.renderAxes(-1, 1, -1, 1);
    }
  }

  dispose(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.profileSampler = null;
    this.resizeObserver?.disconnect();
    this.hitArea.removeEventListener("pointerdown", this.handlePointerDown);
    this.svg.removeEventListener("keydown", this.handleKeyDown);
    this.svg.remove();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.solution || this.destroyed || !this.selectionEnabled) {
      return;
    }
    event.preventDefault();
    this.svg.focus();
    const bounds = this.svg.getBoundingClientRect();
    const renderedWidth = bounds.width || this.geometry.width;
    const localX = ((event.clientX - bounds.left) / renderedWidth) * this.geometry.width;
    const ratio = clamp(
      (localX - this.geometry.left) / (this.geometry.right - this.geometry.left),
      0,
      1
    );
    const xMin = Number(this.solution.x[0]);
    const xMax = Number(this.solution.x[this.solution.x.length - 1]);
    this.selectPoint(xMin + ratio * (xMax - xMin), "pointer");
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.solution || this.destroyed || !this.selectionEnabled) {
      return;
    }
    const last = this.solution.x.length - 1;
    let index =
      this.selectedX === null
        ? Math.floor(last / 2)
        : nearestGridIndex(this.solution.x, this.selectedX);
    const step = event.shiftKey ? Math.max(1, Math.round(last / 20)) : 1;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        index = Math.max(0, index - step);
        break;
      case "ArrowRight":
      case "ArrowUp":
        index = Math.min(last, index + step);
        break;
      case "Home":
        index = 0;
        break;
      case "End":
        index = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selectPoint(Number(this.solution.x[index]), "keyboard");
  };

  private selectPoint(x: number, trigger: SnapshotSelectionTrigger): void {
    this.setSelectedX(x);
    this.options.onPointSelect?.(x, trigger);
  }

  private paint(layoutChanged: boolean): void {
    if (!this.solution || this.destroyed) {
      return;
    }
    const solution = this.solution;
    const range = normalizedSurfaceRange(solution);
    const xMin = Number(solution.x[0]);
    const xMax = Number(solution.x[solution.x.length - 1]);
    const profile = this.profileSampler?.grid === solution
      ? this.profileSampler.sample(this.time)
      : { x: solution.x, values: sampleSlice(solution, this.time) };
    this.curve.setAttribute("d", this.profilePath(profile));
    this.emptyLabel.style.display = "none";
    setSvgAttributes(this.svg, {
      "data-geometry-ready": "true",
      "data-current-time": compactNumber(this.time, 1_000_000),
      "data-sample-count": solution.x.length,
      "data-revision": solution.revision
    });
    if (layoutChanged) {
      this.renderAxes(xMin, xMax, range.min, range.max);
      this.paintFootpoints();
      this.paintInitialProfile();
    }
    this.paintSelection();
    this.paintBoundaries();
    this.updateDescription();
  }

  private profilePath(profile: SampledProfile): string {
    if (!this.solution) return "";
    const range = normalizedSurfaceRange(this.solution);
    const xMin = Number(this.solution.x[0]);
    const xMax = Number(this.solution.x[this.solution.x.length - 1]);
    return Array.from(profile.x, (x, index) => {
      const pointX = compactNumber(this.mapX(x, xMin, xMax));
      const pointY = compactNumber(this.mapY(
        Number(profile.values[index]), range.min, range.max
      ));
      return `${index === 0 ? "M" : "L"}${pointX} ${pointY}`;
    }).join(" ");
  }

  private paintInitialProfile(): void {
    if (!this.initialProfileVisible || !this.solution) {
      this.initialCurve.setAttribute("visibility", "hidden");
      this.initialLegend.setAttribute("visibility", "hidden");
      return;
    }
    const profile = this.profileSampler?.grid === this.solution
      ? this.profileSampler.initial()
      : { x: this.solution.x, values: sampleSlice(this.solution, 0) };
    this.initialCurve.setAttribute("d", this.profilePath(profile));
    this.initialCurve.setAttribute("visibility", "visible");
    this.initialLegend.setAttribute("visibility", "visible");
  }

  private valueAt(x: number, time = this.time): number {
    if (!this.solution) return 0;
    return this.profileSampler?.grid === this.solution
      ? this.profileSampler.valueAt(x, time)
      : sampleSolutionGrid(this.solution, x, time);
  }

  private paintSelection(): void {
    if (!this.solution || this.selectedX === null) {
      this.hideSelection();
      this.svg.removeAttribute("data-selected-x");
      return;
    }
    const range = normalizedSurfaceRange(this.solution);
    const xMin = Number(this.solution.x[0]);
    const xMax = Number(this.solution.x[this.solution.x.length - 1]);
    const x = this.mapX(this.selectedX, xMin, xMax);
    const value = this.valueAt(this.selectedX);
    const y = this.mapY(value, range.min, range.max);
    setSvgAttributes(this.selectionGuide, {
      x1: x,
      x2: x,
      y1: this.geometry.top,
      y2: this.geometry.bottom,
      visibility: "visible"
    });
    for (const point of [this.selectedPointHalo, this.selectedPoint]) {
      setSvgAttributes(point, { cx: x, cy: y, visibility: "visible" });
    }
    this.svg.setAttribute("data-selected-x", compactNumber(this.selectedX, 1_000_000));
  }

  private hideSelection(): void {
    this.selectionGuide.setAttribute("visibility", "hidden");
    this.selectedPointHalo.setAttribute("visibility", "hidden");
    this.selectedPoint.setAttribute("visibility", "hidden");
  }

  private retainBoundaryMarkers(): void {
    while (this.boundaryMarkers.length < this.boundaryPositions.length) {
      const marker = createSvgElement("circle", "snapshot-boundary-marker");
      setSvgAttributes(marker, {
        r: 5.25,
        fill: "#ffffff",
        stroke: "rgba(4, 12, 16, 0.82)",
        "stroke-width": 1.5,
        "vector-effect": "non-scaling-stroke",
        "pointer-events": "none",
        visibility: "hidden"
      });
      this.boundaryMarkers.push(marker);
      this.boundaryLayer.append(marker);
    }
    while (this.boundaryMarkers.length > this.boundaryPositions.length) {
      this.boundaryMarkers.pop()?.remove();
    }
  }

  private paintBoundaries(): void {
    this.retainBoundaryMarkers();
    const serializedPositions = this.boundaryPositions
      .map((position) => compactNumber(position, 1_000_000))
      .join(",");
    this.svg.dataset.boundaryCount = String(this.boundaryPositions.length);
    this.svg.dataset.boundaryPositions = serializedPositions;
    if (!this.solution) {
      this.svg.dataset.visibleBoundaryCount = "0";
      for (const marker of this.boundaryMarkers) {
        marker.setAttribute("visibility", "hidden");
        marker.dataset.boundaryVisible = "false";
        marker.removeAttribute("data-boundary-value");
      }
      return;
    }

    const range = normalizedSurfaceRange(this.solution);
    const xMin = Number(this.solution.x[0]);
    const xMax = Number(this.solution.x[this.solution.x.length - 1]);
    const viewTolerance = Math.max(1, Math.abs(xMin), Math.abs(xMax)) * 1e-10;
    let visibleCount = 0;
    for (let index = 0; index < this.boundaryMarkers.length; index += 1) {
      const marker = this.boundaryMarkers[index]!;
      const position = this.boundaryPositions[index]!;
      const visible = position >= xMin - viewTolerance && position <= xMax + viewTolerance;
      marker.dataset.boundaryPosition = compactNumber(position, 1_000_000);
      marker.dataset.boundaryVisible = String(visible);
      if (!visible) {
        marker.setAttribute("visibility", "hidden");
        marker.removeAttribute("data-boundary-value");
        continue;
      }
      const displayedPosition = clamp(position, xMin, xMax);
      const value = this.valueAt(displayedPosition);
      setSvgAttributes(marker, {
        cx: this.mapX(displayedPosition, xMin, xMax),
        cy: this.mapY(value, range.min, range.max),
        visibility: "visible",
        "data-boundary-value": compactNumber(value, 1_000_000)
      });
      visibleCount += 1;
    }
    this.svg.dataset.visibleBoundaryCount = String(visibleCount);
  }

  private paintFootpoints(): void {
    this.footpointLayer.replaceChildren();
    if (!this.solution || !this.characteristics) {
      return;
    }
    const xMin = Number(this.solution.x[0]);
    const xMax = Number(this.solution.x[this.solution.x.length - 1]);
    const visibleFootpoints = this.characteristics.footpoints.filter(
      (footpoint, index, all) =>
        all.findIndex((candidate) => Math.abs(candidate.x - footpoint.x) < 1e-10) === index
    );
    for (const footpoint of visibleFootpoints) {
      const x = this.mapX(footpoint.x, xMin, xMax);
      const color = this.characteristicColor(footpoint.path);
      const family = this.characteristicFamily(footpoint.path);
      const guide = createSvgElement("line", "snapshot-footpoint-guide");
      setSvgAttributes(guide, {
        x1: x,
        x2: x,
        y1: this.geometry.top,
        y2: this.geometry.bottom,
        stroke: color,
        "stroke-width": 1,
        "stroke-dasharray": "3 6",
        opacity: 0.48,
        "vector-effect": "non-scaling-stroke",
        "data-characteristic-family": family
      });
      const marker = createSvgElement("path", `snapshot-footpoint snapshot-footpoint-${footpoint.path}`);
      marker.setAttribute(
        "d",
        `M${compactNumber(x)} ${compactNumber(this.geometry.bottom - 7)} ` +
          `L${compactNumber(x - 5)} ${compactNumber(this.geometry.bottom)} ` +
          `L${compactNumber(x + 5)} ${compactNumber(this.geometry.bottom)} Z`
      );
      setSvgAttributes(marker, {
        fill: color,
        stroke: color,
        "data-characteristic-family": family
      });
      this.footpointLayer.append(guide, marker);
    }
  }

  private characteristicColor(path: "left" | "right"): string {
    return path === "left" ? ETA_CHARACTERISTIC_COLOR : XI_CHARACTERISTIC_COLOR;
  }

  private characteristicFamily(path: "left" | "right"): "eta" | "xi" {
    return path === "left" ? "eta" : "xi";
  }

  private renderAxes(xMin: number, xMax: number, yMin: number, yMax: number): void {
    this.gridLayer.replaceChildren();
    this.axisLayer.replaceChildren();
    const xTicks = axisTicks(
      xMin,
      xMax,
      SNAPSHOT_X_TARGET_INTERVALS,
      this.xAxisNotation
    );
    const yTicks = 5;
    const uAxisX =
      xMin <= 0 && xMax >= 0
        ? this.mapX(0, xMin, xMax)
        : xMin > 0
          ? this.geometry.left
          : this.geometry.right;
    for (const tickValue of xTicks) {
      const fraction = (tickValue - xMin) / (xMax - xMin);
      const x = this.geometry.left + fraction * (this.geometry.right - this.geometry.left);
      const line = createSvgElement("line", "snapshot-grid-line snapshot-grid-line-x");
      setSvgAttributes(line, {
        x1: x,
        x2: x,
        y1: this.geometry.top,
        y2: this.geometry.bottom,
        stroke: "rgba(196, 229, 230, 0.12)",
        "stroke-width": 1,
        "vector-effect": "non-scaling-stroke"
      });
      this.gridLayer.append(line);
      const label = this.axisLabel(
        x,
        this.geometry.bottom + 25,
        axisValueToLatex(tickValue, this.xAxisNotation),
        "middle",
        "tick"
      );
      label.classList.add("snapshot-tick", "snapshot-x-tick");
      this.axisLayer.append(label);
    }
    for (let index = 0; index < yTicks; index += 1) {
      const fraction = index / (yTicks - 1);
      const y = this.geometry.bottom - fraction * (this.geometry.bottom - this.geometry.top);
      const line = createSvgElement("line", "snapshot-grid-line snapshot-grid-line-u");
      setSvgAttributes(line, {
        x1: this.geometry.left,
        x2: this.geometry.right,
        y1: y,
        y2: y,
        stroke: "rgba(196, 229, 230, 0.12)",
        "stroke-width": 1,
        "vector-effect": "non-scaling-stroke"
      });
      this.gridLayer.append(line);
      const label = this.axisLabel(
        uAxisX - 16,
        y,
        axisValueToLatex(yMin + fraction * (yMax - yMin)),
        "end",
        "tick"
      );
      label.classList.add("snapshot-tick", "snapshot-u-tick");
      this.axisLayer.append(label);
    }

    const zeroY = this.mapY(0, yMin, yMax);
    const xAxisEnd = this.geometry.right + X_AXIS_END_EXTENSION;
    const xAxis = createSvgElement("line", "snapshot-axis snapshot-axis-x");
    setSvgAttributes(xAxis, {
      x1: this.geometry.left,
      x2: xAxisEnd,
      y1: zeroY,
      y2: zeroY,
      stroke: "rgba(235, 250, 250, 0.62)",
      "stroke-width": 1.2,
      "vector-effect": "non-scaling-stroke",
      "marker-end": `url(#${this.svg.dataset.xAxisArrow})`
    });
    const uAxis = createSvgElement("line", "snapshot-axis snapshot-axis-u");
    setSvgAttributes(uAxis, {
      x1: uAxisX,
      x2: uAxisX,
      y1: this.geometry.bottom,
      y2: this.geometry.top - U_AXIS_END_EXTENSION,
      stroke: "rgba(235, 250, 250, 0.62)",
      "stroke-width": 1.2,
      "vector-effect": "non-scaling-stroke",
      "marker-end": `url(#${this.svg.dataset.uAxisArrow})`
    });
    const xLabel = this.axisLabel(
      xAxisEnd - X_AXIS_NAME_TIP_GAP,
      zeroY - 16,
      "x",
      "end",
      "axis"
    );
    xLabel.classList.add("snapshot-axis-label", "snapshot-x-axis-label");
    const uAxisAtRightBoundary = Math.abs(uAxisX - this.geometry.right) < 1e-8;
    const maximumRightLabelX = this.geometry.width - AXIS_LABEL_WIDTH;
    const rightLabelX = Math.min(uAxisX + U_AXIS_NAME_GAP, maximumRightLabelX);
    const uLabelFitsRight =
      !uAxisAtRightBoundary && rightLabelX >= uAxisX + U_AXIS_NAME_MIN_RIGHT_GAP;
    const uLabel = this.axisLabel(
      uLabelFitsRight ? rightLabelX : uAxisX - U_AXIS_NAME_GAP,
      this.geometry.top + 16,
      "u(x,t)",
      uLabelFitsRight ? "start" : "end",
      "axis"
    );
    uLabel.classList.add("snapshot-axis-label", "snapshot-u-axis-label");
    this.axisLayer.prepend(xAxis, uAxis);
    this.axisLayer.append(xLabel, uLabel);
  }

  private axisArrowMarker(
    id: string,
    axis: "x" | "u"
  ): SVGMarkerElement {
    const marker = createSvgElement("marker", "snapshot-axis-arrow-marker");
    setSvgAttributes(marker, {
      id,
      viewBox: "0 0 11 11",
      refX: 9.5,
      refY: 5.5,
      markerWidth: 11,
      markerHeight: 11,
      markerUnits: "userSpaceOnUse",
      orient: "auto",
      overflow: "visible",
      "data-snapshot-axis-marker": axis
    });
    const arrow = createSvgElement("path", "snapshot-axis-arrow");
    setSvgAttributes(arrow, {
      d: "M 1 1 L 10 5.5 L 1 10 Z",
      fill: "rgba(235, 250, 250, 0.78)",
      "aria-hidden": "true"
    });
    marker.append(arrow);
    return marker;
  }

  private axisLabel(
    x: number,
    y: number,
    latex: string,
    anchor: "start" | "middle" | "end",
    kind: "tick" | "axis"
  ): SVGForeignObjectElement {
    const width = kind === "axis" ? AXIS_LABEL_WIDTH : 123;
    const height = kind === "axis" ? 45 : 36;
    const left = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
    const label = createSvgElement("foreignObject");
    setSvgAttributes(label, {
      x: left,
      y: y - height / 2,
      width,
      height,
      "data-anchor": anchor,
      "pointer-events": "none"
    });
    const content = document.createElement("span");
    content.className = `snapshot-latex-label snapshot-latex-label--${kind}`;
    content.dataset.anchor = anchor;
    content.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    renderLatex(content, latex);
    label.append(content);
    return label;
  }

  private layout(): void {
    const { width, height, left, right, top, bottom } = this.geometry;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.initialLegend.setAttribute("transform", `translate(${Math.max(left, right - 115)}, ${top - 27})`);
    setSvgAttributes(this.background, { x: 0, y: 0, width, height });
    const clipRect = this.svg.querySelector<SVGRectElement>("[data-snapshot-clip]");
    if (clipRect) {
      setSvgAttributes(clipRect, {
        x: left - 3,
        y: top - 3,
        width: right - left + 6,
        height: bottom - top + 6
      });
    }
    setSvgAttributes(this.hitArea, {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    });
    setSvgAttributes(this.emptyLabel, {
      x: (left + right) / 2,
      y: (top + bottom) / 2
    });
  }

  private measure(width?: number, height?: number): SnapshotGeometry {
    const measuredWidth = Number.isFinite(width)
      ? Number(width)
      : this.container.clientWidth || this.options.defaultWidth;
    const measuredHeight = Number.isFinite(height)
      ? Number(height)
      : this.container.clientHeight || this.options.defaultHeight;
    const safeWidth = Math.max(this.options.minimumWidth, measuredWidth);
    const safeHeight = Math.max(this.options.minimumHeight, measuredHeight);
    const compact = safeWidth < 560;
    return {
      width: safeWidth,
      height: safeHeight,
      left: compact ? 66 : 78,
      right: safeWidth - (compact ? 18 : 26),
      top: compact ? 55 : 48,
      bottom: safeHeight - 52
    };
  }

  private mapX(value: number, minimum: number, maximum: number): number {
    return (
      this.geometry.left +
      ((value - minimum) / (maximum - minimum)) *
        (this.geometry.right - this.geometry.left)
    );
  }

  private mapY(value: number, minimum: number, maximum: number): number {
    return (
      this.geometry.bottom -
      ((value - minimum) / (maximum - minimum)) *
        (this.geometry.bottom - this.geometry.top)
    );
  }

  private updateDescription(): void {
    if (!this.solution) {
      this.descriptionElement.textContent =
        "No accepted wave solution is currently displayed. Once available, click the curve or use the arrow keys to select a point.";
      return;
    }
    const xMin = Number(this.solution.x[0]);
    const xMax = Number(this.solution.x[this.solution.x.length - 1]);
    const selected =
      this.selectedX === null
        ? "No characteristic point is selected."
        : `The selected point is x ${axisValueToText(this.selectedX, this.xAxisNotation)}, u ${formatAxisValue(
            this.valueAt(this.selectedX)
          )}.`;
    const etaFootpoint = this.characteristics?.footpoints.find(
      (footpoint) => footpoint.path === "left"
    );
    const xiFootpoint = this.characteristics?.footpoints.find(
      (footpoint) => footpoint.path === "right"
    );
    const traces = etaFootpoint && xiFootpoint
      ? ` Its two backward characteristics reach the initial line: red eta at x ${axisValueToText(
          etaFootpoint.x,
          this.xAxisNotation
        )}, and purple xi at x ${axisValueToText(
          xiFootpoint.x,
          this.xAxisNotation
        )}.`
      : "";
    const visibleBoundaries = this.boundaryPositions
      .filter((position) => position >= xMin && position <= xMax)
      .map((position) => ({
        position,
        value: this.valueAt(position)
      }));
    const boundaries = visibleBoundaries.length > 0
      ? ` Physical boundary ${visibleBoundaries.length === 1 ? "marker is" : "markers are"} shown at ${visibleBoundaries
          .map(
            ({ position, value }) =>
              `x ${axisValueToText(position, this.xAxisNotation)}, u ${formatAxisValue(value)}`
          )
          .join("; ")}.`
      : "";
    this.descriptionElement.textContent =
      `Wave profile u(x,t) at t ${formatAxisValue(this.time)}, on x from ${axisValueToText(
        xMin,
        this.xAxisNotation
      )} to ${axisValueToText(xMax, this.xAxisNotation)}. ${selected}${traces}${boundaries} ` +
      (this.initialProfileVisible ? "The dashed light curve shows the initial displacement f(x). " : "") +
      (this.selectionEnabled
        ? "Click the curve or use Left and Right Arrow keys to choose a point."
        : "Open Characteristics to select a point on the curve.");
  }
}
