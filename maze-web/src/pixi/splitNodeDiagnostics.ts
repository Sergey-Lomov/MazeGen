import type { TileFaceNode } from "../components/features/TileFaceEditor";
import type { SplitPattern } from "../wasm/types";
import * as m from "~/paraglide/messages";

/** Diagnostic hints for a split point's/pattern's current node set (GitHub issue #237) — purely
 *  informational, shown in the owning `SidePanel`'s dismissible warnings strip. Operates on the
 *  already-built `TileFaceNode[]` shape (same data every split-node panel already computes for
 *  `TileFaceEditor`), so it works identically for post-edit, preset and pattern-editor nodes
 *  without needing a third node representation.
 *
 *  Doesn't cover "no faces defined at all" (also listed in #237) — post-edit/preset always carry
 *  one `TileFaceNode.faces` entry per tessellation face (defaulting to `wall`/boundary), so that
 *  case is indistinguishable here from "dead node"; see `patternEmptyNodeDiagnostics` for the
 *  pattern editor's own sparse `SplitPatternFace[]`, where a genuinely empty face list is
 *  representable and distinct.
 *
 *  Deliberately doesn't flag "conflicting/contradictory face requirements after rotation or
 *  resize" (also listed in #237) — a single face only ever holds one `SplitFaceRequirement`, so
 *  no per-face conflict is representable; the closest real case (a sibling pair with mismatched
 *  requirements on each side) was left out of scope pending a clearer spec.
 *
 *  `skipIndices` lets the pattern editor exclude a node already flagged by
 *  `patternEmptyNodeDiagnostics` — an empty `SplitPatternFace[]` renders here as "every face is
 *  wall" (via `tileFaceKindOf`'s default-to-wall), which would otherwise also fire the dead-node
 *  message for the very same node, duplicating the empty-node one. Post-edit/preset never pass
 *  this — their `TileFaceNode.faces` is never genuinely empty. */
export function splitNodeDiagnostics(nodes: TileFaceNode[], skipIndices?: Set<number>): string[] {
  const messages: string[] = [];

  nodes.forEach((node, i) => {
    if (skipIndices?.has(i)) return;
    // A boundary face is never a real neighbor either way — only non-boundary faces count toward
    // "has any wall-openable side at all".
    const openable = node.faces.filter((f) => !f.boundary);
    if (openable.length > 0 && openable.every((f) => f.kind === "wall")) {
      messages.push(m["generation.split_diag_dead_node"]({ index: i }));
      return;
    }
    // `undefined` (preset's optional/undecided connection — GitHub issue #234) still leaves the
    // node reachable: the connection *may* end up existing, it just isn't forced. Only `wall`
    // (explicitly forbidden) and boundary (no neighboring tile) contribute nothing.
    const hasConnection = node.faces.some((f) =>
      f.kind === "passage" || f.kind === "one_way_out" || f.kind === "one_way_in" || f.kind === "undefined");
    if (!hasConnection) {
      messages.push(m["generation.split_diag_unreachable_node"]({ index: i }));
    }
  });

  return messages;
}

/** Pattern-editor-only diagnostic: a node with no `SplitPatternFace` entries at all — the
 *  sparse-list case `splitNodeDiagnostics` can't see (post-edit/preset never have an empty
 *  `TileFaceNode.faces`). */
export function patternEmptyNodeDiagnostics(pattern: SplitPattern): string[] {
  const messages: string[] = [];
  for (let i = 0; i < pattern.node_count; i++) {
    if ((pattern.faces[i]?.length ?? 0) === 0) {
      messages.push(m["generation.split_diag_empty_node"]({ index: i }));
    }
  }
  return messages;
}

/** Pattern-editor-only diagnostic: a face's `sibling_target` pointing at a node index that no
 *  longer exists — can happen after `resizePatternNodes` shrinks `node_count` without rewriting
 *  other nodes' `sibling_target`s (unlike `removePatternNode`, which does fix them up). */
export function patternSiblingDiagnostics(pattern: SplitPattern): string[] {
  const messages: string[] = [];
  pattern.faces.forEach((nodeFaces, nodeIndex) => {
    for (const face of nodeFaces) {
      if (face.sibling_target !== undefined && (face.sibling_target < 0 || face.sibling_target >= pattern.node_count)) {
        messages.push(m["generation.split_diag_dangling_sibling"]({ index: nodeIndex, face: face.face_index }));
      }
    }
  });
  return messages;
}
