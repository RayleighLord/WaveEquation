import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SnapshotRenderer, SpaceTimeRenderer, type ProfileSampler } from "../plot";
import type { CharacteristicTrace, WaveSolutionGrid } from "../types";
import { makeGrid } from "./plot_fixtures";

describe("SnapshotRenderer", () => {
  it("retains an optional initial displacement comparison while the current profile changes", () => {
    const renderer = new SnapshotRenderer(sizedHost(800, 260));
    const grid = makeGrid();
    renderer.setSolution(grid);
    const initial = renderer.svg.querySelector(".snapshot-initial-curve")!;
    expect(initial.getAttribute("visibility")).toBe("hidden");
    renderer.setInitialProfileVisible(true);
    expect(renderer.svg.querySelector(".snapshot-initial-legend .katex")).not.toBeNull();
    const initialPath = initial.getAttribute("d");
    expect(initialPath).toBe(renderer.svg.querySelector(".snapshot-curve")?.getAttribute("d"));
    renderer.setTime(0.5);
    expect(initial.getAttribute("d")).toBe(initialPath);
    expect(renderer.svg.querySelector(".snapshot-curve")?.getAttribute("d")).not.toBe(initialPath);
    renderer.setInitialProfileVisible(false);
    expect(initial.getAttribute("visibility")).toBe("hidden");
    expect(renderer.svg.querySelector(".snapshot-initial-curve")).toBe(initial);
    renderer.dispose();
  });

  it("does not create a local selected marker when application selection is disabled", () => {
    const onPointSelect = vi.fn();
    const renderer = new SnapshotRenderer(sizedHost(800, 260), { onPointSelect });
    renderer.setSolution(makeGrid());
    renderer.setSelectionEnabled(false);
    const hitArea = renderer.svg.querySelector(".snapshot-selection-hit-area")!;
    hitArea.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 300, clientY: 100 }));
    renderer.svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onPointSelect).not.toHaveBeenCalled();
    expect(renderer.svg.dataset.selectedX).toBeUndefined();
    renderer.setSelectionEnabled(true);
    renderer.svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onPointSelect).toHaveBeenCalledOnce();
    renderer.setSelectionEnabled(false);
    expect(renderer.svg.dataset.selectedX).toBeUndefined();
    renderer.dispose();
  });
  it("retains its SVG, interpolates the snapshot, and exposes explicit axes", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    const sameSvg = renderer.svg;

    renderer.setSolution(makeGrid());
    renderer.setTime(0.5);

    expect(renderer.svg).toBe(sameSvg);
    expect(renderer.svg.dataset.geometryReady).toBe("true");
    expect(renderer.svg.dataset.currentTime).toBe("0.5");
    expect(renderer.svg.dataset.sampleCount).toBe("3");
    const curve = renderer.svg.querySelector<SVGPathElement>(".snapshot-curve");
    expect(curve?.getAttribute("d")).toMatch(
      /^M.+ L.+ L.+$/
    );
    const setCurveAttribute = vi.spyOn(curve!, "setAttribute");
    renderer.setTime(0.5);
    expect(setCurveAttribute).not.toHaveBeenCalled();
    setCurveAttribute.mockRestore();
    expect(renderer.svg.querySelectorAll(".snapshot-axis")).toHaveLength(2);
    expect(renderer.svg.querySelectorAll(".snapshot-x-tick")).toHaveLength(11);
    expect(renderer.svg.querySelectorAll(".snapshot-u-tick")).toHaveLength(5);

    const xAxis = renderer.svg.querySelector<SVGLineElement>(".snapshot-axis-x");
    const uAxis = renderer.svg.querySelector<SVGLineElement>(".snapshot-axis-u");
    const xMarker = renderer.svg.querySelector<SVGMarkerElement>(
      "marker[data-snapshot-axis-marker='x']"
    );
    const uMarker = renderer.svg.querySelector<SVGMarkerElement>(
      "marker[data-snapshot-axis-marker='u']"
    );
    expect(xMarker).not.toBeNull();
    expect(uMarker).not.toBeNull();
    expect(xMarker?.id).not.toBe(uMarker?.id);
    expect(xAxis?.getAttribute("marker-end")).toBe(`url(#${xMarker?.id})`);
    expect(uAxis?.getAttribute("marker-end")).toBe(`url(#${uMarker?.id})`);
    expect(Number(xAxis?.getAttribute("x2"))).toBeGreaterThan(
      Number(xAxis?.getAttribute("x1"))
    );
    expect(Number(uAxis?.getAttribute("y2"))).toBeLessThan(
      Number(uAxis?.getAttribute("y1"))
    );

    const hitArea = renderer.svg.querySelector<SVGRectElement>(
      ".snapshot-selection-hit-area"
    );
    const xLabel = renderer.svg.querySelector<SVGForeignObjectElement>(
      ".snapshot-x-axis-label"
    );
    const dataRight =
      Number(hitArea?.getAttribute("x")) + Number(hitArea?.getAttribute("width"));
    const dataTop = Math.min(
      ...Array.from(
        renderer.svg.querySelectorAll<SVGLineElement>(".snapshot-grid-line-u")
      ).map((line) => Number(line.getAttribute("y1")))
    );
    const axisEnd = Number(xAxis?.getAttribute("x2"));
    expect(axisEnd - dataRight).toBe(16);
    expect(foreignObjectRight(xLabel)).toBe(axisEnd - 3);
    expect(foreignObjectRight(xLabel)).toBeLessThanOrEqual(800);
    expect(dataTop - Number(uAxis?.getAttribute("y2"))).toBe(16);
    expect(renderer.svg.querySelector(".snapshot-curve")?.getAttribute("d")).toMatch(
      new RegExp(`L${dataRight}\\s`)
    );

    renderer.setSolution({ ...makeGrid(), x: new Float64Array([-2, 0, 2]) });
    expect(renderer.svg.querySelector(`#${xMarker?.id}`)).toBe(xMarker);
    expect(renderer.svg.querySelector(`#${uMarker?.id}`)).toBe(uMarker);

    renderer.dispose();
    expect(host.contains(sameSvg)).toBe(false);
  });

  it("keeps the extended positive x tip and its name contained at compact width", () => {
    const host = sizedHost(300, 230);
    const renderer = new SnapshotRenderer(host);
    renderer.setSolution({ ...makeGrid(), x: new Float64Array([-6, 0, 6]) });

    const hitArea = renderer.svg.querySelector<SVGRectElement>(
      ".snapshot-selection-hit-area"
    );
    const xAxis = renderer.svg.querySelector<SVGLineElement>(".snapshot-axis-x");
    const xLabel = renderer.svg.querySelector<SVGForeignObjectElement>(
      ".snapshot-x-axis-label"
    );
    const uAxis = renderer.svg.querySelector<SVGLineElement>(".snapshot-axis-u");
    const uLabel = renderer.svg.querySelector<SVGForeignObjectElement>(
      ".snapshot-u-axis-label"
    );
    const dataRight =
      Number(hitArea?.getAttribute("x")) + Number(hitArea?.getAttribute("width"));
    const axisStart = Number(xAxis?.getAttribute("x1"));
    const axisEnd = Number(xAxis?.getAttribute("x2"));

    expect(axisEnd).toBeGreaterThan(dataRight);
    expect(axisEnd - dataRight).toBe(16);
    expect(axisEnd).toBeLessThan(300);
    expect(axisEnd).toBeGreaterThan(axisStart);
    expect(xAxis?.getAttribute("marker-end")).toMatch(
      /^url\(#wave-snapshot-x-axis-arrow-\d+\)$/
    );
    expect(foreignObjectLeft(xLabel)).toBeGreaterThanOrEqual(0);
    expect(foreignObjectRight(xLabel)).toBe(axisEnd - 3);
    expect(foreignObjectRight(xLabel)).toBeLessThanOrEqual(300);
    expect(uLabel?.dataset.anchor).toBe("start");
    expect(foreignObjectLeft(uLabel)).toBe(186);
    expect(foreignObjectLeft(uLabel) - Number(uAxis?.getAttribute("x1"))).toBe(12);
    expect(foreignObjectRight(uLabel)).toBe(300);
    expect(renderer.svg.querySelectorAll(".snapshot-grid-line-x")).toHaveLength(13);

    renderer.dispose();
  });

  it("places the u ticks left and the u name right of the central x = 0 axis", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.setSolution({ ...makeGrid(), x: new Float64Array([-6, 0, 6]) });

    const hitArea = renderer.svg.querySelector<SVGRectElement>(
      ".snapshot-selection-hit-area"
    );
    const uAxis = renderer.svg.querySelector<SVGLineElement>(".snapshot-axis-u");
    const uTicks = Array.from(
      renderer.svg.querySelectorAll<SVGForeignObjectElement>(".snapshot-u-tick")
    );
    const uLabel = renderer.svg.querySelector<SVGForeignObjectElement>(
      ".snapshot-u-axis-label"
    );
    const plotMidpoint =
      Number(hitArea?.getAttribute("x")) + Number(hitArea?.getAttribute("width")) / 2;
    const uAxisX = Number(uAxis?.getAttribute("x1"));

    expect(uAxisX).toBeCloseTo(plotMidpoint, 8);
    expect(uTicks).toHaveLength(5);
    for (const tick of uTicks) {
      expect(foreignObjectRight(tick)).toBeCloseTo(uAxisX - 16, 8);
      expect(tick.dataset.anchor).toBe("end");
    }
    expect(foreignObjectLeft(uLabel)).toBeCloseTo(uAxisX + 18, 8);
    expect(uLabel?.dataset.anchor).toBe("start");
    expect(foreignObjectRight(uLabel)).toBeLessThanOrEqual(800);

    renderer.dispose();
  });

  it("places the u name right of the left-edge axis on a positive one-sided view", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.setSolution({ ...makeGrid(), x: new Float64Array([2, 4, 6]) });

    const hitArea = renderer.svg.querySelector<SVGRectElement>(
      ".snapshot-selection-hit-area"
    );
    const uAxis = renderer.svg.querySelector<SVGLineElement>(".snapshot-axis-u");
    const uTicks = Array.from(
      renderer.svg.querySelectorAll<SVGForeignObjectElement>(".snapshot-u-tick")
    );
    const uLabel = renderer.svg.querySelector<SVGForeignObjectElement>(
      ".snapshot-u-axis-label"
    );
    const uAxisX = Number(uAxis?.getAttribute("x1"));

    expect(uAxisX).toBe(Number(hitArea?.getAttribute("x")));
    for (const tick of uTicks) {
      expect(foreignObjectRight(tick)).toBeCloseTo(uAxisX - 16, 8);
    }
    expect(foreignObjectLeft(uLabel)).toBeCloseTo(uAxisX + 18, 8);
    expect(uLabel?.dataset.anchor).toBe("start");
    expect(foreignObjectRight(uLabel)).toBeLessThanOrEqual(800);

    renderer.dispose();
  });

  it("falls back left of a right-edge u axis rather than clipping the u name", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.setSolution({ ...makeGrid(), x: new Float64Array([-6, -4, -2]) });

    const hitArea = renderer.svg.querySelector<SVGRectElement>(
      ".snapshot-selection-hit-area"
    );
    const uAxis = renderer.svg.querySelector<SVGLineElement>(".snapshot-axis-u");
    const uTicks = Array.from(
      renderer.svg.querySelectorAll<SVGForeignObjectElement>(".snapshot-u-tick")
    );
    const uLabel = renderer.svg.querySelector<SVGForeignObjectElement>(
      ".snapshot-u-axis-label"
    );
    const uAxisX = Number(uAxis?.getAttribute("x1"));

    expect(uAxisX).toBe(
      Number(hitArea?.getAttribute("x")) + Number(hitArea?.getAttribute("width"))
    );
    for (const tick of uTicks) {
      expect(foreignObjectRight(tick)).toBeCloseTo(uAxisX - 16, 8);
    }
    expect(foreignObjectRight(uLabel)).toBeCloseTo(uAxisX - 18, 8);
    expect(uLabel?.dataset.anchor).toBe("end");
    expect(foreignObjectLeft(uLabel)).toBeGreaterThanOrEqual(0);
    expect(foreignObjectRight(uLabel)).toBeLessThanOrEqual(800);

    renderer.dispose();
  });

  it("selects curve points by pointer and keyboard without rebuilding the SVG", () => {
    const host = sizedHost(800, 260);
    const onPointSelect = vi.fn();
    const renderer = new SnapshotRenderer(host, { onPointSelect });
    renderer.setSolution(makeGrid());
    renderer.svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 260, right: 800, bottom: 260, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const hitArea = renderer.svg.querySelector<SVGRectElement>(
      ".snapshot-selection-hit-area"
    );
    const hitAreaMidpoint =
      Number(hitArea?.getAttribute("x")) + Number(hitArea?.getAttribute("width")) / 2;
    hitArea?.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: hitAreaMidpoint, clientY: 100 })
    );
    expect(onPointSelect).toHaveBeenLastCalledWith(expect.closeTo(1, 2), "pointer");
    expect(renderer.svg.dataset.selectedX).toBeTruthy();
    expect(renderer.svg.querySelector(".snapshot-point")?.getAttribute("visibility")).toBe(
      "visible"
    );

    renderer.svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onPointSelect).toHaveBeenLastCalledWith(2, "keyboard");
    renderer.dispose();
  });

  it("projects red eta and purple xi footpoints without snapshot math overlays", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.update({
      solution: makeGrid(),
      time: 0.5,
      selectedX: 1,
      characteristics: makeTrace()
    });

    expect(renderer.svg.querySelectorAll(".snapshot-footpoint")).toHaveLength(2);
    const etaMarker = renderer.svg.querySelector<SVGPathElement>(
      ".snapshot-footpoint-left"
    );
    const xiMarker = renderer.svg.querySelector<SVGPathElement>(
      ".snapshot-footpoint-right"
    );
    const etaGuide = renderer.svg.querySelector<SVGLineElement>(
      ".snapshot-footpoint-guide[data-characteristic-family='eta']"
    );
    const xiGuide = renderer.svg.querySelector<SVGLineElement>(
      ".snapshot-footpoint-guide[data-characteristic-family='xi']"
    );
    expect(etaMarker?.getAttribute("fill")).toBe("#e76f67");
    expect(etaMarker?.dataset.characteristicFamily).toBe("eta");
    expect(xiMarker?.getAttribute("fill")).toBe("#a970ff");
    expect(xiMarker?.dataset.characteristicFamily).toBe("xi");
    expect(etaGuide?.getAttribute("stroke")).toBe("#e76f67");
    expect(xiGuide?.getAttribute("stroke")).toBe("#a970ff");
    expect(renderer.svg.querySelectorAll(".snapshot-characteristic-label")).toHaveLength(0);
    expect(renderer.svg.querySelector("desc")?.textContent).toContain(
      "backward characteristics"
    );
    expect(renderer.svg.querySelector("desc")?.textContent).toContain("red eta");
    expect(renderer.svg.querySelector("desc")?.textContent).toContain("purple xi");
    expect(renderer.svg.querySelector("desc")?.textContent).not.toContain("minus t");
    expect(renderer.svg.querySelector("desc")?.textContent).not.toContain("plus t");
    renderer.dispose();
  });

  it("retains white physical-boundary markers on the evolving snapshot curve", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.setBoundaryPositions([2, 0]);
    renderer.setSolution(makeGrid());
    renderer.setTime(0.5);

    const markers = Array.from(
      renderer.svg.querySelectorAll<SVGCircleElement>(".snapshot-boundary-marker")
    );
    expect(markers).toHaveLength(2);
    expect(renderer.svg.dataset.boundaryCount).toBe("2");
    expect(renderer.svg.dataset.visibleBoundaryCount).toBe("2");
    expect(renderer.svg.dataset.boundaryPositions).toBe("0,2");
    expect(markers.map((marker) => marker.dataset.boundaryPosition)).toEqual(["0", "2"]);
    expect(markers.map((marker) => marker.dataset.boundaryValue)).toEqual(["0.5", "-0.5"]);
    for (const marker of markers) {
      expect(marker.getAttribute("fill")).toBe("#ffffff");
      expect(marker.getAttribute("visibility")).toBe("visible");
      expect(marker.dataset.boundaryVisible).toBe("true");
    }

    const originalMarkers = [...markers];
    const previousY = markers.map((marker) => marker.getAttribute("cy"));
    renderer.setTime(1);
    expect(
      Array.from(renderer.svg.querySelectorAll(".snapshot-boundary-marker"))
    ).toEqual(originalMarkers);
    expect(markers.map((marker) => marker.getAttribute("cy"))).not.toEqual(previousY);
    expect(markers.map((marker) => marker.dataset.boundaryValue)).toEqual(["1", "-1"]);

    renderer.setSolution({
      ...makeGrid(),
      values: new Float32Array([
        0.25, 0.5, 0.75,
        0.5, 0.75, 1
      ]),
      surfaceRange: { min: 0, max: 1 }
    });
    expect(
      Array.from(renderer.svg.querySelectorAll(".snapshot-boundary-marker"))
    ).toEqual(originalMarkers);
    expect(markers.map((marker) => marker.dataset.boundaryValue)).toEqual(["0.5", "1"]);
    expect(renderer.svg.querySelector("desc")?.textContent).toContain(
      "Physical boundary markers are shown at x 0, u 0.5; x 2, u 1."
    );

    renderer.dispose();
  });

  it("hides physical-boundary markers outside the accepted view and removes them for an infinite domain", () => {
    const host = sizedHost(800, 260);
    const renderer = new SnapshotRenderer(host);
    renderer.setSolution(makeGrid());
    renderer.setBoundaryPositions([-1, 3]);

    const markers = Array.from(
      renderer.svg.querySelectorAll<SVGCircleElement>(".snapshot-boundary-marker")
    );
    expect(markers).toHaveLength(2);
    expect(markers.every((marker) => marker.getAttribute("visibility") === "hidden")).toBe(
      true
    );
    expect(markers.every((marker) => marker.dataset.boundaryVisible === "false")).toBe(
      true
    );
    expect(renderer.svg.dataset.boundaryCount).toBe("2");
    expect(renderer.svg.dataset.visibleBoundaryCount).toBe("0");
    expect(renderer.svg.querySelector("desc")?.textContent).not.toContain(
      "Physical boundary marker"
    );

    renderer.setBoundaryPositions([]);
    expect(renderer.svg.querySelectorAll(".snapshot-boundary-marker")).toHaveLength(0);
    expect(renderer.svg.dataset.boundaryCount).toBe("0");
    expect(renderer.svg.dataset.visibleBoundaryCount).toBe("0");
    expect(renderer.svg.dataset.boundaryPositions).toBe("");

    renderer.dispose();
  });
});

describe("SpaceTimeRenderer", () => {
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
  });

  it("keeps an accessible fallback while retaining scene geometry without WebGL", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    expect(renderer.webglAvailable).toBe(false);
    expect(renderer.canvas).toBeNull();
    expect(host.dataset.webglAvailable).toBe("false");
    expect(host.querySelector<HTMLElement>(".webgl-notice")?.hidden).toBe(false);

    renderer.setSolution(makeGrid());
    const surface = renderer.scene.getObjectByName("wave-solution-surface") as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshLambertMaterial
    >;
    expect(surface).toBeTruthy();
    expect(surface.geometry.getAttribute("position").count).toBe(6);
    expect(surface.geometry.index?.count).toBe(12);
    expect(surface.material.color.getHex()).toBe(0x4fcbd3);
    expect(surface.material.opacity).toBe(1);
    expect(surface.material.transparent).toBe(false);
    expect(surface.material.depthWrite).toBe(true);
    expect(surface.material.side).toBe(THREE.DoubleSide);
    expect(surface.material.forceSinglePass).toBe(true);
    expect(surface.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(renderer.scene.getObjectByName("wave-solution-rectangular-grid")).toBeUndefined();
    const hemisphere = renderer.scene.getObjectByName(
      "wave-surface-hemisphere-light"
    ) as THREE.HemisphereLight;
    expect(hemisphere).toBeInstanceOf(THREE.HemisphereLight);
    expect(hemisphere.intensity).toBeGreaterThan(0);
    expect(hemisphere.groundColor.getHex()).not.toBe(0x000000);
    const key = renderer.scene.getObjectByName(
      "wave-surface-key-light"
    ) as THREE.DirectionalLight;
    expect(key).toBeInstanceOf(THREE.DirectionalLight);
    expect(key.intensity).toBeGreaterThan(0);
    expect(key.position.y).toBeGreaterThan(0);
    const underfill = renderer.scene.getObjectByName(
      "wave-surface-underfill-light"
    ) as THREE.DirectionalLight;
    expect(underfill).toBeInstanceOf(THREE.DirectionalLight);
    expect(underfill.intensity).toBeGreaterThan(0);
    expect(underfill.position.y).toBeLessThan(0);
    expect(host.dataset.geometryReady).toBe("true");
    expect(host.dataset.axisArrows).toBe("3");
    expect(host.dataset.surfaceOpacity).toBe("1");
    expect(host.dataset.surfaceTransparency).toBe("0");
    expect(host.dataset.surfaceTransparent).toBe("false");
    expect(host.dataset.surfaceSide).toBe("double");
    expect(host.dataset.surfaceMaterial).toBe("lambert-lit");
    expect(host.dataset.surfaceLighting).toBe("hemisphere-key-underfill");
    expect(host.dataset.surfaceUndersideFill).toBe("true");
    expect(host.dataset.surfacePass).toBe("single");
    expect(host.dataset.webglAntialias).toBe("false");
    expect(host.dataset.webglResolutionScale).toBe("0.9");
    expect(host.dataset.surfaceTopology).toBe("smooth");
    expect(host.dataset.surfaceWallMaterial).toBe("none");
    expect(host.dataset.surfaceGridVisible).toBeUndefined();
    expect(host.dataset.physicalBoundaryTraceCount).toBe("0");
    expect(host.dataset.physicalBoundaryTraceSurface).toBe("true");
    expect(renderer.scene.getObjectByName("t-axis-arrow")).toBeTruthy();
    expect(renderer.scene.getObjectByName("x-axis-arrow")).toBeTruthy();
    expect(renderer.scene.getObjectByName("u-axis-arrow")).toBeTruthy();
    expect(renderer.scene.getObjectByName("time-plane-drag-handle")).toBeUndefined();
    expect(renderer.scene.getObjectByName("time-plane-handle-outline")).toBeUndefined();

    renderer.dispose();
    expect(host.querySelector(".webgl-notice")).toBeNull();
  });

  it("uses flat plateaus and explicit unlit walls for stepped surfaces", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    renderer.setSurfaceTopology("stepped");
    renderer.setSolution(makeGrid());

    const stepped = renderer.scene.getObjectByName("wave-solution-surface") as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.Material[]
    >;
    expect(stepped.material).toHaveLength(2);
    expect(stepped.material[0]).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(stepped.material[1]).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(stepped.geometry.groups).toHaveLength(2);
    expect(stepped.userData.surfaceTopology).toBe("stepped");
    expect(host.dataset.surfaceTopology).toBe("stepped");
    expect(host.dataset.surfaceWallMaterial).toBe("basic-unlit");
    expect(host.dataset.steppedSurfaceTopFaces).toBe("8");
    expect(host.dataset.steppedSurfaceWallFaces).toBe("4");
    expect(host.dataset.steppedSurfaceXWalls).toBe("4");
    expect(host.dataset.steppedSurfaceTWalls).toBe("0");
    expect(host.dataset.meshVertices).toBe("48");
    expect(host.dataset.meshTriangles).toBe("24");

    const normals = stepped.geometry.getAttribute("normal") as THREE.BufferAttribute;
    expect([normals.getX(0), normals.getY(0), normals.getZ(0)]).toEqual([0, 1, 0]);

    renderer.setSurfaceTopology("smooth");
    const smooth = renderer.scene.getObjectByName("wave-solution-surface") as THREE.Mesh;
    expect(smooth).not.toBe(stepped);
    expect(smooth.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(host.dataset.surfaceTopology).toBe("smooth");
    expect(host.dataset.surfaceWallMaterial).toBe("none");
    expect(host.dataset.steppedSurfaceTopFaces).toBe("0");
    expect(host.dataset.steppedSurfaceWallFaces).toBe("0");
    expect(host.dataset.meshVertices).toBe("6");
    expect(host.dataset.meshTriangles).toBe("4");
    renderer.dispose();
  });

  it("retains thick white physical-boundary traces on the solution surface", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    renderer.setBoundaryPositions([2, 0, Number.NaN, 2]);
    renderer.setSolution(makeGrid());

    const group = renderer.scene.getObjectByName("physical-boundary-surface-traces") as THREE.Group;
    expect(group.children).toHaveLength(2);
    const left = group.children[0] as Line2;
    const right = group.children[1] as Line2;
    expect(left).toBeInstanceOf(Line2);
    expect(left.name).toBe("physical-boundary-surface-trace-0");
    expect(left.material).toBeInstanceOf(LineMaterial);
    expect(left.material.color.getHex()).toBe(0xffffff);
    expect(left.material.linewidth).toBeCloseTo(0.055, 8);
    expect(left.material.worldUnits).toBe(true);
    expect(left.material.depthTest).toBe(false);
    expect(left.material.depthWrite).toBe(false);
    expect(left.userData.physicalBoundaryPosition).toBe(0);
    expect(left.userData.traceSpace).toBe("solution-surface");
    expect(right.userData.physicalBoundaryPosition).toBe(2);

    const leftStart = left.geometry.getAttribute("instanceStart") as THREE.BufferAttribute;
    const leftEnd = left.geometry.getAttribute("instanceEnd") as THREE.BufferAttribute;
    expect(leftStart.count).toBe(1);
    expect([leftStart.getX(0), leftStart.getY(0), leftStart.getZ(0)])
      .toEqual([-5, 0, -4]);
    expect([leftEnd.getX(0), leftEnd.getY(0), leftEnd.getZ(0)])
      .toEqual([5, 2.5, -4]);
    const rightEnd = right.geometry.getAttribute("instanceEnd") as THREE.BufferAttribute;
    expect([rightEnd.getX(0), rightEnd.getY(0), rightEnd.getZ(0)])
      .toEqual([5, -2.5, 4]);
    expect(host.dataset.physicalBoundaryPositions).toBe("[0,2]");
    expect(host.dataset.physicalBoundaryTracePositions).toBe("[0,2]");
    expect(host.dataset.physicalBoundaryTraceCount).toBe("2");
    expect(host.dataset.physicalBoundaryTraceSurface).toBe("true");
    expect(host.dataset.physicalBoundaryTraceColor).toBe("#ffffff");
    expect(host.dataset.physicalBoundaryTraceWidth).toBe("0.055");

    const retainedGeometry = left.geometry;
    const replacement = makeGrid();
    replacement.revision = 8;
    replacement.values[0] = 1;
    renderer.setSolution(replacement);
    expect(group.children[0]).toBe(left);
    expect(left.geometry).toBe(retainedGeometry);
    const replacementStart = left.geometry.getAttribute("instanceStart") as THREE.BufferAttribute;
    expect(replacementStart.getY(0)).toBe(2.5);

    renderer.setBoundaryPositions([2]);
    expect(group.children).toHaveLength(1);
    expect(group.children[0]).toBe(left);
    expect(left.userData.physicalBoundaryPosition).toBe(2);
    expect(host.dataset.physicalBoundaryTraceCount).toBe("1");
    expect(host.dataset.physicalBoundaryTracePositions).toBe("[2]");

    const disposeGeometry = vi.spyOn(left.geometry, "dispose");
    const disposeMaterial = vi.spyOn(left.material, "dispose");
    renderer.clear();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
    expect(group.children).toHaveLength(0);
    expect(host.dataset.physicalBoundaryPositions).toBe("[]");
    expect(host.dataset.physicalBoundaryTracePositions).toBe("[]");
    expect(host.dataset.physicalBoundaryTraceCount).toBe("0");
    renderer.dispose();
  });

  it("moves one persistent surface slice and renders characteristics only on the floor", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    const grid = makeGrid();
    renderer.setSolution(grid);
    const surface = renderer.scene.getObjectByName("wave-solution-surface");

    renderer.setTime(0.5);
    const plane = renderer.scene.getObjectByName("draggable-time-plane");
    const slice = renderer.scene.getObjectByName("current-time-surface-slice") as THREE.Line;
    expect(plane?.position.z).toBeCloseTo(0, 8);
    expect(slice.geometry.getAttribute("position").count).toBe(3);
    expect(renderer.scene.getObjectByName("wave-solution-surface")).toBe(surface);
    expect(host.dataset.currentTime).toBe("0.5");
    const retainedSliceGeometry = slice.geometry;
    const retainedSlicePositions = slice.geometry.getAttribute("position");
    renderer.setTime(0.75);
    expect(slice.geometry).toBe(retainedSliceGeometry);
    expect(slice.geometry.getAttribute("position")).toBe(retainedSlicePositions);

    renderer.setCharacteristics(makeTrace());
    const floorLeft = renderer.scene.getObjectByName(
      "characteristic-floor-left"
    ) as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
    expect(floorLeft).toBeTruthy();
    expect(floorLeft.material).toBeInstanceOf(THREE.LineDashedMaterial);
    expect(floorLeft.material.color.getHexString()).toBe("e76f67");
    expect(floorLeft.userData.characteristicFamily).toBe("eta");
    const floorRight = renderer.scene.getObjectByName(
      "characteristic-floor-right"
    ) as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
    expect(floorRight).toBeTruthy();
    expect(floorRight.material.color.getHexString()).toBe("a970ff");
    expect(floorRight.userData.characteristicFamily).toBe("xi");
    expect(renderer.scene.getObjectByName("characteristic-surface-left")).toBeUndefined();
    expect(renderer.scene.getObjectByName("characteristic-surface-right")).toBeUndefined();
    expect(renderer.scene.getObjectByName("characteristic-selected-point")).toBeTruthy();
    expect(renderer.scene.getObjectByName("characteristic-left-left-boundary-hit")).toBeTruthy();
    const overlayMarkers = [
      renderer.scene.getObjectByName("characteristic-left-left-boundary-hit"),
      renderer.scene.getObjectByName("characteristic-left-initial-footpoint"),
      renderer.scene.getObjectByName("characteristic-selected-point")
    ] as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
    for (const marker of overlayMarkers) {
      expect(marker).toBeInstanceOf(THREE.Mesh);
      expect(marker.material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(marker.material.transparent).toBe(true);
      expect(marker.material.opacity).toBe(1);
      expect(marker.material.depthTest).toBe(false);
      expect(marker.material.depthWrite).toBe(false);
      expect(marker.renderOrder).toBeGreaterThan((surface as THREE.Mesh).renderOrder);
      expect(marker.position.y).toBeCloseTo(0, 10);
    }
    const rayPositions = floorLeft.geometry.getAttribute("position");
    for (let index = 0; index < rayPositions.count; index += 1) {
      expect(rayPositions.getY(index)).toBeCloseTo(0, 10);
    }
    expect(host.dataset.characteristics).toBe("visible");
    expect(host.dataset.characteristicFloorPaths).toBe("2");
    expect(host.dataset.characteristicSurfacePaths).toBe("0");
    expect(host.dataset.characteristicHits).toBe("1");
    expect(host.dataset.characteristicFootpoints).toBe("2");
    expect(host.dataset.characteristicMarkerLayer).toBe("overlay");

    renderer.clear();
    expect(renderer.scene.getObjectByName("wave-solution-surface")).toBeUndefined();
    expect(renderer.scene.getObjectByName("wave-solution-rectangular-grid")).toBeUndefined();
    expect(host.dataset.geometryReady).toBe("false");
    expect(host.dataset.characteristicFloorPaths).toBe("0");
    expect(host.dataset.characteristicMarkerLayer).toBe("hidden");
    renderer.dispose();
  });

  it("uses the same explicit jump vertices in the snapshot and gold time slice", () => {
    const grid = makeGrid();
    const profile = { x: new Float64Array([0, 0.7, 0.7, 2]), values: new Float32Array([0, 0, 1, 1]) };
    const sampler: ProfileSampler = {
      grid, sample: () => profile, initial: () => profile,
      valueAt: (x) => x < 0.7 ? 0 : 1
    };
    const snapshot = new SnapshotRenderer(sizedHost(800, 260));
    const surface = new SpaceTimeRenderer(sizedHost(900, 560));
    for (const renderer of [snapshot, surface]) {
      renderer.setProfileSampler(sampler, { defer: true });
      renderer.setSolution(grid, { time: 0.371 });
    }
    const points = (surface.scene.getObjectByName("current-time-surface-slice") as THREE.Line).geometry.getAttribute("position");
    expect(points.count).toBe(4);
    expect(points.getZ(1)).toBe(points.getZ(2));
    expect(points.getY(1)).toBe(0);
    expect(points.getY(2)).toBe(2.5);
    const commands = snapshot.svg.querySelector(".snapshot-curve")!.getAttribute("d")!.split(" ");
    expect(commands[2]).toBe(commands[4]);
    expect(commands[3]).not.toBe(commands[5]);
    snapshot.dispose();
    surface.dispose();
  });

  it("renders a regular stride-two mesh while retaining its full-resolution time slice", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    const grid = makeDenseGrid(513, 161);
    renderer.setSolution(grid);

    const surface = renderer.scene.getObjectByName("wave-solution-surface") as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshLambertMaterial
    >;
    const positions = surface.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(positions.count).toBe(257 * 81);
    expect(surface.geometry.getAttribute("normal").count).toBe(257 * 81);
    expect(surface.geometry.index?.count).toBe(256 * 80 * 6);
    expect(surface.geometry.index?.array).toBeInstanceOf(Uint16Array);
    expect(surface.material.side).toBe(THREE.DoubleSide);
    expect(surface.material.opacity).toBe(1);
    expect(surface.material.transparent).toBe(false);
    expect(surface.material.depthWrite).toBe(true);
    expect(surface.material.forceSinglePass).toBe(true);
    expect([positions.getX(0), positions.getZ(0)]).toEqual([-5, -4]);
    expect([
      positions.getX(positions.count - 1),
      positions.getZ(positions.count - 1)
    ]).toEqual([5, 4]);
    expect(host.dataset.meshXSamples).toBe("257");
    expect(host.dataset.meshTSamples).toBe("81");
    expect(host.dataset.meshVertices).toBe(String(257 * 81));
    expect(host.dataset.meshTriangles).toBe(String(256 * 80 * 2));
    expect(host.dataset.surfaceSide).toBe("double");

    expect(renderer.scene.getObjectByName("wave-solution-rectangular-grid")).toBeUndefined();

    // The fixed accepted grid maps to exact stride-two samples in both axes.
    expect(positions.getX(257)).toBeCloseTo(-4.875, 8);
    expect(positions.getZ(1) - positions.getZ(0)).toBeCloseTo(8 / 256, 8);

    const slice = renderer.scene.getObjectByName("current-time-surface-slice") as THREE.Line;
    expect(slice.geometry.getAttribute("position").count).toBe(513);

    const retainedGeometry = surface.geometry;
    const replacement = makeDenseGrid(513, 161);
    replacement.revision = 8;
    replacement.values[0] = 0.25;
    renderer.setSolution(replacement);
    expect(renderer.scene.getObjectByName("wave-solution-surface")).toBe(surface);
    expect(surface.geometry).toBe(retainedGeometry);
    expect(renderer.scene.getObjectByName("wave-solution-rectangular-grid")).toBeUndefined();
    renderer.dispose();
  });

  it("merges uniform strips at the adaptive cut-surface resolution", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    renderer.setSurfaceTopology("stepped");
    const grid = makeDenseGrid(1025, 321);
    grid.values.fill(0);
    renderer.setSolution(grid);

    expect(host.dataset.surfaceTopology).toBe("stepped");
    expect(host.dataset.meshXSamples).toBe("513");
    expect(host.dataset.meshTSamples).toBe("161");
    expect(host.dataset.steppedSurfaceTopFaces).toBe("160");
    expect(Number(host.dataset.meshVertices)).toBe(160 * 4);
    expect(Number(host.dataset.meshTriangles)).toBe(160 * 2);
    renderer.dispose();
  });

  it("keeps a moving Gaussian crest below one projected-pixel sample-height error", () => {
    const host = sizedHost(900, 560);
    const renderer = new SpaceTimeRenderer(host);
    const grid = makeTravelingGaussianGrid();
    renderer.setSolution(grid);

    const surface = renderer.scene.getObjectByName("wave-solution-surface") as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshLambertMaterial
    >;
    const positions = surface.geometry.getAttribute("position") as THREE.BufferAttribute;
    const crestDeficits: number[] = [];
    const meshXCount = 257;
    const meshTCount = 81;
    for (let tIndex = 0; tIndex < meshTCount; tIndex += 1) {
      let maximumWorldU = Number.NEGATIVE_INFINITY;
      const rowOffset = tIndex * meshXCount;
      for (let xIndex = 0; xIndex < meshXCount; xIndex += 1) {
        maximumWorldU = Math.max(maximumWorldU, positions.getY(rowOffset + xIndex));
      }
      // surfaceRange [0,1] maps exactly to world Y [-2.5,2.5]. A coarse
      // spatial mesh makes the analytically unit-height traveling crest rise
      // and fall periodically as it crosses retained vertices.
      const sampledCrest = (maximumWorldU + 2.5) / 5;
      crestDeficits.push(1 - sampledCrest);
    }

    expect(Math.max(...crestDeficits)).toBeLessThan(0.0015);
    expect(host.dataset.meshXSamples).toBe(String(meshXCount));
    expect(host.dataset.meshTSamples).toBe(String(meshTCount));
    renderer.dispose();
  });

  it("submits prepared characteristic WebGL and CSS2D work in separate stages", () => {
    const host = sizedHost(900, 560);
    const canvas = document.createElement("canvas");
    const render = vi.fn();
    const backend = {
      domElement: canvas,
      outputColorSpace: THREE.SRGBColorSpace,
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
      setClearColor: vi.fn(),
      render,
      dispose: vi.fn()
    } as unknown as THREE.WebGLRenderer;
    const renderer = new SpaceTimeRenderer(host, {
      rendererFactory: () => backend
    });
    renderer.setSolution(makeGrid());
    const plane = renderer.scene.getObjectByName("draggable-time-plane") as THREE.Mesh;
    expect(plane.position.x).toBe(-5);
    expect((plane.material as THREE.MeshBasicMaterial).forceSinglePass).toBe(true);
    render.mockClear();

    renderer.setCharacteristics(makeTrace(), { deferRender: true });
    expect(renderer.scene.getObjectByName("characteristic-floor-left")).toBeTruthy();
    expect(host.dataset.characteristicsFrame).toBe("prepared");
    expect(host.dataset.characteristicsWebglFrame).toBe("prepared");
    expect(host.dataset.characteristicsLabelFrame).toBe("prepared");
    expect(render).not.toHaveBeenCalled();

    renderer.renderPreparedWebGLFrame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(host.dataset.characteristicsFrame).toBe("webgl-rendered");
    expect(host.dataset.characteristicsWebglFrame).toBe("rendered");
    expect(host.dataset.characteristicsLabelFrame).toBe("prepared");

    renderer.renderPreparedLabelFrame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(host.dataset.characteristicsFrame).toBe("rendered");
    expect(host.dataset.characteristicsWebglFrame).toBe("rendered");
    expect(host.dataset.characteristicsLabelFrame).toBe("rendered");

    render.mockClear();
    renderer.setCharacteristics(null, { deferRender: true });
    expect(render).not.toHaveBeenCalled();
    renderer.renderPreparedFrame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(host.dataset.characteristicsFrame).toBe("rendered");
    renderer.dispose();
  });

  it("exposes keyboard time interaction through the shared timeline callback", () => {
    const host = sizedHost(900, 560);
    const canvas = document.createElement("canvas");
    const render = vi.fn();
    const backend = {
      domElement: canvas,
      outputColorSpace: THREE.SRGBColorSpace,
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
      setClearColor: vi.fn(),
      render,
      dispose: vi.fn()
    } as unknown as THREE.WebGLRenderer;
    const onInteractionStart = vi.fn();
    const onTimeChange = vi.fn();
    const renderer = new SpaceTimeRenderer(host, {
      rendererFactory: () => backend,
      onInteractionStart,
      onTimeChange
    });
    renderer.setSolution(makeGrid());
    const plane = renderer.scene.getObjectByName("draggable-time-plane") as THREE.Mesh;
    expect(plane.position.x).toBe(-5);

    expect(backend.setClearColor).toHaveBeenCalledWith(0x000000, 1);
    expect(canvas.dataset.defaultView).toBe("low-oblique-u-left-t-left-edge");
    expect(canvas.dataset.timeAxisEdge).toBe("x-min");
    expect(canvas.dataset.axisArrows).toBe("3");
    expect(host.dataset.surfaceOpacity).toBe("1");
    expect(host.dataset.surfaceTransparency).toBe("0");
    expect(host.dataset.surfaceTransparent).toBe("false");
    expect(host.dataset.surfaceSide).toBe("double");
    expect(host.dataset.surfaceMaterial).toBe("lambert-lit");
    expect(host.dataset.surfaceLighting).toBe("hemisphere-key-underfill");
    expect(host.dataset.surfaceUndersideFill).toBe("true");
    expect(host.dataset.surfacePass).toBe("single");
    expect(canvas.dataset.surfaceOpacity).toBe("1");
    expect(canvas.dataset.surfaceTransparency).toBe("0");
    expect(canvas.dataset.surfaceTransparent).toBe("false");
    expect(canvas.dataset.surfaceSide).toBe("double");
    expect(canvas.dataset.surfaceMaterial).toBe("lambert-lit");
    expect(canvas.dataset.surfaceLighting).toBe("hemisphere-key-underfill");
    expect(canvas.dataset.surfaceUndersideFill).toBe("true");
    expect(canvas.dataset.surfacePass).toBe("single");
    expect(canvas.dataset.webglAntialias).toBe("false");
    expect(canvas.dataset.webglResolutionScale).toBe("0.9");
    expect(host.dataset.surfaceGridVisible).toBeUndefined();
    expect(canvas.dataset.surfaceGridVisible).toBeUndefined();

    render.mockClear();
    renderer.setTime(0);
    expect(render).not.toHaveBeenCalled();
    renderer.setTime(0.5);
    expect(render).toHaveBeenCalledTimes(1);
    render.mockClear();

    const raycaster = (renderer as unknown as { raycaster: THREE.Raycaster }).raycaster;
    const planeIntersection = {
      distance: 1,
      point: new THREE.Vector3(0, 0, 0),
      object: plane
    } as THREE.Intersection;
    const intersectObject = vi
      .spyOn(raycaster, "intersectObject")
      .mockReturnValue([planeIntersection]);
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 })
    );
    expect(intersectObject).toHaveBeenCalledWith(plane, false);
    expect(onInteractionStart).toHaveBeenCalledWith("plane-drag");
    expect(canvas.dataset.planeDragging).toBe("true");

    let pointerWorldT = -3;
    vi.spyOn(raycaster.ray, "intersectPlane").mockImplementation((_plane, target) =>
      target.set(pointerWorldT, 0, 0)
    );
    for (const coordinate of [-3, -1, 1]) {
      pointerWorldT = coordinate;
      canvas.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 220, clientY: 150 }));
    }
    expect(onTimeChange).toHaveBeenLastCalledWith(0.6, "plane-drag");
    expect(render).not.toHaveBeenCalled();
    expect(canvas.dataset.currentTime).toBe("0.5");

    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onInteractionStart).toHaveBeenCalledWith("keyboard");
    expect(onTimeChange).toHaveBeenCalledWith(1, "keyboard");
    // Application-owned time is requested first; its next frame synchronizes
    // the surface, snapshot, and controls in one update.
    expect(canvas.dataset.currentTime).toBe("0.5");
    expect(backend.render).not.toHaveBeenCalled();
    renderer.setTime(1);
    expect(canvas.dataset.currentTime).toBe("1");
    expect(backend.render).toHaveBeenCalledTimes(1);

    renderer.resize(640, 360);
    expect(backend.setSize).toHaveBeenLastCalledWith(640, 360, false);
    renderer.dispose();
    expect(backend.dispose).toHaveBeenCalled();
  });
});

function sizedHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
  document.body.append(host);
  return host;
}

function foreignObjectRight(element: SVGForeignObjectElement | null): number {
  return Number(element?.getAttribute("x")) + Number(element?.getAttribute("width"));
}

function foreignObjectLeft(element: SVGForeignObjectElement | null): number {
  return Number(element?.getAttribute("x"));
}

function makeTrace(): CharacteristicTrace {
  return {
    point: { x: 1, t: 0.5, u: 0.5 },
    left: {
      direction: -1,
      points: [
        { x: 1, t: 0.5, u: 0.5 },
        { x: 0, t: 0.25, u: 0.2 },
        { x: 0.5, t: 0, u: 0.5 }
      ]
    },
    right: {
      direction: 1,
      points: [
        { x: 1, t: 0.5, u: 0.5 },
        { x: 1.5, t: 0, u: 0.5 }
      ]
    },
    hits: [
      { side: "left", path: "left", index: 1, x: 0, t: 0.25, u: 0.2 }
    ],
    footpoints: [
      { path: "left", x: 0.5, t: 0, u: 0.5 },
      { path: "right", x: 1.5, t: 0, u: 0.5 }
    ]
  };
}

function makeDenseGrid(xCount: number, tCount: number): WaveSolutionGrid {
  const x = new Float64Array(xCount);
  const t = new Float64Array(tCount);
  const values = new Float32Array(xCount * tCount);
  for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
    x[xIndex] = -6 + (12 * xIndex) / (xCount - 1);
  }
  for (let tIndex = 0; tIndex < tCount; tIndex += 1) {
    t[tIndex] = (3 * tIndex) / (tCount - 1);
    for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
      values[tIndex * xCount + xIndex] = Math.sin(x[xIndex] ?? 0) *
        Math.cos(t[tIndex] ?? 0);
    }
  }
  return {
    revision: 7,
    problemSignature: "dense-plot-fixture",
    x,
    t,
    values,
    surfaceRange: { min: -1, max: 1 },
    warnings: [],
    timings: { totalMs: 1, integrationMs: 0.2, samplingMs: 0.8 },
    reflectionCount: 0
  };
}

function makeTravelingGaussianGrid(): WaveSolutionGrid {
  const grid = makeDenseGrid(513, 161);
  for (let tIndex = 0; tIndex < grid.t.length; tIndex += 1) {
    const time = Number(grid.t[tIndex]);
    for (let xIndex = 0; xIndex < grid.x.length; xIndex += 1) {
      const distanceFromCrest = Number(grid.x[xIndex]) - time;
      grid.values[tIndex * grid.x.length + xIndex] = Math.exp(
        -4 * distanceFromCrest * distanceFromCrest
      );
    }
  }
  grid.problemSignature = "traveling-gaussian-smoothness-fixture";
  grid.surfaceRange = { min: 0, max: 1 };
  return grid;
}
