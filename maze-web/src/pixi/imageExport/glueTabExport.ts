import type { GlueTabStyle } from "../../store/imageExportTypes";
import type { MazeState } from "../../store/storeTypes";
import type { WireFoldEnd, WireTopology } from "../../wasm/types";
import { getSeamModel } from "../selectors/seams";
import { displayTransform } from "../tessellationGeometry";
import { applyTransform } from "../geometry/worldTransform";
import { cutLineOf, cutSettingOf, lineSpans, type Vec2 } from "./cutLines";
import { floorGroupCuts, tilePolygons } from "./exportContent";
import { selectFloorScopedMaze } from "../selectors/mazeSelectors";

/// Glue tabs of the export (GitHub issue #901, `Specs/image-export.md`, "Glue tabs"): trapezoidal flaps, one per straight
/// stretch of the glued edge of side A of every glue, drawn outward from the cells. Display space.

/// A tab: the four corners of its trapezoid, the base (on the edge) first.
export type GlueTab = readonly [Vec2, Vec2, Vec2, Vec2];

/// The tabs of the active floor and the stretches that got none because the inset leaves nothing of them (GitHub issue #913):
/// as fold faces for a glue seen from its cells, as plain display-space lines for a cut glue.
export interface GlueTabLayout {
  tabs: GlueTab[];
  missingEnds: WireFoldEnd[];
  missingLines: Vec2[][];
}

const NO_LAYOUT: GlueTabLayout = { tabs: [], missingEnds: [], missingLines: [] };

/// Points closer than this (display units) are one point.
const EPS = 1e-6;
/// A direction counts as the same one when the sine of the angle between them is below this.
const PARALLEL_EPS = 1e-6;

interface Edge {
  from: Vec2;
  to: Vec2;
  /// The centre of the cell the edge belongs to: the tab reaches away from it.
  center: Vec2;
  /// The folds (indices into `WireTopology.folds`) whose faces the edge is made of.
  folds: number[];
}

const pointKey = ([x, y]: Vec2): string => `${Math.round(x / EPS)},${Math.round(y / EPS)}`;

/// The straight pieces of a face's outline: consecutive line segments with the same direction are one piece. `null` when the
/// face has a curved segment (a curved glued edge gets no tab).
function straightPieces(segments: readonly { kind: string; from?: readonly number[]; to?: readonly number[] }[], toDisplay: (p: readonly [number, number]) => Vec2): { from: Vec2; to: Vec2 }[] | null {
  const pieces: { from: Vec2; to: Vec2 }[] = [];
  for (const segment of segments) {
    if (segment.kind !== "line" || !segment.from || !segment.to) return null;
    const from = toDisplay([segment.from[0], segment.from[1]]);
    const to = toDisplay([segment.to[0], segment.to[1]]);
    const last = pieces[pieces.length - 1];
    if (last && continues(last, { from, to })) last.to = to;
    else pieces.push({ from, to });
  }
  return pieces;
}

/// Whether `b` starts where `a` ends and goes on in the same direction.
function continues(a: { from: Vec2; to: Vec2 }, b: { from: Vec2; to: Vec2 }): boolean {
  if (pointKey(a.to) !== pointKey(b.from)) return false;
  const [ux, uy] = [a.to[0] - a.from[0], a.to[1] - a.from[1]];
  const [vx, vy] = [b.to[0] - b.from[0], b.to[1] - b.from[1]];
  const norms = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (norms === 0) return false;
  return Math.abs(ux * vy - uy * vx) / norms < PARALLEL_EPS && ux * vx + uy * vy > 0;
}

/// Joins the edges that continue each other in a straight line into one edge each.
function mergeStraight(edges: Edge[]): Edge[] {
  const byFrom = new Map<string, number>();
  edges.forEach((edge, i) => byFrom.set(pointKey(edge.from), i));
  const next = edges.map((edge) => {
    const j = byFrom.get(pointKey(edge.to));
    return j !== undefined && continues(edge, edges[j]) ? j : -1;
  });
  const hasPrev = new Set(next.filter((j) => j >= 0));
  const merged: Edge[] = [];
  const visited = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    if (hasPrev.has(i)) continue;
    let end = i;
    const folds = new Set(edges[i].folds);
    visited.add(i);
    while (next[end] >= 0 && !visited.has(next[end])) {
      end = next[end];
      visited.add(end);
      for (const fold of edges[end].folds) folds.add(fold);
    }
    merged.push({ from: edges[i].from, to: edges[end].to, center: edges[i].center, folds: [...folds] });
  }
  return merged;
}

/// The trapezoid on the edge `from`-`to`, reaching along `normal` (a unit vector), or `null` when the inset leaves nothing of the edge.
/// Its sides lean at 45 degrees; a tab too short for that is a triangle.
export function glueTabOn(from: Vec2, to: Vec2, normal: Vec2, style: Pick<GlueTabStyle, "inset" | "width">): GlueTab | null {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const span = length - 2 * style.inset;
  if (length === 0 || span <= EPS) return null;
  const u: Vec2 = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
  const lean = Math.min(style.width, span / 2);
  const a: Vec2 = [from[0] + u[0] * style.inset, from[1] + u[1] * style.inset];
  const b: Vec2 = [to[0] - u[0] * style.inset, to[1] - u[1] * style.inset];
  const reach = (p: Vec2, along: number): Vec2 => [p[0] + normal[0] * style.width + u[0] * along, p[1] + normal[1] * style.width + u[1] * along];
  return [a, b, reach(b, -lean), reach(a, lean)];
}

/// The straight edges of one side (`"a"` or `"b"`) of the given folds, as far as they continue each other.
function sideEdges(topology: WireTopology, folds: readonly number[], side: "a" | "b", cfg: MazeState["activeFieldConfig"]): Edge[] {
  const model = getSeamModel(cfg);
  const transform = displayTransform(cfg);
  const toDisplay = (p: readonly [number, number]): Vec2 => applyTransform(transform, [p[0], p[1]]) as Vec2;
  const edges: Edge[] = [];
  for (const index of folds) {
    const end = topology.folds[index]?.[side];
    const half = end ? model.halfEdgeAt(end.cell, end.face_idx) : null;
    if (!half) continue;
    const pieces = straightPieces(half.segments, toDisplay);
    if (!pieces) continue;
    const center = toDisplay(half.center);
    for (const piece of pieces) edges.push({ ...piece, center, folds: [index] });
  }
  return mergeStraight(edges);
}

/// The tab on a straight edge, reaching away from its cell, or `null`.
function tabAway(edge: Edge, style: Pick<GlueTabStyle, "inset" | "width">): GlueTab | null {
  const { from, to, center } = edge;
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (length === 0) return null;
  let normal: Vec2 = [-(to[1] - from[1]) / length, (to[0] - from[0]) / length];
  const middle: Vec2 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  if (normal[0] * (middle[0] - center[0]) + normal[1] * (middle[1] - center[1]) < 0) normal = [-normal[0], -normal[1]];
  return glueTabOn(from, to, normal, style);
}

/// The tabs of a glue that is not cut: on every straight stretch of its side A, away from the cells. With `alternate`, every
/// second stretch of a broken edge goes on side B instead (the same folds, seen from their B faces).
function groupTabs(topology: WireTopology, group: WireTopology["groups"][number], cfg: MazeState["activeFieldConfig"], style: Pick<GlueTabStyle, "inset" | "width" | "alternate">, layout: GlueTabLayout): void {
  sideEdges(topology, group.folds, "a", cfg).forEach((stretch, i) => {
    const onB = style.alternate && i % 2 === 1;
    const side = onB ? "b" : "a";
    const edges = onB ? sideEdges(topology, stretch.folds, "b", cfg) : [stretch];
    for (const edge of edges) {
      const tab = tabAway(edge, style);
      if (tab) layout.tabs.push(tab);
      else layout.missingEnds.push(...edge.folds.flatMap((fold) => topology.folds[fold]?.[side] ?? []));
    }
  });
}

/// The tabs of the active floor (GitHub issue #901), or none while the style hides them. A glue with a cut line gets its tab
/// along the cut line instead (the line over the cells, outward from the sheet); the others on their side A.
export function selectExportGlueTabs(
  state: Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "pngExportSettings" | "nodes" | "floors">,
  style: Pick<GlueTabStyle, "showTabs" | "inset" | "width" | "alternate">,
): GlueTab[] {
  return selectExportGlueTabLayout(state, style).tabs;
}

/// The tabs together with the stretches the inset left without one (GitHub issue #913); same memoisation as the tabs.
export function selectExportGlueTabLayout(
  state: Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "pngExportSettings" | "nodes" | "floors">,
  style: Pick<GlueTabStyle, "showTabs" | "inset" | "width" | "alternate">,
): GlueTabLayout {
  if (!style.showTabs) return NO_LAYOUT;
  // The renderers ask on every settings change (a colour, a wall width); the tabs change only with these inputs.
  const inputs = [state.activeFloorId, state.activeFieldConfig, state.floorTopology, state.pngExportSettings.cuts, state.nodes, state.floors, style.inset, style.width, style.alternate];
  if (lastTabs && lastTabs.inputs.every((input, i) => Object.is(input, inputs[i]))) return lastTabs.layout;
  const layout = computeGlueTabs(state, style);
  // An empty answer may only mean the seam geometry is not warmed yet: ask again next time.
  lastTabs = layout.tabs.length > 0 || layout.missingEnds.length > 0 || layout.missingLines.length > 0 ? { inputs, layout } : null;
  return layout;
}

let lastTabs: { inputs: readonly unknown[]; layout: GlueTabLayout } | null = null;

function computeGlueTabs(
  state: Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "pngExportSettings" | "nodes" | "floors">,
  style: Pick<GlueTabStyle, "inset" | "width" | "alternate">,
): GlueTabLayout {
  const floorId = state.activeFloorId;
  const topology = state.floorTopology[floorId];
  if (!topology || topology.groups.length === 0) return NO_LAYOUT;
  const cfg = state.activeFieldConfig;
  const cuts = new Map(floorGroupCuts({ cfg, topology }).flatMap((cut) => {
    const line = cutLineOf(cut, cutSettingOf(state.pngExportSettings.cuts, floorId, cut.group));
    return line ? [[cut.group, line] as const] : [];
  }));
  let tiles: Vec2[][] | null = null;
  const layout: GlueTabLayout = { tabs: [], missingEnds: [], missingLines: [] };
  for (const group of topology.groups) {
    const line = cuts.get(group.id);
    if (!line) {
      groupTabs(topology, group, cfg, style, layout);
      continue;
    }
    tiles ??= tilePolygons(selectFloorScopedMaze(state.nodes, [], state.floors, floorId).nodes, cfg);
    const { direction, period } = line.cut;
    // The period points from the cut line into the sheet, so the tab reaches the other way.
    const across: Vec2 = [-direction[1], direction[0]];
    const normal: Vec2 = across[0] * period[0] + across[1] * period[1] > 0 ? [-across[0], -across[1]] : across;
    for (const [from, to] of lineSpans(tiles, line.point, direction)) {
      const tab = glueTabOn(from, to, normal, style);
      if (tab) layout.tabs.push(tab);
      else layout.missingLines.push([from, to]);
    }
  }
  return layout;
}
