import { describe, it, expect } from "vitest";
import { computeTextFitGroups, fitAcrossGroups, type TextFitScopeInput } from "../components/features/textFitScopes";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS } from "../store/slices/imageExportDefaults";
import type { VectorByWallsSettings } from "../store/storeTypes";
import type { EdgeDto, NodeDto } from "../wasm/types";
import type { ExportZoneOverride } from "../store/zonesTypes";
import { fieldOf } from "./fieldConfigFixtures";

const nodes: NodeDto[] = [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 3, y: 0, i: 0 }];
const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
const cfg = fieldOf("square", { shape: "rect", cols: 6, rows: 6 });

const marker = (text: string, size: number) => ({ ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, text, size, textSize: 10, textMargin: 1, markerEnabled: true, textEnabled: true });
const settings: VectorByWallsSettings = {
  ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  startMarker: marker("S", 30),
  finishMarker: marker("F", 30),
};
// The zone holds the start cell and shrinks its marker plate.
const zoneOverride = (params: ExportZoneOverride["params"]): ExportZoneOverride => ({ id: 1, mode: "walls", zoneIds: [1], groupIds: [], params });
const zones = [{ id: 1, name: "Z", kind: "manual" as const, cells: [[0, 0, 0] as [number, number, number]] }];

const input = (overrides: ExportZoneOverride[], target: TextFitScopeInput<VectorByWallsSettings>["target"], effective = settings): TextFitScopeInput<VectorByWallsSettings> => ({
  nodes, edges, floors: [{ id: "f0" }], cfg, start: 0, finish: 1, settings: effective, mode: "walls", overrides, zones, groups: [], target,
});

describe("zone-aware auto-fit (GitHub issue #1040)", () => {
  const shrunk = zoneOverride({ "startMarker.size": 12 });

  it("keeps one group over the whole maze while no zone overrides anything", () => {
    const groups = computeTextFitGroups(input([], null));
    expect(groups).toHaveLength(1);
    expect(groups[0].items.start).toHaveLength(1);
    expect(groups[0].items.finish).toHaveLength(1);
  });

  it("fits the global size against the smaller plate of a zone that does not set its own size", () => {
    const withoutZone = fitAcrossGroups(computeTextFitGroups(input([], null)), ["start"])!;
    const groups = computeTextFitGroups(input([shrunk], null));
    expect(groups).toHaveLength(2);
    const global = fitAcrossGroups(groups, ["start"])!;
    expect(global).toBeLessThan(withoutZone);
    // The finish marker is outside the zone and keeps the global plate.
    expect(fitAcrossGroups(groups, ["finish"])).toBe(withoutZone);
  });

  it("leaves out a zone that sets its own font size: the global size never reaches it", () => {
    const own = zoneOverride({ "startMarker.size": 12, "startMarker.textSize": 6 });
    const groups = computeTextFitGroups(input([own], null));
    // The only start label sits in that zone, so no label is left for the global size to fit.
    expect(fitAcrossGroups(groups, ["start"])).toBeNull();
    expect(fitAcrossGroups(groups, ["finish"])).not.toBeNull();
  });

  it("in a zone's context counts only that zone's labels, with the zone's plate", () => {
    const effective = { ...settings, startMarker: { ...settings.startMarker, size: 12 } };
    const groups = computeTextFitGroups(input([shrunk], { kind: "zone", id: 1 }, effective));
    expect(groups).toHaveLength(1);
    expect(groups[0].items.start).toHaveLength(1);
    expect(groups[0].items.finish).toEqual([]);
    expect(fitAcrossGroups(groups, ["finish"])).toBeNull();
  });
});
