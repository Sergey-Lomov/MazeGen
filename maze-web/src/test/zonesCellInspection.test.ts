import { afterEach, describe, expect, it } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { resolveCellInspection } from "../pixi/cellInspectionResolver";
import { resolveCells } from "../pixi/fieldEditUtils";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";

function firstFieldCell(): [number, number] {
  const st = useMazeStore.getState();
  const field = st.floorFields[st.activeFloorId];
  return resolveCells(field.fieldConfig, undefined, st.smoothPrimitives)[0];
}

describe("resolveCellInspection: zones card", () => {
  afterEach(() => useMazeStore.setState({ openCard: "basic_config", ...zonesInitialState }));

  it("lists the zones of an in-field cell and stays bare for a cell outside the field", () => {
    const [x, y] = firstFieldCell();
    const zones: Zone[] = [{ id: 1, name: "Z", kind: "manual", cells: [[0, x, y], [0, 9999, 9999]] }];
    useMazeStore.setState({ openCard: "zones", zones });
    const st = useMazeStore.getState();
    expect(resolveCellInspection(st, x, y)).toBe(`x:${x}, y:${y} | Z`);
    expect(resolveCellInspection(st, 9999, 9999)).toBe("x:9999, y:9999");
  });
});
