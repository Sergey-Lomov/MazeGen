import { describe, it, expect, vi } from "vitest";
import { buildTeleportConnectorSegments } from "../pixi/selectors/teleportConnectorSegments";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";

// Cell centers resolve through wasm, unavailable in unit tests — canonical square formula.
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

// Connector pieces of the connector editor's list (GitHub issue #989).
describe("buildTeleportConnectorSegments", () => {
  const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 8, rows: 8 });
  const floors = [{ id: "f1" }, { id: "f2" }];
  const nodes = [
    { id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 3, y: 3, i: 0, level: 0 },
    { id: 2, x: 5, y: 5, i: 0, level: 1 }, { id: 3, x: 1, y: 1, i: 0, level: 1 },
  ] as NodeDto[];
  const tp = (from: number, to: number) => ({ from, to, kind: "teleport" }) as EdgeDto;
  const build = (edges: EdgeDto[]) => buildTeleportConnectorSegments({ nodes, edges, cfg, floors, avoidFieldExit: false, start: null, finish: null });

  it("joins the two teleport nodes of a same-floor teleport, two-way or one-way", () => {
    const twoWay = build([tp(0, 1), tp(1, 0)]).get("0:1")!;
    expect(twoWay).toMatchObject({ floorIndex: 0, oneWay: false });
    expect("node" in twoWay.from && "node" in twoWay.to).toBe(true);
    expect(build([tp(0, 1)]).get("0:1")).toMatchObject({ from: { node: 0 }, to: { node: 1 }, oneWay: true });
  });

  it("splits a two-way cross-floor teleport into one piece per floor, each ending in a badge on its own floor", () => {
    const segments = build([tp(1, 2), tp(2, 1)]);
    const onFloor0 = segments.get("1:2@1")!, onFloor1 = segments.get("1:2@2")!;
    expect(onFloor0).toMatchObject({ floorIndex: 0, oneWay: false });
    expect(onFloor1).toMatchObject({ floorIndex: 1, oneWay: false });
    const ends = (s: typeof onFloor0) => [s.from, s.to];
    expect(ends(onFloor0).filter((end) => "node" in end)).toEqual([{ node: 1 }]);
    expect(ends(onFloor0).filter((end) => "badge" in end)).toHaveLength(1);
    expect(ends(onFloor1).filter((end) => "node" in end)).toEqual([{ node: 2 }]);
    expect(ends(onFloor1).filter((end) => "badge" in end)).toHaveLength(1);
  });

  it("keeps the direction of a one-way cross-floor teleport: the badge is the far end on each floor", () => {
    const segments = build([tp(1, 2)]);
    const departure = segments.get("1:2@1")!, arrival = segments.get("1:2@2")!;
    expect(departure).toMatchObject({ from: { node: 1 }, oneWay: true });
    expect("badge" in departure.to).toBe(true);
    expect(arrival).toMatchObject({ to: { node: 2 }, oneWay: true });
    expect("badge" in arrival.from).toBe(true);
  });
});
