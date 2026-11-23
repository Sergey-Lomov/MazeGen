import type { TileFaceNode } from "../domain/tileFace";
import * as m from "~/paraglide/messages";

/** Diagnostic hints for a split point's/pattern's current node set (GitHub issue #237) — purely
 *  informational, shown in the owning `SidePanel`'s dismissible warnings strip. Operates on the
 *  already-built `TileFaceNode[]` shape (same data every split-node panel already computes for
 *  `TileFaceEditor`), so it works identically for post-edit, preset and pattern-editor nodes
 *  without needing a third node representation.
 *
 *  Deliberately doesn't flag "conflicting/contradictory face requirements after rotation or
 *  resize" (also listed in #237) — a single face only ever holds one `SplitFaceRequirement`, so
 *  no per-face conflict is representable; the closest real case (a sibling pair with mismatched
 *  requirements on each side) was left out of scope pending a clearer spec.
 *
 *  A missing pattern face defaults to `wall`, so it is intentionally diagnosed the same way as an
 *  explicit wall rather than producing a separate "undefined face" warning. */
export function splitNodeDiagnostics(nodes: TileFaceNode[]): string[] {
  const messages: string[] = [];

  nodes.forEach((node, i) => {
    // 1-based, matching `Node {n}` numbering everywhere else in the split-node UI (dialogs, panel
    // row titles) — GitHub issue #539, this used to be the raw 0-based array index.
    const name = m["post_edit.split_node_label"]({ slotId: i + 1 });
    // A boundary face is never a real neighbor either way — only non-boundary faces count toward
    // "has any wall-openable side at all".
    const openable = node.faces.filter((f) => !f.boundary);
    if (openable.length > 0 && openable.every((f) => f.kind === "wall")) {
      messages.push(m["generation.split_diag_dead_node"]({ name }));
      return;
    }
    // `undefined` (preset's optional/undecided connection — GitHub issue #234) still leaves the
    // node reachable: the connection *may* end up existing, it just isn't forced. Only `wall`
    // (explicitly forbidden) and boundary (no neighboring tile) contribute nothing.
    const hasConnection = node.faces.some((f) =>
      f.kind === "passage" || f.kind === "one_way_out" || f.kind === "one_way_in" || f.kind === "undefined");
    if (!hasConnection) {
      messages.push(m["generation.split_diag_unreachable_node"]({ name }));
    }
  });

  return messages;
}
