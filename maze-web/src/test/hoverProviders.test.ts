import { describe, it, expect } from "vitest";
import type { Container } from "pixi.js";
import { canvasToGrid, DefaultHoverProvider } from "../pixi/hoverProviders";
import { makeProjection } from "../pixi/tessellationProjection";
import type { TessellationProjection } from "../pixi/tessellationProjection";
import { TILE_SIZE } from "../pixi/constants";

function fakeViewport(x: number, y: number, scale = 1): Container {
  return { x, y, scale: { x: scale, y: scale } } as unknown as Container;
}

const squareProjection = makeProjection({ type: "square", width: 10, height: 10 });

describe("canvasToGrid", () => {
  it("maps canvas origin through viewport offset to grid coords", () => {
    const vp = fakeViewport(0, 0);
    expect(canvasToGrid(TILE_SIZE / 2, -TILE_SIZE / 2, vp, squareProjection)).toEqual({ x: 0, y: 0 });
  });

  it("accounts for viewport pan offset", () => {
    const vp = fakeViewport(100, 100);
    expect(canvasToGrid(100 + TILE_SIZE / 2, 100 - TILE_SIZE / 2, vp, squareProjection)).toEqual({ x: 0, y: 0 });
  });

  it("accounts for viewport zoom scale", () => {
    const vp = fakeViewport(0, 0, 2);
    expect(canvasToGrid(TILE_SIZE, -TILE_SIZE, vp, squareProjection)).toEqual({ x: 0, y: 0 });
  });
});

describe("DefaultHoverProvider", () => {
  it("returns null when no projection is available", () => {
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => null);
    expect(provider.getHoverInfo(0, 0)).toBeNull();
  });

  it("returns grid coords when projection is available", () => {
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => squareProjection);
    expect(provider.getHoverInfo(TILE_SIZE / 2, -TILE_SIZE / 2)).toEqual({ x: 0, y: 0 });
  });

  it("returns coords even far outside typical field bounds", () => {
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => squareProjection);
    const far = provider.getHoverInfo(TILE_SIZE * 1000, -TILE_SIZE * 1000);
    expect(far).toEqual({ x: 1000, y: 1000 });
  });

  it("re-queries the projection getter on every call", () => {
    let current: TessellationProjection | null = null;
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => current);
    expect(provider.getHoverInfo(0, 0)).toBeNull();
    current = squareProjection;
    expect(provider.getHoverInfo(TILE_SIZE / 2, -TILE_SIZE / 2)).toEqual({ x: 0, y: 0 });
  });
});
