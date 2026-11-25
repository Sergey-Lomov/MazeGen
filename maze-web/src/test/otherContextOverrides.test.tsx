import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMazeStore } from "../store/mazeStore";
import type { ExportZoneOverride } from "../store/zonesTypes";
import type { Zone } from "../wasm/mazeService";
import { useOtherContextOverrides } from "../components/features/ExportZoneOverrides";

const zone = (id: number): Zone => ({ id, name: `Z${id}`, kind: "manual", cells: [[0, id, 0]] });
const override = (id: number, zoneIds: number[], params: ExportZoneOverride["params"]): ExportZoneOverride => ({ id, mode: "walls", zoneIds, groupIds: [], params });

describe("other contexts' overrides under a parameter (GitHub issue #1040)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      zones: [zone(1), zone(2)],
      zoneGroups: [],
      showZoneOverrideButtons: true,
      zoneOverrideDisplay: "always",
      exportOverrideContext: null,
      exportZoneOverrides: [override(1, [1], { wallColor: 0xff0000 }), override(2, [2], { wallColor: 0x00ff00, wallThickness: 3 })],
    });
  });

  it("lists the zones that set the parameter while editing the whole maze", () => {
    const { result } = renderHook(() => useOtherContextOverrides("walls"));
    expect(result.current?.entriesOf("wallColor").map((e) => [e.global, e.zoneIds, e.value])).toEqual([[false, [1], 0xff0000], [false, [2], 0x00ff00]]);
    expect(result.current?.entriesOf("wallThickness")).toHaveLength(1);
    expect(result.current?.entriesOf("cornerStyle")).toEqual([]);
  });

  it("lists the other zones and the whole maze inside a zone", () => {
    useMazeStore.setState({ exportOverrideContext: { kind: "zone", id: 1 } });
    const { result } = renderHook(() => useOtherContextOverrides("walls"));
    const entries = result.current?.entriesOf("wallColor") ?? [];
    expect(entries.map((e) => [e.global, e.zoneIds])).toEqual([[true, []], [false, [2]]]);
    expect(entries[0].value).toBe(useMazeStore.getState().vectorByWallsSettings.wallColor);
  });

  it("skips an override that has no zones left", () => {
    useMazeStore.setState({ exportZoneOverrides: [override(1, [1], { wallColor: 1 }), override(2, [99], { wallColor: 2 })] });
    const { result } = renderHook(() => useOtherContextOverrides("walls"));
    expect(result.current?.entriesOf("wallColor").map((e) => e.zoneIds)).toEqual([[1]]);
  });

  it("is off for the none display and while the zone switch is off", () => {
    useMazeStore.setState({ zoneOverrideDisplay: "none" });
    expect(renderHook(() => useOtherContextOverrides("walls")).result.current).toBeNull();
    useMazeStore.setState({ zoneOverrideDisplay: "always", showZoneOverrideButtons: false });
    expect(renderHook(() => useOtherContextOverrides("walls")).result.current).toBeNull();
  });

  it("lists the overrides of the corridors mode apart from the walls ones", () => {
    useMazeStore.setState({ exportZoneOverrides: [override(1, [1], { wallColor: 1 }), { ...override(2, [2], { color: 0x123456 }), mode: "corridors" }] });
    const { result } = renderHook(() => useOtherContextOverrides("corridors"));
    expect(result.current?.entriesOf("color").map((e) => [e.global, e.zoneIds, e.value])).toEqual([[false, [2], 0x123456]]);
    expect(result.current?.entriesOf("wallColor")).toEqual([]);
  });

  it("opens and closes a parameter's list on request", () => {
    useMazeStore.setState({ zoneOverrideDisplay: "onRequest" });
    const { result } = renderHook(() => useOtherContextOverrides("walls"));
    expect(result.current?.open.has("wallColor")).toBe(false);
    act(() => result.current?.toggle("wallColor"));
    expect(result.current?.open.has("wallColor")).toBe(true);
    act(() => result.current?.toggle("wallColor"));
    expect(result.current?.open.has("wallColor")).toBe(false);
  });
});
