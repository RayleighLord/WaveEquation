import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import {
  CSS2DObject,
  CSS2DRenderer
} from "three/addons/renderers/CSS2DRenderer.js";

import type {
  CharacteristicPoint,
  CharacteristicTrace,
  WaveSolutionGrid
} from "../types";
import { adaptiveSurfaceSampleCounts } from "../math/resolution";
import {
  clampGridTime,
  normalizedSurfaceRange,
  sampleSolutionGrid,
  sampleSlice,
  validateSolutionGrid
} from "./sampling";
import { axisValueToLatex, renderLatex } from "./latex";
import { clamp } from "./svg";
import { axisTicks, type AxisValueNotation } from "./ticks";
import { buildSteppedSurfaceBuffers } from "./steppedSurface";
import type { ProfileSampler } from "./profile";

// World coordinates intentionally follow the reference view: time occupies
// the long horizontal X axis, space recedes along Z, and displacement is Y.
const WORLD_T_MIN = -5;
const WORLD_T_MAX = 5;
const WORLD_X_MIN = -4;
const WORLD_X_MAX = 4;
const WORLD_U_MIN = -2.5;
const WORLD_U_MAX = 2.5;
// Low, oblique reference perspective: u is visually vertical at the left and
// x crosses the foreground. The time axis itself is placed on x = x_min below,
// so it occupies the opposite spatial edge from the supplied reference image.
const DEFAULT_CAMERA_POSITION = new THREE.Vector3(-15, 5.3, 8);
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, -0.7, 0);
// OrbitControls measures its polar angle down from world +Y. Guard only the
// two singular poles so users can pass smoothly through the floor and inspect
// the double-sided surface from the complete lower hemisphere.
const ORBIT_POLE_GUARD = 0.16;
const ORBIT_MIN_POLAR_ANGLE = ORBIT_POLE_GUARD;
const ORBIT_MAX_POLAR_ANGLE = Math.PI - ORBIT_POLE_GUARD;

const AXIS_ARROW_HEIGHT = 0.36;
const T_AXIS_LINE_END = WORLD_T_MAX + 0.55;
const X_AXIS_LINE_END = WORLD_X_MAX + 0.55;
const U_AXIS_LINE_END = WORLD_U_MAX + 0.32;
// These outward offsets both project toward screen-left in the stable default
// view. Tick labels use their right edge as the anchor, so even wider values
// remain wholly clear of the corresponding axis instead of straddling it.
const T_AXIS_TICK_SPATIAL_OFFSET = 0.4;
const U_AXIS_TICK_TIME_OFFSET = 0.4;
const FLOOR_AXIS_TICK_VERTICAL_OFFSET = 0.24;

const SURFACE_COLOR = 0x4fcbd3;
// Diffuse lighting lets the already-smoothed graph normals reveal its shape.
// A hemisphere light with a nonblack ground color keeps the flipped underside
// normals readable below the x-t plane, while the directional key creates the
// stronger curvature cues seen from the default upper view. The current visual
// trial is completely opaque so the illuminated shape remains dominant.
const SURFACE_OPACITY = 1;
const SURFACE_TRANSPARENCY = 0;
const SURFACE_TRANSPARENT = false;
const SURFACE_SIDE = THREE.DoubleSide;
const SURFACE_SIDE_DATASET = "double";
const SURFACE_MATERIAL_DATASET = "lambert-lit";
const SURFACE_LIGHTING_DATASET = "hemisphere-key-underfill";
const SURFACE_UNDERSIDE_FILL_DATASET = "true";
const SURFACE_PASS_DATASET = "single";
const WEBGL_ANTIALIAS = false;
const WEBGL_RESOLUTION_SCALE = 0.9;
const SLICE_COLOR = 0xffe088;
// The backward-left stored path preserves eta = x - t before any reflection;
// the backward-right path preserves xi = x + t. Keep each broken reflected ray
// associated with the family selected at P, and pair names with color so the
// presentation never relies on color alone.
const ETA_CHARACTERISTIC_COLOR = 0xe76f67;
const XI_CHARACTERISTIC_COLOR = 0xa970ff;
const MATH_LABEL_SCALE = 1.5;
const SURFACE_BOUNDING_RADIUS = 7.25;
const STEPPED_SURFACE_JUMP_THRESHOLD = 0.05;
const PHYSICAL_BOUNDARY_TRACE_COLOR = 0xffffff;
// A world-space Line2 keeps the boundary trace visibly heavier than the floor
// grid even on WebGL implementations that ignore LineBasicMaterial.linewidth.
const PHYSICAL_BOUNDARY_TRACE_WIDTH = 0.055;

export type TimeInteractionTrigger = "plane-drag" | "keyboard";
export interface PresentationUpdateOptions {
  /** Assign state now; an imminent setSolution call performs the one rebuild. */
  defer?: boolean;
}
export interface SolutionUpdateOptions {
  /** The revision-safe worker client already validated the complete grid. */
  validated?: boolean;
  time?: number;
}

export interface SpaceTimeRendererOptions {
  ariaLabel?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  minimumWidth?: number;
  minimumHeight?: number;
  onTimeChange?: (time: number, trigger: TimeInteractionTrigger) => void;
  onInteractionStart?: (trigger: TimeInteractionTrigger) => void;
  /** Injection seam used by renderer tests and nonstandard WebGL hosts. */
  rendererFactory?: () => THREE.WebGLRenderer;
  /** Optional shell-owned notice. The renderer toggles its `hidden` state. */
  fallbackElement?: HTMLElement;
}

export interface SpaceTimeRendererFrame {
  solution: WaveSolutionGrid;
  time: number;
  characteristics?: CharacteristicTrace | null;
}

export interface SpaceTimeAxisNotation {
  x: AxisValueNotation;
  t: AxisValueNotation;
}

export type SurfaceTopology = "smooth" | "stepped";

export interface CharacteristicRenderOptions {
  /** Prepare retained characteristic objects now and submit WebGL later. */
  deferRender?: boolean;
}

/**
 * Persistent Three.js scene for u(x,t), its current-time section, and backward
 * characteristics. Solution changes keep every other accepted spatial sample
 * and every adaptive time row; time changes only update the plane and one
 * full-resolution line.
 */
export class SpaceTimeRenderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement | null;
  readonly webglAvailable: boolean;

  private readonly container: HTMLElement;
  private readonly options: Required<
    Omit<
      SpaceTimeRendererOptions,
      "onTimeChange" | "onInteractionStart" | "rendererFactory" | "fallbackElement"
    >
  > &
    Pick<
      SpaceTimeRendererOptions,
      "onTimeChange" | "onInteractionStart" | "rendererFactory" | "fallbackElement"
    >;
  private readonly renderer: THREE.WebGLRenderer | null;
  private readonly labelRenderer: CSS2DRenderer | null;
  private readonly controls: OrbitControls | null;
  private readonly fallbackElement: HTMLElement;
  private readonly ownsFallbackElement: boolean;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private readonly dragPoint = new THREE.Vector3();
  private readonly defaultCameraPosition = DEFAULT_CAMERA_POSITION.clone();

  private readonly floorGrid: THREE.LineSegments<
    THREE.BufferGeometry,
    THREE.LineBasicMaterial
  >;
  private readonly axisLines: THREE.LineSegments;
  private readonly axisArrowGroup = new THREE.Group();
  private readonly tAxisArrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private readonly xAxisArrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private readonly uAxisArrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private readonly axisLabelGroup = new THREE.Group();
  private readonly surfaceGroup = new THREE.Group();
  private readonly physicalBoundaryTraceGroup = new THREE.Group();
  private readonly timePlaneGroup = new THREE.Group();
  private readonly characteristicFloorGroup = new THREE.Group();
  private readonly characteristicPointGroup = new THREE.Group();
  private readonly timePlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly timePlaneOutline: THREE.LineSegments;
  private readonly sliceLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;

  private solution: WaveSolutionGrid | null = null;
  private profileSampler: ProfileSampler | null = null;
  private webglFrames = 0;
  private physicalBoundaryPositions: number[] = [];
  private characteristics: CharacteristicTrace | null = null;
  private axisNotation: SpaceTimeAxisNotation = { x: "decimal", t: "decimal" };
  private surfaceTopology: SurfaceTopology = "smooth";
  private time = 0;
  private surfaceMesh: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.Material | THREE.Material[]
  > | null = null;
  private surfaceRangeMinimum = -1;
  private surfaceRangeMaximum = 1;
  private width: number;
  private height: number;
  private activePointerId: number | null = null;
  private interactionFrame = 0;
  private pendingInteraction: { time: number; trigger: TimeInteractionTrigger } | null = null;
  private destroyed = false;

  constructor(container: HTMLElement, options: SpaceTimeRendererOptions = {}) {
    this.container = container;
    this.options = {
      ariaLabel: options.ariaLabel ??
        "Three-dimensional wave solution u over the x and t plane",
      defaultWidth: options.defaultWidth ?? 1120,
      defaultHeight: options.defaultHeight ?? 650,
      minimumWidth: options.minimumWidth ?? 300,
      minimumHeight: options.minimumHeight ?? 300,
      onTimeChange: options.onTimeChange,
      onInteractionStart: options.onInteractionStart,
      rendererFactory: options.rendererFactory,
      fallbackElement: options.fallbackElement
    };
    this.width = Math.max(
      this.options.minimumWidth,
      container.clientWidth || this.options.defaultWidth
    );
    this.height = Math.max(
      this.options.minimumHeight,
      container.clientHeight || this.options.defaultHeight
    );

    this.scene = new THREE.Scene();
    this.scene.name = "wave-space-time-scene";
    this.camera = new THREE.PerspectiveCamera(38, this.width / this.height, 0.1, 100);
    this.camera.position.copy(DEFAULT_CAMERA_POSITION);

    const surfaceHemisphereLight = new THREE.HemisphereLight(
      0xe8ffff,
      0x91c4c6,
      1.45
    );
    surfaceHemisphereLight.name = "wave-surface-hemisphere-light";
    const surfaceKeyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    surfaceKeyLight.name = "wave-surface-key-light";
    surfaceKeyLight.position.set(-6, 9, 8);
    const surfaceUnderfillLight = new THREE.DirectionalLight(0xb9f0f1, 0.55);
    surfaceUnderfillLight.name = "wave-surface-underfill-light";
    surfaceUnderfillLight.position.set(5, -7, -6);
    this.scene.add(
      surfaceHemisphereLight,
      surfaceKeyLight,
      surfaceUnderfillLight
    );

    this.floorGrid = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x356668,
        transparent: true,
        opacity: 0.42,
        depthWrite: false
      })
    );
    this.floorGrid.name = "x-t-grid";
    this.floorGrid.renderOrder = 0;
    this.rebuildFloorGrid();
    this.scene.add(this.floorGrid);

    this.axisLines = this.createAxisLines();
    this.axisArrowGroup.name = "axis-arrows";
    this.tAxisArrow = this.createAxisArrow(
      "t-axis-arrow",
      new THREE.Vector3(1, 0, 0)
    );
    this.xAxisArrow = this.createAxisArrow(
      "x-axis-arrow",
      new THREE.Vector3(0, 0, 1)
    );
    this.uAxisArrow = this.createAxisArrow(
      "u-axis-arrow",
      new THREE.Vector3(0, 1, 0)
    );
    this.axisArrowGroup.add(this.tAxisArrow, this.xAxisArrow, this.uAxisArrow);
    this.axisLabelGroup.name = "axis-labels";
    this.scene.add(this.axisLines, this.axisArrowGroup, this.axisLabelGroup);

    const timePlaneMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc95c,
      opacity: 0.16,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    // A zero-thickness plane needs both orientations but not Three's default
    // two-pass transparent DoubleSide submission.
    timePlaneMaterial.forceSinglePass = true;
    this.timePlane = new THREE.Mesh(new THREE.PlaneGeometry(8.2, 6.1), timePlaneMaterial);
    this.timePlane.name = "draggable-time-plane";
    this.timePlane.rotation.y = Math.PI / 2;
    this.timePlane.renderOrder = 2;
    const planeEdges = new THREE.EdgesGeometry(this.timePlane.geometry);
    this.timePlaneOutline = new THREE.LineSegments(
      planeEdges,
      new THREE.LineBasicMaterial({
        color: 0xffd983,
        transparent: true,
        opacity: 0.7,
        depthWrite: false
      })
    );
    this.timePlaneOutline.name = "time-plane-outline";
    this.timePlaneOutline.rotation.y = Math.PI / 2;
    this.timePlaneOutline.renderOrder = 3;

    this.sliceLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: SLICE_COLOR,
        transparent: true,
        opacity: 1,
        depthTest: false
      })
    );
    this.sliceLine.name = "current-time-surface-slice";
    this.sliceLine.renderOrder = 7;
    this.timePlaneGroup.name = "time-plane-group";
    this.timePlaneGroup.add(
      this.timePlane,
      this.timePlaneOutline,
      this.sliceLine
    );
    this.scene.add(
      this.surfaceGroup,
      this.physicalBoundaryTraceGroup,
      this.timePlaneGroup,
      this.characteristicFloorGroup,
      this.characteristicPointGroup
    );
    this.surfaceGroup.name = "wave-surface-group";
    this.physicalBoundaryTraceGroup.name = "physical-boundary-surface-traces";
    this.characteristicFloorGroup.name = "characteristic-floor-paths";
    this.characteristicPointGroup.name = "characteristic-selected-point-layer";

    this.renderer = this.createRenderer();
    this.labelRenderer = this.renderer ? new CSS2DRenderer() : null;
    this.webglAvailable = this.renderer !== null;
    this.canvas = this.renderer?.domElement ?? null;
    this.container.dataset.webglAvailable = String(this.webglAvailable);
    this.container.dataset.axisOrientation = "t-horizontal-x-depth-u-vertical";
    this.container.dataset.defaultView = "low-oblique-u-left-t-left-edge";
    this.container.dataset.timeAxisEdge = "x-min";
    this.container.dataset.axisArrows = "3";
    this.container.dataset.lowerHemisphereOrbit = "enabled";
    this.container.dataset.orbitMinPolarAngle = String(ORBIT_MIN_POLAR_ANGLE);
    this.container.dataset.orbitMaxPolarAngle = String(ORBIT_MAX_POLAR_ANGLE);
    this.setSurfacePresentationDatasets();
    this.setAxisNotationDatasets();
    this.container.dataset.geometryReady = "false";
    this.container.dataset.currentTime = "0";
    this.container.dataset.characteristicFloorPaths = "0";
    this.container.dataset.characteristicSurfacePaths = "0";
    this.container.dataset.characteristicHits = "0";
    this.container.dataset.characteristicFootpoints = "0";
    this.setCharacteristicFrameDatasets("idle", "idle", "idle");

    if (this.canvas) {
      this.canvas.classList.add("wave-surface-canvas");
      this.canvas.setAttribute("role", "application");
      this.canvas.setAttribute("aria-label", this.options.ariaLabel);
      this.canvas.setAttribute(
        "aria-description",
        "Drag the gold time plane to choose a snapshot. Drag elsewhere to orbit the camera above or below the u equals zero plane. Use Left and Right Arrow keys to move through time."
      );
      this.canvas.tabIndex = 0;
      this.canvas.style.display = "block";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      this.canvas.style.touchAction = "none";
      this.canvas.dataset.currentTime = "0";
      this.canvas.dataset.axisOrientation = "t-horizontal-x-depth-u-vertical";
      this.canvas.dataset.defaultView = "low-oblique-u-left-t-left-edge";
      this.canvas.dataset.timeAxisEdge = "x-min";
      this.canvas.dataset.axisArrows = "3";
      this.canvas.dataset.lowerHemisphereOrbit = "enabled";
      this.canvas.dataset.orbitMinPolarAngle = String(ORBIT_MIN_POLAR_ANGLE);
      this.canvas.dataset.orbitMaxPolarAngle = String(ORBIT_MAX_POLAR_ANGLE);
      this.setSurfacePresentationDatasets();
      this.container.append(this.canvas);
      if (this.labelRenderer) {
        const labelLayer = this.labelRenderer.domElement;
        labelLayer.className = "space-time-label-layer";
        labelLayer.setAttribute("aria-hidden", "true");
        labelLayer.style.position = "absolute";
        labelLayer.style.inset = "0";
        labelLayer.style.pointerEvents = "none";
        labelLayer.style.overflow = "hidden";
        this.container.append(labelLayer);
      }
      this.canvas.addEventListener("pointerdown", this.handlePointerDown);
      this.canvas.addEventListener("pointermove", this.handlePointerMove);
      this.canvas.addEventListener("pointerup", this.handlePointerUp);
      this.canvas.addEventListener("pointercancel", this.handlePointerUp);
      this.canvas.addEventListener("keydown", this.handleKeyDown);
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.target.copy(DEFAULT_CAMERA_TARGET);
      this.controls.enableDamping = false;
      this.controls.minDistance = 7;
      this.controls.maxDistance = 28;
      this.controls.minPolarAngle = ORBIT_MIN_POLAR_ANGLE;
      this.controls.maxPolarAngle = ORBIT_MAX_POLAR_ANGLE;
      this.controls.addEventListener("change", this.render);
      this.controls.update();
      this.renderer!.setPixelRatio(
        Math.max(
          0.75,
          Math.min(window.devicePixelRatio || 1, 2) * WEBGL_RESOLUTION_SCALE
        )
      );
      this.renderer!.setSize(this.width, this.height, false);
      this.labelRenderer?.setSize(this.width, this.height);
      this.renderer!.setClearColor(0x000000, 1);
      this.renderer!.outputColorSpace = THREE.SRGBColorSpace;
    } else {
      this.controls = null;
    }
    this.setMeshDatasets(0, 0, 0, 0);
    this.setPhysicalBoundaryTraceDatasets([]);

    const existingNotice = options.fallbackElement ??
      container.querySelector<HTMLElement>("[data-webgl-notice], #webgl-notice");
    if (existingNotice) {
      this.fallbackElement = existingNotice;
      this.ownsFallbackElement = false;
    } else {
      this.fallbackElement = document.createElement("p");
      this.fallbackElement.className = "webgl-notice";
      this.fallbackElement.dataset.webglNotice = "";
      this.fallbackElement.setAttribute("role", "status");
      this.fallbackElement.setAttribute("aria-live", "polite");
      this.fallbackElement.textContent =
        "The 3D view is unavailable because WebGL could not be started. The wave snapshot and controls remain available.";
      this.container.append(this.fallbackElement);
      this.ownsFallbackElement = true;
    }
    this.fallbackElement.hidden = this.webglAvailable;

    this.rebuildAxisLabels();
    this.positionFloorAndAxes();
    this.resetCamera();

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

  update(frame: SpaceTimeRendererFrame): void {
    if (frame.solution !== this.solution) {
      this.setSolution(frame.solution);
    }
    this.setTime(frame.time);
    this.setCharacteristics(frame.characteristics ?? null);
  }

  setSolution(
    solution: WaveSolutionGrid,
    options: SolutionUpdateOptions = {}
  ): void {
    if (this.destroyed) {
      return;
    }
    if (!options.validated) validateSolutionGrid(solution);
    if (this.interactionFrame) window.cancelAnimationFrame(this.interactionFrame);
    this.interactionFrame = 0;
    this.pendingInteraction = null;
    const wasDefault = this.camera.position.distanceToSquared(this.defaultCameraPosition) < 1e-10;
    this.solution = solution;
    const surfaceRange = normalizedSurfaceRange(solution);
    this.surfaceRangeMinimum = surfaceRange.min;
    this.surfaceRangeMaximum = surfaceRange.max;
    this.time = clampGridTime(solution, options.time ?? this.time);
    this.positionTimePlane();
    this.rebuildSurface();
    this.rebuildPhysicalBoundaryTraces();
    this.rebuildFloorGrid();
    this.rebuildAxisLabels();
    this.positionFloorAndAxes();
    if (wasDefault) {
      this.fitDefaultCamera();
      this.camera.position.copy(this.defaultCameraPosition);
      this.camera.lookAt(DEFAULT_CAMERA_TARGET);
    }
    this.paintTimeSlice();
    this.paintCharacteristics();
    this.container.dataset.geometryReady = "true";
    this.container.dataset.revision = String(solution.revision);
    if (this.canvas) {
      this.canvas.dataset.geometryReady = "true";
      this.canvas.dataset.revision = String(solution.revision);
      this.canvas.dataset.xSamples = String(solution.x.length);
      this.canvas.dataset.tSamples = String(solution.t.length);
    }
    this.render();
  }

  /**
   * Mark finite physical endpoints on the accepted solution surface. Values
   * may be supplied before or after a solution; their world mapping is rebuilt
   * whenever the accepted grid changes.
   */
  setBoundaryPositions(
    positions: readonly number[],
    options: PresentationUpdateOptions = {}
  ): void {
    if (this.destroyed) {
      return;
    }
    this.physicalBoundaryPositions = normalizeBoundaryPositions(positions);
    if (options.defer) return;
    this.rebuildPhysicalBoundaryTraces();
    this.render();
  }

  setProfileSampler(
    sampler: ProfileSampler | null,
    options: PresentationUpdateOptions = {}
  ): void {
    if (this.destroyed) return;
    this.profileSampler = sampler;
    if (!options.defer && this.solution) {
      this.paintTimeSlice();
      this.renderWebGL();
    }
  }

  setTime(time: number): void {
    if (this.destroyed) {
      return;
    }
    const nextTime = this.solution
      ? clampGridTime(this.solution, time)
      : Math.max(0, Number.isFinite(time) ? time : 0);
    this.pendingInteraction = null;
    if (nextTime === this.time) {
      return;
    }
    this.time = nextTime;
    this.positionTimePlane();
    this.paintTimeSlice();
    // Axis and annotation labels are static while only the retained time plane
    // and intersection move. Avoid a full CSS2D/KaTeX layout on every scrub.
    this.renderWebGL();
  }

  setCharacteristics(
    characteristics: CharacteristicTrace | null,
    options: CharacteristicRenderOptions = {}
  ): void {
    if (this.destroyed) {
      return;
    }
    this.characteristics = characteristics;
    this.paintCharacteristics();
    this.container.dataset.characteristics = characteristics ? "visible" : "hidden";
    if (options.deferRender) {
      this.setCharacteristicFrameDatasets("prepared", "prepared", "prepared");
      return;
    }
    this.render();
    this.setCharacteristicFrameDatasets("rendered", "rendered", "rendered");
  }

  /**
   * Change axis/grid presentation independently of the accepted solution.
   * Characteristic constants follow the spatial notation because their
   * initial-line footpoints are spatial coordinates.
   */
  setAxisNotation(
    notation: Partial<SpaceTimeAxisNotation>,
    options: PresentationUpdateOptions = {}
  ): void {
    if (this.destroyed) {
      return;
    }
    const next: SpaceTimeAxisNotation = {
      x: notation.x ?? this.axisNotation.x,
      t: notation.t ?? this.axisNotation.t
    };
    if (next.x === this.axisNotation.x && next.t === this.axisNotation.t) {
      return;
    }
    this.axisNotation = next;
    this.setAxisNotationDatasets();
    if (options.defer) return;
    this.rebuildFloorGrid();
    this.rebuildAxisLabels();
    this.paintCharacteristics();
    this.render();
  }

  /** Select a continuous height field or a jump-preserving terrace topology. */
  setSurfaceTopology(
    topology: SurfaceTopology,
    options: PresentationUpdateOptions = {}
  ): void {
    if (this.destroyed || topology === this.surfaceTopology) {
      return;
    }
    this.surfaceTopology = topology;
    this.setSurfacePresentationDatasets();
    if (options.defer) return;
    if (this.solution) {
      this.rebuildSurface();
      this.render();
    }
  }

  /** Submit only WebGL objects prepared by a deferred characteristics update. */
  renderPreparedWebGLFrame(): void {
    if (this.destroyed) {
      return;
    }
    this.renderWebGL();
    this.setCharacteristicFrameDatasets("webgl-rendered", "rendered", "prepared");
  }

  /** Submit only CSS2D labels prepared by a deferred characteristics update. */
  renderPreparedLabelFrame(): void {
    if (this.destroyed) {
      return;
    }
    this.renderLabels();
    this.setCharacteristicFrameDatasets("rendered", "rendered", "rendered");
  }

  /** Backward-compatible combined submission of a prepared characteristic frame. */
  renderPreparedFrame(): void {
    if (this.destroyed) {
      return;
    }
    this.renderPreparedWebGLFrame();
    this.renderPreparedLabelFrame();
  }

  resetCamera(): void {
    if (this.destroyed) {
      return;
    }
    this.fitDefaultCamera();
    this.camera.position.copy(this.defaultCameraPosition);
    if (this.controls) {
      this.controls.target.copy(DEFAULT_CAMERA_TARGET);
      this.controls.update();
    } else {
      this.camera.lookAt(DEFAULT_CAMERA_TARGET);
    }
    this.render();
  }

  resize(width?: number, height?: number): void {
    if (this.destroyed) {
      return;
    }
    const wasDefault = this.camera.position.distanceToSquared(this.defaultCameraPosition) < 1e-10;
    this.width = Math.max(
      this.options.minimumWidth,
      Number.isFinite(width) ? Number(width) : this.container.clientWidth || this.options.defaultWidth
    );
    this.height = Math.max(
      this.options.minimumHeight,
      Number.isFinite(height)
        ? Number(height)
        : this.container.clientHeight || this.options.defaultHeight
    );
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (wasDefault) {
      this.fitDefaultCamera();
      this.camera.position.copy(this.defaultCameraPosition);
      this.camera.lookAt(DEFAULT_CAMERA_TARGET);
    }
    this.renderer?.setSize(this.width, this.height, false);
    this.labelRenderer?.setSize(this.width, this.height);
    this.container.dataset.renderWidth = String(this.width);
    this.container.dataset.renderHeight = String(this.height);
    this.render();
  }

  /** Preserve the reference viewing direction while reserving room for math. */
  private fitDefaultCamera(): void {
    this.defaultCameraPosition.copy(DEFAULT_CAMERA_POSITION);
    if (this.width >= 760 && this.camera.aspect >= 1.25) return;
    const probe = this.camera.clone();
    const direction = DEFAULT_CAMERA_POSITION.clone().sub(DEFAULT_CAMERA_TARGET);
    const points: { point: THREE.Vector3; width: number; height: number; anchor: THREE.Vector2 }[] = [];
    for (const t of [WORLD_T_MIN, T_AXIS_LINE_END + AXIS_ARROW_HEIGHT]) {
      for (const x of [WORLD_X_MIN, X_AXIS_LINE_END + AXIS_ARROW_HEIGHT]) {
        for (const u of [WORLD_U_MIN - 0.3, U_AXIS_LINE_END + AXIS_ARROW_HEIGHT]) {
          points.push({ point: new THREE.Vector3(t, u, x), width: 0, height: 0, anchor: new THREE.Vector2() });
        }
      }
    }
    for (const child of this.axisLabelGroup.children) {
      if (!(child instanceof CSS2DObject)) continue;
      const fontPixels = parseFloat(child.element.style.fontSize) * 16;
      const source = String(child.userData.label ?? "");
      const visibleLength = source.replace(/\\[a-z]+|[{}]/g, "").length;
      points.push({
        point: child.position,
        width: child.element.offsetWidth || Math.max(fontPixels, Math.min(130, visibleLength * fontPixels * 0.65)),
        height: child.element.offsetHeight || fontPixels * 1.5,
        anchor: child.center
      });
    }
    let factor = 1;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      probe.position.copy(DEFAULT_CAMERA_TARGET).addScaledVector(direction, factor);
      probe.lookAt(DEFAULT_CAMERA_TARGET);
      probe.updateMatrixWorld(true);
      const fits = points.every(({ point, width, height, anchor }) => {
        const projected = point.clone().project(probe);
        const left = (projected.x + 1) * this.width / 2 - width * anchor.x;
        const top = (1 - projected.y) * this.height / 2 - height * anchor.y;
        return left >= 12 && left + width <= this.width - 12 && top >= 12 && top + height <= this.height - 12;
      });
      if (fits) break;
      factor *= 1.045;
    }
    this.defaultCameraPosition.copy(probe.position);
    if (this.controls) this.controls.maxDistance = Math.max(28, direction.length() * factor * 1.25);
  }

  clear(): void {
    if (this.interactionFrame) window.cancelAnimationFrame(this.interactionFrame);
    this.interactionFrame = 0;
    this.pendingInteraction = null;
    this.solution = null;
    this.profileSampler = null;
    this.physicalBoundaryPositions = [];
    this.characteristics = null;
    this.surfaceRangeMinimum = -1;
    this.surfaceRangeMaximum = 1;
    this.disposeSurface();
    this.clearGroup(this.physicalBoundaryTraceGroup);
    this.setPhysicalBoundaryTraceDatasets([]);
    this.sliceLine.geometry.dispose();
    this.sliceLine.geometry = new THREE.BufferGeometry();
    this.clearGroup(this.characteristicFloorGroup);
    this.clearGroup(this.characteristicPointGroup);
    this.container.dataset.geometryReady = "false";
    this.container.dataset.currentTime = "0";
    this.container.dataset.characteristics = "hidden";
    this.setCharacteristicDatasets(0, 0, 0, 0);
    this.setMeshDatasets(0, 0, 0, 0);
    delete this.container.dataset.revision;
    if (this.canvas) {
      this.canvas.dataset.geometryReady = "false";
      this.canvas.dataset.currentTime = "0";
      delete this.canvas.dataset.revision;
    }
    this.rebuildAxisLabels();
    this.rebuildFloorGrid();
    this.positionFloorAndAxes();
    this.setTime(0);
    this.render();
  }

  dispose(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.profileSampler = null;
    if (this.interactionFrame) window.cancelAnimationFrame(this.interactionFrame);
    this.pendingInteraction = null;
    this.resizeObserver?.disconnect();
    if (this.canvas) {
      this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
      this.canvas.removeEventListener("pointermove", this.handlePointerMove);
      this.canvas.removeEventListener("pointerup", this.handlePointerUp);
      this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
      this.canvas.removeEventListener("keydown", this.handleKeyDown);
    }
    this.controls?.removeEventListener("change", this.render);
    this.controls?.dispose();
    this.disposeSurface();
    this.clearGroup(this.axisLabelGroup);
    this.clearGroup(this.physicalBoundaryTraceGroup);
    this.clearGroup(this.characteristicFloorGroup);
    this.clearGroup(this.characteristicPointGroup);
    this.timePlane.geometry.dispose();
    this.timePlane.material.dispose();
    this.disposeObject(this.timePlaneOutline);
    this.sliceLine.geometry.dispose();
    this.sliceLine.material.dispose();
    this.floorGrid.geometry.dispose();
    this.floorGrid.material.dispose();
    this.disposeObject(this.axisLines);
    this.disposeObject(this.axisArrowGroup);
    this.renderer?.dispose();
    this.labelRenderer?.domElement.remove();
    this.canvas?.remove();
    if (this.ownsFallbackElement) {
      this.fallbackElement.remove();
    }
  }

  private createRenderer(): THREE.WebGLRenderer | null {
    try {
      if (this.options.rendererFactory) {
        return this.options.rendererFactory();
      }
      if (
        typeof window === "undefined" ||
        (typeof WebGLRenderingContext === "undefined" &&
          typeof WebGL2RenderingContext === "undefined")
      ) {
        return null;
      }
      const probe = document.createElement("canvas");
      const context = probe.getContext("webgl2") ?? probe.getContext("webgl");
      if (!context) {
        return null;
      }
      return new THREE.WebGLRenderer({
        antialias: WEBGL_ANTIALIAS,
        alpha: false,
        powerPreference: "high-performance"
      });
    } catch {
      return null;
    }
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.canvas || !this.solution || event.button !== 0 || this.destroyed) {
      return;
    }
    this.updateRaycaster(event);
    const intersections = this.raycaster.intersectObject(this.timePlane, false);
    if (intersections.length === 0) {
      return;
    }
    const grabPoint = intersections[0]?.point;
    if (!grabPoint) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.activePointerId = event.pointerId;
    this.canvas.setPointerCapture?.(event.pointerId);
    if (this.controls) {
      this.controls.enabled = false;
    }
    this.canvas.dataset.planeDragging = "true";
    const dragNormal = this.camera.position.clone().sub(grabPoint);
    // The interaction plane contains the world-X direction, so pointer motion
    // resolves directly to the time coordinate while Y/Z remain unconstrained.
    dragNormal.x = 0;
    if (dragNormal.lengthSq() < 1e-8) {
      dragNormal.set(0, 0, 1);
    } else {
      dragNormal.normalize();
    }
    this.dragPlane.setFromNormalAndCoplanarPoint(dragNormal, grabPoint);
    this.options.onInteractionStart?.("plane-drag");
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId || this.destroyed) {
      return;
    }
    event.preventDefault();
    this.moveTimePlaneFromPointer(event);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    this.activePointerId = null;
    this.canvas?.releasePointerCapture?.(event.pointerId);
    if (this.controls) {
      this.controls.enabled = true;
    }
    if (this.canvas) {
      this.canvas.dataset.planeDragging = "false";
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.solution || this.destroyed) {
      return;
    }
    const tMin = Number(this.solution.t[0]);
    const tMax = Number(this.solution.t[this.solution.t.length - 1]);
    const nominalStep =
      this.solution.t.length > 1 ? (tMax - tMin) / (this.solution.t.length - 1) : 0;
    const step = nominalStep * (event.shiftKey ? 10 : 1);
    const requestedTime = this.pendingInteraction?.time ?? this.time;
    let next = requestedTime;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = requestedTime - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = requestedTime + step;
        break;
      case "Home":
        next = tMin;
        break;
      case "End":
        next = tMax;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.options.onInteractionStart?.("keyboard");
    this.requestTimeChange(next, "keyboard");
  };

  private updateRaycaster(event: PointerEvent): void {
    if (!this.canvas) {
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    const width = bounds.width || this.width;
    const height = bounds.height || this.height;
    this.pointer.set(
      ((event.clientX - bounds.left) / width) * 2 - 1,
      -((event.clientY - bounds.top) / height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private moveTimePlaneFromPointer(event: PointerEvent): void {
    if (!this.solution) {
      return;
    }
    this.updateRaycaster(event);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) {
      return;
    }
    const tMin = Number(this.solution.t[0]);
    const tMax = Number(this.solution.t[this.solution.t.length - 1]);
    const fraction = clamp(
      (this.dragPoint.x - WORLD_T_MIN) / (WORLD_T_MAX - WORLD_T_MIN),
      0,
      1
    );
    this.requestTimeChange(tMin + fraction * (tMax - tMin), "plane-drag");
  }

  private requestTimeChange(time: number, trigger: TimeInteractionTrigger): void {
    const next = this.solution ? clampGridTime(this.solution, time) : time;
    this.pendingInteraction = { time: next, trigger };
    // The application owns selected time and coalesces every dependent view in
    // its animation frame. Standalone renderers retain the same behavior using
    // one local frame, including a final pointermove immediately before release.
    if (this.options.onTimeChange) {
      this.options.onTimeChange(next, trigger);
      return;
    }
    if (this.interactionFrame) return;
    this.interactionFrame = window.requestAnimationFrame(() => {
      this.interactionFrame = 0;
      const pending = this.pendingInteraction;
      this.pendingInteraction = null;
      if (pending && !this.destroyed) this.setTime(pending.time);
    });
  }

  private rebuildSurface(): void {
    if (!this.solution) {
      return;
    }
    if (this.surfaceTopology === "stepped") {
      this.rebuildSteppedSurface();
      return;
    }
    const solution = this.solution;
    const sourceXCount = solution.x.length;
    const sampling = adaptiveSurfaceSampleCounts(
      Number(solution.t[solution.t.length - 1]),
      Number(solution.x[0]),
      Number(solution.x[solution.x.length - 1]),
      "smooth"
    );
    const xIndices = uniformSampleIndices(
      sourceXCount,
      Math.min(sourceXCount, sampling.xSamples)
    );
    const tIndices = uniformSampleIndices(
      solution.t.length,
      Math.min(solution.t.length, sampling.tSamples)
    );
    const xCount = xIndices.length;
    const tCount = tIndices.length;
    const vertexCount = xCount * tCount;
    const canReuse =
      this.surfaceMesh !== null &&
      this.surfaceMesh.userData.surfaceTopology === "smooth" &&
      this.surfaceMesh.userData.xCount === xCount &&
      this.surfaceMesh.userData.tCount === tCount;
    let geometry: THREE.BufferGeometry;
    let positions: Float32Array;
    let normals: Float32Array;
    if (canReuse && this.surfaceMesh) {
      geometry = this.surfaceMesh.geometry;
      positions = (geometry.getAttribute("position") as THREE.BufferAttribute)
        .array as Float32Array;
      normals = (geometry.getAttribute("normal") as THREE.BufferAttribute)
        .array as Float32Array;
    } else {
      this.disposeSurface();
      geometry = new THREE.BufferGeometry();
      positions = new Float32Array(vertexCount * 3);
      normals = new Float32Array(vertexCount * 3);
    }

    let offset = 0;
    for (const sourceTIndex of tIndices) {
      const worldT = this.worldT(Number(solution.t[sourceTIndex]));
      const rowOffset = sourceTIndex * sourceXCount;
      for (const sourceXIndex of xIndices) {
        positions[offset] = worldT;
        positions[offset + 1] = this.worldU(
          Number(solution.values[rowOffset + sourceXIndex])
        );
        positions[offset + 2] = this.worldX(Number(solution.x[sourceXIndex]));
        offset += 3;
      }
    }
    computeRegularSurfaceNormals(positions, normals, xCount, tCount);

    const cellCount = Math.max(0, (xCount - 1) * (tCount - 1));
    if (canReuse && this.surfaceMesh) {
      const positionAttribute = geometry.getAttribute("position") as THREE.BufferAttribute;
      const normalAttribute = geometry.getAttribute("normal") as THREE.BufferAttribute;
      positionAttribute.needsUpdate = true;
      normalAttribute.needsUpdate = true;
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, 0, 0),
        SURFACE_BOUNDING_RADIUS
      );
    } else {
      const indices = vertexCount <= 65_535
        ? new Uint16Array(cellCount * 6)
        : new Uint32Array(cellCount * 6);
      let indexOffset = 0;
      for (let tIndex = 0; tIndex < tCount - 1; tIndex += 1) {
        for (let xIndex = 0; xIndex < xCount - 1; xIndex += 1) {
          const a = tIndex * xCount + xIndex;
          const b = a + 1;
          const c = a + xCount;
          const d = c + 1;
          indices[indexOffset] = a;
          indices[indexOffset + 1] = b;
          indices[indexOffset + 2] = c;
          indices[indexOffset + 3] = b;
          indices[indexOffset + 4] = d;
          indices[indexOffset + 5] = c;
          indexOffset += 6;
        }
      }
      const positionAttribute = new THREE.BufferAttribute(positions, 3);
      positionAttribute.setUsage(THREE.DynamicDrawUsage);
      const normalAttribute = new THREE.BufferAttribute(normals, 3);
      normalAttribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", positionAttribute);
      geometry.setAttribute("normal", normalAttribute);
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, 0, 0),
        SURFACE_BOUNDING_RADIUS
      );
      const material = new THREE.MeshLambertMaterial({
        color: SURFACE_COLOR,
        opacity: SURFACE_OPACITY,
        transparent: SURFACE_TRANSPARENT,
        // Steep graph facets can project as back-facing from valid oblique
        // camera angles even while the camera remains above the x-t floor.
        // Render both faces so those facets do not disappear through culling.
        side: SURFACE_SIDE,
        depthWrite: true
      });
      material.forceSinglePass = true;
      this.surfaceMesh = new THREE.Mesh(geometry, material);
      this.surfaceMesh.name = "wave-solution-surface";
      this.surfaceMesh.renderOrder = 1;
      this.surfaceMesh.userData.xCount = xCount;
      this.surfaceMesh.userData.tCount = tCount;
      this.surfaceMesh.userData.surfaceTopology = "smooth";
      this.surfaceGroup.add(this.surfaceMesh);
    }
    this.setSteppedSurfaceDatasets(null);
    this.setMeshDatasets(xCount, tCount, vertexCount, cellCount * 2);
  }

  private rebuildSteppedSurface(): void {
    if (!this.solution) {
      return;
    }
    const solution = this.solution;
    const sourceXCount = solution.x.length;
    const sampling = adaptiveSurfaceSampleCounts(
      Number(solution.t[solution.t.length - 1]),
      Number(solution.x[0]),
      Number(solution.x[solution.x.length - 1]),
      "stepped"
    );
    const xIndices = uniformSampleIndices(
      sourceXCount,
      Math.min(sourceXCount, sampling.xSamples)
    );
    const tIndices = uniformSampleIndices(
      solution.t.length,
      Math.min(solution.t.length, sampling.tSamples)
    );
    const worldX = new Float64Array(xIndices.length);
    const worldT = new Float64Array(tIndices.length);
    const heights = new Float32Array(xIndices.length * tIndices.length);

    for (let index = 0; index < xIndices.length; index += 1) {
      worldX[index] = this.worldX(Number(solution.x[xIndices[index]!]));
    }
    for (let index = 0; index < tIndices.length; index += 1) {
      worldT[index] = this.worldT(Number(solution.t[tIndices[index]!]));
    }
    let heightOffset = 0;
    for (const sourceTIndex of tIndices) {
      const rowOffset = sourceTIndex * sourceXCount;
      for (const sourceXIndex of xIndices) {
        heights[heightOffset] = this.worldU(
          Number(solution.values[rowOffset + sourceXIndex])
        );
        heightOffset += 1;
      }
    }

    const buffers = buildSteppedSurfaceBuffers({
      x: worldX,
      t: worldT,
      heights,
      jumpThreshold: STEPPED_SURFACE_JUMP_THRESHOLD
    });
    this.disposeSurface();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(buffers.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
    const topIndexCount = buffers.metadata.topFaceCount * 6;
    geometry.addGroup(0, topIndexCount, 0);
    geometry.addGroup(
      topIndexCount,
      buffers.metadata.indexCount - topIndexCount,
      1
    );
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, 0),
      SURFACE_BOUNDING_RADIUS
    );

    const topMaterial = new THREE.MeshLambertMaterial({
      color: SURFACE_COLOR,
      opacity: SURFACE_OPACITY,
      transparent: SURFACE_TRANSPARENT,
      side: SURFACE_SIDE,
      depthWrite: true
    });
    topMaterial.forceSinglePass = true;
    const wallMaterial = new THREE.MeshBasicMaterial({
      color: SURFACE_COLOR,
      opacity: SURFACE_OPACITY,
      transparent: SURFACE_TRANSPARENT,
      side: SURFACE_SIDE,
      depthWrite: true
    });
    wallMaterial.forceSinglePass = true;
    this.surfaceMesh = new THREE.Mesh(geometry, [topMaterial, wallMaterial]);
    this.surfaceMesh.name = "wave-solution-surface";
    this.surfaceMesh.renderOrder = 1;
    this.surfaceMesh.userData.xCount = xIndices.length;
    this.surfaceMesh.userData.tCount = tIndices.length;
    this.surfaceMesh.userData.surfaceTopology = "stepped";
    this.surfaceMesh.userData.steppedMetadata = { ...buffers.metadata };
    this.surfaceGroup.add(this.surfaceMesh);
    this.setSteppedSurfaceDatasets(buffers.metadata);
    this.setMeshDatasets(
      xIndices.length,
      tIndices.length,
      buffers.metadata.vertexCount,
      buffers.metadata.triangleCount
    );
  }

  private rebuildPhysicalBoundaryTraces(): void {
    const visiblePositions = this.visiblePhysicalBoundaryPositions();
    const retainedTraces = this.physicalBoundaryTraceGroup.children as Line2[];

    while (retainedTraces.length > visiblePositions.length) {
      const trace = retainedTraces[retainedTraces.length - 1];
      if (!trace) {
        break;
      }
      this.physicalBoundaryTraceGroup.remove(trace);
      this.disposeObject(trace);
    }

    if (!this.solution) {
      this.setPhysicalBoundaryTraceDatasets([]);
      return;
    }

    for (const [index, x] of visiblePositions.entries()) {
      let trace = this.physicalBoundaryTraceGroup.children[index] as Line2 | undefined;
      if (!trace) {
        const geometry = new LineGeometry();
        const material = new LineMaterial({
          color: PHYSICAL_BOUNDARY_TRACE_COLOR,
          linewidth: PHYSICAL_BOUNDARY_TRACE_WIDTH,
          worldUnits: true,
          transparent: true,
          opacity: 0.94,
          depthTest: false,
          depthWrite: false
        });
        trace = new Line2(geometry, material);
        trace.name = `physical-boundary-surface-trace-${index}`;
        trace.renderOrder = 6;
        trace.frustumCulled = false;
        this.physicalBoundaryTraceGroup.add(trace);
      }

      const points: number[] = [];
      for (const time of this.solution.t) {
        points.push(
          this.worldT(Number(time)),
          this.worldU(sampleSolutionGrid(this.solution, x, Number(time))),
          this.worldX(x)
        );
      }
      // Accepted grids have many time samples. A duplicated endpoint keeps the
      // retained geometry valid for a degenerate one-row test grid.
      trace.geometry.setPositions(
        points.length >= 6 ? points : [...points, ...points]
      );
      trace.computeLineDistances();
      trace.userData.physicalBoundaryPosition = x;
      trace.userData.traceSpace = "solution-surface";
      trace.userData.coordinateMapping = {
        t: "world-x",
        u: "world-y",
        x: "world-z"
      };
    }
    this.setPhysicalBoundaryTraceDatasets(visiblePositions);
  }

  private visiblePhysicalBoundaryPositions(): number[] {
    if (!this.solution) {
      return [];
    }
    const xMinimum = Number(this.solution.x[0]);
    const xMaximum = Number(this.solution.x[this.solution.x.length - 1]);
    const tolerance = Math.max(1, Math.abs(xMinimum), Math.abs(xMaximum)) * 1e-10;
    return this.physicalBoundaryPositions
      .filter((x) => x >= xMinimum - tolerance && x <= xMaximum + tolerance)
      .map((x) => clamp(x, xMinimum, xMaximum));
  }

  private paintTimeSlice(): void {
    if (!this.solution) {
      return;
    }
    const profile = this.profileSampler?.grid === this.solution
      ? this.profileSampler.sample(this.time)
      : { x: this.solution.x, values: sampleSlice(this.solution, this.time) };
    const expectedLength = profile.x.length * 3;
    const currentAttribute = this.sliceLine.geometry.getAttribute("position");
    let positions: Float32Array;
    if (
      currentAttribute instanceof THREE.BufferAttribute &&
      currentAttribute.array instanceof Float32Array &&
      currentAttribute.array.length >= expectedLength
    ) {
      positions = currentAttribute.array;
    } else {
      positions = new Float32Array(expectedLength);
    }
    const worldT = this.worldT(this.time);
    for (let index = 0; index < profile.x.length; index += 1) {
      const offset = index * 3;
      positions[offset] = worldT;
      positions[offset + 1] = this.worldU(Number(profile.values[index]));
      positions[offset + 2] = this.worldX(Number(profile.x[index]));
    }
    if (positions === currentAttribute?.array) {
      currentAttribute.needsUpdate = true;
      this.sliceLine.geometry.computeBoundingSphere();
    } else {
      this.sliceLine.geometry.dispose();
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.computeBoundingSphere();
      this.sliceLine.geometry = geometry;
    }
    this.sliceLine.geometry.setDrawRange(0, profile.x.length);
  }

  private positionTimePlane(): void {
    const x = this.solution ? this.worldT(this.time) : WORLD_T_MIN;
    this.timePlane.position.x = x;
    this.timePlaneOutline.position.x = x;
    this.container.dataset.currentTime = String(this.time);
    if (this.canvas) {
      this.canvas.dataset.currentTime = String(this.time);
      this.canvas.setAttribute("aria-valuetext", `time ${this.time.toFixed(3)}`);
    }
  }

  private paintCharacteristics(): void {
    this.clearGroup(this.characteristicFloorGroup);
    this.clearGroup(this.characteristicPointGroup);
    if (!this.solution || !this.characteristics) {
      this.setCharacteristicDatasets(0, 0, 0, 0);
      return;
    }

    this.addCharacteristicBranch(
      this.characteristics.left.points,
      "left",
      ETA_CHARACTERISTIC_COLOR
    );
    this.addCharacteristicBranch(
      this.characteristics.right.points,
      "right",
      XI_CHARACTERISTIC_COLOR
    );

    const floorY = this.worldU(0);
    for (const hit of this.characteristics.hits) {
      const color = this.characteristicColor(hit.path);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 12, 8),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 1,
          depthTest: false,
          depthWrite: false
        })
      );
      marker.name = `characteristic-${hit.path}-${hit.side}-boundary-hit`;
      marker.userData.characteristicFamily = this.characteristicFamily(hit.path);
      marker.position.set(this.worldT(hit.t), floorY, this.worldX(hit.x));
      marker.renderOrder = 9;
      this.characteristicFloorGroup.add(marker);
      const boundary = hit.side === "left" ? String.raw`x=a` : String.raw`x=b`;
      const label = this.makeLatexLabel(
        String.raw`${boundary},\quad${this.characteristicCoordinateLatex(hit.path)}`,
        color,
        0.82,
        "boundary-label"
      );
      label.name = `${marker.name}-label`;
      label.position.set(marker.position.x, marker.position.y + 0.28, marker.position.z);
      this.characteristicFloorGroup.add(label);
    }
    const visibleFootpoints = this.characteristics.footpoints.filter(
      (footpoint, index, all) =>
        all.findIndex((candidate) => Math.abs(candidate.x - footpoint.x) < 1e-10) === index
    );
    for (const footpoint of visibleFootpoints) {
      const color = this.characteristicColor(footpoint.path);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.105, 12, 8),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 1,
          depthTest: false,
          depthWrite: false
        })
      );
      marker.name = `characteristic-${footpoint.path}-initial-footpoint`;
      marker.userData.characteristicFamily = this.characteristicFamily(footpoint.path);
      marker.position.set(this.worldT(0), floorY, this.worldX(footpoint.x));
      marker.renderOrder = 9;
      this.characteristicFloorGroup.add(marker);
      const label = this.makeLatexLabel(
        this.characteristicCoordinateLatex(footpoint.path),
        color,
        0.82,
        "footpoint-label"
      );
      label.name = `${marker.name}-label`;
      label.position.set(marker.position.x, marker.position.y + 0.3, marker.position.z);
      this.characteristicFloorGroup.add(label);
    }

    const selected = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 16, 10),
      new THREE.MeshBasicMaterial({
        color: 0xffdf82,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false
      })
    );
    selected.name = "characteristic-selected-point";
    selected.position.set(
      this.worldT(this.characteristics.point.t),
      floorY,
      this.worldX(this.characteristics.point.x)
    );
    selected.renderOrder = 10;
    this.characteristicPointGroup.add(selected);
    const pathCount = Number(this.characteristics.left.points.length >= 2) +
      Number(this.characteristics.right.points.length >= 2);
    this.setCharacteristicDatasets(
      pathCount,
      0,
      this.characteristics.hits.length,
      this.characteristics.footpoints.length
    );
  }

  private setCharacteristicDatasets(
    floorPaths: number,
    surfacePaths: number,
    hits: number,
    footpoints: number
  ): void {
    const targets: HTMLElement[] = this.canvas ? [this.container, this.canvas] : [this.container];
    for (const target of targets) {
      target.dataset.characteristicFloorPaths = String(floorPaths);
      target.dataset.characteristicSurfacePaths = String(surfacePaths);
      target.dataset.characteristicHits = String(hits);
      target.dataset.characteristicFootpoints = String(footpoints);
      target.dataset.characteristicMarkerLayer = floorPaths > 0 ? "overlay" : "hidden";
    }
  }

  private setCharacteristicFrameDatasets(
    frame: "idle" | "prepared" | "webgl-rendered" | "rendered",
    webgl: "idle" | "prepared" | "rendered",
    labels: "idle" | "prepared" | "rendered"
  ): void {
    const targets: HTMLElement[] = this.canvas ? [this.container, this.canvas] : [this.container];
    for (const target of targets) {
      target.dataset.characteristicsFrame = frame;
      target.dataset.characteristicsWebglFrame = webgl;
      target.dataset.characteristicsLabelFrame = labels;
    }
  }

  private setMeshDatasets(
    xSamples: number,
    tSamples: number,
    vertices: number,
    triangles: number
  ): void {
    const targets: HTMLElement[] = this.canvas ? [this.container, this.canvas] : [this.container];
    for (const target of targets) {
      target.dataset.meshXSamples = String(xSamples);
      target.dataset.meshTSamples = String(tSamples);
      target.dataset.meshVertices = String(vertices);
      target.dataset.meshTriangles = String(triangles);
    }
  }

  private setPhysicalBoundaryTraceDatasets(visiblePositions: readonly number[]): void {
    const targets: HTMLElement[] = this.canvas ? [this.container, this.canvas] : [this.container];
    for (const target of targets) {
      target.dataset.physicalBoundaryPositions = JSON.stringify(
        this.physicalBoundaryPositions
      );
      target.dataset.physicalBoundaryTracePositions = JSON.stringify(visiblePositions);
      target.dataset.physicalBoundaryTraceCount = String(visiblePositions.length);
      target.dataset.physicalBoundaryTraceSurface = "true";
      target.dataset.physicalBoundaryTraceColor = "#ffffff";
      target.dataset.physicalBoundaryTraceWidth = String(PHYSICAL_BOUNDARY_TRACE_WIDTH);
    }
  }

  private setSurfacePresentationDatasets(): void {
    const targets: HTMLElement[] = this.canvas ? [this.container, this.canvas] : [this.container];
    for (const target of targets) {
      target.dataset.surfaceOpacity = String(SURFACE_OPACITY);
      target.dataset.surfaceTransparency = String(SURFACE_TRANSPARENCY);
      target.dataset.surfaceTransparent = String(SURFACE_TRANSPARENT);
      target.dataset.surfaceSide = SURFACE_SIDE_DATASET;
      target.dataset.surfaceMaterial = SURFACE_MATERIAL_DATASET;
      target.dataset.surfaceLighting = SURFACE_LIGHTING_DATASET;
      target.dataset.surfaceUndersideFill = SURFACE_UNDERSIDE_FILL_DATASET;
      target.dataset.surfacePass = SURFACE_PASS_DATASET;
      target.dataset.webglAntialias = String(WEBGL_ANTIALIAS);
      target.dataset.webglResolutionScale = String(WEBGL_RESOLUTION_SCALE);
      target.dataset.surfaceTopology = this.surfaceTopology;
      target.dataset.surfaceWallMaterial =
        this.surfaceTopology === "stepped" ? "basic-unlit" : "none";
    }
  }

  private setSteppedSurfaceDatasets(
    metadata: ReturnType<typeof buildSteppedSurfaceBuffers>["metadata"] | null
  ): void {
    const targets: HTMLElement[] = this.canvas ? [this.container, this.canvas] : [this.container];
    for (const target of targets) {
      target.dataset.steppedSurfaceTopFaces = String(metadata?.topFaceCount ?? 0);
      target.dataset.steppedSurfaceWallFaces = String(metadata?.wallFaceCount ?? 0);
      target.dataset.steppedSurfaceXWalls = String(metadata?.xJumpWallCount ?? 0);
      target.dataset.steppedSurfaceTWalls = String(metadata?.tJumpWallCount ?? 0);
      target.dataset.steppedSurfaceJumpThreshold = String(
        STEPPED_SURFACE_JUMP_THRESHOLD
      );
    }
  }

  private setAxisNotationDatasets(): void {
    const targets: HTMLElement[] = this.canvas ? [this.container, this.canvas] : [this.container];
    for (const target of targets) {
      target.dataset.xAxisNotation = this.axisNotation.x;
      target.dataset.tAxisNotation = this.axisNotation.t;
      target.dataset.characteristicNotation = this.axisNotation.x;
    }
  }

  private addCharacteristicBranch(
    points: CharacteristicPoint[],
    path: "left" | "right",
    color: number
  ): void {
    if (points.length < 2) {
      return;
    }
    const floorY = this.worldU(0);
    const floorPoints = points.map(
      (point) => new THREE.Vector3(this.worldT(point.t), floorY, this.worldX(point.x))
    );
    const floorLine = this.createFloorTraceLine(floorPoints, color, 0.84);
    floorLine.name = `characteristic-floor-${path}`;
    floorLine.userData.className = "characteristic-floor-path";
    floorLine.userData.characteristicFamily = this.characteristicFamily(path);
    this.characteristicFloorGroup.add(floorLine);
  }

  private characteristicColor(path: "left" | "right"): number {
    return path === "left" ? ETA_CHARACTERISTIC_COLOR : XI_CHARACTERISTIC_COLOR;
  }

  private characteristicFamily(path: "left" | "right"): "eta" | "xi" {
    return path === "left" ? "eta" : "xi";
  }

  private characteristicCoordinateLatex(path: "left" | "right"): string {
    const point = this.characteristics?.point;
    if (!point) {
      return path === "left" ? String.raw`\eta` : String.raw`\xi`;
    }
    if (path === "left") {
      return String.raw`\eta=${axisValueToLatex(
        point.x - point.t,
        this.axisNotation.x
      )}`;
    }
    return String.raw`\xi=${axisValueToLatex(
      point.x + point.t,
      this.axisNotation.x
    )}`;
  }

  private createFloorTraceLine(
    points: THREE.Vector3[],
    color: number,
    opacity: number
  ): THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial> {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color,
      opacity,
      transparent: opacity < 1,
      depthTest: false,
      dashSize: 0.22,
      gapSize: 0.13
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 8;
    return line;
  }

  private createAxisLines(): THREE.LineSegments {
    const positions = new Float32Array([
      // All three positive axes meet at the t_min, x_min floor corner. This
      // places the time axis on the left spatial edge in the default view.
      WORLD_T_MIN, 0, WORLD_X_MIN,
      T_AXIS_LINE_END, 0, WORLD_X_MIN,
      WORLD_T_MIN, 0, WORLD_X_MIN,
      WORLD_T_MIN, 0, X_AXIS_LINE_END,
      WORLD_T_MIN, WORLD_U_MIN - 0.1, WORLD_X_MIN,
      WORLD_T_MIN, U_AXIS_LINE_END, WORLD_X_MIN
    ]);
    const colors = new Float32Array([
      0.68, 0.92, 0.91, 0.68, 0.92, 0.91,
      0.68, 0.92, 0.91, 0.68, 0.92, 0.91,
      0.68, 0.92, 0.91, 0.68, 0.92, 0.91
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.78 });
    const axes = new THREE.LineSegments(geometry, material);
    axes.name = "x-t-u-axes";
    axes.userData.coordinateMapping = {
      t: "world-x",
      u: "world-y",
      x: "world-z"
    };
    axes.userData.timeAxisSpatialEdge = "x-min";
    return axes;
  }

  private createAxisArrow(
    name: "t-axis-arrow" | "x-axis-arrow" | "u-axis-arrow",
    direction: THREE.Vector3
  ): THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> {
    const geometry = new THREE.ConeGeometry(0.115, AXIS_ARROW_HEIGHT, 10, 1, false);
    const material = new THREE.MeshBasicMaterial({
      color: 0xaddbda,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    });
    const arrow = new THREE.Mesh(geometry, material);
    const normalizedDirection = direction.clone().normalize();
    arrow.name = name;
    arrow.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      normalizedDirection
    );
    arrow.renderOrder = 9;
    arrow.userData.axis = name.slice(0, 1);
    arrow.userData.positiveDirection = normalizedDirection.toArray();
    return arrow;
  }

  private rebuildFloorGrid(): void {
    const xMin = this.solution ? Number(this.solution.x[0]) : -1;
    const xMax = this.solution ? Number(this.solution.x[this.solution.x.length - 1]) : 1;
    const tMin = this.solution ? Number(this.solution.t[0]) : 0;
    const tMax = this.solution ? Number(this.solution.t[this.solution.t.length - 1]) : 1;
    const xTicks = axisTicks(xMin, xMax, 6, this.axisNotation.x);
    const tTicks = axisTicks(tMin, tMax, 6, this.axisNotation.t);
    const positions: number[] = [];

    for (const time of tTicks) {
      const worldT = this.solution
        ? this.worldT(time)
        : WORLD_T_MIN + ((time - tMin) / (tMax - tMin)) * (WORLD_T_MAX - WORLD_T_MIN);
      positions.push(
        worldT, 0, WORLD_X_MIN,
        worldT, 0, WORLD_X_MAX
      );
    }
    for (const x of xTicks) {
      const worldX = this.solution
        ? this.worldX(x)
        : WORLD_X_MIN + ((x - xMin) / (xMax - xMin)) * (WORLD_X_MAX - WORLD_X_MIN);
      positions.push(
        WORLD_T_MIN, 0, worldX,
        WORLD_T_MAX, 0, worldX
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    this.floorGrid.geometry.dispose();
    this.floorGrid.geometry = geometry;
    this.floorGrid.userData.coordinateMapping = {
      t: "world-x",
      x: "world-z"
    };
    this.floorGrid.userData.ticks = {
      t: [...tTicks],
      x: [...xTicks]
    };
  }

  private rebuildAxisLabels(): void {
    this.clearGroup(this.axisLabelGroup);
    const floorY = this.solution ? this.worldU(0) : 0;
    const xMin = this.solution ? Number(this.solution.x[0]) : -1;
    const xMax = this.solution ? Number(this.solution.x[this.solution.x.length - 1]) : 1;
    const tMin = this.solution ? Number(this.solution.t[0]) : 0;
    const tMax = this.solution ? Number(this.solution.t[this.solution.t.length - 1]) : 1;
    const range = this.solution ? normalizedSurfaceRange(this.solution) : { min: -1, max: 1 };
    const xTicks = axisTicks(xMin, xMax, 6, this.axisNotation.x);
    const tTicks = axisTicks(tMin, tMax, 6, this.axisNotation.t);
    for (const [index, value] of xTicks.entries()) {
      const xLabel = this.makeLatexLabel(
        axisValueToLatex(value, this.axisNotation.x),
        0xb7dddd,
        0.72,
        "x-axis-tick"
      );
      xLabel.name = `x-axis-tick-${index}`;
      xLabel.userData.value = value;
      xLabel.position.set(
        WORLD_T_MIN - 0.16,
        floorY - FLOOR_AXIS_TICK_VERTICAL_OFFSET,
        this.solution
          ? this.worldX(value)
          : WORLD_X_MIN + ((value - xMin) / (xMax - xMin)) * (WORLD_X_MAX - WORLD_X_MIN)
      );
      this.axisLabelGroup.add(xLabel);
    }
    for (const [index, value] of tTicks.entries()) {
      // The t and u axes share the floor origin. Keep the t=0 grid line and
      // coordinate, but let the u=0 numeral own that point without a duplicate.
      if (value === 0) {
        continue;
      }
      const tLabel = this.makeLatexLabel(
        axisValueToLatex(value, this.axisNotation.t),
        0xb7dddd,
        0.72,
        "t-axis-tick"
      );
      tLabel.name = `t-axis-tick-${index}`;
      tLabel.userData.value = value;
      // Right-edge anchoring keeps the full value to the left of its axis,
      // while the vertical midpoint and world offset match the x tick labels.
      tLabel.center.set(1, 0.5);
      tLabel.position.set(
        this.solution
          ? this.worldT(value)
          : WORLD_T_MIN + ((value - tMin) / (tMax - tMin)) * (WORLD_T_MAX - WORLD_T_MIN),
        floorY - FLOOR_AXIS_TICK_VERTICAL_OFFSET,
        WORLD_X_MIN - T_AXIS_TICK_SPATIAL_OFFSET
      );
      this.axisLabelGroup.add(tLabel);
    }
    for (let index = 0; index < 5; index += 1) {
      const fraction = index / 4;
      const value = range.min + fraction * (range.max - range.min);
      const uLabel = this.makeLatexLabel(
        axisValueToLatex(value),
        0xb7dddd,
        0.72,
        "u-axis-tick"
      );
      uLabel.name = `u-axis-tick-${index}`;
      uLabel.userData.value = value;
      uLabel.center.set(1, 0.5);
      uLabel.position.set(
        WORLD_T_MIN - U_AXIS_TICK_TIME_OFFSET,
        WORLD_U_MIN + fraction * 5,
        WORLD_X_MIN
      );
      this.axisLabelGroup.add(uLabel);
    }
    const xAxisLabel = this.makeLatexLabel("x", 0xe8ffff, 1.12, "axis-name");
    xAxisLabel.name = "x-axis-label";
    xAxisLabel.position.set(WORLD_T_MIN, floorY + 0.4, X_AXIS_LINE_END + 0.7);
    const tAxisLabel = this.makeLatexLabel("t", 0xe8ffff, 1.12, "axis-name");
    tAxisLabel.name = "t-axis-label";
    tAxisLabel.position.set(T_AXIS_LINE_END + 0.6, floorY + 0.25, WORLD_X_MIN);
    const uAxisLabel = this.makeLatexLabel(String.raw`u(x,t)`, 0xe8ffff, 1.06, "axis-name");
    uAxisLabel.name = "u-axis-label";
    uAxisLabel.position.set(WORLD_T_MIN, U_AXIS_LINE_END + 0.55, WORLD_X_MIN);
    this.axisLabelGroup.add(xAxisLabel, tAxisLabel, uAxisLabel);
  }

  private makeLatexLabel(
    source: string,
    color: number,
    scale = 1,
    kind = "annotation"
  ): CSS2DObject {
    const element = document.createElement("span");
    element.className = `space-time-math-label space-time-math-label--${kind}`;
    element.dataset.plotLabel = kind;
    element.style.color = `#${color.toString(16).padStart(6, "0")}`;
    const scaledFontSize = Number((scale * MATH_LABEL_SCALE).toFixed(3));
    element.style.fontSize = `${scaledFontSize}rem`;
    element.style.lineHeight = "1";
    element.style.whiteSpace = "nowrap";
    element.style.opacity = "0.92";
    element.style.pointerEvents = "none";
    element.style.textShadow = "0 1px 3px #03090d, 0 0 8px rgba(3, 9, 13, 0.8)";
    renderLatex(element, source, { ariaHidden: true });
    const label = new CSS2DObject(element);
    label.userData.label = source;
    label.userData.latex = true;
    label.userData.kind = kind;
    return label;
  }

  private positionFloorAndAxes(): void {
    const floorY = this.solution ? this.worldU(0) : 0;
    const gridPositions = this.floorGrid.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let index = 0; index < gridPositions.count; index += 1) {
      gridPositions.setY(index, floorY);
    }
    gridPositions.needsUpdate = true;
    const positions = this.axisLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    positions.setY(0, floorY);
    positions.setY(1, floorY);
    positions.setY(2, floorY);
    positions.setY(3, floorY);
    positions.setY(4, WORLD_U_MIN - 0.1);
    positions.setY(5, U_AXIS_LINE_END);
    positions.needsUpdate = true;

    this.tAxisArrow.position.set(
      T_AXIS_LINE_END + AXIS_ARROW_HEIGHT / 2,
      floorY,
      WORLD_X_MIN
    );
    this.xAxisArrow.position.set(
      WORLD_T_MIN,
      floorY,
      X_AXIS_LINE_END + AXIS_ARROW_HEIGHT / 2
    );
    this.uAxisArrow.position.set(
      WORLD_T_MIN,
      U_AXIS_LINE_END + AXIS_ARROW_HEIGHT / 2,
      WORLD_X_MIN
    );
  }

  private worldX(x: number): number {
    if (!this.solution) {
      return 0;
    }
    const minimum = Number(this.solution.x[0]);
    const maximum = Number(this.solution.x[this.solution.x.length - 1]);
    return WORLD_X_MIN + ((x - minimum) / (maximum - minimum)) * (WORLD_X_MAX - WORLD_X_MIN);
  }

  private worldT(time: number): number {
    if (!this.solution) {
      return WORLD_T_MIN;
    }
    const minimum = Number(this.solution.t[0]);
    const maximum = Number(this.solution.t[this.solution.t.length - 1]);
    if (maximum <= minimum) {
      return WORLD_T_MIN;
    }
    return WORLD_T_MIN + ((time - minimum) / (maximum - minimum)) * (WORLD_T_MAX - WORLD_T_MIN);
  }

  private worldU(value: number): number {
    if (!this.solution) {
      return 0;
    }
    return (
      WORLD_U_MIN +
      ((value - this.surfaceRangeMinimum) /
        (this.surfaceRangeMaximum - this.surfaceRangeMinimum)) *
        (WORLD_U_MAX - WORLD_U_MIN)
    );
  }

  private disposeSurface(): void {
    if (this.surfaceMesh) {
      this.surfaceGroup.remove(this.surfaceMesh);
      this.surfaceMesh.geometry.dispose();
      const materials = Array.isArray(this.surfaceMesh.material)
        ? this.surfaceMesh.material
        : [this.surfaceMesh.material];
      for (const material of materials) {
        material.dispose();
      }
      this.surfaceMesh = null;
    }
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      this.disposeObject(child);
    }
  }

  private updateCameraDatasets(): void {
    const target = this.controls?.target ?? DEFAULT_CAMERA_TARGET;
    const isDefault = this.camera.position.distanceToSquared(this.defaultCameraPosition) < 1e-12 &&
      target.distanceToSquared(DEFAULT_CAMERA_TARGET) < 1e-12;
    const hemisphere = this.camera.position.y < target.y ? "below" : "above";
    for (const element of [this.container, this.canvas]) {
      if (!element) {
        continue;
      }
      element.dataset.cameraHemisphere = hemisphere;
      element.dataset.cameraDefault = String(isDefault);
    }
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      if (child instanceof CSS2DObject) {
        child.element.remove();
      }
      const renderable = child as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      renderable.geometry?.dispose();
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : renderable.material
          ? [renderable.material]
          : [];
      for (const material of materials) {
        const spriteMaterial = material as THREE.SpriteMaterial;
        spriteMaterial.map?.dispose();
        material.dispose();
      }
    });
  }

  private renderWebGL(): void {
    if (this.destroyed) {
      return;
    }
    this.updateCameraDatasets();
    this.camera.updateMatrixWorld(true);
    const grab = new THREE.Vector3(this.timePlane.position.x, 0, 0).project(this.camera);
    this.container.dataset.timePlaneGrabX = String((grab.x + 1) * this.width / 2);
    this.container.dataset.timePlaneGrabY = String((1 - grab.y) * this.height / 2);
    if (!this.renderer) {
      return;
    }
    this.renderer.render(this.scene, this.camera);
    this.container.dataset.webglFrames = String(++this.webglFrames);
  }

  private renderLabels(): void {
    if (this.destroyed) {
      return;
    }
    this.updateCameraDatasets();
    this.labelRenderer?.render(this.scene, this.camera);
  }

  private readonly render = (): void => {
    this.renderWebGL();
    this.renderLabels();
  };
}

function uniformSampleIndices(length: number, maximumCount: number): number[] {
  const count = Math.min(length, maximumCount);
  if (count <= 1) {
    return [0];
  }
  return Array.from({ length: count }, (_, index) =>
    Math.round((index * (length - 1)) / (count - 1))
  );
}


function normalizeBoundaryPositions(positions: readonly number[]): number[] {
  const sorted = positions
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const unique: number[] = [];
  for (const position of sorted) {
    const previous = unique[unique.length - 1];
    const tolerance = Math.max(1, Math.abs(position), Math.abs(previous ?? 0)) *
      Number.EPSILON * 32;
    if (previous === undefined || Math.abs(position - previous) > tolerance) {
      unique.push(position);
    }
  }
  return unique;
}

function computeRegularSurfaceNormals(
  positions: Float32Array,
  normals: Float32Array,
  xCount: number,
  tCount: number
): void {
  for (let tIndex = 0; tIndex < tCount; tIndex += 1) {
    const previousT = Math.max(0, tIndex - 1);
    const nextT = Math.min(tCount - 1, tIndex + 1);
    for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
      const previousX = Math.max(0, xIndex - 1);
      const nextX = Math.min(xCount - 1, xIndex + 1);
      const centerOffset = (tIndex * xCount + xIndex) * 3;
      const leftOffset = (tIndex * xCount + previousX) * 3;
      const rightOffset = (tIndex * xCount + nextX) * 3;
      const previousTOffset = (previousT * xCount + xIndex) * 3;
      const nextTOffset = (nextT * xCount + xIndex) * 3;

      const tangentXX = (positions[rightOffset] ?? 0) - (positions[leftOffset] ?? 0);
      const tangentXY = (positions[rightOffset + 1] ?? 0) - (positions[leftOffset + 1] ?? 0);
      const tangentXZ = (positions[rightOffset + 2] ?? 0) - (positions[leftOffset + 2] ?? 0);
      const tangentTX = (positions[nextTOffset] ?? 0) - (positions[previousTOffset] ?? 0);
      const tangentTY = (positions[nextTOffset + 1] ?? 0) - (positions[previousTOffset + 1] ?? 0);
      const tangentTZ = (positions[nextTOffset + 2] ?? 0) - (positions[previousTOffset + 2] ?? 0);

      let normalX = tangentXY * tangentTZ - tangentXZ * tangentTY;
      let normalY = tangentXZ * tangentTX - tangentXX * tangentTZ;
      let normalZ = tangentXX * tangentTY - tangentXY * tangentTX;
      const length = Math.hypot(normalX, normalY, normalZ);
      if (length > 1e-12) {
        normalX /= length;
        normalY /= length;
        normalZ /= length;
      } else {
        normalX = 0;
        normalY = 1;
        normalZ = 0;
      }
      normals[centerOffset] = normalX;
      normals[centerOffset + 1] = normalY;
      normals[centerOffset + 2] = normalZ;
    }
  }
}
