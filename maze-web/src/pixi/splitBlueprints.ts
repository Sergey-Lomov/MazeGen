/** Built-in split-node blueprints (GitHub issue #235) — predefined multi-node configurations a
 * user can apply to a split point instead of building one by hand, offered in both post-edit's
 * `ManageSplitNodesDialog` and the preset stage's `PresetSplitNodesDialog`. Deliberately distinct
 * from `SplitPattern` (`Specs/split-patterns.md`): a pattern is a generation-time construct
 * (weighted, applied by the wasm generator during `CustomVertexBased`), a blueprint is a plain
 * client-side template applied instantly and directly to the current point's nodes/edges — no
 * wire type, nothing sent to wasm, nothing stored in the project file.
 *
 * Filtered by tile degree (`getNeighborData(cfg, x, y).offsets.length`), not by tessellation
 * `type` — two different tessellations sharing the same tile shape (e.g. a future tessellation
 * with square cells) can reuse the same blueprint set.
 *
 * A point at the field's boundary has some faces with no neighbor at all — a blueprint whose
 * required faces land there can't be applied as authored. Rather than a manual rotate control,
 * the dialog tries every rotation automatically (`fittingRotation`) and offers the first one that
 * fits, or disables the blueprint if none do. */

import { splitPatternNodeColor } from "./splitPatternTile";
import type { TileFace, TileFaceNode } from "../components/features/TileFaceEditor";
import type { SplitPattern } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { cairoCanonicalFaceOrder } from "./cairoGeometry";

export interface SplitNodeBlueprint {
  /** Unique within its own degree's list — used as a stable React `key`, nothing else (no label
   *  is shown anywhere in the picker UI; the preview thumbnail itself is the only UI for picking
   *  a blueprint). */
  id: number;
  /** Tile degree this blueprint applies to (`offsets.length`). */
  degree: number;
  /** One entry per minted node (node 0 first) — each a list of 0-indexed face offsets that node
   *  gets a `passage` on. Every other face defaults to `wall` (post-edit) / stays undecided
   *  (preset, see `applySplitBlueprint`'s own handling). */
  nodeFaces: number[][];
  /** i18n message key (paraglide, `split_pattern_title.*` — same registry `splitPatternTitles.ts`
   *  uses for a generation-time pattern's recognizable shape) for the "Changes" panel's
   *  `applySplitBlueprint` label (GitHub issue #545). Deliberately independent of
   *  `titleKeyForTopology`'s exact structural match against core's rotation/mirror-canonicalized
   *  `SplitGroupDto.topology` — a blueprint here is authored raw, in whatever face order/rotation
   *  its own `nodeFaces` happens to use, so it can't reuse that matcher; set by hand instead,
   *  purely by eyeballing the shape against the registry's own entries. `undefined` for a
   *  blueprint with no recognizable/named counterpart — the panel falls back to a generic
   *  "split-tile" label. */
  titleKey?: string;
  /** `nodeFaces` uses Cairo's canonical perimeter indices instead of the native core face slots. */
  faceIndexMode?: "cairo_canonical";
}

const TRIANGLE_BLUEPRINTS: SplitNodeBlueprint[] = [
  { id: 0, degree: 3, nodeFaces: [[0, 1], [0, 2]], titleKey: "split_pattern_title.split_fork" },
];

const SQUARE_BLUEPRINTS: SplitNodeBlueprint[] = [
  { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]], titleKey: "split_pattern_title.bridge" },
  { id: 1, degree: 4, nodeFaces: [[0, 1], [2, 3]], titleKey: "split_pattern_title.diagonal_divider" },
];

const HEX_BLUEPRINTS: SplitNodeBlueprint[] = [
  { id: 0, degree: 6, nodeFaces: [[0, 3], [1, 4]], titleKey: "split_pattern_title.bridge" },
  { id: 1, degree: 6, nodeFaces: [[1, 2], [4, 5]] },
  { id: 2, degree: 6, nodeFaces: [[0, 2], [4, 5]] },
  { id: 3, degree: 6, nodeFaces: [[0, 2], [3, 5]] },
  { id: 4, degree: 6, nodeFaces: [[0, 3], [1, 4], [2, 5]], titleKey: "split_pattern_title.double_bridge" },
  { id: 5, degree: 6, nodeFaces: [[0, 3], [1, 2], [4, 5]] },
  { id: 6, degree: 6, nodeFaces: [[0, 1, 2], [3, 4, 5]], titleKey: "split_pattern_title.diagonal_divider" },
];

const CAIRO_BLUEPRINTS: SplitNodeBlueprint[] = [
  {
    id: 0,
    degree: 5,
    nodeFaces: [[2, 3], [1, 4]],
    titleKey: "split_pattern_title.parallel_divider",
    faceIndexMode: "cairo_canonical",
  },
  {
    id: 1,
    degree: 5,
    nodeFaces: [[1, 2], [3, 4]],
    titleKey: "split_pattern_title.adjacent_divider",
    faceIndexMode: "cairo_canonical",
  },
  {
    id: 2,
    degree: 5,
    nodeFaces: [[0, 2, 3], [1, 4]],
    titleKey: "split_pattern_title.bridge_2x3",
    faceIndexMode: "cairo_canonical",
  },
];

const BLUEPRINTS_BY_DEGREE: Record<number, SplitNodeBlueprint[]> = {
  3: TRIANGLE_BLUEPRINTS,
  4: SQUARE_BLUEPRINTS,
  5: CAIRO_BLUEPRINTS,
  6: HEX_BLUEPRINTS,
};

/** Every built-in blueprint for a tile of the given degree, or `[]` if none are defined. */
export function blueprintsForDegree(degree: number): SplitNodeBlueprint[] {
  return BLUEPRINTS_BY_DEGREE[degree] ?? [];
}

/** Builds the `TileFaceEditor`/`TileFaceNode[]` shape for `blueprint`'s preview thumbnail — same
 *  role as `splitPatternTile.ts`'s `tileNodesForPattern`, simpler here since a blueprint only ever
 *  declares `passage` faces (everything else defaults to `wall`), no `one_way`/`undefined`. */
export function resolveBlueprintFaceIndex(
  blueprint: SplitNodeBlueprint,
  cfg: TessellationConfig | undefined,
  point: [number, number] | undefined,
  faceIndex: number,
): number {
  if (blueprint.faceIndexMode !== "cairo_canonical" || !cfg?.type.startsWith("cairo") || !point) return faceIndex;
  return cairoCanonicalFaceOrder(point[0], point[1])[faceIndex] ?? faceIndex;
}

export function tileNodesForBlueprint(
  blueprint: SplitNodeBlueprint,
  cfg?: TessellationConfig,
  point?: [number, number],
): TileFaceNode[] {
  return blueprint.nodeFaces.map((faces, nodeIndex): TileFaceNode => {
    const resolvedFaces = faces.map((face) => resolveBlueprintFaceIndex(blueprint, cfg, point, face));
    return {
      color: splitPatternNodeColor(nodeIndex),
      faces: Array.from({ length: blueprint.degree }, (_, faceIndex): TileFace => ({
        kind: resolvedFaces.includes(faceIndex) ? "passage" : "wall",
        boundary: false,
      })),
    };
  });
}

/** Rotates every face index in `blueprint` by `offset` steps around the tile's faces (mod
 *  `degree`) — used by `fittingRotation` to search for an orientation whose required faces avoid
 *  the field boundary. */
export function rotateBlueprint(blueprint: SplitNodeBlueprint, offset: number): SplitNodeBlueprint {
  const d = blueprint.degree;
  const norm = ((offset % d) + d) % d;
  if (norm === 0) return blueprint;
  return {
    ...blueprint,
    nodeFaces: blueprint.nodeFaces.map((faces) => faces.map((f) => (f + norm) % d)),
  };
}

function fitsBoundary(blueprint: SplitNodeBlueprint, isBoundary: (faceIndex: number) => boolean): boolean {
  return blueprint.nodeFaces.every((faces) => faces.every((f) => !isBoundary(f)));
}

/** Tries every rotation of `blueprint` (0..degree-1) around the tile's faces and returns the
 *  first one whose required faces avoid the field boundary at the target point — a point at the
 *  field's edge shows a boundary on some of its faces, and a blueprint's required passage can
 *  never land there (no neighbor to connect to). `isBoundary(faceIndex)` reports whether a given
 *  0-indexed face offset is a field boundary for that point. Returns `null` if no rotation fits
 *  (the point's boundary faces leave no valid orientation for this blueprint at all) — the caller
 *  should offer the blueprint as disabled in that case. */
export function fittingRotation(
  blueprint: SplitNodeBlueprint,
  isBoundary: (faceIndex: number) => boolean,
): SplitNodeBlueprint | null {
  for (let offset = 0; offset < blueprint.degree; offset++) {
    const rotated = rotateBlueprint(blueprint, offset);
    if (fitsBoundary(rotated, isBoundary)) return rotated;
  }
  return null;
}

/** Converts `blueprint` into a fresh `SplitPattern` (GitHub issue #235 follow-up) — for
 *  `SplitSettingsDialog`'s "add a standard pattern" strip, offering the same built-in blueprints
 *  as a one-click starting point for a generation-time pattern instead of building one by hand in
 *  `AbstractPatternEditorDialog`. No boundary concept applies here (a pattern isn't tied to any
 *  specific field point — `face_index` stays abstract until the generator applies it), so this is
 *  a direct, unrotated conversion for native-face blueprints. Cairo canonical blueprints are
 *  resolved through the supplied anchor point before storage. Every declared face becomes a
 *  `passage` requirement, every
 *  other face is simply absent (core already treats "no entry" as `Wall`, see
 *  `splitPatternTile.ts`'s `tileFaceKindOf`). `weight: 1.0` matches `SplitSettingsDialog`'s own
 *  `handleAddPattern` default for a freshly added pattern. */
export function blueprintToSplitPattern(
  blueprint: SplitNodeBlueprint,
  cfg?: TessellationConfig,
  point?: [number, number],
): SplitPattern {
  return {
    node_count: blueprint.nodeFaces.length,
    faces: blueprint.nodeFaces.map((faces) => faces.map((face) => {
      const face_index = resolveBlueprintFaceIndex(blueprint, cfg, point, face);
      return { face_index, requirement: { kind: "passage" as const } };
    })),
    weight: 1.0,
  };
}
