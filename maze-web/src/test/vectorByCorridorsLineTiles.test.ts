import { describe, expect, it, vi } from "vitest";
import { GraphicsContext } from "pixi.js";
import { buildCorridorLineTiles, traceCorridorLineTile } from "../pixi/imageExport/vectorByCorridorsLineTiles";
import { CorridorTileLayer } from "../pixi/imageExport/corridorTileLayer";

const run = (xs: number[], y = 20) => xs.slice(1).map((x, i) => ({ v0: { x: xs[i], y }, v1: { x, y } }));

describe("buildCorridorLineTiles", () => {
  it("cuts every segment at its midpoint and keys cells by their local ports", () => {
    const tiles = buildCorridorLineTiles(run([0, 40, 80, 120]), 10, "miter");
    const byX = new Map(tiles.map((tile) => [tile.offset.x, tile]));
    expect(tiles).toHaveLength(4);
    expect(byX.get(0)!.ports).toEqual([{ x: 20, y: 0 }]);
    expect(byX.get(40)!.ports).toEqual([{ x: -20, y: 0 }, { x: 20, y: 0 }]);
    // Equal local shapes share a key regardless of position or port order; mirrored dead ends don't.
    expect(byX.get(40)!.key).toBe(byX.get(80)!.key);
    expect(byX.get(0)!.key).not.toBe(byX.get(120)!.key);
    expect(buildCorridorLineTiles([{ v0: { x: 80, y: 20 }, v1: { x: 40, y: 20 } }, { v0: { x: 80, y: 20 }, v1: { x: 120, y: 20 } }], 10, "miter")
      .find((tile) => tile.offset.x === 80)!.key).toBe(byX.get(80)!.key);
  });

  it("puts width and join into the key, so different styles never share a shape", () => {
    const keyOf = (width: number, join: "round" | "miter") => buildCorridorLineTiles(run([0, 40]), width, join)[0].key;
    expect(keyOf(10, "miter")).not.toBe(keyOf(12, "miter"));
    expect(keyOf(10, "miter")).not.toBe(keyOf(10, "round"));
  });

  it("gives a split-touching segment to its v0 cell only, ending at the split point", () => {
    const tiles = buildCorridorLineTiles([{ v0: { x: 0, y: 0 }, v1: { x: 30, y: 0 }, v1TouchesSplit: true }], 10, "miter");
    expect(tiles).toHaveLength(1);
    expect(tiles[0].ports).toEqual([{ x: 30, y: 0 }]);
  });

  it("skips zero-length segments", () => {
    expect(buildCorridorLineTiles([{ v0: { x: 5, y: 5 }, v1: { x: 5, y: 5 } }], 10, "miter")).toEqual([]);
  });
});

describe("traceCorridorLineTile", () => {
  const traced = (ports: { x: number; y: number }[], join: "round" | "miter") => {
    const context = new GraphicsContext();
    const spies = {
      moveTo: vi.spyOn(context, "moveTo"),
      lineTo: vi.spyOn(context, "lineTo"),
      stroke: vi.spyOn(context, "stroke"),
      circle: vi.spyOn(context, "circle"),
      fill: vi.spyOn(context, "fill"),
    };
    traceCorridorLineTile(context, ports, 10, join);
    return spies;
  };

  it("caps a miter dead end with a square patch behind the centre", () => {
    const spies = traced([{ x: 20, y: 0 }], "miter");
    expect(spies.stroke).toHaveBeenCalledWith(expect.objectContaining({ cap: "butt", width: 10 }));
    expect(spies.moveTo).toHaveBeenCalledWith(0, -5);
    expect(spies.lineTo).toHaveBeenCalledWith(-5, -5);
    expect(spies.lineTo).toHaveBeenCalledWith(-5, 5);
    expect(spies.lineTo).toHaveBeenCalledWith(0, 5);
    expect(spies.fill).toHaveBeenCalledWith(0xffffff);
  });

  it("caps a round dead end with a centre disc", () => {
    const spies = traced([{ x: 20, y: 0 }], "round");
    expect(spies.circle).toHaveBeenCalledWith(0, 0, 5);
    expect(spies.stroke).toHaveBeenCalledWith(expect.objectContaining({ cap: "butt", join: "round" }));
  });

  it("draws a miter turn as one polyline through the centre", () => {
    const spies = traced([{ x: 20, y: 0 }, { x: 0, y: 20 }], "miter");
    expect(spies.moveTo.mock.calls).toEqual([[20, 0]]);
    expect(spies.lineTo.mock.calls).toEqual([[0, 0], [0, 20]]);
    expect(spies.stroke).toHaveBeenCalledWith(expect.objectContaining({ join: "miter", cap: "butt" }));
    expect(spies.fill).not.toHaveBeenCalled();
  });

  it("patches a 3-way hex junction with filled miter wedges", () => {
    const ports = [0, 120, 240].map((deg) => ({ x: 20 * Math.cos(deg * Math.PI / 180), y: 20 * Math.sin(deg * Math.PI / 180) }));
    const spies = traced(ports, "miter");
    expect(spies.stroke).toHaveBeenCalledTimes(1);
    expect(spies.fill).toHaveBeenCalled();
  });
});

describe("CorridorTileLayer", () => {
  const instance = (cellId: string, key: string, x: number) => ({ cellId, key, offset: { x, y: 0 } });
  const trace = (_: unknown, context: GraphicsContext) => { context.rect(0, 0, 1, 1).fill(0xffffff); };
  const state = (layer: CorridorTileLayer) => layer as unknown as {
    tiles: Map<string, { graphics: { context: GraphicsContext; tint: number; destroyed: boolean } }>;
    contexts: Map<string, GraphicsContext>;
  };

  it("reuses unchanged tiles, swaps changed ones in place and prunes unused contexts", () => {
    const layer = new CorridorTileLayer();
    layer.setTint(0x123456);
    layer.update([instance("a", "k1", 0), instance("b", "k1", 10), instance("c", "k2", 20)], trace);
    const before = new Map([...state(layer).tiles].map(([id, tile]) => [id, tile.graphics]));
    expect(before.get("a")!.context).toBe(before.get("b")!.context);
    expect(before.get("a")!.tint).toBe(0x123456);

    const removed = before.get("c")!;
    layer.update([instance("a", "k1", 0), instance("b", "k3", 10), instance("d", "k1", 30)], trace);
    const after = state(layer).tiles;
    expect(after.get("a")!.graphics).toBe(before.get("a"));
    expect(after.get("b")!.graphics).toBe(before.get("b"));
    expect(after.get("b")!.graphics.context).toBe(state(layer).contexts.get("k3"));
    expect(after.get("d")!.graphics.tint).toBe(0x123456);
    expect(after.has("c")).toBe(false);
    expect(removed.destroyed).toBe(true);
    expect([...state(layer).contexts.keys()].sort()).toEqual(["k1", "k3"]);

    // A cell that moves keeps its object; only its position changes.
    const moved = after.get("a")!.graphics as unknown as { position: { x: number } };
    layer.update([instance("a", "k1", 5), instance("b", "k3", 10), instance("d", "k1", 30)], trace);
    expect(state(layer).tiles.get("a")!.graphics).toBe(moved);
    expect(moved.position.x).toBe(5);
    layer.destroy();
  });
});
