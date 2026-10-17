import { splitSlotColor } from "./colorUtils";
import { canvas } from "./colorTokens";
import { getNeighborData, splitFaceIndexToCore } from "./tessellationGeometry";
import { TESSELLATION_UI } from "./geometry/tessellationUi";
import type { TileFace, TileFaceKind, TileFaceNode } from "../components/features/TileFaceEditor";
import type { SplitPattern, SplitFaceRequirement } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";

/** Number of faces (`Tessellation::faces().len()`) for `cfg` — derived from
 *  `getNeighborData`'s own offset list (the same source `TileFaceEditor`'s face geometry uses),
 *  not a separate hardcoded per-kind count, so the two can never drift out of sync. A pattern's
 *  `face_index` is only ever authored/consumed against the currently active tessellation
 *  (patterns are per-tessellation, see `SplitGenerationConfig`'s doc comment). Anchored at the
 *  origin — every square/hex cell has the same degree regardless of position, and a pattern's
 *  synthetic anchor point is the origin except for Cairo, whose origin is not an occupied tile.
 *  Triangle cells alternate up/down parity by `(x+y) % 2`, but both parities have the same degree
 *  (3), so the origin's value is representative here too. */
export function degreeFor(cfg: FieldConfig): number {
  const [x, y] = originCellOf(cfg);
  return getNeighborData(cfg, x, y).offsets.length;
}

/** A valid cell near the lattice origin: split-pattern previews and the origin marker. The origin
 * itself for tessellations where it is a cell (triangle parity stays unchanged); Cairo needs one
 * of its occupied residue classes. */
export function originCellOf(cfg: FieldConfig): [number, number] {
  return [...TESSELLATION_UI[cfg.tessellation.kind].originCell];
}

export function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function splitPatternNodeColor(nodeIndex: number): string {
  return colorToCss(splitSlotColor(nodeIndex, canvas.node.splitSlots));
}

/** `SplitFaceRequirement` -> `TileFaceKind`: a face absent from a node's face list altogether is
 *  equivalent to `Wall` (core treats "no entry" and `Wall` identically — neither becomes an
 *  edge), same as post-edit's own default-to-wall convention. */
export function tileFaceKindOf(requirement: SplitFaceRequirement | undefined): TileFaceKind {
  if (!requirement) return "wall";
  switch (requirement.kind) {
    case "wall": return "wall";
    case "unspecified": return "undefined";
    case "passage": return "passage";
    case "one_way": return requirement.direction === "forward" ? "one_way_out" : "one_way_in";
  }
}

/** Builds the `TileFaceEditor`/`TileFaceNode[]` shape for every node of `pattern` at once — shared
 *  between the abstract pattern editor and the compact read-only preview shown on each pattern's
 *  card in the settings list, so the two always render a given pattern identically. */
export function tileNodesForPattern(pattern: SplitPattern, degree: number): TileFaceNode[] {
  return Array.from({ length: pattern.node_count }, (_, nodeIndex): TileFaceNode => ({
    color: splitPatternNodeColor(nodeIndex),
    faces: Array.from({ length: degree }, (_, faceIndex): TileFace => ({
      kind: tileFaceKindOf(pattern.faces[nodeIndex]?.find((f) => f.face_index === faceIndex)?.requirement),
      boundary: false,
    })),
  }));
}

/** Builds the `TileFaceEditor`/`TileFaceNode[]` shape for a maze-wide split group's canonical
 *  topology (`SplitGroupDto.topology`, `maze_core::graph::split_topology`) — used by the analytics
 *  "pattern statistics" modal's preview thumbnails. Unlike `tileNodesForPattern`, `topology[node]`
 *  is a plain array indexed by the shape template's canonical face index directly (no
 *  `face_index` field to match against), so each web face position is converted to its canonical
 *  index via `splitFaceIndexToCore` before reading — the same conversion point
 *  `splitPatternsToCore` uses at the wasm-config-serialization boundary (GitHub issue #273), just
 *  read in the opposite direction (canonical value -> web slot) since this data already arrived
 *  from wasm in canonical ordering, unlike an authored `SplitPattern`. */
export function tileNodesForTopology(topology: SplitFaceRequirement[][], cfg: FieldConfig): TileFaceNode[] {
  const degree = degreeFor(cfg);
  return topology.map((nodeFaces, nodeIndex): TileFaceNode => ({
    color: splitPatternNodeColor(nodeIndex),
    faces: Array.from({ length: degree }, (_, webFaceIndex): TileFace => ({
      kind: tileFaceKindOf(nodeFaces[splitFaceIndexToCore(cfg, webFaceIndex)]),
      boundary: false,
    })),
  }));
}

/** Resizes `pattern.faces` to exactly `n` (clamped to `>= 1`, truncated to an integer) entries —
 *  truncates extra nodes' face lists, pads missing ones with an empty list. Pure resize only: does
 *  not touch any other node's `sibling_target` referencing a truncated-away index (unlike
 *  `removePatternNode`, a resize can't tell which specific index the caller means to drop when
 *  shrinking by more than one, so it's the caller's job to call `removePatternNode` first for a
 *  single, reference-safe removal). */
export function resizePatternNodes(pattern: SplitPattern, n: number): SplitPattern {
  const nodeCount = Math.max(1, Math.trunc(n));
  const faces = pattern.faces.slice(0, nodeCount);
  while (faces.length < nodeCount) faces.push([]);
  return { ...pattern, node_count: nodeCount, faces };
}

/** Removes pattern-local node `nodeIndex` (a no-op returning `pattern` unchanged if it's the last
 *  remaining node — a pattern always has at least one node). Node indices are positional
 *  (0..node_count-1), not stable ids, so removal must also: drop every other node's face that
 *  targeted the removed node as a `sibling_target` (that connection no longer has anywhere to
 *  point), and shift every remaining `sibling_target` above the removed index down by one (every
 *  index past the removal point shifts down by one in the new, shorter list). */
export function removePatternNode(pattern: SplitPattern, nodeIndex: number): SplitPattern {
  if (pattern.node_count <= 1) return pattern;
  const faces = pattern.faces
    .filter((_, i) => i !== nodeIndex)
    .map((nodeFaces) => nodeFaces
      .filter((f) => f.sibling_target !== nodeIndex)
      .map((f) => f.sibling_target !== undefined && f.sibling_target > nodeIndex
        ? { ...f, sibling_target: f.sibling_target - 1 }
        : f));
  return { ...pattern, node_count: pattern.node_count - 1, faces };
}
