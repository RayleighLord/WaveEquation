import { describe, expect, it } from "vitest";

import { buildSteppedSurfaceBuffers, hasLargeRelativeGridJump } from "../plot";

describe("discontinuity-aware stepped surface buffers", () => {
  it("detects large relative grid jumps without classifying resolved smooth slopes", () => {
    const smoothRow = Array.from({ length: 9 }, (_, index) => index / 8);
    expect(hasLargeRelativeGridJump([...smoothRow, ...smoothRow], 9, 2)).toBe(false);
    expect(
      hasLargeRelativeGridJump(
        [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0],
        8,
        2
      )
    ).toBe(true);
    expect(hasLargeRelativeGridJump(new Float32Array(8), 4, 2)).toBe(false);
    expect(
      hasLargeRelativeGridJump(
        [
          0, 0, 0, 0,
          1, 1, 1, 1
        ],
        4,
        2
      )
    ).toBe(false);
    expect(
      hasLargeRelativeGridJump(
        [
          0, 0, 1, 1,
          0, 0, 1, 1
        ],
        4,
        2
      )
    ).toBe(true);
    expect(() => hasLargeRelativeGridJump([0, 1, 0], 2, 2)).toThrow(/complete grid/);
  });

  it("merges a same-height spatial run into one plateau face", () => {
    const surface = buildSteppedSurfaceBuffers({
      x: [0, 1, 2, 3, 4],
      t: [0, 1],
      heights: [
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0
      ]
    });

    expect(surface.metadata.topFaceCount).toBe(1);
    expect(surface.metadata.wallFaceCount).toBe(0);
    expect([...surface.positions]).toEqual([
      0, 0, 0,
      0, 0, 4,
      1, 0, 4,
      1, 0, 0
    ]);
  });

  it("cuts a one-corner jump with one slanted wall instead of a staircase", () => {
    const surface = buildSteppedSurfaceBuffers({
      x: new Float64Array([0, 2]),
      t: new Float64Array([10, 14]),
      heights: new Float32Array([
        0, 1,
        1, 1
      ])
    });

    expect(surface.metadata).toEqual({
      xSampleCount: 2,
      tSampleCount: 2,
      topFaceCount: 3,
      xJumpWallCount: 1,
      tJumpWallCount: 0,
      wallFaceCount: 1,
      faceCount: 4,
      vertexCount: 16,
      triangleCount: 8,
      indexCount: 24,
      jumpThreshold: 0,
      xJumpWallFaceOffset: 3,
      tJumpWallFaceOffset: 4
    });

    // The low corner becomes a triangular top cut at the two edge midpoints.
    // Its padded fourth vertex keeps the renderer's six-index face contract.
    expect([...surface.positions.slice(0, 12)]).toEqual([
      10, 0, 0,
      10, 0, 1,
      12, 0, 0,
      12, 0, 0
    ]);
    expect([...surface.normals.slice(0, 12)]).toEqual([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0
    ]);

    const wallOffset = surface.metadata.xJumpWallFaceOffset * 12;
    const wall = [...surface.positions.slice(wallOffset, wallOffset + 12)];
    // Both t and x change along the wall front. The former node-centred builder
    // could emit only constant-t or constant-x fronts here.
    expect(wall).toEqual([
      12, 0, 0,
      10, 0, 1,
      10, 1, 1,
      12, 1, 0
    ]);
    expect(wall[0]).not.toBe(wall[3]);
    expect(wall[2]).not.toBe(wall[5]);

    const wallNormal = [...surface.normals.slice(wallOffset, wallOffset + 3)];
    expect(wallNormal[0]).toBeCloseTo(-1 / Math.sqrt(5));
    expect(wallNormal[1]).toBe(0);
    expect(wallNormal[2]).toBeCloseTo(-2 / Math.sqrt(5));
    // The oriented normal points from the high plateau toward the low corner.
    expect((wallNormal[0] as number) * 0 + (wallNormal[2] as number) * -2)
      .toBeGreaterThan(0);
  });

  it("keeps top triangles flat and never bridges a jump", () => {
    const surface = buildSteppedSurfaceBuffers({
      x: [0, 2],
      t: [10, 14],
      heights: [0, 1, 1, 1]
    });

    for (let faceIndex = 0; faceIndex < surface.metadata.topFaceCount; faceIndex += 1) {
      const vertexOffset = faceIndex * 12;
      const faceHeights = [0, 1, 2, 3].map(
        (vertexIndex) => surface.positions[vertexOffset + vertexIndex * 3 + 1]
      );
      expect(new Set(faceHeights).size).toBe(1);
      for (let vertexIndex = 0; vertexIndex < 4; vertexIndex += 1) {
        const normalOffset = vertexOffset + vertexIndex * 3;
        expect([...surface.normals.slice(normalOffset, normalOffset + 3)])
          .toEqual([0, 1, 0]);
      }
      const faceIndices = [...surface.indices.slice(faceIndex * 6, faceIndex * 6 + 6)];
      expect(new Set(faceIndices).size).toBeLessThanOrEqual(4);
      expect(Math.min(...faceIndices)).toBe(faceIndex * 4);
      expect(Math.max(...faceIndices)).toBeLessThan(faceIndex * 4 + 4);
    }

    const wallFace = surface.metadata.xJumpWallFaceOffset;
    const wallVertexOffset = wallFace * 12;
    expect(
      [0, 1, 2, 3].map(
        (vertexIndex) => surface.positions[wallVertexOffset + vertexIndex * 3 + 1]
      )
    ).toEqual([0, 0, 1, 1]);
    expect(surface.metadata.xJumpWallFaceOffset * 6)
      .toBe(surface.metadata.topFaceCount * 6);
  });

  it("tracks a sampled traveling front with diagonal segments across many cells", () => {
    const samples = [0, 1, 2, 3, 4];
    const heights = samples.flatMap((_, tIndex) =>
      samples.map((__, xIndex) => (xIndex >= tIndex ? 1 : 0))
    );
    const surface = buildSteppedSurfaceBuffers({
      x: samples,
      t: samples,
      heights
    });

    expect(surface.metadata.wallFaceCount).toBeGreaterThan(4);
    for (
      let faceIndex = surface.metadata.xJumpWallFaceOffset;
      faceIndex < surface.metadata.faceCount;
      faceIndex += 1
    ) {
      const offset = faceIndex * 12;
      const deltaT = Math.abs(
        Number(surface.positions[offset]) - Number(surface.positions[offset + 3])
      );
      const deltaX = Math.abs(
        Number(surface.positions[offset + 2]) - Number(surface.positions[offset + 5])
      );
      expect(deltaT).toBeGreaterThan(0);
      expect(deltaX).toBeGreaterThan(0);
      expect(deltaT).toBeCloseTo(deltaX);
    }
  });

  it("merges sub-threshold variation while retaining a resolved straight front", () => {
    const uniform = buildSteppedSurfaceBuffers({
      x: [0, 1],
      t: [0, 1],
      heights: [0, 0.001, 0.002, 0.003],
      jumpThreshold: 0.01
    });
    expect(uniform.metadata.topFaceCount).toBe(1);
    expect(uniform.metadata.wallFaceCount).toBe(0);
    expect([0, 1, 2, 3].map((index) => uniform.positions[index * 3 + 1]))
      .toEqual([
        expect.closeTo(0.0015),
        expect.closeTo(0.0015),
        expect.closeTo(0.0015),
        expect.closeTo(0.0015)
      ]);

    const input = {
      x: [0, 1],
      t: [0, 1],
      heights: [0, 0.001, 1, 1],
      jumpThreshold: 0.01
    };
    const first = buildSteppedSurfaceBuffers(input);
    const second = buildSteppedSurfaceBuffers(input);

    expect(first.metadata.topFaceCount).toBe(4);
    expect(first.metadata.xJumpWallCount).toBe(0);
    expect(first.metadata.tJumpWallCount).toBe(2);
    expect(first.metadata.vertexCount).toBe(24);
    expect(first.metadata.triangleCount).toBe(12);

    // Every face owns its vertices and has one exact normal. No vertex normal
    // can be averaged between a horizontal top and a vertical wall.
    for (let faceIndex = 0; faceIndex < first.metadata.faceCount; faceIndex += 1) {
      const offset = faceIndex * 12;
      const normal = [...first.normals.slice(offset, offset + 3)];
      for (let vertexIndex = 1; vertexIndex < 4; vertexIndex += 1) {
        expect([...first.normals.slice(offset + vertexIndex * 3, offset + vertexIndex * 3 + 3)])
          .toEqual(normal);
      }
      if (faceIndex < first.metadata.topFaceCount) {
        const heights = [0, 1, 2, 3].map(
          (vertexIndex) => first.positions[offset + vertexIndex * 3 + 1]
        );
        expect(new Set(heights).size).toBe(1);
        expect(normal).toEqual([0, 1, 0]);
      }
    }

    expect([...first.positions]).toEqual([...second.positions]);
    expect([...first.normals]).toEqual([...second.normals]);
    expect([...first.indices]).toEqual([...second.indices]);
    expect(first.metadata).toEqual(second.metadata);
  });

  it("uses a deterministic finite centroid junction for three plateau levels", () => {
    const input = {
      x: [0, 1],
      t: [0, 1],
      heights: [0, 1, 2, 3],
      jumpThreshold: 0.01
    };
    const first = buildSteppedSurfaceBuffers(input);
    const second = buildSteppedSurfaceBuffers(input);

    expect(first.metadata.topFaceCount).toBe(6);
    expect(first.metadata.wallFaceCount).toBe(6);
    expect(first.metadata.faceCount).toBe(12);
    expect(first.metadata.vertexCount).toBe(48);
    expect(first.metadata.indexCount).toBe(72);
    expect([...first.positions].every(Number.isFinite)).toBe(true);
    expect([...first.normals].every(Number.isFinite)).toBe(true);
    expect([...first.indices].every((index) => index < first.metadata.vertexCount))
      .toBe(true);
    expect([...first.positions]).toEqual([...second.positions]);
    expect([...first.normals]).toEqual([...second.normals]);
    expect([...first.indices]).toEqual([...second.indices]);
    expect(first.metadata).toEqual(second.metadata);
  });

  it("keeps a 513 by 641 moving square within a compact deterministic budget", () => {
    const xCount = 513;
    const tCount = 641;
    const x = Float64Array.from({ length: xCount }, (_, index) => index);
    const t = Float64Array.from({ length: tCount }, (_, index) => index);
    const heights = new Float32Array(xCount * tCount);
    for (let tIndex = 0; tIndex < tCount; tIndex += 1) {
      const centre = tIndex <= 320 ? 80 + tIndex : 720 - tIndex;
      const left = centre - 24;
      const right = centre + 24;
      const rowOffset = tIndex * xCount;
      for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
        heights[rowOffset + xIndex] = xIndex >= left && xIndex <= right ? 1 : 0;
      }
    }

    const input = { x, t, heights, jumpThreshold: 0.01 };
    const first = buildSteppedSurfaceBuffers(input);
    const second = buildSteppedSurfaceBuffers(input);
    const rawCellCount = (xCount - 1) * (tCount - 1);
    const bufferBytes =
      first.positions.byteLength +
      first.normals.byteLength +
      first.indices.byteLength;

    expect(first.metadata.xSampleCount).toBe(xCount);
    expect(first.metadata.tSampleCount).toBe(tCount);
    expect(first.metadata.faceCount).toBeLessThan(30_000);
    expect(first.metadata.faceCount).toBeLessThan(rawCellCount / 10);
    expect(bufferBytes).toBeLessThan(4_000_000);
    expect(first.metadata.wallFaceCount).toBeGreaterThan(1_000);
    expect(first.metadata.xJumpWallFaceOffset * 6)
      .toBe(first.metadata.topFaceCount * 6);
    expect(allFinite(first.positions)).toBe(true);
    expect(allFinite(first.normals)).toBe(true);
    expect(allIndicesInRange(first.indices, first.metadata.vertexCount)).toBe(true);

    let slantedWallCount = 0;
    for (
      let faceIndex = first.metadata.xJumpWallFaceOffset;
      faceIndex < first.metadata.faceCount;
      faceIndex += 1
    ) {
      const offset = faceIndex * 12;
      const deltaT = Math.abs(
        Number(first.positions[offset]) - Number(first.positions[offset + 3])
      );
      const deltaX = Math.abs(
        Number(first.positions[offset + 2]) - Number(first.positions[offset + 5])
      );
      if (deltaT > 0 && deltaX > 0) slantedWallCount += 1;
    }
    expect(slantedWallCount).toBeGreaterThan(1_000);

    for (let faceIndex = 0; faceIndex < first.metadata.topFaceCount; faceIndex += 1) {
      const offset = faceIndex * 12;
      const height = first.positions[offset + 1];
      expect(first.positions[offset + 4]).toBe(height);
      expect(first.positions[offset + 7]).toBe(height);
      expect(first.positions[offset + 10]).toBe(height);
    }

    expect(second.metadata).toEqual(first.metadata);
    expect(hashBytes(second.positions)).toBe(hashBytes(first.positions));
    expect(hashBytes(second.normals)).toBe(hashBytes(first.normals));
    expect(hashBytes(second.indices)).toBe(hashBytes(first.indices));
  });

  it("validates dimensions, ordering, finite data, and threshold", () => {
    expect(() =>
      buildSteppedSurfaceBuffers({ x: [0], t: [0, 1], heights: [0, 0] })
    ).toThrow(/at least two spatial and two time/);
    expect(() =>
      buildSteppedSurfaceBuffers({ x: [0, 0], t: [0, 1], heights: [0, 0, 0, 0] })
    ).toThrow(/spatial coordinates.*strictly increasing/);
    expect(() =>
      buildSteppedSurfaceBuffers({ x: [0, 1], t: [0, 1], heights: [0, 0, 0] })
    ).toThrow(/exactly 4 row-major heights/);
    expect(() =>
      buildSteppedSurfaceBuffers({
        x: [0, 1],
        t: [0, 1],
        heights: [0, Number.NaN, 0, 0]
      })
    ).toThrow(/non-finite height/);
    expect(() =>
      buildSteppedSurfaceBuffers({
        x: [0, 1],
        t: [0, 1],
        heights: [0, 0, 0, 0],
        jumpThreshold: -1
      })
    ).toThrow(/threshold.*nonnegative/);
  });
});

function allFinite(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

function allIndicesInRange(values: Uint32Array, vertexCount: number): boolean {
  for (const value of values) {
    if (value >= vertexCount) return false;
  }
  return true;
}

function hashBytes(values: Float32Array | Uint32Array): number {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let hash = 2_166_136_261;
  for (const value of bytes) {
    hash = Math.imul(hash ^ value, 16_777_619);
  }
  return hash >>> 0;
}
