// --- Preset setup event decoding + replay (GitHub issue #225) ---
//
// One event per preset connection `build_preset_state` resolves into the graph before any
// generation algorithm is dispatched (`maze-core/src/generation/preset_state.rs`) — mirrors that
// module's three event kinds exactly (`Wall` blocks a pair without adding anything, so it emits
// nothing here). Always the first source when present — see `mergeDebugSources` on the WASM
// boundary side (`maze-wasm/src/runner.rs`) and `Specs/event_log.md`'s "Preset Setup Source"
// section.

import { expectLen, readNodeId, type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { validateStepShape, type Edge } from "./applyShared";

export const PRESET_SETUP_TAG = {
  PASSAGE_ESTABLISHED: 1,
  ONE_WAY_ESTABLISHED: 2,
  TELEPORT_ESTABLISHED: 3,
} as const;

export type PresetSetupEvent =
  | { kind: "PassageEstablished"; from: bigint; to: bigint }
  | { kind: "OneWayEstablished"; from: bigint; to: bigint }
  | { kind: "TeleportEstablished"; from: bigint; to: bigint; twoWay: boolean };

/** Decodes one event this source emits. Contract: only called with `tag >= 1` — callers filter
 *  out `TAG_SCOPE` first, same error-on-mismatch contract as every other decoder. */
export function decodePresetSetupEvent(tag: number, bytes: Uint8Array): PresetSetupEvent {
  switch (tag) {
    case PRESET_SETUP_TAG.PASSAGE_ESTABLISHED: {
      expectLen(tag, bytes, 16);
      return { kind: "PassageEstablished", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    }
    case PRESET_SETUP_TAG.ONE_WAY_ESTABLISHED: {
      expectLen(tag, bytes, 16);
      return { kind: "OneWayEstablished", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    }
    case PRESET_SETUP_TAG.TELEPORT_ESTABLISHED: {
      expectLen(tag, bytes, 17);
      return { kind: "TeleportEstablished", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8), twoWay: bytes[16] !== 0 };
    }
    default:
      throw new Error(`PresetSetupEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating` for `PresetSetupEvent` in
 *  `maze-core/src/generation/preset_setup_event.rs` — every event this source emits is mutating,
 *  each one is a preset edge the graph already carries before generation starts. */
export function isMutatingPresetSetupEvent(_event: PresetSetupEvent): boolean {
  return true;
}

export type MutatingPresetSetupEventAt = MutatingEventAt<PresetSetupEvent>;

/** Flat layer: forward scan over the node table, skipping scope nodes, decoding events, filtering
 *  to mutating ones only — mirrors every other algorithm's `mutatingXEventsWithIndex`. */
export function mutatingPresetSetupEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingPresetSetupEventAt[] {
  return mutatingEventsWithIndex(tape, decodePresetSetupEvent, isMutatingPresetSetupEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingPresetSetupEventsWithIndex` for callers that only need the
 *  decoded events, not their arena indices. */
export function mutatingPresetSetupEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): PresetSetupEvent[] {
  return mutatingPresetSetupEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

export interface PresetSetupApplyResult {
  edges: Edge[];
  step: number;
  nodeIndex: number;
}

/** A `PassageEstablished`/two-way `TeleportEstablished` is one logical connection but two directed
 *  graph edges (mirrors `applyRecursiveBacktracker`'s bidirectional `EdgeAdded` handling) —
 *  `OneWayEstablished` and a one-way `TeleportEstablished` contribute only their own direction. */
function edgesFor(event: PresetSetupEvent): Edge[] {
  switch (event.kind) {
    case "PassageEstablished":
      return [{ from: event.from, to: event.to, kind: "basic" }, { from: event.to, to: event.from, kind: "basic" }];
    case "OneWayEstablished":
      return [{ from: event.from, to: event.to, kind: "basic" }];
    case "TeleportEstablished":
      return event.twoWay
        ? [{ from: event.from, to: event.to, kind: "teleport" }, { from: event.to, to: event.from, kind: "teleport" }]
        : [{ from: event.from, to: event.to, kind: "teleport" }];
  }
}

/** Replays the preset setup source up to and including `targetStep` — mirrors every generation
 *  adapter's `applyX`. This source declares no debug values, but does get the same generic
 *  `resolveDebugArenaMetadata` checkpointing every other source gets (`PRESET_SETUP_ADAPTER.
 *  resolveMetadata`, `algorithmRegistry.ts`) — one `PresetSetupEvent` per preset connection, not
 *  one batch event, so a preset-heavy field benefits from checkpointed resume the same way a long
 *  generation run does. */
export function applyPresetSetup(tape: ParsedTape, targetStep: number, from?: PresetSetupApplyResult, startNodeIndex = 0, endIndex?: number): PresetSetupApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyPresetSetup: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return { edges: [...from.edges], step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startNodeIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingPresetSetupEventsWithIndex(tape, needed, scanStart, endIndex);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const edges = from ? [...from.edges] : [];
  for (const { event } of events) {
    edges.push(...edgesFor(event));
  }

  return { edges, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}
