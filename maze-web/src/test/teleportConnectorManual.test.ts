import { describe, expect, it } from "vitest";
import { TeleportConnectorRouter } from "../pixi/renderers/teleportConnectorRouter";
import { routeTeleportConnectors } from "../pixi/renderers/teleportConnectorPlan";
import { curveControls, editableCurvePoints, manualConnectorPoints, parseTeleportConnectorKey, sampleCubicPath, straightCubicControls, teleportConnectorKey } from "../pixi/renderers/teleportConnectorManual";
import { DEFAULT_MAZE_RENDER_STYLE } from "../pixi/defaultMazeRenderStyle";
import type { TeleportEdge } from "../pixi/renderers/types";

const edge = (from: [number, number], to: [number, number], fromNode: number, toNode: number): TeleportEdge =>
  ({ from, to, fromNode, toNode, oneWay: false });

describe("manual teleport connector paths", () => {
  it("uses an unordered node-pair key and retains authored endpoint positions", () => {
    const forward = edge([0, 0], [40, 40], 7, 3);
    expect(teleportConnectorKey(forward)).toBe("3:7");
    expect(manualConnectorPoints(forward, { "3:7": { nodes: [[4, 5], [20, 0], [20, 40], [42, 43]] } })).toEqual([4, 5, 20, 0, 20, 40, 42, 43]);
  });

  it("keys each floor's piece of a cross-floor pair separately (GitHub issue #989)", () => {
    // Floor A sees node 7 as its marker and the badge as `to`; floor B sees the badge as `from`.
    const onA = { ...edge([0, 0], [40, 40], 7, 3), toFloor: 1 };
    const onB = { ...edge([40, 40], [90, 90], 7, 3), fromFloor: 0 };
    expect(teleportConnectorKey(onA)).toBe("3:7@7");
    expect(teleportConnectorKey(onB)).toBe("3:7@3");
    const paths = { "3:7@7": { nodes: [[0, 0], [20, 0], [40, 40]] as [number, number][] }, "3:7@3": { nodes: [[40, 40], [90, 40], [90, 90]] as [number, number][] } };
    expect(manualConnectorPoints(onA, paths)).toEqual([0, 0, 20, 0, 40, 40]);
    expect(manualConnectorPoints(onB, paths)).toEqual([40, 40, 90, 40, 90, 90]);
    // The legacy single-path key no longer applies to a cross-floor edge.
    expect(manualConnectorPoints(onA, { "3:7": paths["3:7@7"] })).toBeNull();
  });

  it("parses plain and cross-floor connector keys", () => {
    expect(parseTeleportConnectorKey("3:7")).toEqual({ ids: [3, 7] });
    expect(parseTeleportConnectorKey("3:7@7")).toEqual({ ids: [3, 7], ownNode: 7 });
  });

  it("never sends a manually edited connector through automatic routing", () => {
    const edited = edge([0, 0], [40, 40], 1, 2);
    const automatic = edge([0, 0], [40, 40], 3, 4);
    const routed = routeTeleportConnectors({
      router: new TeleportConnectorRouter(),
      edges: [edited, automatic],
      style: DEFAULT_MAZE_RENDER_STYLE.teleport,
      cfg: undefined,
      waypoints: [],
      avoidFieldExit: false,
      fieldCells: [],
      markerMaxFactor: 1,
      manualPaths: { "1:2": { nodes: [[0, 0], [5, 30], [35, 10], [40, 40]] } },
    });
    expect(routed[0].points).toEqual([0, 0, 5, 30, 35, 10, 40, 40]);
    expect(routed[1].points).not.toEqual(routed[0].points);
  });

  it("samples cubic spans without changing the authored control points", () => {
    const points: [number, number][] = [[0, 0], [30, 0], [30, 30]];
    const sampled = sampleCubicPath(points);
    expect(points).toEqual([[0, 0], [30, 0], [30, 30]]);
    expect(sampled.slice(0, 2)).toEqual([0, 0]);
    expect(sampled.slice(-2)).toEqual([30, 30]);
    expect(sampled).not.toEqual(points.flat());
  });

  it("generates two controls per segment with a smooth join at an interior node", () => {
    const nodes: [number, number][] = [[0, 0], [100, 0], [100, 100]];
    const controls = straightCubicControls(nodes);
    expect(controls).toHaveLength(4);
    expect(curveControls({ mode: "curve", nodes })).toEqual(controls);
    const [incoming, outgoing] = [controls[1], controls[2]];
    const fromNode: [number, number] = [incoming[0] - 100, incoming[1]];
    const toNode: [number, number] = [outgoing[0] - 100, outgoing[1]];
    expect(fromNode[0] * toNode[1] - fromNode[1] * toNode[0]).toBeCloseTo(0);
    expect(fromNode[0] * toNode[0] + fromNode[1] * toNode[1]).toBeLessThan(0);
  });

  it("keeps handles inside short or degenerate segments so no end curls into a loop", () => {
    const cases: [number, number][][] = [
      [[0, 0], [100, 0], [100, 0]],
      [[0, 0], [0, 0], [100, 0]],
      [[0, 0], [100, 0], [0, 0]],
      [[0, 0], [5, 0], [100, 0]],
    ];
    for (const nodes of cases) {
      const controls = straightCubicControls(nodes);
      for (let i = 0; i + 1 < nodes.length; i++) {
        const a = nodes[i], b = nodes[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
        for (const c of [controls[i * 2], controls[i * 2 + 1]]) {
          const t = len2 === 0 ? 0 : ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / len2;
          expect(t).toBeGreaterThanOrEqual(-1e-9);
          expect(t).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });

  it("lays out editable curve points as anchor, two controls, anchor", () => {
    const nodes: [number, number][] = [[0, 0], [100, 0], [100, 100]];
    const controls = straightCubicControls(nodes);
    expect(editableCurvePoints({ mode: "curve", nodes, controls })).toEqual([
      0, 0, ...controls[0], ...controls[1], 100, 0, ...controls[2], ...controls[3], 100, 100,
    ]);
  });

  it("samples a cubic manual path for the renderer while retaining its editable control points", () => {
    const curved = edge([0, 0], [30, 30], 1, 2);
    const rendered = manualConnectorPoints(curved, {
      "1:2": { mode: "curve", nodes: [[0, 0], [30, 30]], controls: [[30, 0], [0, 30]] },
    });
    expect(rendered).not.toEqual([0, 0, 30, 0, 0, 30, 30, 30]);
    expect(rendered?.slice(0, 2)).toEqual([0, 0]);
    expect(rendered?.slice(-2)).toEqual([30, 30]);
  });
});
