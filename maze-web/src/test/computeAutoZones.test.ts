import { beforeEach, describe, expect, it, vi } from "vitest";

const compute = vi.fn();
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<object>()),
  getWasm: () => ({ zones_compute_auto: compute }),
}));

import { computeAutoZones } from "../wasm/mazeService";

const tessellation = { kind: "square", params: {} } as never;
const request = (cells: [number, number][], folded = false) => ({
  tessellation,
  floors: [{ cells, creases: [], folded }],
});

describe("computeAutoZones", () => {
  beforeEach(() => {
    compute.mockReset();
    compute.mockReturnValue([["maze", new Int32Array([0, 0, 0, 0, 1, 0])]]);
  });

  it("sends the cells flat and unpacks the answer into triples", () => {
    const zones = computeAutoZones(request([[0, 0], [1, 0]], true));
    const [meta, flat] = compute.mock.calls[0];
    expect(meta.floors).toEqual([{ count: 2, creases: [], folded: true }]);
    expect(Array.from(flat as Int32Array)).toEqual([0, 0, 1, 0]);
    expect(zones).toEqual([{ key: "maze", cells: [[0, 0, 0], [0, 1, 0]] }]);
  });

  it("answers an identical request without calling wasm again, and a changed one with a new call", () => {
    computeAutoZones(request([[5, 5]]));
    computeAutoZones(request([[5, 5]]));
    expect(compute).toHaveBeenCalledTimes(1);
    computeAutoZones(request([[5, 6]]));
    expect(compute).toHaveBeenCalledTimes(2);
    computeAutoZones(request([[5, 6]], true));
    expect(compute).toHaveBeenCalledTimes(3);
  });
});
