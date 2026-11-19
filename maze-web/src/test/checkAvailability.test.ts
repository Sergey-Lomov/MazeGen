import { describe, it, expect, vi } from "vitest";

const getTessellationTraits = vi.hoisted(() => vi.fn());
vi.mock("../wasm/mazeService", () => ({ getTessellationTraits }));

import { checkUnavailableReason, unavailableReason } from "../components/features/checkAvailability";
import type { TessellationRequirement } from "../wasm/types";

const LIMITS: TessellationRequirement[] = [{ type: "regular_cells" }, { type: "max_cell_sides", max: 8 }];

describe("unavailableReason", () => {
  it("is available without requirements", () => {
    expect(unavailableReason(undefined, { irregular: true, maxCellSides: 50 })).toBeNull();
    expect(unavailableReason([], { irregular: true, maxCellSides: 50 })).toBeNull();
  });

  it("is available when every requirement holds", () => {
    expect(unavailableReason(LIMITS, { irregular: false, maxCellSides: 8 })).toBeNull();
  });

  it("names irregular cells", () => {
    expect(unavailableReason(LIMITS, { irregular: true, maxCellSides: 6 })).toEqual({ type: "irregular_tessellation" });
  });

  it("names the side limit a larger cell exceeds", () => {
    expect(unavailableReason(LIMITS, { irregular: false, maxCellSides: 12 })).toEqual({ type: "cell_sides_exceed", max: 8 });
  });

  it("reports the first failing requirement when several fail", () => {
    expect(unavailableReason(LIMITS, { irregular: true, maxCellSides: 12 })).toEqual({ type: "irregular_tessellation" });
    expect(unavailableReason([...LIMITS].reverse(), { irregular: true, maxCellSides: 12 })).toEqual({ type: "cell_sides_exceed", max: 8 });
  });
});

describe("checkUnavailableReason", () => {
  const SQUARE = { kind: "square", params: {} } as never;

  it("asks core once per tessellation config", () => {
    getTessellationTraits.mockReset();
    getTessellationTraits.mockReturnValue({ irregular: true, maxCellSides: 4 });
    const check = { requires: LIMITS };
    expect(checkUnavailableReason(check, SQUARE)).toEqual({ type: "irregular_tessellation" });
    expect(checkUnavailableReason(check, SQUARE)).toEqual({ type: "irregular_tessellation" });
    expect(getTessellationTraits).toHaveBeenCalledTimes(1);
  });

  it("does not ask core for a check without requirements", () => {
    getTessellationTraits.mockReset();
    expect(checkUnavailableReason({ requires: [] }, { kind: "hex", params: {} } as never)).toBeNull();
    expect(getTessellationTraits).not.toHaveBeenCalled();
  });

  it("reads a config core rejects as available instead of throwing", () => {
    getTessellationTraits.mockReset();
    getTessellationTraits.mockImplementation(() => { throw new Error("invalid params"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(checkUnavailableReason({ requires: LIMITS }, { kind: "voronoi", params: { bad: 1 } } as never)).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
