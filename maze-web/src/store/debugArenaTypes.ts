import type { NodeDto } from "../wasm/types";
import type { ParsedTape, Snapshot, DebugValueDescriptor } from "../debug/eventTape";
import type { EventedEventKind } from "../wasm/mazeService";

/** Handle onto the last debug generation run's raw event tape (GitHub issue #124/#125) plus the
 *  static node list needed to join reconstructed `bigint` node ids against `NodeDto.id`. */
export interface DebugArenaHandle {
  tape: ParsedTape;
  /** Which concrete event enum `tape`'s generation source was encoded from — the generation
   *  source's own kind, *not* necessarily `sources[0]` (GitHub issue #225's "preset setup" source,
   *  when present, is always merged before generation — Contract A, `Specs/event_log.md`'s #147
   *  section). Falls back to `sources[sources.length - 1].kind` (always "quality_control", per
   *  Contract A's fixed source order) only for `qc_experiment` runs (GitHub issue #173), which
   *  have no generation source at all — a preset setup source can still precede it there. Kept
   *  only for the handful of call sites that are
   *  inherently generation-specific (e.g. `GenerationRenderer.ts`'s Kruskal DSU-groups toggle,
   *  `DebugPanel.tsx`'s Kruskal-only UI) — anything that needs to dispatch per-node across a
   *  possibly-multi-source tape must use `sources`/`adapterForNode` instead, never this field. */
  algorithmKind: EventedEventKind;
  /** One entry per top-level source scope in `tape`, in the same order as `topLevelSourceScopes`
   *  (GitHub issue #147/#169) — `algorithmKind` above is derived from whichever entry here is the
   *  generation source (see that field's doc comment), not simply `sources[0]`, kept as a
   *  separate field for the generation-specific call sites described in that field's doc comment.
   *  `startStep`/`endStep` are 0-based, half-open `[startStep, endStep)` ranges into the same
   *  global `debugStep` numbering `debugStep`/`totalSteps` already use (Contract A) — e.g. with a
   *  200-step generation source followed by a 12-step QC source, `sources` is
   *  `[{ startStep: 0, endStep: 200, ... }, { startStep: 200, endStep: 212, ... }]`.
   *
   *  `checkpointFroms` (GitHub issue #128, generalized past Recursive Backtracker) is this
   *  source's own intermediate snapshot cache, resolved once at generation time via
   *  `resolveDebugArenaMetadata` — opaque `Snapshot<unknown>[]` here since each source's adapter
   *  produces a structurally different result type (`ApplyResult`/`KruskalApplyResult`/
   *  `QcApplyResult`/etc); only the adapter that produced a given source's snapshots knows how to
   *  consume them (`selectDebugMazeView` always calls `adapterForKind(source.kind)`, so the cast
   *  back to that adapter's own `TResult` is sound at every real call site). Empty when the source
   *  is shorter than `CHECKPOINT_INTERVAL`. */
  sources: {
    scopeName: string;
    kind: EventedEventKind;
    nodeIndex: number;
    startStep: number;
    endStep: number;
    checkpointFroms: Snapshot<unknown>[];
  }[];
  nodes: NodeDto[];
  /** Nodes minted mid-run (preset split, pattern-mode split, QC/repair mint) — including ones
   *  later removed or replaced (`MutationCommand::RemoveNode`/`ReplacePointNodes`) — GitHub issue
   *  #271. Sourced from the WASM response's `debugAllNodes()`. Deliberately *not* a full union of
   *  every node that ever existed: the field's original base nodes are never removed, so they're
   *  always already present in `nodes` below — see `DebugGenerationState`'s doc comment.
   *  Consumers that need the true "every node that ever existed" union (`NodeId -> (x, y)` lookups
   *  in debug-tape narration, `buildNodeCoordIndex`) must concatenate this with `nodes` themselves.
   *  Separate from `nodes` (final survivors only, used for canvas rendering via
   *  `selectDebugMazeView`) — never used for rendering directly, since it can include nodes that
   *  don't exist at the current `debugStep`. */
  allNodes: NodeDto[];
  /** Total mutating-event count across every source in `tape` — a static property of the arena
   *  (computed once at generation time), not a per-step cache; lets the UI know the last valid
   *  `debugStep` without a bounded-scan trick on every render. */
  totalSteps: number;
  /** Every debug value (GitHub issue #131, e.g. `"recursion_stack"`) the instrumented algorithm
   *  declares, name plus rendering `kind` — sourced from the WASM response's static
   *  `debugValueNames` (`GenerateResult::debugValueNames()`/`debugValueKinds()`, mirroring the
   *  algorithm's own declaration in Rust), *not* derived from scanning this tape's actual emitted
   *  deltas — a trivial run that never triggers a delta would otherwise silently omit a name the
   *  algorithm still supports. The debug panel derives its per-value toggle list from this, per
   *  the issue's "declared, not hardcoded, on the web side" requirement. Empty for algorithms not
   *  instrumented for debug values yet. */
  debugValueNames: DebugValueDescriptor[];
}

/** A node/edge/cycle/region reference hovered in the debug event tree narration (GitHub issue
 *  #130) — mirrors the `Token` union built from `RecursiveBacktrackerEvent` payloads in
 *  `DebugEventTree.tsx`. `cycle`/`region` don't occur for Recursive Backtracker's own events but
 *  were modeled up front so QC/repair narration didn't need a shape change later. `issue` (GitHub
 *  issue #171) mirrors `Token`'s own `issue` variant one-to-one — its `target`, when non-null, is
 *  rendered exactly like a standalone `cycle`/`region` ref (see `DebugRefHighlightOverlay`);
 *  `reasons` (one already-resolved display string per contributing check) is only read by
 *  `DebugRefBubble`'s own click-to-modal handling, never by the hover-highlight overlay. */
export type HoveredDebugRef =
  | { kind: "node"; id: bigint }
  | { kind: "edge"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "cycle"; edges: [bigint, bigint][] }
  | { kind: "region"; nodes: bigint[] }
  | {
      kind: "issue"; issueKind: string;
      target: { kind: "cycle"; edges: [bigint, bigint][] } | { kind: "region"; nodes: bigint[] } | null;
      reasons: string[];
    };
