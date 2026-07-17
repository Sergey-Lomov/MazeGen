/** Web-side replay engine for the debug event tape (GitHub issue #125). Turns the two flat
 *  buffers produced by `DebugTape::encode()` (`maze-core/src/event_log/mod.rs`, see GitHub issue
 *  #124 and `Specs/event_log.md`) into "maze state at step N" — pure logic, no store/UI wiring.
 *
 *  Two independent layers, deliberately not mixed:
 *  - flat layer (`scan.ts`'s `mutatingEventsWithIndex`, each algorithm's `mutatingXEvents`) —
 *    linear forward scan over the node table, ignoring parent/firstChild/nextSibling entirely.
 *    This is what every `applyX` function uses.
 *  - tree layer (`tree.ts`'s `nodeView`, `.parent()`/`.children()`) — walks
 *    parent/firstChild/nextSibling, for a future structural viewer (#126+); unused by any `applyX`.
 *
 *  This file is a thin re-export barrel — the actual implementation lives in `eventTape/`, split
 *  by responsibility (`wire.ts` binary-format primitives, `tree.ts` tree-layer navigation,
 *  `scan.ts` the generic flat-layer scan, `applyShared.ts` shared apply-loop types/helpers,
 *  `checkpoints.ts` the generic snapshot mechanism) and by generation algorithm
 *  (`recursiveBacktracker.ts`, `kruskal.ts`, `wilson.ts`, `edgeBased.ts`, `vertexBased.ts`,
 *  `qc.ts`). Kept as a barrel — rather than updating every call site's import path — since many
 *  call sites (tests especially) import a mix of names spanning several of those modules at once. */

export * from "./eventTape/wire";
export * from "./eventTape/tree";
export * from "./eventTape/scan";
export * from "./eventTape/applyShared";
export * from "./eventTape/checkpoints";
export * from "./eventTape/recursiveBacktracker";
export * from "./eventTape/kruskal";
export * from "./eventTape/wilson";
export * from "./eventTape/edgeBased";
export * from "./eventTape/vertexBased";
export * from "./eventTape/qc";
