import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultWaveProblem, solveWaveProblem } from "../math";
import { SpaceTimeRenderer } from "../plot";
import type { CharacteristicTrace, WaveSolutionGrid } from "../types";
import { makeGrid } from "./plot_fixtures";

describe("SpaceTimeRenderer coordinate orientation", () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => null)
    });
  });

  afterEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: originalGetContext
    });
    document.body.replaceChildren();
  });

  it("maps time to world X, space to world Z, and displacement to world Y", () => {
    const host = sizedHost();
    const renderer = new SpaceTimeRenderer(host);
    renderer.setSolution(makeGrid());

    const axes = renderer.scene.getObjectByName("x-t-u-axes") as THREE.LineSegments;
    const axisPositions = axes.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(axes.userData.coordinateMapping).toEqual({
      t: "world-x",
      u: "world-y",
      x: "world-z"
    });
    expect(renderer.scene.getObjectByName("x-t-u-axes")).toBe(axes);
    expect(host.dataset.axisOrientation).toBe("t-horizontal-x-depth-u-vertical");
    expect(host.dataset.defaultView).toBe("low-oblique-u-left-t-left-edge");
    expect(host.dataset.timeAxisEdge).toBe("x-min");
    expect(host.dataset.axisArrows).toBe("3");
    expect([axisPositions.getX(0), axisPositions.getZ(0)]).toEqual([-5, -4]);
    expect(axisPositions.getX(1)).toBeCloseTo(5.55, 6);
    expect(axisPositions.getZ(1)).toBe(-4);
    expect([axisPositions.getX(2), axisPositions.getZ(2)]).toEqual([-5, -4]);
    expect(axisPositions.getX(3)).toBe(-5);
    expect(axisPositions.getZ(3)).toBeCloseTo(4.55, 6);

    const surface = renderer.scene.getObjectByName("wave-solution-surface") as THREE.Mesh;
    const surfacePositions = surface.geometry.getAttribute("position") as THREE.BufferAttribute;
    // One complete spatial row is held at the first time coordinate.
    expect([surfacePositions.getX(0), surfacePositions.getZ(0)]).toEqual([-5, -4]);
    expect([surfacePositions.getX(2), surfacePositions.getZ(2)]).toEqual([-5, 4]);
    // Advancing to the next time row moves along world X, not world Z.
    expect([surfacePositions.getX(3), surfacePositions.getZ(3)]).toEqual([5, -4]);

    renderer.setTime(0.25);
    const plane = renderer.scene.getObjectByName("draggable-time-plane") as THREE.Mesh;
    expect(plane.position.x).toBeCloseTo(-2.5, 8);
    expect(plane.rotation.y).toBeCloseTo(Math.PI / 2, 8);
    const slice = renderer.scene.getObjectByName("current-time-surface-slice") as THREE.Line;
    const slicePositions = slice.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(Array.from({ length: slicePositions.count }, (_, index) => slicePositions.getX(index)))
      .toEqual([-2.5, -2.5, -2.5]);
    expect([slicePositions.getZ(0), slicePositions.getZ(2)]).toEqual([-4, 4]);

    renderer.dispose();
  });

  it("uses the supplied low oblique side with u and the x-min time edge on the left", () => {
    const renderer = new SpaceTimeRenderer(sizedHost());
    renderer.setSolution(makeGrid());
    renderer.camera.updateMatrixWorld(true);

    const tLabel = renderer.scene.getObjectByName("t-axis-label") as CSS2DObject;
    const uLabel = renderer.scene.getObjectByName("u-axis-label") as CSS2DObject;
    const projectedT = tLabel.position.clone().project(renderer.camera);
    const projectedU = uLabel.position.clone().project(renderer.camera);
    const viewDirection = renderer.camera.position
      .clone()
      .sub(new THREE.Vector3(0, -0.7, 0))
      .normalize();

    expect(renderer.camera.position.toArray()).toEqual([-15, 5.3, 8]);
    expect(renderer.camera.position.x).toBeLessThan(0);
    expect(renderer.camera.position.z).toBeGreaterThan(0);
    expect(viewDirection.y).toBeLessThan(0.4);
    expect(projectedU.x).toBeLessThan(-0.5);
    expect(projectedT.x).toBeLessThan(0);
    expect(projectedU.x).toBeLessThan(projectedT.x);
    expect(
      (renderer.scene.getObjectByName("x-t-u-axes") as THREE.LineSegments)
        .userData.timeAxisSpatialEdge
    ).toBe("x-min");

    renderer.camera.position.set(2, 12, -3);
    renderer.resetCamera();
    expect(renderer.camera.position.x).toBeCloseTo(-15, 12);
    expect(renderer.camera.position.y).toBeCloseTo(5.3, 12);
    expect(renderer.camera.position.z).toBeCloseTo(8, 12);
    renderer.camera.updateMatrixWorld(true);
    expect(tLabel.position.clone().project(renderer.camera).x).toBeLessThan(0);

    renderer.dispose();
  });

  it("fits compact reset views with room for complete mathematical labels", () => {
    const host = sizedHost();
    const renderer = new SpaceTimeRenderer(host);
    renderer.setSolution(makeGrid());
    renderer.resize(320, 360);
    renderer.camera.updateMatrixWorld(true);
    const labels = renderer.scene.getObjectByName("axis-labels") as THREE.Group;
    for (const label of labels.children as CSS2DObject[]) {
      const projected = label.position.clone().project(renderer.camera);
      const x = (projected.x + 1) * 160;
      const y = (1 - projected.y) * 180;
      const fontPixels = parseFloat(label.element.style.fontSize) * 16;
      expect(x).toBeGreaterThan(12);
      expect(x).toBeLessThan(308);
      expect(y - fontPixels * 0.75).toBeGreaterThan(10);
      expect(y + fontPixels * 0.75).toBeLessThan(350);
    }
    const fitted = renderer.camera.position.clone();
    renderer.camera.position.set(2, 12, -3);
    renderer.resetCamera();
    expect(renderer.camera.position.distanceTo(fitted)).toBeLessThan(1e-8);
    expect(host.dataset.cameraDefault).toBe("true");
    renderer.resize(1120, 650);
    expect(renderer.camera.position.toArray()).toEqual([-15, 5.3, 8]);
    renderer.dispose();
  });

  it("orbits through the lower hemisphere while reset restores the reference view", () => {
    const host = sizedHost();
    const canvas = document.createElement("canvas");
    const backend = makeRendererBackend(canvas);
    const renderer = new SpaceTimeRenderer(host, {
      rendererFactory: () => backend
    });
    const controls = (renderer as unknown as {
      controls: {
        target: THREE.Vector3;
        minPolarAngle: number;
        maxPolarAngle: number;
        getPolarAngle: () => number;
        update: () => boolean;
      };
    }).controls;

    expect(host.dataset.lowerHemisphereOrbit).toBe("enabled");
    expect(canvas.dataset.lowerHemisphereOrbit).toBe("enabled");
    expect(host.dataset.cameraHemisphere).toBe("above");
    expect(canvas.dataset.cameraHemisphere).toBe("above");
    expect(host.dataset.cameraDefault).toBe("true");
    expect(canvas.dataset.cameraDefault).toBe("true");
    expect(Number(host.dataset.orbitMinPolarAngle)).toBeCloseTo(0.16, 12);
    expect(Number(host.dataset.orbitMaxPolarAngle)).toBeCloseTo(Math.PI - 0.16, 12);
    expect(canvas.dataset.orbitMinPolarAngle).toBe(host.dataset.orbitMinPolarAngle);
    expect(canvas.dataset.orbitMaxPolarAngle).toBe(host.dataset.orbitMaxPolarAngle);
    expect(controls.minPolarAngle).toBeCloseTo(0.16, 12);
    expect(controls.maxPolarAngle).toBeGreaterThan(Math.PI / 2);
    expect(controls.maxPolarAngle).toBeCloseTo(Math.PI - controls.minPolarAngle, 12);

    // A camera below the orbit target is a lower-hemisphere view. Updating the
    // real OrbitControls must retain it rather than clamping back above u=0.
    renderer.camera.position.copy(
      controls.target.clone().add(new THREE.Vector3(-5, -8, 7))
    );
    renderer.camera.lookAt(controls.target);
    controls.update();
    expect(renderer.camera.position.y).toBeLessThan(controls.target.y);
    expect(controls.getPolarAngle()).toBeGreaterThan(Math.PI / 2);
    expect(host.dataset.cameraHemisphere).toBe("below");
    expect(canvas.dataset.cameraHemisphere).toBe("below");
    expect(host.dataset.cameraDefault).toBe("false");
    expect(canvas.dataset.cameraDefault).toBe("false");
    const directionToTarget = controls.target.clone()
      .sub(renderer.camera.position)
      .normalize();
    expect(renderer.camera.getWorldDirection(new THREE.Vector3()).dot(directionToTarget))
      .toBeGreaterThan(0.999999);

    renderer.resetCamera();
    expect(renderer.camera.position.x).toBeCloseTo(-15, 12);
    expect(renderer.camera.position.y).toBeCloseTo(5.3, 12);
    expect(renderer.camera.position.z).toBeCloseTo(8, 12);
    expect(controls.target.toArray()).toEqual([0, -0.7, 0]);
    expect(controls.getPolarAngle()).toBeLessThan(Math.PI / 2);
    expect(host.dataset.cameraHemisphere).toBe("above");
    expect(canvas.dataset.cameraHemisphere).toBe("above");
    expect(host.dataset.cameraDefault).toBe("true");
    expect(canvas.dataset.cameraDefault).toBe("true");

    renderer.dispose();
  });

  it("aligns the floor-axis tick height while keeping u and t clear to the left", () => {
    const host = sizedHost();
    const renderer = new SpaceTimeRenderer(host);
    renderer.setSolution(makeGrid());
    renderer.camera.updateMatrixWorld(true);

    const axes = renderer.scene.getObjectByName("x-t-u-axes") as THREE.LineSegments;
    const axisPositions = axes.geometry.getAttribute("position") as THREE.BufferAttribute;
    const tAxisY = axisPositions.getY(0);
    const tAxisZ = axisPositions.getZ(0);
    const uAxisX = axisPositions.getX(4);
    const uAxisZ = axisPositions.getZ(4);
    const labels = renderer.scene.getObjectByName("axis-labels") as THREE.Group;
    const xLabels = labels.children.filter(
      (child): child is CSS2DObject => child.name.startsWith("x-axis-tick-")
    );
    const tLabels = labels.children.filter(
      (child): child is CSS2DObject => child.name.startsWith("t-axis-tick-")
    );
    const uLabels = labels.children.filter(
      (child): child is CSS2DObject => child.name.startsWith("u-axis-tick-")
    );

    expect(tLabels.map((label) => label.userData.value)).not.toContain(0);

    const tClearances = tLabels.map((label) => {
      expect(label.center.toArray()).toEqual([1, 0.5]);
      expect(label.position.y).toBeCloseTo(tAxisY - 0.24, 8);
      expect(label.position.z).toBeCloseTo(tAxisZ - 0.4, 8);
      return projectedHorizontalClearance(
        label.position,
        new THREE.Vector3(label.position.x, tAxisY, tAxisZ),
        renderer.camera,
        host.clientWidth
      );
    });
    expect(xLabels.length).toBeGreaterThan(0);
    for (const label of xLabels) {
      expect(label.center.y).toBe(0.5);
      expect(label.position.y).toBeCloseTo(tAxisY - 0.24, 8);
    }
    expect(new Set([...xLabels, ...tLabels].map((label) => label.position.y)).size).toBe(1);
    const uClearances = uLabels.map((label) => {
      expect(label.center.toArray()).toEqual([1, 0.5]);
      expect(label.position.x).toBeCloseTo(uAxisX - 0.4, 8);
      return projectedHorizontalClearance(
        label.position,
        new THREE.Vector3(uAxisX, label.position.y, uAxisZ),
        renderer.camera,
        host.clientWidth
      );
    });

    // The former default anchors cleared the axes by only about 3 px for t and
    // 10 px for u at this viewport. The deliberate offsets now provide at
    // least 11 px and 15 px respectively before right-edge label anchoring.
    expect(Math.min(...tClearances)).toBeGreaterThan(11);
    expect(Math.min(...uClearances)).toBeGreaterThan(15);
    expect(tClearances.every((clearance) => clearance > 0)).toBe(true);
    expect(uClearances.every((clearance) => clearance > 0)).toBe(true);

    renderer.dispose();
  });

  it("retains positive-direction arrowheads on all three axes", () => {
    const renderer = new SpaceTimeRenderer(sizedHost());
    renderer.setSolution(makeGrid());

    const expectedDirections = new Map<string, THREE.Vector3>([
      ["t-axis-arrow", new THREE.Vector3(1, 0, 0)],
      ["x-axis-arrow", new THREE.Vector3(0, 0, 1)],
      ["u-axis-arrow", new THREE.Vector3(0, 1, 0)]
    ]);
    for (const [name, expectedDirection] of expectedDirections) {
      const arrow = renderer.scene.getObjectByName(name) as THREE.Mesh<
        THREE.ConeGeometry,
        THREE.MeshBasicMaterial
      >;
      expect(arrow).toBeInstanceOf(THREE.Mesh);
      expect(arrow.geometry).toBeInstanceOf(THREE.ConeGeometry);
      expect(arrow.userData.positiveDirection).toEqual(expectedDirection.toArray());
      expect(
        new THREE.Vector3(0, 1, 0)
          .applyQuaternion(arrow.quaternion)
          .distanceTo(expectedDirection)
      ).toBeLessThan(1e-10);
    }

    const tArrow = renderer.scene.getObjectByName("t-axis-arrow") as THREE.Mesh;
    const xArrow = renderer.scene.getObjectByName("x-axis-arrow") as THREE.Mesh;
    const uArrow = renderer.scene.getObjectByName("u-axis-arrow") as THREE.Mesh;
    expect(tArrow.position.x).toBeGreaterThan(5.55);
    expect(tArrow.position.z).toBe(-4);
    expect(xArrow.position.x).toBe(-5);
    expect(xArrow.position.z).toBeGreaterThan(4.55);
    expect(uArrow.position.y).toBeGreaterThan(2.82);
    expect([tArrow.position.y, xArrow.position.y]).toEqual([0, 0]);

    renderer.setSolution(makePiGrid());
    expect([tArrow.position.y, xArrow.position.y]).toEqual([-2.5, -2.5]);
    expect(renderer.scene.getObjectByName("t-axis-arrow")).toBe(tArrow);
    expect(renderer.scene.getObjectByName("x-axis-arrow")).toBe(xArrow);
    expect(renderer.scene.getObjectByName("u-axis-arrow")).toBe(uArrow);

    renderer.dispose();
  });

  it("renders locally back-facing facets of the default Gaussian from the default camera", () => {
    const renderer = new SpaceTimeRenderer(sizedHost());
    renderer.setSolution(solveWaveProblem(getDefaultWaveProblem()));
    renderer.camera.updateMatrixWorld(true);

    const surface = renderer.scene.getObjectByName("wave-solution-surface") as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshLambertMaterial
    >;
    const facing = countTriangleFacing(surface, renderer.camera);

    // The steep moving Gaussian folds over itself in this projection even
    // though it remains a single-valued graph. FrontSide would therefore
    // discard valid facets and create the visible triangular holes.
    expect(facing.front).toBeGreaterThan(0);
    expect(facing.back).toBeGreaterThan(0);
    expect(facing.front + facing.back + facing.edgeOn).toBe(81_920);
    expect(surface.material.side).toBe(THREE.DoubleSide);

    renderer.dispose();
  });

  it("builds finite-domain labels and floor lines from one pleasant aligned grid", () => {
    const renderer = new SpaceTimeRenderer(sizedHost());
    renderer.setSolution(makePiGrid());

    const labels = renderer.scene.getObjectByName("axis-labels") as THREE.Group;
    const xLabels = labels.children.filter((child) => child.name.startsWith("x-axis-tick-"));
    const tLabels = labels.children.filter((child) => child.name.startsWith("t-axis-tick-"));
    expect(xLabels.map((label) => label.userData.value)).toEqual([0, 1, 2, 3]);
    expect(tLabels.map((label) => label.userData.value)).toEqual([
      2.5, 5, 7.5, 10, 12.5
    ]);
    expect(
      xLabels.map((label) => (label as CSS2DObject).element.dataset.latexSource)
    ).toEqual(["0", "1", "2", "3"]);
    expect(
      tLabels.map((label) => (label as CSS2DObject).element.dataset.latexSource)
    ).toEqual(["2.5", "5", "7.5", "10", "12.5"]);

    const floorGrid = renderer.scene.getObjectByName("x-t-grid") as THREE.LineSegments;
    expect(floorGrid.userData.ticks).toEqual({
      x: [0, 1, 2, 3],
      t: [0, 2.5, 5, 7.5, 10, 12.5]
    });
    const positions = floorGrid.geometry.getAttribute("position") as THREE.BufferAttribute;
    const retainedTTicks = floorGrid.userData.ticks.t as number[];
    expect(retainedTTicks).toContain(0);
    expect(positions.count).toBe(2 * (xLabels.length + retainedTTicks.length));
    for (const label of tLabels) {
      const gridIndex = retainedTTicks.indexOf(label.userData.value as number);
      expect(gridIndex).toBeGreaterThan(0);
      expect(positions.getX(gridIndex * 2)).toBeCloseTo(label.position.x, 6);
      expect(positions.getX(gridIndex * 2 + 1)).toBeCloseTo(label.position.x, 6);
    }
    for (const [index, label] of xLabels.entries()) {
      const offset = 2 * (retainedTTicks.length + index);
      expect(positions.getZ(offset)).toBeCloseTo(label.position.z, 6);
      expect(positions.getZ(offset + 1)).toBeCloseTo(label.position.z, 6);
    }
    expect(equalSpacing(tLabels.map((label) => label.position.x))).toBe(true);
    expect(equalSpacing(xLabels.map((label) => label.position.z))).toBe(true);

    renderer.dispose();
  });

  it("renders all 3D ticks, axis names, and trace annotations as retained KaTeX labels", () => {
    const renderer = new SpaceTimeRenderer(sizedHost());
    renderer.setSolution(makeGrid());

    const labels = renderer.scene.getObjectByName("axis-labels") as THREE.Group;
    expect(labels.children).toHaveLength(18);
    expect(labels.children.every((child) => child instanceof CSS2DObject)).toBe(true);
    for (const child of labels.children as CSS2DObject[]) {
      expect(child.element.dataset.latexSource).toBeTruthy();
      expect(child.element.querySelector(".katex")).toBeTruthy();
    }
    const tName = renderer.scene.getObjectByName("t-axis-label") as CSS2DObject;
    const xName = renderer.scene.getObjectByName("x-axis-label") as CSS2DObject;
    const uName = renderer.scene.getObjectByName("u-axis-label") as CSS2DObject;
    expect(tName.element.dataset.latexSource).toBe("t");
    expect(xName.element.dataset.latexSource).toBe("x");
    expect(uName.element.dataset.latexSource).toBe("u(x,t)");
    expect(tName.element.style.fontSize).toBe("1.68rem");
    expect(
      (renderer.scene.getObjectByName("t-axis-tick-1") as CSS2DObject).element.style.fontSize
    ).toBe("1.08rem");

    renderer.setCharacteristics(makeTrace());
    const boundaryLabel = renderer.scene.getObjectByName(
      "characteristic-left-left-boundary-hit-label"
    ) as CSS2DObject;
    const footpointLabel = renderer.scene.getObjectByName(
      "characteristic-left-initial-footpoint-label"
    ) as CSS2DObject;
    expect(boundaryLabel).toBeInstanceOf(CSS2DObject);
    expect(boundaryLabel.element.dataset.latexSource).toBe(
      String.raw`x=a,\quad\eta=0.5`
    );
    expect(boundaryLabel.element.querySelector(".katex")).toBeTruthy();
    expect(boundaryLabel.element.style.fontSize).toBe("1.23rem");
    expect(footpointLabel).toBeInstanceOf(CSS2DObject);
    expect(footpointLabel.element.dataset.latexSource).toBe(
      String.raw`\eta=0.5`
    );
    expect(footpointLabel.element.querySelector(".katex")).toBeTruthy();
    const xiFootpointLabel = renderer.scene.getObjectByName(
      "characteristic-right-initial-footpoint-label"
    ) as CSS2DObject;
    expect(xiFootpointLabel.element.dataset.latexSource).toBe(
      String.raw`\xi=1.5`
    );
    for (const label of [boundaryLabel, footpointLabel, xiFootpointLabel]) {
      expect(label.element.dataset.latexSource).not.toMatch(/x[+-]t/);
    }

    renderer.dispose();
  });
});

function sizedHost(): HTMLDivElement {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 560 }
  });
  document.body.append(host);
  return host;
}

function makeRendererBackend(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  return {
    domElement: canvas,
    outputColorSpace: THREE.SRGBColorSpace,
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    setClearColor: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn()
  } as unknown as THREE.WebGLRenderer;
}

function makePiGrid(): WaveSolutionGrid {
  return {
    revision: 8,
    problemSignature: "pi-grid-fixture",
    x: new Float64Array([0, Math.PI / 2, Math.PI]),
    t: new Float64Array([0, 2 * Math.PI, 4 * Math.PI]),
    values: new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0
    ]),
    surfaceRange: { min: 0, max: 1 },
    warnings: [],
    timings: { totalMs: 1, integrationMs: 0.25, samplingMs: 0.75 },
    reflectionCount: 0
  };
}

function equalSpacing(values: number[]): boolean {
  if (values.length < 3) {
    return true;
  }
  const step = Number(values[1]) - Number(values[0]);
  return values.slice(2).every(
    (value, index) => Math.abs(value - Number(values[index + 1]) - step) < 1e-10
  );
}

function projectedHorizontalClearance(
  labelPosition: THREE.Vector3,
  axisPosition: THREE.Vector3,
  camera: THREE.Camera,
  viewportWidth: number
): number {
  const labelNdc = labelPosition.clone().project(camera).x;
  const axisNdc = axisPosition.clone().project(camera).x;
  return (axisNdc - labelNdc) * viewportWidth / 2;
}

function countTriangleFacing(
  mesh: THREE.Mesh<THREE.BufferGeometry>,
  camera: THREE.Camera
): { front: number; back: number; edgeOn: number } {
  const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const indices = mesh.geometry.index;
  if (!indices) {
    throw new Error("The surface regression requires indexed geometry.");
  }

  mesh.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const cameraPosition = new THREE.Vector3();
  camera.getWorldPosition(cameraPosition);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edgeAB = new THREE.Vector3();
  const edgeAC = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const view = new THREE.Vector3();
  let front = 0;
  let back = 0;
  let edgeOn = 0;

  for (let offset = 0; offset < indices.count; offset += 3) {
    a.fromBufferAttribute(positions, indices.getX(offset)).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(positions, indices.getX(offset + 1)).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(positions, indices.getX(offset + 2)).applyMatrix4(mesh.matrixWorld);
    edgeAB.subVectors(b, a);
    edgeAC.subVectors(c, a);
    normal.crossVectors(edgeAB, edgeAC);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    view.subVectors(cameraPosition, centroid);
    const orientation = normal.dot(view);
    if (orientation > 1e-10) {
      front += 1;
    } else if (orientation < -1e-10) {
      back += 1;
    } else {
      edgeOn += 1;
    }
  }

  return { front, back, edgeOn };
}

function makeTrace(): CharacteristicTrace {
  return {
    point: { x: 1, t: 0.5, u: 0.5 },
    left: {
      direction: -1,
      points: [
        { x: 1, t: 0.5, u: 0.5 },
        { x: 0, t: 0.25, u: 0 },
        { x: 1, t: 0, u: 0 }
      ]
    },
    right: {
      direction: 1,
      points: [
        { x: 1, t: 0.5, u: 0.5 },
        { x: 2, t: 0, u: 0 }
      ]
    },
    hits: [
      { x: 0, t: 0.25, u: 0, side: "left", path: "left", index: 1 }
    ],
    footpoints: [
      { x: 1, t: 0, u: 0, path: "left" },
      { x: 2, t: 0, u: 0, path: "right" }
    ]
  };
}
