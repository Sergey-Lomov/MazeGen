import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import type { ExportZoneOverride } from "../store/zonesTypes";
import { buildExportZoneValues, exportOverrideConflicts, exportOverrideWarningCount, exportParamConflicts, isExportOverridable, linkEnabledPath, settingsWithOverride } from "../store/exportZoneOverrides";
import { effectiveCorridorsSettings, effectiveWallsSettings, zoneLinkToggleChanges } from "../store/exportZoneContext";
import { computeImageExportCard } from "../components/FeaturesPanel";
import { parseAndValidate } from "../store/projectExport";
import { makeState, reparse, toJson } from "./projectExportKit";

const zone = (id: number, cells: Zone["cells"]): Zone => ({ id, name: `Z${id}`, kind: "manual", cells });
const override = (id: number, zoneIds: number[], params: ExportZoneOverride["params"], groupIds: number[] = [], mode: ExportZoneOverride["mode"] = "walls"): ExportZoneOverride => ({ id, mode, zoneIds, groupIds, params });

describe("export zone overrides (GitHub issue #1040)", () => {
  const zones = [zone(1, [[0, 0, 0], [0, 1, 0]]), zone(2, [[0, 1, 0], [0, 2, 0]]), zone(3, [[0, 9, 9]])];
  const groups = [{ id: 7, name: "G", zoneIds: [2, 3] }];

  it("flags one parameter set to different values on a shared cell", () => {
    const conflicts = exportOverrideConflicts([override(1, [1], { wallColor: 1 }), override(2, [2], { wallColor: 2 })], zones, groups);
    expect(conflicts.get(1)).toEqual([{ otherId: 2, params: ["wallColor"] }]);
  });

  it("groups conflicts by parameter, not by zone pair", () => {
    const shared = [zone(1, [[0, 0, 0], [0, 1, 0]]), zone(2, [[0, 1, 0]]), zone(4, [[0, 1, 0]])];
    const three = exportParamConflicts([override(1, [1], { wallColor: 1 }), override(2, [2], { wallColor: 2 }), override(3, [4], { wallColor: 3 })], shared, []);
    expect(three).toHaveLength(1);
    expect(three[0]).toMatchObject({ path: "wallColor", zoneIds: [1, 2, 4] });
    const two = exportParamConflicts([override(1, [1], { wallColor: 1, wallThickness: 1 }), override(2, [2], { wallColor: 2, wallThickness: 2 })], shared, []);
    expect(two.map((c) => c.path).sort()).toEqual(["wallColor", "wallThickness"]);
  });

  it("does not flag the same value, other parameters or disjoint cells", () => {
    expect(exportOverrideConflicts([override(1, [1], { wallColor: 1 }), override(2, [2], { wallColor: 1 })], zones, groups).size).toBe(0);
    expect(exportOverrideConflicts([override(1, [1], { wallColor: 1 }), override(2, [2], { wallThickness: 3 })], zones, groups).size).toBe(0);
    expect(exportOverrideConflicts([override(1, [1], { wallColor: 1 }), override(2, [3], { wallColor: 2 })], zones, groups).size).toBe(0);
  });

  it("counts overrides with no zones or with a conflict", () => {
    const list = [override(1, [1], { wallColor: 1 }), override(2, [2], { wallColor: 2 }), override(3, [99], { wallThickness: 4 }), override(4, [3], { wallThickness: 4 })];
    expect(exportOverrideWarningCount(list, zones, groups)).toBe(3);
  });

  const link = (source: string, target: string, enabled = true) => ({ id: `${source}>${target}`, source, target, enabled });
  const settings = { wallColor: 1, wallThickness: 2, markerFillColor: 3, startMarker: { fillColor: 3, size: 5 }, finishMarker: { fillColor: 3 }, links: [link("markerFillColor", "startMarker.fillColor"), link("markerFillColor", "finishMarker.fillColor", false)] };

  it("applies a zone's own parameters only to the cells of that zone", () => {
    const values = buildExportZoneValues([override(1, [1], { wallColor: 9 })], "walls", zones, groups, settings);
    expect(values.settingsAt(0, [[0, 0]]).wallColor).toBe(9);
    expect(values.settingsAt(0, [[0, 0]]).wallThickness).toBe(2);
    expect(values.settingsAt(0, [[5, 5]])).toBe(settings);
    expect(values.settingsAt(1, [[0, 0]])).toBe(settings);
  });

  it("takes the dependents of an overridden source along, through enabled links only", () => {
    const values = buildExportZoneValues([override(1, [1], { markerFillColor: 7 })], "walls", zones, groups, settings);
    const zoned = values.settingsAt(0, [[0, 0]]);
    expect(zoned.startMarker).toEqual({ fillColor: 7, size: 5 });
    expect(zoned.finishMarker.fillColor).toBe(3);
  });

  it("turns a link off for a zone alone: its target stops following the zone's source", () => {
    const values = buildExportZoneValues([override(1, [1], { markerFillColor: 7, [linkEnabledPath("startMarker.fillColor")]: false })], "walls", zones, groups, settings);
    expect(values.settingsAt(0, [[0, 0]]).startMarker.fillColor).toBe(3);
    expect(values.settingsAt(0, [[0, 0]]).links.find((l) => l.target === "startMarker.fillColor")?.enabled).toBe(false);
    expect(settings.links[0].enabled).toBe(true);
  });

  it("turns a globally disabled link on for a zone: its target follows the source there", () => {
    const values = buildExportZoneValues([override(1, [1], { [linkEnabledPath("finishMarker.fillColor")]: true })], "walls", zones, groups, settings);
    expect(values.settingsAt(0, [[0, 0]]).finishMarker.fillColor).toBe(3);
    const withSource = buildExportZoneValues([override(1, [1], { markerFillColor: 7, [linkEnabledPath("finishMarker.fillColor")]: true })], "walls", zones, groups, settings);
    expect(withSource.settingsAt(0, [[0, 0]]).finishMarker.fillColor).toBe(7);
    expect(withSource.settingsAt(0, [[5, 5]])).toBe(settings);
  });

  it("judges one override alone: the global settings with that override's parameters", () => {
    const own = settingsWithOverride("walls", settings, override(1, [1], { wallColor: 9, background: 5 }));
    expect(own.wallColor).toBe(9);
    expect(own.wallThickness).toBe(2);
    expect(settingsWithOverride("walls", settings, override(1, [1], {}))).toBe(settings);
  });

  it("flags overlapping zones that set the same link differently", () => {
    const flag = linkEnabledPath("startMarker.fillColor");
    expect(exportOverrideConflicts([override(1, [1], { [flag]: false }), override(2, [2], { [flag]: true })], zones, groups).get(1)).toEqual([{ otherId: 2, params: [flag] }]);
  });

  it("lets a parameter the zone sets itself beat the link into it", () => {
    const values = buildExportZoneValues([override(1, [1], { markerFillColor: 7, "startMarker.fillColor": 9 })], "walls", zones, groups, settings);
    expect(values.settingsAt(0, [[0, 0]]).startMarker.fillColor).toBe(9);
    expect(values.settingsAt(0, [[0, 0]]).links.find((l) => l.target === "startMarker.fillColor")?.enabled).toBe(false);
  });

  it("ignores overrides of another mode and of parameters that stay global", () => {
    const list = [override(1, [1], { wallColor: 1 }, [], "corridors"), override(2, [1], { background: 3 })];
    expect(buildExportZoneValues(list, "walls", zones, groups, settings).any).toBe(false);
    expect(exportOverrideConflicts([override(1, [1], { wallColor: 1 }), override(2, [1], { wallColor: 2 }, [], "corridors")], zones, groups).size).toBe(0);
  });

  it("knows a source is overridable once a link carries it to a drawn parameter", () => {
    expect(isExportOverridable("walls", "background")).toBe(false);
    expect(isExportOverridable("walls", "background", [link("background", "wallColor")])).toBe(true);
    expect(isExportOverridable("walls", "markerFillColor", [])).toBe(true);
    expect(isExportOverridable("walls", "teleportMarker.size")).toBe(true);
    expect(isExportOverridable("walls", "floorLabel.enabled")).toBe(false);
    expect(isExportOverridable("corridors", "thickness")).toBe(true);
    expect(isExportOverridable("corridors", "splitNodeColors")).toBe(false);
    expect(isExportOverridable("corridors", "color")).toBe(true);
  });

  it("picks the value of the smallest zone id, also through a group", () => {
    const values = buildExportZoneValues([override(1, [], { wallColor: 5 }, [7]), override(2, [1], { wallColor: 9 })], "walls", zones, groups, settings);
    expect(values.any).toBe(true);
    expect(values.settingsAt(0, [[0, 0]]).wallColor).toBe(9);
    expect(values.settingsAt(0, [[2, 0]]).wallColor).toBe(5);
    expect(values.settingsAt(0, [[1, 0]]).wallColor).toBe(9);
    expect(values.settingsAt(0, [[0, 0], [2, 0]]).wallColor).toBe(9);
  });

  it("marks the export card with a warning only while an override has a problem", () => {
    const mode = { label: () => "Walls" };
    expect(computeImageExportCard(true, mode, 0).status).toBe("set");
    expect(computeImageExportCard(true, mode, 1).status).toBe("warning");
  });

  describe("store", () => {
    beforeEach(() => {
      useMazeStore.setState({ ...zonesInitialState, zones: [zone(1, [[0, 0, 0]]), zone(2, [[0, 1, 0]])], zoneGroups: [{ id: 7, name: "G", zoneIds: [1, 2] }], nextZoneId: 3 });
    });

    const walls = (changes: Record<string, number | null>, id = 1) => useMazeStore.getState().setExportZoneParams("walls", { kind: "zone", id }, changes);

    it("creates, edits and drops the override of a target", () => {
      walls({ wallColor: 3 });
      walls({ wallThickness: 2 }, 2);
      useMazeStore.getState().setExportZoneParams("walls", { kind: "group", id: 99 }, { wallColor: 1 });
      expect(useMazeStore.getState().exportZoneOverrides).toEqual([
        { id: 1, mode: "walls", zoneIds: [1], groupIds: [], params: { wallColor: 3 } },
        { id: 2, mode: "walls", zoneIds: [2], groupIds: [], params: { wallThickness: 2 } },
      ]);
      walls({ wallColor: 8, wallThickness: 4 });
      expect(useMazeStore.getState().exportZoneOverrides[0].params).toEqual({ wallColor: 8, wallThickness: 4 });
      walls({ wallColor: null, wallThickness: null });
      expect(useMazeStore.getState().exportZoneOverrides.map((o) => o.id)).toEqual([2]);
    });

    it("drops a deleted zone or group from the overrides and leaves its context", () => {
      walls({ wallColor: 3 });
      useMazeStore.getState().setExportZoneParams("walls", { kind: "group", id: 7 }, { wallColor: 4 });
      useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
      useMazeStore.getState().removeZone(1);
      expect(useMazeStore.getState().exportZoneOverrides.map((o) => o.zoneIds)).toEqual([[], []]);
      expect(useMazeStore.getState().exportOverrideContext).toBeNull();
      useMazeStore.getState().setExportOverrideContext({ kind: "group", id: 7 });
      useMazeStore.getState().removeZoneGroup(7);
      expect(useMazeStore.getState().exportZoneOverrides.map((o) => o.groupIds)).toEqual([[], []]);
      expect(useMazeStore.getState().exportOverrideContext).toBeNull();
    });

    describe("zone context", () => {
      const globalSettings = () => useMazeStore.getState().vectorByWallsSettings;
      beforeEach(() => {
        const base = useMazeStore.getState().vectorByWallsSettings;
        useMazeStore.setState({ exportZoneOverrides: [], nextExportZoneOverrideId: 1, exportOverrideContext: null, showZoneOverrideButtons: true, vectorByWallsSettings: { ...base, links: base.links.map((l) => (l.target === "startMarker.fillColor" ? { ...l, enabled: true } : l)) } });
      });

      it("writes an edit into the zone's override and leaves the global settings alone", () => {
        const before = globalSettings();
        useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
        useMazeStore.getState().setVectorByWallsWallColor(0xff0000);
        expect(globalSettings()).toBe(before);
        expect(useMazeStore.getState().exportZoneOverrides.map((o) => o.params)).toEqual([{ wallColor: 0xff0000 }]);
      });

      it("sets a source as the zone's own value and lets the dependents follow it", () => {
        useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
        useMazeStore.getState().patchVectorByWallsSharedStyle({ markerFillColor: 0x00ff00 });
        expect(useMazeStore.getState().exportZoneOverrides.map((o) => o.params)).toEqual([{ markerFillColor: 0x00ff00 }]);
        expect(effectiveWallsSettings(useMazeStore.getState()).startMarker.fillColor).toBe(0x00ff00);
      });

      it("lets a zone turn the random wall colour on and pick its mode", () => {
        expect(isExportOverridable("walls", "randomWallColorMode")).toBe(true);
        useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
        useMazeStore.getState().setVectorByWallsRandomWallColorMode("per_segment");
        expect(globalSettings().randomWallColorMode).toBe("off");
        expect(useMazeStore.getState().exportZoneOverrides[0].params).toEqual({ randomWallColorMode: "per_segment" });
        expect(effectiveWallsSettings(useMazeStore.getState()).randomWallColorMode).toBe("per_segment");
      });

      it("keeps a parameter in the zone when it is set to the global value", () => {
        useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
        useMazeStore.getState().setVectorByWallsWallColor(0xff0000);
        useMazeStore.getState().setVectorByWallsWallColor(globalSettings().wallColor);
        expect(useMazeStore.getState().exportZoneOverrides[0].params).toEqual({ wallColor: globalSettings().wallColor });
      });

      it("turns a link off for the zone and keeps the value, then back on with the global state", () => {
        const s = useMazeStore.getState();
        s.setExportOverrideContext({ kind: "zone", id: 1 });
        const flag = linkEnabledPath("startMarker.fillColor");
        useMazeStore.getState().setExportZoneParams("walls", { kind: "zone", id: 1 }, zoneLinkToggleChanges(useMazeStore.getState(), "startMarker.fillColor", false));
        expect(useMazeStore.getState().exportZoneOverrides[0].params).toEqual({ [flag]: false });
        expect(effectiveWallsSettings(useMazeStore.getState()).links.find((l) => l.target === "startMarker.fillColor")?.enabled).toBe(false);
        useMazeStore.getState().setExportZoneParams("walls", { kind: "zone", id: 1 }, zoneLinkToggleChanges(useMazeStore.getState(), "startMarker.fillColor", true));
        expect(useMazeStore.getState().exportZoneOverrides).toEqual([]);
      });

      it("writes a corridors edit into the zone's corridors override while that panel is open", () => {
        const before = useMazeStore.getState().vectorByCorridorsSettings;
        useMazeStore.setState({ activeRenderMode: "vector_by_corridors" });
        useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
        useMazeStore.getState().setVectorByCorridorsColor(0xff0000);
        expect(useMazeStore.getState().vectorByCorridorsSettings).toBe(before);
        expect(useMazeStore.getState().vectorByWallsSettings).toBe(globalSettings());
        expect(useMazeStore.getState().exportZoneOverrides.map((o) => [o.mode, o.params])).toEqual([["corridors", { color: 0xff0000 }]]);
        expect(effectiveCorridorsSettings(useMazeStore.getState()).color).toBe(0xff0000);
        useMazeStore.setState({ activeRenderMode: null });
      });

      it("keeps the split identity parameters global in the corridors mode", () => {
        for (const path of ["splitNodeColors", "splitSpecialShapes"]) expect(isExportOverridable("corridors", path)).toBe(false);
        for (const path of ["thickness", "join", "junctionRadius", "renderStyle", "color", "oneWayColor", "startMarker.fillColor", "markerWidenPadding", "markerIndex.enabled"]) {
          expect(isExportOverridable("corridors", path)).toBe(true);
        }
      });

      it("writes a corridor thickness edit into the zone's override", () => {
        useMazeStore.setState({ activeRenderMode: "vector_by_corridors" });
        useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
        const before = useMazeStore.getState().vectorByCorridorsSettings.thickness;
        useMazeStore.getState().setVectorByCorridorsThickness(before + 3);
        expect(useMazeStore.getState().vectorByCorridorsSettings.thickness).toBe(before);
        expect(useMazeStore.getState().exportZoneOverrides[0]?.params).toMatchObject({ thickness: before + 3 });
        useMazeStore.setState({ activeRenderMode: null });
      });

      it("edits the global settings while the zone switch is off", () => {
        useMazeStore.getState().setExportOverrideContext({ kind: "zone", id: 1 });
        useMazeStore.setState({ showZoneOverrideButtons: false });
        useMazeStore.getState().setVectorByWallsWallColor(0xff0000);
        expect(globalSettings().wallColor).toBe(0xff0000);
        expect(useMazeStore.getState().exportZoneOverrides).toEqual([]);
      });
    });
  });

  it("round-trips through the project file together with the buttons switch", () => {
    const state = makeState({
      zones: [zone(1, [[0, 0, 0]])], nextZoneId: 2,
      exportZoneOverrides: [override(4, [1], { wallColor: 0x123456, wallThickness: 6 })], nextExportZoneOverrideId: 5,
      showZoneOverrideButtons: false,
      showZoneProblems: false,
      zoneOverrideDisplay: "always",
    });
    const file = reparse(state);
    expect(file.zones?.exportOverrides).toEqual([override(4, [1], { wallColor: 0x123456, wallThickness: 6 })]);
    expect(file.zones?.nextExportOverrideId).toBe(5);
    expect(file.imageExport.showZoneOverrideButtons).toBe(false);
    expect(file.imageExport.showZoneProblems).toBe(false);
    expect(file.imageExport.zoneOverrideDisplay).toBe("always");
  });

  it("rejects an export override with a bad mode or value in a file", () => {
    const json = toJson(makeState({ zones: [zone(1, [[0, 0, 0]])], nextZoneId: 2, exportZoneOverrides: [override(1, [1], { wallColor: 1 })], nextExportZoneOverrideId: 2 }));
    json.zones.exportOverrides[0].params = { wallColor: { nested: 1 } };
    expect(() => parseAndValidate(json)).toThrow(/expected a number, boolean or string/);
    json.zones.exportOverrides[0].params = { wallColor: 1 };
    json.zones.exportOverrides[0].mode = "bogus";
    expect(() => parseAndValidate(json)).toThrow(/mode/);
  });
});
