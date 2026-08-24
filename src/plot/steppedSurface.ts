/**
 * Pure geometry buffers for a discontinuous, piecewise-constant graph.
 *
 * The renderer uses the coordinate order `(t, u, x)`. Inputs to this builder
 * are therefore already mapped into renderer/world units. Uniform grid cells
 * become flat plateau quads. A cell crossed by a jump is divided along the
 * least-discontinuous diagonal and its two triangles are cut at edge
 * midpoints. The resulting plateau polygons meet an explicit wall whose front
 * can run diagonally through the cell instead of following a node-centred
 * Manhattan staircase.
 *
 * Every reported face owns four vertices and six indices. Triangular plateau
 * pieces duplicate their final vertex, leaving the second indexed triangle
 * degenerate. This keeps the renderer's existing `topFaceCount * 6` material
 * split compatible while ensuring wall vertices are never shared with top
 * vertices. Lighting therefore cannot average their normals and round a jump
 * back into a serrated ramp.
 */

export interface SteppedSurfaceInput {
  /** Strictly increasing world-space spatial coordinates. */
  x: ArrayLike<number>;
  /** Strictly increasing world-space time coordinates. */
  t: ArrayLike<number>;
  /** World-space heights in row-major order: `tIndex * x.length + xIndex`. */
  heights: ArrayLike<number>;
  /**
   * Add a wall only when adjacent heights differ by more than this amount.
   * The threshold is absolute and expressed in the same world units as
   * `heights`; it defaults to zero.
   */
  jumpThreshold?: number;
}

export interface SteppedSurfaceMetadata {
  xSampleCount: number;
  tSampleCount: number;
  topFaceCount: number;
  xJumpWallCount: number;
  tJumpWallCount: number;
  wallFaceCount: number;
  faceCount: number;
  vertexCount: number;
  triangleCount: number;
  indexCount: number;
  jumpThreshold: number;
  /**
   * Face offset for walls whose front runs primarily in time. Retains the
   * legacy x-jump bucket name used by renderer diagnostics.
   */
  xJumpWallFaceOffset: number;
  /** Face offset for the remaining primarily-spatial wall fronts. */
  tJumpWallFaceOffset: number;
}

export interface SteppedSurfaceBuffers {
  /** Three components per vertex in renderer order `(t, u, x)`. */
  positions: Float32Array;
  /** Per-face normals; top faces are exactly `(0, 1, 0)`. */
  normals: Float32Array;
  /** Two counter-clockwise triangles per independent quad. */
  indices: Uint32Array;
  metadata: SteppedSurfaceMetadata;
}

const COMPONENTS_PER_VERTEX = 3;
const VERTICES_PER_FACE = 4;
const INDICES_PER_FACE = 6;

interface SampleVertex {
  t: number;
  x: number;
  height: number;
}

interface DomainPoint {
  t: number;
  x: number;
}

type WallBucket = "x" | "t";

interface TopologyCounts {
  topFaceCount: number;
  xJumpWallCount: number;
  tJumpWallCount: number;
}

interface GeometrySink {
  addTopFace: (
    aT: number,
    aX: number,
    bT: number,
    bX: number,
    cT: number,
    cX: number,
    dT: number,
    dX: number,
    height: number
  ) => void;
  addWallFace: (
    bucket: WallBucket,
    startT: number,
    startX: number,
    endT: number,
    endX: number,
    lower: number,
    upper: number,
    normalT: number,
    normalX: number
  ) => void;
}

/**
 * Detect a sampled height field whose spatial jump is too large for a smooth
 * interpolating topology. Time-neighbor changes are deliberately ignored: a
 * coarse but spatially smooth traveling wave can vary sharply between output
 * rows without containing a discontinuity in x. The ratio is measured against
 * the complete sampled value range, so ordinary spatial slopes remain
 * resolution-aware.
 */
export function hasLargeRelativeGridJump(
  heights: ArrayLike<number>,
  xCount: number,
  tCount: number,
  relativeThreshold = 0.2
): boolean {
  if (
    !Number.isInteger(xCount) ||
    !Number.isInteger(tCount) ||
    xCount < 2 ||
    tCount < 2 ||
    heights.length !== xCount * tCount
  ) {
    throw new Error("Jump detection needs a complete grid with at least two samples per axis.");
  }
  if (!Number.isFinite(relativeThreshold) || relativeThreshold <= 0) {
    throw new Error("The relative jump threshold must be finite and positive.");
  }
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < heights.length; index += 1) {
    const value = Number(heights[index]);
    if (!Number.isFinite(value)) {
      throw new Error("Jump detection cannot inspect non-finite heights.");
    }
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const range = maximum - minimum;
  if (range <= Number.EPSILON * Math.max(1, Math.abs(minimum), Math.abs(maximum))) {
    return false;
  }
  const threshold = range * relativeThreshold;
  for (let tIndex = 0; tIndex < tCount; tIndex += 1) {
    const rowOffset = tIndex * xCount;
    for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
      const index = rowOffset + xIndex;
      const value = Number(heights[index]);
      if (
        xIndex + 1 < xCount &&
        Math.abs(Number(heights[index + 1]) - value) >= threshold
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build flat cut-cell plateau tops and explicit vertical jump walls.
 *
 * Face order is stable: row-major cell tops, followed by walls whose dominant
 * tangent is temporal (the legacy x-wall bucket), then the remaining walls
 * (the legacy t-wall bucket). The returned buffers are consequently
 * byte-for-byte deterministic for identical inputs.
 */
export function buildSteppedSurfaceBuffers(
  input: SteppedSurfaceInput
): SteppedSurfaceBuffers {
  const xCount = input.x.length;
  const tCount = input.t.length;
  if (xCount < 2 || tCount < 2) {
    throw new Error(
      "A stepped surface needs at least two spatial and two time samples."
    );
  }

  validateIncreasingFiniteCoordinates(input.x, "spatial");
  validateIncreasingFiniteCoordinates(input.t, "time");

  const expectedHeightCount = xCount * tCount;
  if (input.heights.length !== expectedHeightCount) {
    throw new Error(
      `A stepped surface needs exactly ${expectedHeightCount} row-major heights.`
    );
  }
  for (let index = 0; index < expectedHeightCount; index += 1) {
    if (!Number.isFinite(Number(input.heights[index]))) {
      throw new Error("A stepped surface cannot contain a non-finite height.");
    }
  }

  const jumpThreshold = input.jumpThreshold ?? 0;
  if (!Number.isFinite(jumpThreshold) || jumpThreshold < 0) {
    throw new Error("The stepped-surface jump threshold must be finite and nonnegative.");
  }

  // Pass one stores counts only. Pass two repeats the same deterministic walk
  // directly into exact typed buffers. This avoids the former multi-megabyte
  // temporary JS number arrays and their associated garbage-collection task.
  const counts = countTopology(input, jumpThreshold);
  const { topFaceCount, xJumpWallCount, tJumpWallCount } = counts;
  const wallFaceCount = xJumpWallCount + tJumpWallCount;
  const faceCount = topFaceCount + wallFaceCount;
  const vertexCount = faceCount * VERTICES_PER_FACE;
  const triangleCount = faceCount * 2;
  const indexCount = faceCount * INDICES_PER_FACE;
  const positions = new Float32Array(vertexCount * COMPONENTS_PER_VERTEX);
  const normals = new Float32Array(vertexCount * COMPONENTS_PER_VERTEX);
  const indices = new Uint32Array(indexCount);
  const xJumpWallFaceOffset = topFaceCount;
  const tJumpWallFaceOffset = topFaceCount + xJumpWallCount;
  let topCursor = 0;
  let xWallCursor = xJumpWallFaceOffset;
  let tWallCursor = tJumpWallFaceOffset;
  const sink: GeometrySink = {
    addTopFace: (aT, aX, bT, bX, cT, cX, dT, dX, height) => {
      writeQuad(
        positions,
        normals,
        indices,
        topCursor,
        aT,
        height,
        aX,
        bT,
        height,
        bX,
        cT,
        height,
        cX,
        dT,
        height,
        dX,
        0,
        1,
        0
      );
      topCursor += 1;
    },
    addWallFace: (
      bucket,
      startT,
      startX,
      endT,
      endX,
      lower,
      upper,
      normalT,
      normalX
    ) => {
      const faceIndex = bucket === "x" ? xWallCursor++ : tWallCursor++;
      writeQuad(
        positions,
        normals,
        indices,
        faceIndex,
        startT,
        lower,
        startX,
        endT,
        lower,
        endX,
        endT,
        upper,
        endX,
        startT,
        upper,
        startX,
        normalT,
        0,
        normalX
      );
    }
  };
  walkTopology(input, jumpThreshold, sink);

  if (
    topCursor !== topFaceCount ||
    xWallCursor !== tJumpWallFaceOffset ||
    tWallCursor !== faceCount
  ) {
    throw new Error("The stepped-surface face count changed during construction.");
  }

  return {
    positions,
    normals,
    indices,
    metadata: {
      xSampleCount: xCount,
      tSampleCount: tCount,
      topFaceCount,
      xJumpWallCount,
      tJumpWallCount,
      wallFaceCount,
      faceCount,
      vertexCount,
      triangleCount,
      indexCount,
      jumpThreshold,
      xJumpWallFaceOffset,
      tJumpWallFaceOffset
    }
  };
}

function countTopology(
  input: SteppedSurfaceInput,
  threshold: number
): TopologyCounts {
  const counts: TopologyCounts = {
    topFaceCount: 0,
    xJumpWallCount: 0,
    tJumpWallCount: 0
  };
  const sink: GeometrySink = {
    addTopFace: () => {
      counts.topFaceCount += 1;
    },
    addWallFace: (bucket) => {
      if (bucket === "x") counts.xJumpWallCount += 1;
      else counts.tJumpWallCount += 1;
    }
  };
  walkTopology(input, threshold, sink);
  return counts;
}

function walkTopology(
  input: SteppedSurfaceInput,
  threshold: number,
  sink: GeometrySink
): void {
  const xCount = input.x.length;
  const tCount = input.t.length;
  for (let tIndex = 0; tIndex < tCount - 1; tIndex += 1) {
    const rowOffset = tIndex * xCount;
    const nextRowOffset = rowOffset + xCount;
    const tMinimum = Number(input.t[tIndex]);
    const tMaximum = Number(input.t[tIndex + 1]);
    let runActive = false;
    let runXMinimum = 0;
    let runXMaximum = 0;
    let runHeightMinimum = 0;
    let runHeightMaximum = 0;
    let runHeightTotal = 0;
    let runCellCount = 0;

    for (let xIndex = 0; xIndex < xCount - 1; xIndex += 1) {
      const xMinimum = Number(input.x[xIndex]);
      const xMaximum = Number(input.x[xIndex + 1]);
      const aHeight = Number(input.heights[rowOffset + xIndex]);
      const bHeight = Number(input.heights[rowOffset + xIndex + 1]);
      const cHeight = Number(input.heights[nextRowOffset + xIndex + 1]);
      const dHeight = Number(input.heights[nextRowOffset + xIndex]);
      const cellMinimum = Math.min(aHeight, bHeight, cHeight, dHeight);
      const cellMaximum = Math.max(aHeight, bHeight, cHeight, dHeight);
      if (cellMaximum - cellMinimum <= threshold) {
        const combinedMinimum = runActive
          ? Math.min(runHeightMinimum, cellMinimum)
          : cellMinimum;
        const combinedMaximum = runActive
          ? Math.max(runHeightMaximum, cellMaximum)
          : cellMaximum;
        if (runActive && combinedMaximum - combinedMinimum > threshold) {
          emitUniformRun(
            sink,
            tMinimum,
            tMaximum,
            runXMinimum,
            runXMaximum,
            runHeightTotal / runCellCount
          );
          runActive = false;
        }
        const cellHeight = (aHeight + bHeight + cHeight + dHeight) / 4;
        if (!runActive) {
          runActive = true;
          runXMinimum = xMinimum;
          runXMaximum = xMaximum;
          runHeightMinimum = cellMinimum;
          runHeightMaximum = cellMaximum;
          runHeightTotal = cellHeight;
          runCellCount = 1;
        } else {
          runXMaximum = xMaximum;
          runHeightMinimum = combinedMinimum;
          runHeightMaximum = combinedMaximum;
          runHeightTotal += cellHeight;
          runCellCount += 1;
        }
        continue;
      }

      if (runActive) {
        emitUniformRun(
          sink,
          tMinimum,
          tMaximum,
          runXMinimum,
          runXMaximum,
          runHeightTotal / runCellCount
        );
        runActive = false;
      }
      const a: SampleVertex = { t: tMinimum, x: xMinimum, height: aHeight };
      const b: SampleVertex = { t: tMinimum, x: xMaximum, height: bHeight };
      const c: SampleVertex = { t: tMaximum, x: xMaximum, height: cHeight };
      const d: SampleVertex = { t: tMaximum, x: xMinimum, height: dHeight };
      emitCutCell(sink, a, b, c, d, threshold);
    }

    if (runActive) {
      emitUniformRun(
        sink,
        tMinimum,
        tMaximum,
        runXMinimum,
        runXMaximum,
        runHeightTotal / runCellCount
      );
    }
  }
}

function emitUniformRun(
  sink: GeometrySink,
  tMinimum: number,
  tMaximum: number,
  xMinimum: number,
  xMaximum: number,
  height: number
): void {
  sink.addTopFace(
    tMinimum,
    xMinimum,
    tMinimum,
    xMaximum,
    tMaximum,
    xMaximum,
    tMaximum,
    xMinimum,
    height
  );
}

function emitCutCell(
  sink: GeometrySink,
  a: SampleVertex,
  b: SampleVertex,
  c: SampleVertex,
  d: SampleVertex,
  threshold: number
): void {
  const minimum = Math.min(a.height, b.height, c.height, d.height);
  const maximum = Math.max(a.height, b.height, c.height, d.height);
  if (maximum - minimum <= threshold) {
    emitTopFace(sink, [a, b, c, d], averageHeights(a, b, c, d));
    return;
  }

  // Connecting the more alike diagonal endpoints isolates a single-corner
  // jump as one direct edge-to-edge cut rather than two orthogonal half-cuts.
  const acCost = jumpCost(a.height, c.height, threshold);
  const bdCost = jumpCost(b.height, d.height, threshold);
  if (acCost <= bdCost) {
    emitCutTriangle(sink, [a, b, c], threshold);
    emitCutTriangle(sink, [a, c, d], threshold);
  } else {
    emitCutTriangle(sink, [a, b, d], threshold);
    emitCutTriangle(sink, [b, c, d], threshold);
  }
}

function emitCutTriangle(
  sink: GeometrySink,
  vertices: readonly [SampleVertex, SampleVertex, SampleVertex],
  threshold: number
): void {
  const [a, b, c] = vertices;
  const minimum = Math.min(a.height, b.height, c.height);
  const maximum = Math.max(a.height, b.height, c.height);
  if (maximum - minimum <= threshold) {
    emitTopFace(sink, vertices, averageHeights(a, b, c));
    return;
  }

  const pairs = [
    { first: 0, second: 1, difference: Math.abs(a.height - b.height) },
    { first: 1, second: 2, difference: Math.abs(b.height - c.height) },
    { first: 2, second: 0, difference: Math.abs(c.height - a.height) }
  ] as const;
  let closest: { first: number; second: number; difference: number } = pairs[0];
  for (const pair of pairs.slice(1)) {
    if (pair.difference < closest.difference) closest = pair;
  }

  if (closest.difference <= threshold) {
    const minorityIndex = 3 - closest.first - closest.second;
    const nextIndex = (minorityIndex + 1) % 3;
    const previousIndex = (minorityIndex + 2) % 3;
    const minority = vertices[minorityIndex] as SampleVertex;
    const next = vertices[nextIndex] as SampleVertex;
    const previous = vertices[previousIndex] as SampleVertex;
    const nextMidpoint = midpoint(minority, next);
    const previousMidpoint = midpoint(previous, minority);
    const majorityHeight = (next.height + previous.height) / 2;
    emitTopFace(
      sink,
      [minority, nextMidpoint, previousMidpoint],
      minority.height
    );
    emitTopFace(
      sink,
      [next, previous, previousMidpoint, nextMidpoint],
      majorityHeight
    );
    emitWallFace(
      sink,
      nextMidpoint,
      previousMidpoint,
      minority.height,
      majorityHeight,
      minority,
      next
    );
    return;
  }

  // Rare three-level junction: each corner owns a centroid-bounded plateau.
  // The three pairwise walls meet at one deterministic interior point.
  const ab = midpoint(a, b);
  const bc = midpoint(b, c);
  const ca = midpoint(c, a);
  const centre: DomainPoint = {
    t: (a.t + b.t + c.t) / 3,
    x: (a.x + b.x + c.x) / 3
  };
  emitTopFace(sink, [a, ab, centre, ca], a.height);
  emitTopFace(sink, [b, bc, centre, ab], b.height);
  emitTopFace(sink, [c, ca, centre, bc], c.height);
  emitWallFace(sink, ab, centre, a.height, b.height, a, b);
  emitWallFace(sink, bc, centre, b.height, c.height, b, c);
  emitWallFace(sink, ca, centre, c.height, a.height, c, a);
}

function emitTopFace(
  sink: GeometrySink,
  points: readonly DomainPoint[],
  height: number
): void {
  const first = points[0];
  const second = points[1];
  const third = points[2];
  const fourth = points[3] ?? third;
  if (!first || !second || !third || !fourth) {
    throw new Error("A cut-cell plateau needs at least three points.");
  }
  sink.addTopFace(
    first.t,
    first.x,
    second.t,
    second.x,
    third.t,
    third.x,
    fourth.t,
    fourth.x,
    height
  );
}

function emitWallFace(
  sink: GeometrySink,
  first: DomainPoint,
  second: DomainPoint,
  firstHeight: number,
  secondHeight: number,
  firstSide: DomainPoint,
  secondSide: DomainPoint
): void {
  let start = first;
  let end = second;
  const deltaT = end.t - start.t;
  const deltaX = end.x - start.x;
  const length = Math.hypot(deltaT, deltaX);
  if (!(length > 0)) {
    throw new Error("A cut-cell wall must have positive length.");
  }
  let normalT = -deltaX / length;
  let normalX = deltaT / length;
  const highSide = firstHeight > secondHeight ? firstSide : secondSide;
  const lowSide = firstHeight > secondHeight ? secondSide : firstSide;
  if (
    normalT * (lowSide.t - highSide.t) +
      normalX * (lowSide.x - highSide.x) <
    0
  ) {
    start = second;
    end = first;
    normalT = -normalT;
    normalX = -normalX;
  }
  const bucket = Math.abs(deltaT) >= Math.abs(deltaX) ? "x" : "t";
  sink.addWallFace(
    bucket,
    start.t,
    start.x,
    end.t,
    end.x,
    Math.min(firstHeight, secondHeight),
    Math.max(firstHeight, secondHeight),
    normalT,
    normalX
  );
}

function midpoint(first: DomainPoint, second: DomainPoint): DomainPoint {
  return {
    t: (first.t + second.t) / 2,
    x: (first.x + second.x) / 2
  };
}

function averageHeights(...vertices: readonly SampleVertex[]): number {
  return vertices.reduce((sum, vertex) => sum + vertex.height, 0) / vertices.length;
}

function jumpCost(first: number, second: number, threshold: number): number {
  const difference = Math.abs(second - first);
  return difference <= threshold ? 0 : difference;
}

function validateIncreasingFiniteCoordinates(
  coordinates: ArrayLike<number>,
  label: string
): void {
  let previous = Number(coordinates[0]);
  if (!Number.isFinite(previous)) {
    throw new Error(`The stepped-surface ${label} coordinates must be finite.`);
  }
  for (let index = 1; index < coordinates.length; index += 1) {
    const current = Number(coordinates[index]);
    if (!Number.isFinite(current) || current <= previous) {
      throw new Error(
        `The stepped-surface ${label} coordinates must be finite and strictly increasing.`
      );
    }
    previous = current;
  }
}

function writeQuad(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  faceIndex: number,
  aT: number,
  aU: number,
  aX: number,
  bT: number,
  bU: number,
  bX: number,
  cT: number,
  cU: number,
  cX: number,
  dT: number,
  dU: number,
  dX: number,
  normalT: number,
  normalU: number,
  normalX: number
): void {
  const vertexOffset = faceIndex * VERTICES_PER_FACE;
  const positionOffset = vertexOffset * COMPONENTS_PER_VERTEX;
  positions[positionOffset] = aT;
  positions[positionOffset + 1] = aU;
  positions[positionOffset + 2] = aX;
  positions[positionOffset + 3] = bT;
  positions[positionOffset + 4] = bU;
  positions[positionOffset + 5] = bX;
  positions[positionOffset + 6] = cT;
  positions[positionOffset + 7] = cU;
  positions[positionOffset + 8] = cX;
  positions[positionOffset + 9] = dT;
  positions[positionOffset + 10] = dU;
  positions[positionOffset + 11] = dX;
  for (let vertexIndex = 0; vertexIndex < VERTICES_PER_FACE; vertexIndex += 1) {
    const normalOffset = positionOffset + vertexIndex * COMPONENTS_PER_VERTEX;
    normals[normalOffset] = normalT;
    normals[normalOffset + 1] = normalU;
    normals[normalOffset + 2] = normalX;
  }
  const indexOffset = faceIndex * INDICES_PER_FACE;
  indices[indexOffset] = vertexOffset;
  indices[indexOffset + 1] = vertexOffset + 1;
  indices[indexOffset + 2] = vertexOffset + 2;
  indices[indexOffset + 3] = vertexOffset;
  indices[indexOffset + 4] = vertexOffset + 2;
  indices[indexOffset + 5] = vertexOffset + 3;
}
