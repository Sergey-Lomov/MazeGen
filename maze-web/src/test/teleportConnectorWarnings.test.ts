import { describe, expect, it, vi } from "vitest";
import { computeTeleportConnectorWarningsAcrossFloors, computeVectorByCorridorsWarnings, computeVectorByWallsWarnings, computeVectorByWallsWarningsAcrossFloors, type ExportWarning, type ExportWarningId } from "../pixi/selectors/exportWarnings";
import { getCellCenter } from "../pixi/tessellationGeometry";
import type { ManualTeleportConnectorPath } from "../pixi/renderers/teleportConnectorManual";
import type { EdgeDto, NodeDto } from "../wasm/types";
import { corridorsSettings, squareCfg, wallsSettings } from "./exportWarningFixtures";
import type { VectorByWallsSettings } from "../store/storeTypes";

// GitHub issue #945 — warnings about the geometry of the drawn teleport connectors.

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

const n = (id: number, x: number, y: number): NodeDto => ({ id, x, y, i: 0 });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });
const teleport = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });
const center = (x: number, y: number): [number, number] => {
  const c = getCellCenter(x, y, squareCfg);
  return [c.x, c.y];
};

/** A row of four cells; cell `i` is node `i` at column `i`. */
const row = [n(0, 0, 0), n(1, 1, 0), n(2, 2, 0), n(3, 3, 0)];
const rowPassages = [e(0, 1), e(1, 0), e(1, 2), e(2, 1), e(2, 3), e(3, 2)];
/** A two-way connector between the two ends of the row. */
const endsPair = [teleport(0, 3), teleport(3, 0)];

const manual = (...paths: [string, ManualTeleportConnectorPath][]): Pick<VectorByWallsSettings, "manualTeleportConnectorPaths"> => ({ manualTeleportConnectorPaths: Object.fromEntries(paths) });
/** Row-0 cell center lifted `lift` display units off the row (the display y axis points down, so up is negative). */
const lifted = (x: number, lift: number): [number, number] => [center(x, 0)[0], center(x, 0)[1] - lift];
const polyline = (...nodes: [number, number][]): ManualTeleportConnectorPath => ({ mode: "polyline", nodes });

function run(settings: Partial<VectorByWallsSettings>, extra: EdgeDto[] = endsPair, nodes: NodeDto[] = row): ExportWarning[] {
  return computeVectorByWallsWarnings(nodes, [...rowPassages, ...extra], squareCfg, wallsSettings({ teleportMergeMode: false, ...settings }), null, null);
}
const ids = (warnings: ExportWarning[]): ExportWarningId[] => warnings.map((w) => w.id);
const has = (warnings: ExportWarning[], id: ExportWarningId) => ids(warnings).includes(id);

describe("teleport connector warnings (GitHub issue #945)", () => {
  it("stays silent for an ordinary connector", () => {
    const found = run({ teleportConnectorStyle: "straight" }).filter((w) => w.id.startsWith("teleport_connector"));
    expect(ids(found)).toEqual([]);
  });

  it("is silent while connectors are off", () => {
    const warnings = run({ teleportConnectorStyle: "none", ...manual(["0:3", polyline([20, 20], [20, 20])]) });
    expect(ids(warnings).filter((id) => id.startsWith("teleport_connector"))).toEqual([]);
  });

  describe("overlap", () => {
    it("flags collinear connectors lying over each other", () => {
      const warnings = run({ teleportConnectorStyle: "straight" }, [...endsPair, teleport(1, 2), teleport(2, 1)]);
      const overlap = warnings.find((w) => w.id === "teleport_connectors_overlap");
      expect(overlap).toBeDefined();
      expect(overlap!.floorPolygons!.length).toBeGreaterThan(0);
      expect(overlap!.floorPolygons!.every((shape) => shape.floorIndex === 0 && shape.polygon.length >= 3)).toBe(true);
    });

    it("flags slightly tilted lines a few units apart, within the reach of the line and its gap", () => {
      const nodes = [...row, n(4, 0, 2), n(5, 3, 2)];
      const warnings = run(manual(
        ["0:3", polyline([20, 20], [120, 20])],
        ["4:5", polyline([20, 23], [120, 24])],
      ), [...endsPair, teleport(4, 5), teleport(5, 4)], nodes);
      expect(has(warnings, "teleport_connectors_overlap")).toBe(true);
    });

    it("shapes the highlight along the connector drawn on top", () => {
      const nodes = [...row, n(4, 0, 2), n(5, 3, 2)];
      const warnings = run(manual(
        ["0:3", polyline([20, 20], [120, 20])],
        ["4:5", polyline([20, 23], [120, 24])],
      ), [...endsPair, teleport(4, 5), teleport(5, 4)], nodes);
      const points = warnings.find((w) => w.id === "teleport_connectors_overlap")!.floorPolygons!.flatMap((shape) => shape.polygon);
      const meanY = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      // Group "4:5" sorts after "0:3", so it is drawn later: the shape follows its line (y 23..24), not the one below (y 20).
      expect(meanY).toBeGreaterThan(21.75);
    });

    it("does not flag connectors on separate rows", () => {
      const nodes = [...row, n(4, 0, 2), n(5, 3, 2)];
      const warnings = run({ teleportConnectorStyle: "straight" }, [...endsPair, teleport(4, 5), teleport(5, 4)], nodes);
      expect(has(warnings, "teleport_connectors_overlap")).toBe(false);
    });

    it("does not flag connectors that merely cross", () => {
      const nodes = [n(0, 0, 0), n(1, 2, 2), n(2, 2, 0), n(3, 0, 2)];
      const warnings = run({ teleportConnectorStyle: "straight" }, [teleport(0, 1), teleport(1, 0), teleport(2, 3), teleport(3, 2)], nodes);
      expect(has(warnings, "teleport_connectors_overlap")).toBe(false);
    });
  });

  describe("detached endpoint", () => {
    it("is silent for a manual path that starts and ends on its markers", () => {
      const warnings = run(manual(["0:3", polyline(center(0, 0), lifted(0, 35), lifted(3, 35), center(3, 0))]));
      expect(has(warnings, "teleport_connector_endpoint_detached")).toBe(false);
    });

    it("flags an end dragged off its marker", () => {
      const warnings = run(manual(["0:3", polyline(lifted(0, 35), lifted(3, 35), center(3, 0))]));
      expect(has(warnings, "teleport_connector_endpoint_detached")).toBe(true);
    });

    it("never flags an automatically routed connector", () => {
      expect(has(run({ teleportConnectorStyle: "orthogonal" }), "teleport_connector_endpoint_detached")).toBe(false);
    });
  });

  describe("leaves the field", () => {
    const outside = manual(["0:3", polyline(center(0, 0), lifted(0, 60), lifted(3, 60), center(3, 0))]);

    it("flags a connector outside the field while \"avoid field exit\" is on", () => {
      expect(has(run({ teleportAvoidFieldExit: true, ...outside }), "teleport_connector_leaves_field")).toBe(true);
    });

    it("marks a run that spans several segments as one shape", () => {
      const found = run({ teleportAvoidFieldExit: true, ...outside }).find((w) => w.id === "teleport_connector_leaves_field");
      expect(found!.floorPolygons).toHaveLength(1);
    });

    it("is silent when the option is off", () => {
      expect(has(run({ teleportAvoidFieldExit: false, ...outside }), "teleport_connector_leaves_field")).toBe(false);
    });

    it("is silent for a connector inside the field", () => {
      expect(has(run({ teleportAvoidFieldExit: true, teleportConnectorStyle: "straight" }), "teleport_connector_leaves_field")).toBe(false);
    });
  });

  describe("crosses a marker", () => {
    it("flags a straight connector running over another teleport's marker", () => {
      const warnings = run({ teleportConnectorStyle: "straight" }, [...endsPair, teleport(1, 2), teleport(2, 1)]);
      expect(has(warnings, "teleport_connector_crosses_marker")).toBe(true);
    });

    it("never counts the connector's own end markers", () => {
      expect(has(run({ teleportConnectorStyle: "straight" }), "teleport_connector_crosses_marker")).toBe(false);
    });

    it("goes away once the connector is routed around the marker by hand", () => {
      const around = manual(["0:3", polyline(center(0, 0), lifted(0, 35), lifted(3, 35), center(3, 0))]);
      const warnings = run({ teleportConnectorStyle: "straight", ...around }, [...endsPair, teleport(1, 2), teleport(2, 1)]);
      expect(has(warnings, "teleport_connector_crosses_marker")).toBe(false);
    });
  });

  describe("arrow", () => {
    const oneWay = [teleport(0, 3)];

    it("flags an arrow that does not fit on a short manual line", () => {
      const warnings = run({ teleportArrowMode: "center", teleportArrowSize: 10, ...manual(["0:3", polyline([20, 20], [28, 20])]) }, oneWay);
      expect(has(warnings, "teleport_connector_arrow_sticks_out")).toBe(true);
    });

    it("is silent for an arrow on a long straight line", () => {
      const warnings = run({ teleportConnectorStyle: "straight", teleportArrowMode: "center", teleportArrowSize: 10 }, oneWay);
      expect(has(warnings, "teleport_connector_arrow_sticks_out")).toBe(false);
    });

    it("is silent without arrows", () => {
      const warnings = run({ teleportArrowMode: "none", ...manual(["0:3", polyline([20, 20], [28, 20])]) }, oneWay);
      expect(has(warnings, "teleport_connector_arrow_sticks_out")).toBe(false);
      expect(has(warnings, "teleport_connector_too_short_for_arrow")).toBe(false);
    });

    it("flags a one-way connector too short for its arrow between the markers", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const warnings = run({ teleportConnectorStyle: "straight", teleportArrowMode: "center", teleportArrowSize: 60 }, [teleport(0, 1)], nodes);
      expect(has(warnings, "teleport_connector_too_short_for_arrow")).toBe(true);
    });

    it("does not flag a two-way connector", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const warnings = run({ teleportConnectorStyle: "straight", teleportArrowMode: "center", teleportArrowSize: 60 }, [teleport(0, 1), teleport(1, 0)], nodes);
      expect(has(warnings, "teleport_connector_too_short_for_arrow")).toBe(false);
    });
  });

  describe("covers another connector's arrow", () => {
    const settings: Partial<VectorByWallsSettings> = { teleportConnectorStyle: "straight", teleportArrowMode: "center", teleportArrowSize: 10 };
    const oneWay = [teleport(0, 3)];
    /** A two-way connector crossing the row between cells 1 and 2, where the one-way connector's centered arrow sits. */
    const crossing = (nodes: NodeDto[]): [NodeDto[], EdgeDto[]] => [[...row, ...nodes], [...oneWay, teleport(4, 5), teleport(5, 4)]];

    it("flags a connector running over the arrow", () => {
      const [nodes, extra] = crossing([n(4, 1, 1), n(5, 2, -1)]);
      const found = run(settings, extra, nodes).find((w) => w.id === "teleport_connector_covers_arrow");
      expect(found).toBeDefined();
      expect(found!.floorPolygons!.every((shape) => shape.floorIndex === 0 && shape.polygon.length === 3)).toBe(true);
    });

    it("is silent when the arrow is drawn above the other connector", () => {
      // Groups draw in node-pair key order: the crossing connector (nodes 0-1) goes first, the one-way connector (nodes 2-3) over it.
      const nodes = [n(0, 1, 1), n(1, 2, -1), n(2, 0, 0), n(3, 3, 0)];
      const warnings = run(settings, [teleport(0, 1), teleport(1, 0), teleport(2, 3)], nodes);
      expect(has(warnings, "teleport_connector_covers_arrow")).toBe(false);
    });

    it("is silent when the other connector stays clear of the arrow", () => {
      const [nodes, extra] = crossing([n(4, 0, 2), n(5, 3, 2)]);
      expect(has(run(settings, extra, nodes), "teleport_connector_covers_arrow")).toBe(false);
    });

    it("is silent without arrows", () => {
      const [nodes, extra] = crossing([n(4, 1, 1), n(5, 2, -1)]);
      expect(has(run({ ...settings, teleportArrowMode: "none" }, extra, nodes), "teleport_connector_covers_arrow")).toBe(false);
    });

    it("never flags a connector against its own arrow", () => {
      expect(has(run(settings, oneWay), "teleport_connector_covers_arrow")).toBe(false);
    });
  });

  describe("degenerate", () => {
    it("flags a manual connector collapsed to a point", () => {
      const warnings = run(manual(["0:3", polyline([20, 20], [20, 20])]));
      expect(has(warnings, "teleport_connector_degenerate")).toBe(true);
    });

    it("is silent for an ordinary connector", () => {
      expect(has(run({ teleportConnectorStyle: "straight" }), "teleport_connector_degenerate")).toBe(false);
    });
  });

  describe("connector over a one-way passage (teleport_connector_covers_one_way)", () => {
    const withOneWay = [...row];
    const passages = [e(0, 1), e(1, 0), e(1, 2), e(2, 3), e(3, 2)];
    const compute = (settings: Partial<VectorByWallsSettings>) =>
      computeVectorByWallsWarnings(withOneWay, [...passages, ...endsPair], squareCfg, wallsSettings({ teleportMergeMode: false, ...settings }), null, null);

    it("fires for the automatic connector", () => {
      expect(has(compute({ teleportConnectorStyle: "straight" }), "teleport_connector_covers_one_way")).toBe(true);
    });

    it("disappears once the connector is routed around the indicator by hand", () => {
      const around = manual(["0:3", polyline(center(0, 0), lifted(0, 35), lifted(3, 35), center(3, 0))]);
      expect(has(compute({ teleportConnectorStyle: "straight", ...around }), "teleport_connector_covers_one_way")).toBe(false);
    });
  });

  it("reports in Vector by corridors too", () => {
    const warnings = computeVectorByCorridorsWarnings(
      row, [...rowPassages, ...endsPair], squareCfg,
      corridorsSettings({ teleportMergeMode: false, ...manual(["0:3", polyline([20, 20], [20, 20])]) }), null, null,
    );
    expect(has(warnings, "teleport_connector_degenerate")).toBe(true);
  });
});

describe("computeTeleportConnectorWarningsAcrossFloors (GitHub issue #952)", () => {
  const floors = [{ id: "f0", title: "F0" }];
  const settings = wallsSettings({ teleportMergeMode: false, teleportConnectorStyle: "straight", ...manual(["0:3", polyline([20, 20], [20, 20])]) });
  const args: Parameters<typeof computeTeleportConnectorWarningsAcrossFloors> = [row, [...rowPassages, ...endsPair], floors, squareCfg, settings, null, null];

  it("returns the connector warnings of the full pass and nothing else", () => {
    const only = computeTeleportConnectorWarningsAcrossFloors(...args);
    const full = computeVectorByWallsWarningsAcrossFloors(...args);

    expect(ids(only)).toContain("teleport_connector_degenerate");
    expect(ids(only)).toEqual(ids(full).filter((id) => id.startsWith("teleport_connector") && !id.includes("low_contrast")));
  });

  it("keeps its merged list across an interleaved full pass", () => {
    const first = computeTeleportConnectorWarningsAcrossFloors(...args);
    computeVectorByWallsWarningsAcrossFloors(...args);

    expect(computeTeleportConnectorWarningsAcrossFloors(...args)).toBe(first);
  });
});
