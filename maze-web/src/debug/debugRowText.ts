/** Canonical text representation of one debug event tree row (GitHub issue #482) — the single
 *  source of truth for "what text does this row show", used by the search index (`buildSearchMatches`
 *  in `debugTreeSelectors.ts`) so a substring search matches exactly what the user sees. The row
 *  itself renders `tokens` directly (`DebugEventTree.tsx`); every visible bit of text is either a
 *  `text` token's `text` or a bubble token's `bubbleLabel`, so joining those reproduces the row. */

import { resolveIssue } from "../components/issueRegistry";
import type { Token } from "./algorithmRegistry";
import * as m from "~/paraglide/messages";

/** Bubble label — coordinates only, per user decision (narration text around it stays wordless,
 *  e.g. "Passage added", not "Passage added: 3:18 → 3:19"). Format is `x:y`, no parens/comma —
 *  or, on a multi-floor maze (GitHub issue #350), `Lf:x:y` (1-based floor index, `L` prefix so
 *  it's unambiguous this is a floor, not another coordinate), so a bubble stays readable when
 *  nodes on different floors legitimately share the same `(x, y)`. The floor prefix is only shown
 *  when `multiFloor` — a single-floor maze's bubbles are unchanged, since every node is trivially
 *  floor 1. `issue` tokens are the one exception: there's no id to format, so the label is the
 *  issue kind's own resolved display name (`resolveIssue`, the same registry `IssuesBlock`'s
 *  `IssueBubble` reads), not a coordinate. */
export function bubbleLabel(
  token: Token,
  coords?: (id: bigint) => { x: number; y: number; level: number; i: number; split: boolean } | null,
  multiFloor = false,
): string {
  const fmt = (id: bigint) => {
    if (!coords) return `${id}`;
    const p = coords(id);
    // `coords` joins against `debugArena.nodes` concatenated with `debugArena.allNodes` (GitHub
    // issue #271) — the union of every node that ever existed during the run, including ones a
    // later QC command removed/replaced (`RemoveNode`, `ReplacePointNodes`), not just
    // `debugArena.nodes`'s final survivors (see `coordIndex`'s own `useMemo` in `DebugEventTree`
    // for why both are needed). The `#id` fallback below is now only reached for a genuinely
    // unresolvable id (a real core/web tape desync), not for the common "removed later" case —
    // degrades gracefully rather than crashing the whole tree either way (a React render-time
    // throw here previously took down the entire debug panel).
    if (!p) return `#${id}`;
    const coord = multiFloor ? `L${p.level + 1}:${p.x}:${p.y}` : `${p.x}:${p.y}`;
    // A split point's node also names which node of the point it is (GitHub issue #468) — 1-based
    // compact "N{N}" form, the point's original node is "N1". Non-split points stay bare coords.
    return p.split ? `${coord} (${m["post_edit.split_node_label_short"]({ slotId: p.i + 1 })})` : coord;
  };
  switch (token.kind) {
    case "text": return token.text;
    case "node": return fmt(token.id);
    case "edge": return `${fmt(token.from)} ${token.bidirectional ? "<->" : "->"} ${fmt(token.to)}`;
    case "cycle": return token.edges.map(([f, t]) => `${fmt(f)}-${fmt(t)}`).join(", ");
    case "region": return token.nodes.map(fmt).join(", ");
    case "issue": return resolveIssue(token.issueKind).label;
  }
}

/** Concatenates a row's tokens into one plain string — `text` tokens verbatim, bubble tokens via
 *  `bubbleLabel` — joined by a single space so a query can span a token boundary (e.g. the space
 *  between narration prose and a coordinate bubble) without matching across it with no separator
 *  at all. This is search text, not a byte-exact mirror of the rendered DOM. */
export function buildDebugRowText(
  tokens: Token[],
  coords?: (id: bigint) => { x: number; y: number; level: number; i: number; split: boolean } | null,
  multiFloor = false,
): string {
  return tokens.map((t) => (t.kind === "text" ? t.text : bubbleLabel(t, coords, multiFloor))).join(" ");
}

/** Case-fold for substring search — plain `toLowerCase()`, deliberately not `toLocaleLowerCase()`:
 *  debug narration is technical text and a deterministic fold (independent of the browser's locale,
 *  e.g. Turkish `I`/`i`) matters more than locale-correct casing here. The same function normalizes
 *  both the indexed row text and the query, so the two sides stay symmetric. */
export function normalizeSearchText(s: string): string {
  return s.toLowerCase();
}
