import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { getSeamModel } from "../pixi/selectors/seams";
import { applyTransform } from "../pixi/geometry/worldTransform";
import { displayTransform } from "../pixi/tessellationGeometry";
import { DEFAULT_VERTICAL_STYLE } from "../pixi/renderers/VerticalConnectionRenderer";
import type { VerticalConnectionMarker } from "../pixi/renderers/types";
import type { MarkerIndexLabel } from "../pixi/selectors/mazeSelectors/markerIndex";
import { Container } from "pixi.js";
import { SeamCopyRenderer, type SeamCopySource } from "../pixi/renderers/SeamCopyRenderer";
import { buildSeamCopySources, markerIndexDisks, markerIndexSource, verticalMarkerDisks, verticalSource, waypointDisks } from "../pixi/imageExport/seamCopySources";
import { DEFAULT_MARKER_INDEX_SETTINGS } from "../store/slices/imageExportDefaults";
import type { WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

// A 6x5 square field glued into a cylinder (east column to west column).
const COLUMNS = 6;
const ROWS = 5;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });
const folds: Omit<WireFold, "group">[] = Array.from({ length: ROWS }, (_, y) => ({
  a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 },
  b: { cell: [0, y] as [number, number], face_idx: 2 },
  twist: false,
}));
const cylinder: WireTopology = { fingerprint: "square{}", folds: folds.map((fold) => ({ ...fold, group: 0 })), groups: [{ id: 0, folds: folds.map((_, i) => i) }] };

const style = { ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: true };

const label = (pos: [number, number], nodeId: number): MarkerIndexLabel => ({
  pos, nodeId, kind: "vertical", label: "I", markerOuterRadius: 6, markerBorderWidth: 1, borderMatchColor: 0,
});

const elevator = (pos: [number, number], floors: number[]): VerticalConnectionMarker => ({
  pos, fromNode: 1, kind: "elevator", direction: "both", targetFloorIndices: floors, filled: true, arrowFilled: true,
});

/** Display-space contact point of a cell's glued face. */
function contactOf(cell: [number, number], face: number): [number, number] {
  warmCartesianCache(field, cylinder);
  return applyTransform(displayTransform(field), getSeamModel(field).halfEdgeAt(cell, face)!.contact) as [number, number];
}

describe("seam copy plan", () => {
  it("bounds a plate and an elevator with its badges", () => {
    const [plate] = markerIndexDisks([label([100, 100], 1)], style);
    expect(plate.r).toBeGreaterThan(Math.hypot(style.width, style.height) / 2);
    const lone = verticalMarkerDisks([elevator([0, 0], [])], { ...DEFAULT_VERTICAL_STYLE, elevatorBadges: { ...DEFAULT_VERTICAL_STYLE.elevatorBadges, enabled: true } })[0];
    const fan = verticalMarkerDisks([elevator([0, 0], [0, 1, 2])], { ...DEFAULT_VERTICAL_STYLE, elevatorBadges: { ...DEFAULT_VERTICAL_STYLE.elevatorBadges, enabled: true } })[0];
    expect(fan.r).toBeGreaterThan(lone.r);
  });

  it("bounds a start/finish marker by its ring, corners and label", () => {
    const base = { pos: [0, 0] as [number, number], color: 0, radius: 10 };
    const [round] = waypointDisks([base]);
    const [square] = waypointDisks([{ ...base, shape: "square" }]);
    const [ringed] = waypointDisks([{ ...base, borderWidth: 2, gapWidth: 3 }]);
    const [labelled] = waypointDisks([{ ...base, text: "START", textSize: 20 }]);
    expect(round.r).toBeGreaterThan(10);
    expect(square.r).toBeGreaterThan(round.r);
    expect(ringed.r).toBeGreaterThan(round.r);
    expect(labelled.r).toBeGreaterThan(round.r);
  });

  it("hands each source only its own elements that reach a glued side", () => {
    warmCartesianCache(field, cylinder);
    const [ex, ey] = contactOf([COLUMNS - 1, 2], 0);
    const [wx, wy] = contactOf([0, 3], 2);
    const [mx, my] = contactOf([0, 0], 2);
    const markerIndex = { labels: [label([ex - 2, ey - 8], 1), label([wx + 1, wy - 8], 2), label([ex - 300, ey], 3)], style, floorColor: 0xffffff };
    const vertical = { markers: [elevator([mx + 2, my], [0, 1]), elevator([ex - 300, ey], [0, 1])], style: DEFAULT_VERTICAL_STYLE };
    const drawn: { source: string; indices: number[] }[] = [];
    const spy = (name: string, source: SeamCopySource | null): SeamCopySource => ({
      disks: source!.disks,
      draw: (_layers, indices) => {
        drawn.push({ source: name, indices: [...indices] });
        return () => {};
      },
    });
    const sources = [
      spy("plates", markerIndexSource(markerIndex)),
      spy("vertical", verticalSource(vertical)),
    ];
    const renderer = new SeamCopyRenderer(new Container());
    renderer.render(field, sources);
    const bySource = (name: string) => drawn.filter((d) => d.source === name).flatMap((d) => d.indices);
    // Plates 0 and 1 reach the glue; plate 2 and the second elevator are far from it.
    expect(bySource("plates").sort()).toEqual([0, 1]);
    expect(bySource("vertical")).toEqual([0]);
    renderer.destroy();
  });

  it("draws every real source's elements into a copy and releases them", () => {
    warmCartesianCache(field, cylinder);
    const [ex, ey] = contactOf([COLUMNS - 1, 2], 0);
    const sources = buildSeamCopySources({
      markerIndex: { labels: [label([ex - 2, ey - 8], 1)], style, floorColor: 0xffffff },
      vertical: { markers: [elevator([ex - 2, ey + 8], [0, 1])], style: DEFAULT_VERTICAL_STYLE },
      waypoints: { markers: [{ pos: [ex - 2, ey], color: 0xff0000, radius: 6 }] },
    });
    expect(sources).toHaveLength(3);
    const parent = new Container();
    const renderer = new SeamCopyRenderer(parent);
    renderer.render(field, sources);
    expect(renderer.container.children.length).toBeGreaterThan(0);
    renderer.clear();
    expect(renderer.container.children).toHaveLength(0);
    renderer.destroy();
  });

  it("copies nothing on a floor without glues", () => {
    warmCartesianCache(field, null);
    const drawn: number[][] = [];
    const source: SeamCopySource = { disks: [{ x: 0, y: 0, r: 1000 }], draw: (_layers, indices) => { drawn.push([...indices]); return () => {}; } };
    const renderer = new SeamCopyRenderer(new Container());
    renderer.render(field, [source]);
    expect(drawn).toEqual([]);
    expect(buildSeamCopySources({ markerIndex: null, vertical: null, waypoints: null })).toEqual([]);
    renderer.destroy();
  });
});
