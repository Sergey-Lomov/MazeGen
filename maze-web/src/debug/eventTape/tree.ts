/** Tree layer — walks parent/firstChild/nextSibling, for a future structural viewer (#126+) and
 *  for locating a merged tape's per-source ranges (GitHub issue #169/#147). Unused by any
 *  algorithm's flat `applyX` replay (see `scan.ts`'s doc comment for the flat/tree split). */

import { nodeAt, textDecoder, type NodeRecord, type ParsedTape } from "./wire";
import { TAG_SCOPE } from "./wire";

export type NodePayload =
  | { kind: "scope"; name: string }
  | { kind: "event"; tag: number; bytes: Uint8Array };

export interface NodeView {
  index: number;
  payload(): NodePayload;
  parent(): NodeView | null;
  children(): NodeView[];
}

/** Tree-layer handle onto one arena node — mirrors Rust's `NodeView`/`NodePayload`. */
export function nodeView(tape: ParsedTape, index: number): NodeView {
  return nodeViewFromRecord(tape, index, nodeAt(tape, index));
}

/** Builds a `NodeView` from an already-decoded record, so a caller that has just read a record
 *  for its own purposes (e.g. `children()` below, walking siblings via `nextSibling`) doesn't
 *  pay for decoding the same 22-byte record a second time through a fresh `nodeAt` call. */
function nodeViewFromRecord(tape: ParsedTape, index: number, record: NodeRecord): NodeView {
  const payloadBytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
  return {
    index,
    payload(): NodePayload {
      return record.tag === TAG_SCOPE
        ? { kind: "scope", name: textDecoder.decode(payloadBytes) }
        : { kind: "event", tag: record.tag, bytes: payloadBytes };
    },
    parent(): NodeView | null {
      return record.parent === null ? null : nodeView(tape, record.parent);
    },
    children(): NodeView[] {
      const result: NodeView[] = [];
      let next = record.firstChild;
      while (next !== null) {
        const childRecord = nodeAt(tape, next);
        result.push(nodeViewFromRecord(tape, next, childRecord));
        next = childRecord.nextSibling;
      }
      return result;
    },
  };
}

/** One top-level source scope in a merged tape's tree (GitHub issue #169) — the label + the
 *  arena index of that scope node itself (its own children are the source's original tree,
 *  starting one level deeper than before merging existed). */
export interface TopLevelSourceScope {
  scopeName: string;
  nodeIndex: number;
}

/** Resolves a top-level source's own content-scan start index (GitHub issue #147). A real merged
 *  tape's `TopLevelSourceScope.nodeIndex` points at the scope *wrapper* node itself (a `TAG_SCOPE`
 *  node whose payload is just the scope's name) — every wrapper is laid out contiguously right
 *  after the merged root, *before* any source's actual content (`merge_tapes`, `maze-core/src/
 *  event_log/mod.rs`), so the wrapper's own `firstChild` is where that source's real events begin,
 *  a different (and for every source after the first, much later) arena index. Passing
 *  `nodeIndex` itself as a flat-scan bound previously let one source's decoder run over a
 *  different source's bytes (e.g. QC's scan started right after QC's own wrapper node, landing
 *  inside generation's content instead).
 *
 *  Some hand-built test fixtures use a legacy flat (pre-#169, unwrapped) tape shape where
 *  `nodeIndex` already points directly at the first real event, not a scope wrapper — this
 *  function stays a no-op for those (`tag !== TAG_SCOPE`), so both shapes work through the same
 *  call sites. */
export function sourceContentStart(tape: ParsedTape, nodeIndex: number): number {
  const record = nodeAt(tape, nodeIndex);
  if (record.tag !== TAG_SCOPE) return nodeIndex;
  return record.firstChild ?? tape.nodeCount;
}

/** Walks the merged root's direct children (GitHub issue #169) — every tape produced since the
 *  merge exists has exactly this shape: node 0 is the merged root, and each of its children is
 *  one source's dedicated top-level scope, in the same order `sourceScopeNames`/
 *  `sourceEventKinds` (`mazeService.ts`) list them. A navigation/inspection helper — aggregating
 *  narration/apply across more than one source scope at once is out of scope until a real second
 *  source (#147) exists. */
export function topLevelSourceScopes(tape: ParsedTape): TopLevelSourceScope[] {
  const root = nodeAt(tape, 0);
  const result: TopLevelSourceScope[] = [];
  let next = root.firstChild;
  while (next !== null) {
    const record = nodeAt(tape, next);
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    result.push({ scopeName: textDecoder.decode(bytes), nodeIndex: next });
    next = record.nextSibling;
  }
  return result;
}

/** Given any arena node index, walks `.parent` up to the nearest top-level source scope and
 *  returns it — the single place this walk happens (Contract B, `Specs/event_log.md`'s #147
 *  section): `debugTreeSelectors.ts`/`DebugEventTree.tsx` call this instead of walking
 *  `record.parent` themselves, so "which source does this node belong to" has exactly one
 *  implementation. Throws if `nodeIndex` is the merged root itself (index 0) or otherwise has no
 *  top-level-scope ancestor — every real node produced by `merge_tapes` has one by construction. */
export function sourceScopeForNode(tape: ParsedTape, nodeIndex: number): TopLevelSourceScope {
  if (nodeIndex === 0) {
    throw new Error("sourceScopeForNode: node 0 is the merged root itself, not a member of any source scope");
  }
  let current = nodeAt(tape, nodeIndex);
  let currentIndex = nodeIndex;
  while (current.parent !== null && current.parent !== 0) {
    currentIndex = current.parent;
    current = nodeAt(tape, currentIndex);
  }
  if (current.parent !== 0) {
    throw new Error(`sourceScopeForNode: node ${nodeIndex} has no top-level-scope ancestor under the merged root`);
  }
  const bytes = tape.payload.subarray(current.payloadOffset, current.payloadOffset + current.payloadLen);
  return { scopeName: textDecoder.decode(bytes), nodeIndex: currentIndex };
}
