import type { GlueTabStyle } from "../../store/imageExportTypes";
import type { MazeState } from "../../store/storeTypes";
import { selectExportGlueTabLayout, type GlueTab, type GlueTabLayout } from "../imageExport/glueTabExport";
import { mergedFacePolylines } from "../topologyGeometry";
import type { ExportWarning } from "./exportWarnings";

/// Glue tab geometry warnings (GitHub issue #913, `Specs/export-warnings.md`, "Glue tab geometry"): tabs that overlap each
/// other, tabs whose part of the edge is thinner than `MIN_TAB_BASE` (both highlight the tabs as polygons), and stretches the
/// inset left without any tab (highlighted as bands).

/// The thinnest base (the part of the edge left for the tab) that still glues reliably, in display units (pixels at scale 1).
export const MIN_TAB_BASE = 10;
/// Penetration (display units) below which two touching tabs do not count as overlapping.
const OVERLAP_EPS = 1e-3;

type GlueTabWarningState = Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "pngExportSettings" | "nodes" | "floors">;
type Point = readonly [number, number];

/// The extent of the polygon's projection on the axis, as `[min, max]`.
function project(poly: readonly Point[], axis: Point): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of poly) {
    const d = x * axis[0] + y * axis[1];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/// Whether the interiors of two convex polygons overlap by more than `OVERLAP_EPS` (separating axis test).
export function convexPolygonsOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (length === 0) continue;
      const axis: Point = [-(q[1] - p[1]) / length, (q[0] - p[0]) / length];
      const [minA, maxA] = project(a, axis);
      const [minB, maxB] = project(b, axis);
      if (Math.min(maxA, maxB) - Math.max(minA, minB) <= OVERLAP_EPS) return false;
    }
  }
  return true;
}

function warningOf(id: ExportWarning["id"], tabs: readonly GlueTab[]): ExportWarning {
  return { id, key: id, nodes: [], edges: [], polygons: tabs.map((tab) => tab.map(([x, y]): [number, number] => [x, y])) };
}

/// The glue tab warnings of the active floor; none while the tabs are hidden.
export function computeGlueTabWarnings(state: GlueTabWarningState, style: Pick<GlueTabStyle, "showTabs" | "inset" | "width" | "alternate">): ExportWarning[] {
  const layout = selectExportGlueTabLayout(state, style);
  if (layout.tabs.length === 0 && layout.missingEnds.length === 0 && layout.missingLines.length === 0) return [];
  // The layout is memoised by `selectExportGlueTabLayout`; the pairwise overlap test below is quadratic, and hover renders and
  // unrelated settings edits ask again with the same layout.
  if (lastWarnings?.layout === layout) return lastWarnings.warnings;
  const warnings = warningsOfLayout(layout, state.activeFieldConfig);
  lastWarnings = { layout, warnings };
  return warnings;
}

let lastWarnings: { layout: GlueTabLayout; warnings: ExportWarning[] } | null = null;

function warningsOfLayout({ tabs, missingEnds, missingLines }: GlueTabLayout, cfg: GlueTabWarningState["activeFieldConfig"]): ExportWarning[] {
  const warnings: ExportWarning[] = [];

  const overlapping = new Set<GlueTab>();
  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      if (!convexPolygonsOverlap(tabs[i], tabs[j])) continue;
      overlapping.add(tabs[i]);
      overlapping.add(tabs[j]);
    }
  }
  if (overlapping.size > 0) warnings.push(warningOf("glue_tabs_overlap", tabs.filter((tab) => overlapping.has(tab))));

  // The base is the first side of the trapezoid: the part of the edge between the insets.
  const thin = tabs.filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_TAB_BASE);
  if (thin.length > 0) warnings.push(warningOf("glue_tab_too_thin", thin));

  // The stretches the inset left without a tab: neighbouring faces merge into one band, as in the glue editor.
  const bands = [...mergedFacePolylines(missingEnds, [], cfg), ...missingLines];
  if (bands.length > 0) warnings.push({ id: "glue_tab_missing", key: "glue_tab_missing", nodes: [], edges: [], bands });
  return warnings;
}
