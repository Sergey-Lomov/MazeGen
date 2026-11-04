import type { Graphics } from "pixi.js";
import type { FloorEdgeMarkerStyle, RenderModeId } from "../../store/imageExportTypes";
import { withResolvedEdgeMarkers } from "../../store/edgeMarkerLinks";
import type { ParamLink } from "../../store/parameterLinks";
import type { MazeState } from "../../store/storeTypes";
import type { MarkerShape } from "../renderers/types";
import { circlePolygonPoints, markerPolygonPoints } from "../renderers/markerShapes";
import { creaseDisplayPoint } from "../creaseGeometry";
import { getSeamModel, partnerFraction, pointOnHalfEdge, type HalfEdge } from "../selectors/seams";
import { selectFloorScopedMaze } from "../selectors/mazeSelectors";
import { displayTransform } from "../tessellationGeometry";
import { applyTransform } from "../geometry/worldTransform";
import { cutLineOf, cutSettingOf, lineSpans, type Vec2 } from "./cutLines";
import { floorGroupCuts, tilePolygons } from "./exportContent";
import { hasLowContrast } from "../colorContrast";
import { selectAmbiguousGlueSections } from "../selectors/ambiguousGlueSections";

/// Edge alignment markers of the export (GitHub issue #902, `Specs/image-export.md`, "Edge alignment markers"): marks centred
/// on matching edges so the user can see which edges are joined during assembly. Display space.

/// The edge marker style of a render mode, with every marker override resolved through the mode's parameter links (the
/// look each marker actually draws). Both modes carry the same fields.
export function edgeMarkerStyleOf(
  state: Pick<MazeState, "vectorByWallsSettings" | "vectorByCorridorsSettings" | "activeFloorId">,
  mode: RenderModeId,
): FloorEdgeMarkerStyle {
  const settings = mode === "vector_by_walls" ? state.vectorByWallsSettings : state.vectorByCorridorsSettings;
  return withResolvedEdgeMarkers(settings.edgeMarkers, settings.links as ParamLink<string>[], state.activeFloorId);
}

/// One half (or the whole) of a marker. The two halves of a glue's marker share a `key`, so they share a look.
export interface EdgeMarker {
  key: string;
  /// The point on the edge the marker is centred on.
  center: Vec2;
  /// A unit vector toward the face the half lies on: only the part of the marker on that side of the edge is drawn.
  /// `null` draws the whole marker (a crease marker: both halves lie on faces next to each other).
  inward: Vec2 | null;
  /// The marker's own axes at the edge, so that the two halves of a glue join into one whole marker once folded: the shape's x axis
  /// runs along `tangent`, its y axis along `inward` on side A (`side` 1) and against it on side B (`side` -1), which is where the
  /// folded face lies. The tangents of the two sides are `R^-1(inward)` on A and `R(inward)` on B (R: quarter turn), which a rigid
  /// fold maps onto each other. A whole marker (no `inward`) is drawn unrotated.
  tangent: Vec2;
  side: 1 | -1;
}

/// The tangent and side of a marker half whose face lies toward `inward` (see `EdgeMarker.tangent`).
function edgeFrame(inward: Vec2, side: 1 | -1): { tangent: Vec2; side: 1 | -1 } {
  return { tangent: side === 1 ? [inward[1], -inward[0]] : [-inward[1], inward[0]], side };
}

/// The half-edge's own parameter step used to read the edge direction at the marker.
const TANGENT_STEP = 0.05;
/// Samples of a face used to measure its length.
const LENGTH_SAMPLES = 16;
/// Two display points closer than this are one point.
const JOIN_EPS = 1e-4;
/// Two directions whose sine of the angle between them is below this continue each other (no corner).
const STRAIGHT_EPS = 0.01;

/// The shape and colour a marker is drawn with: its own override, else the shared ones.
export function edgeMarkerLook(style: Pick<FloorEdgeMarkerStyle, "shape" | "color" | "overrides">, key: string): { shape: MarkerShape; color: number } {
  const override = style.overrides[key];
  return { shape: override?.shape ?? style.shape, color: override?.color ?? style.color };
}

type EdgeMarkerState = Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "floorCreases" | "pngExportSettings" | "nodes" | "edges" | "floors">;

/// The markers of the active floor, or none while the style hides them. "gluings": one marker per
/// glue, at the centre of its side A and the matching spot on side B, each as the half on its own face (a glue with a cut line
/// gets it in the middle of the cut line and on its twin). "ambiguous": only the glue runs that share a wall/passage
/// pattern with a run from another physical-net component. "all": also the centre of every crease line.
export function selectExportEdgeMarkers(state: EdgeMarkerState, style: Pick<FloorEdgeMarkerStyle, "mode">): EdgeMarker[] {
  if (style.mode === "hidden") return [];
  const floorId = state.activeFloorId;
  const cfg = state.activeFieldConfig;
  const markers: EdgeMarker[] = [];
  const topology = state.floorTopology[floorId];
  if (topology && topology.groups.length > 0) {
    const ambiguousSides = style.mode === "ambiguous" ? new Map<number, Set<"a" | "b">>() : null;
    if (ambiguousSides) {
      for (const section of selectAmbiguousGlueSections(state)) {
        const sides = ambiguousSides.get(section.group) ?? new Set<"a" | "b">();
        sides.add(section.side);
        ambiguousSides.set(section.group, sides);
      }
    }
    const model = getSeamModel(cfg);
    const transform = displayTransform(cfg);
    const toDisplay = (p: readonly [number, number]): Vec2 => applyTransform(transform, [p[0], p[1]]) as Vec2;
    const cuts = new Map(floorGroupCuts({ cfg, topology }).flatMap((cut) => {
      const line = cutLineOf(cut, cutSettingOf(state.pngExportSettings.cuts, floorId, cut.group));
      return line ? [[cut.group, line] as const] : [];
    }));
    let tiles: Vec2[][] | null = null;

    const faceLength = (half: HalfEdge): number => {
      let length = 0;
      let last = toDisplay(pointOnHalfEdge(half, 0));
      for (let i = 1; i <= LENGTH_SAMPLES; i++) {
        const point = toDisplay(pointOnHalfEdge(half, i / LENGTH_SAMPLES));
        length += Math.hypot(point[0] - last[0], point[1] - last[1]);
        last = point;
      }
      return length;
    };

    // The two halves of a fold's marker, at fraction `t` of its A face and the matching fraction of its B face, each looking toward its own cell.
    const pushFold = (key: string, foldIndex: number, t: number, shownSides: ReadonlySet<"a" | "b"> | null): void => {
      const fold = topology.folds[foldIndex];
      if (!fold) return;
      const ends = [model.halfEdgeAt(fold.a.cell, fold.a.face_idx), model.halfEdgeAt(fold.b.cell, fold.b.face_idx)];
      if (!ends[0] || !ends[1]) return;
      const fractions = [t, partnerFraction(model.seams[ends[0].seam], t)];
      const halves: EdgeMarker[] = [];
      for (const [i, half] of ends.entries()) {
        if (shownSides && !shownSides.has(i === 0 ? "a" : "b")) continue;
        const at = fractions[i];
        const center = toDisplay(pointOnHalfEdge(half!, at));
        const before = toDisplay(pointOnHalfEdge(half!, at - TANGENT_STEP));
        const after = toDisplay(pointOnHalfEdge(half!, at + TANGENT_STEP));
        const length = Math.hypot(after[0] - before[0], after[1] - before[1]);
        if (length === 0) return;
        let normal: Vec2 = [-(after[1] - before[1]) / length, (after[0] - before[0]) / length];
        const cell = toDisplay(half!.center);
        if (normal[0] * (cell[0] - center[0]) + normal[1] * (cell[1] - center[1]) < 0) normal = [-normal[0], -normal[1]];
        halves.push({ key, center, inward: normal, ...edgeFrame(normal, i === 0 ? 1 : -1) });
      }
      markers.push(...halves);
    };

    const displayAt = (half: HalfEdge, t: number): Vec2 => toDisplay(pointOnHalfEdge(half, t));
    /// The direction a face runs in at its start (`end` false) or its end, display space.
    const directionAt = (half: HalfEdge, end: boolean): Vec2 => {
      const from = displayAt(half, end ? 1 - TANGENT_STEP : 0);
      const to = displayAt(half, end ? 1 : TANGENT_STEP);
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      return length === 0 ? [0, 0] : [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    };
    /// Whether face `b` goes on where face `a` ends, in the same direction (the faces' shared vertex is not a corner).
    const joinsStraight = (a: HalfEdge, b: HalfEdge): boolean => {
      const [ax, ay] = displayAt(a, 1);
      const [bx, by] = displayAt(b, 0);
      if (Math.hypot(ax - bx, ay - by) > JOIN_EPS) return false;
      const u = directionAt(a, true);
      const v = directionAt(b, false);
      return Math.abs(u[0] * v[1] - u[1] * v[0]) < STRAIGHT_EPS && u[0] * v[0] + u[1] * v[1] > 0;
    };

    // A glue has exactly one marker, as near the centre of its side A (by arc length) as a cell allows: at the middle of a
    // face (a cell's own centre of that edge) or at a vertex between two faces that continue each other, never at a corner,
    // where the marker would lie across a bend and its halves would not join once folded. The earlier of equally near spots wins.
    const pushGlue = (key: string, folds: readonly number[], shownSides: ReadonlySet<"a" | "b"> | null): void => {
      const faces = folds.flatMap((index) => {
        const fold = topology.folds[index];
        const half = fold && model.halfEdgeAt(fold.a.cell, fold.a.face_idx);
        const length = half ? faceLength(half) : 0;
        return half && length > 0 ? [{ index, half, length }] : [];
      });
      if (faces.length === 0) return;
      const total = faces.reduce((sum, face) => sum + face.length, 0);
      const best = { index: faces[0].index, t: 0.5, distance: Infinity };
      const consider = (index: number, t: number, at: number): void => {
        const distance = Math.abs(at - total / 2);
        if (distance < best.distance - JOIN_EPS) Object.assign(best, { index, t, distance });
      };
      let start = 0;
      faces.forEach((face, i) => {
        consider(face.index, 0.5, start + face.length / 2);
        const next = faces[i + 1];
        if (next && joinsStraight(face.half, next.half)) consider(face.index, 1, start + face.length);
        start += face.length;
      });
      pushFold(key, best.index, best.t, shownSides);
    };

    for (const group of topology.groups) {
      const shownSides = ambiguousSides?.get(group.id) ?? null;
      if (ambiguousSides && !shownSides) continue;
      const line = cuts.get(group.id);
      if (!line) {
        pushGlue(`g${group.id}`, group.folds, shownSides);
        continue;
      }
      // A glue with a cut line: the marker is in the middle of the line, whatever its offset, half on each side of the cut.
      tiles ??= tilePolygons(selectFloorScopedMaze(state.nodes, [], state.floors, floorId).nodes, cfg);
      const { direction, period } = line.cut;
      // The period points from the cut line into the sheet, so the sheet lies that way from the line.
      const across: Vec2 = [-direction[1], direction[0]];
      const sheet: Vec2 = across[0] * period[0] + across[1] * period[1] > 0 ? across : [-across[0], -across[1]];
      const span = lineSpans(tiles, line.point, direction)[0];
      if (!span) continue;
      const key = `g${group.id}`;
      const middle: Vec2 = [(span[0][0] + span[1][0]) / 2, (span[0][1] + span[1][1]) / 2];
      if (!shownSides || shownSides.has("a")) markers.push({ key, center: middle, inward: sheet, ...edgeFrame(sheet, 1) });
      const away: Vec2 = [-sheet[0], -sheet[1]];
      if (!shownSides || shownSides.has("b")) markers.push({ key, center: [middle[0] + period[0], middle[1] + period[1]], inward: away, ...edgeFrame(away, -1) });
    }
  }
  if (style.mode === "all") {
    for (const crease of state.floorCreases[floorId] ?? []) {
      const a = creaseDisplayPoint(crease.a, cfg);
      const b = creaseDisplayPoint(crease.b, cfg);
      markers.push({ key: `c${crease.id}`, center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], inward: null, tangent: [1, 0], side: 1 });
    }
  }
  return markers;
}

/// The distinct marker keys, in order: one row of the settings per key.
export function edgeMarkerKeys(markers: readonly EdgeMarker[]): string[] {
  return [...new Set(markers.map((marker) => marker.key))];
}

/// The markers moved by `offset`: one cut-plan copy of them.
export function shiftEdgeMarkers(markers: readonly EdgeMarker[], offset: readonly [number, number]): EdgeMarker[] {
  return markers.map((marker) => ({ ...marker, center: [marker.center[0] + offset[0], marker.center[1] + offset[1]] }));
}

/// The part of the polygon `points` (x, y pairs) on the `inward` side of the line through `center` (Sutherland-Hodgman against one half-plane).
export function clipToHalfPlane(points: readonly number[], center: Vec2, inward: Vec2): number[] {
  const side = (x: number, y: number): number => (x - center[0]) * inward[0] + (y - center[1]) * inward[1];
  const out: number[] = [];
  const count = points.length / 2;
  for (let i = 0; i < count; i++) {
    const [x0, y0] = [points[2 * i], points[2 * i + 1]];
    const j = (i + 1) % count;
    const [x1, y1] = [points[2 * j], points[2 * j + 1]];
    const d0 = side(x0, y0);
    const d1 = side(x1, y1);
    if (d0 >= 0) out.push(x0, y0);
    if ((d0 >= 0) !== (d1 >= 0)) {
      const t = d0 / (d0 - d1);
      out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }
  return out;
}

/// The display point of the marker's local point (`x` along its tangent, `y` toward its face): the frame its shape is drawn in.
export function markerPoint(marker: EdgeMarker, x: number, y: number): Vec2 {
  const [tx, ty] = marker.tangent;
  const [nx, ny] = marker.inward ?? [-ty, tx];
  return [marker.center[0] + x * tx + y * nx * marker.side, marker.center[1] + x * ty + y * ny * marker.side];
}

/// Draws the markers, each filled in its own colour (`edgeMarkerLook`). A half is cut from the shape in the marker's own axes
/// (`EdgeMarker.tangent`), so the halves of a glue assemble into the whole shape.
export function drawExportEdgeMarkers(g: Graphics, markers: readonly EdgeMarker[], style: Pick<FloorEdgeMarkerStyle, "size" | "shape" | "color" | "overrides">): void {
  const radius = style.size / 2;
  for (const marker of markers) {
    const { shape, color } = edgeMarkerLook(style, marker.key);
    const local = shape === "circle" ? circlePolygonPoints(0, 0, radius) : markerPolygonPoints(shape, 0, 0, radius);
    // Local y is along the face's inward direction on side A and against it on side B; the kept half is the one on the face's side.
    const kept = marker.inward ? clipToHalfPlane(local, [0, 0], [0, marker.side]) : local;
    if (kept.length < 6) continue;
    const points: number[] = [];
    for (let i = 0; i < kept.length; i += 2) points.push(...markerPoint(marker, kept[i], kept[i + 1]));
    g.poly(points, true).fill({ color });
  }
}

/// True if two markers' looks are hard to tell apart: the same shape and colours too close (`hasLowContrast`). A different
/// shape alone is enough to tell markers apart.
export function edgeMarkerLooksAlike(a: { shape: MarkerShape; color: number }, b: { shape: MarkerShape; color: number }): boolean {
  return a.shape === b.shape && hasLowContrast(a.color, b.color);
}
