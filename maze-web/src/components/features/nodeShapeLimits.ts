import * as m from "~/paraglide/messages";
import { cellTypeLabel } from "../../i18n/cellTypeLabel";
import { parseNodeShapeKey } from "../../pixi/nodeShapeKey";

/** One shape's limit — mirrors `maze-runner`'s `parse_node_shape_limits_param`: `null` is an
 *  unbounded side. */
export interface NodeShapeLimit {
  min: number | null;
  max: number | null;
}

/** `node_shape_limits`' `limits` param value: cell type (`regular:4`) -> `NodeShape::key()` ->
 *  limit (GitHub issue #1008). */
export type NodeShapeLimits = Record<string, Record<string, NodeShapeLimit>>;

/** Parses the JSON param value; malformed input is "no limits", like the Rust side. */
export function parseNodeShapeLimits(raw: string | undefined): NodeShapeLimits {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: NodeShapeLimits = {};
    for (const [cellType, shapes] of Object.entries(parsed as Record<string, unknown>)) {
      if (shapes === null || typeof shapes !== "object" || Array.isArray(shapes)) continue;
      const limits: Record<string, NodeShapeLimit> = {};
      for (const [key, value] of Object.entries(shapes as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        const { min, max } = value as { min?: unknown; max?: unknown };
        limits[key] = {
          min: typeof min === "number" ? min : null,
          max: typeof max === "number" ? max : null,
        };
      }
      out[cellType] = limits;
    }
    return out;
  } catch {
    return {};
  }
}

function isActive(limit: NodeShapeLimit): boolean {
  return limit.min !== null || limit.max !== null;
}

/** Entries with neither bound are dropped — an empty bound is "no limit", so they say nothing — and
 *  so are cell types left with no entry. */
export function serializeNodeShapeLimits(limits: NodeShapeLimits): string {
  const active: NodeShapeLimits = {};
  for (const [cellType, shapes] of Object.entries(limits)) {
    const kept = Object.fromEntries(Object.entries(shapes).filter(([, l]) => isActive(l)));
    if (Object.keys(kept).length > 0) active[cellType] = kept;
  }
  return JSON.stringify(active);
}

/** Number of shapes that actually constrain something. */
export function activeLimitCount(limits: NodeShapeLimits): number {
  return Object.values(limits).reduce((n, shapes) => n + Object.values(shapes).filter(isActive).length, 0);
}

const REGULAR_CELL_TYPE_LABELS: Record<number, string> = {
  3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 8: "octagon", 12: "dodecagon",
};

/** Human label of a cell type (`ShapeDescriptor::key`, e.g. `regular:4`); a template without a
 *  name is shown as is. */
export function nodeShapeCellTypeLabel(cellType: string): string {
  const regular = /^regular:(\d+)$/.exec(cellType);
  const name = regular ? REGULAR_CELL_TYPE_LABELS[Number(regular[1])] : cellType === "cell" ? "cell" : undefined;
  return name ? cellTypeLabel(name) : cellType;
}

/** Splits a `cell_type/shape_key` detail entry of the bubble. */
export function splitTypedShape(entry: string): { cellType: string; shape: string } {
  const slash = entry.indexOf("/");
  return slash < 0 ? { cellType: "", shape: entry } : { cellType: entry.slice(0, slash), shape: entry.slice(slash + 1) };
}

/** The first shape — in the editor's own order: cell types, then their shapes — whose min is above
 *  its max. Such a limit can never be met, so the limits dialog refuses to apply it. */
export function firstInvertedLimit(
  limits: NodeShapeLimits,
  cellTypes: readonly { cellType: string; shapes: readonly string[] }[],
): { cellType: string; shape: string } | null {
  for (const { cellType, shapes } of cellTypes) {
    for (const shape of shapes) {
      const limit = limits[cellType]?.[shape];
      if (limit && limit.min !== null && limit.max !== null && limit.min > limit.max) return { cellType, shape };
    }
  }
  return null;
}

/** Human label of a `NodeShape::key()` (`dead_end`, `straight`, `turn_<deg>`,
 *  `junction_<sides>_<ranks>` or the unresolved `junction_<n>`); an unknown key is shown as is.
 *
 *  A junction with a known layout is told apart by its degree and its face arrangement. The key
 *  counts faces from 0; the label counts from 1 (key `0-1-3` reads "1-2-4"). Given `siblings` (every
 *  shape key of its cell type), only what is needed is shown: the degree alone ("Junction of 3")
 *  when it is the cell type's only junction of that degree, a name with the faces ("Junction
 *  1-2-4", which already tell the degree) when there are several. Without `siblings` both are
 *  shown. */
export function nodeShapeLabel(key: string, siblings?: readonly string[]): string {
  const shape = parseNodeShapeKey(key);
  switch (shape?.type) {
    case undefined: return key;
    case "dead_end": return m["node_shape.dead_end"]();
    case "straight": return m["node_shape.straight"]();
    case "turn": return m["node_shape.turn"]({ angle: shape.angle });
    case "junction": {
      const name = m["node_shape.junction"]({ degree: shape.degree });
      if (!shape.ranks) return name;
      const faces = shape.ranks.map((rank) => rank + 1).join("-");
      if (!siblings) return `${name} (${faces})`;
      const ofDegree = siblings.filter((s) => {
        const other = parseNodeShapeKey(s);
        return other?.type === "junction" && other.ranks !== null && other.degree === shape.degree;
      });
      return ofDegree.length > 1 ? m["node_shape.junction_faces"]({ faces }) : name;
    }
  }
}
