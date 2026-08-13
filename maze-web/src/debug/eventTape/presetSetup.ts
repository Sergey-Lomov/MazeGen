// --- Preset setup event replay (GitHub issue #225; decoding lives in generated/presetSetup.ts) ---
//
// One event per preset connection `build_preset_state` resolves into the graph before any
// generation algorithm is dispatched (`maze-core/src/generation/preset_state.rs`) — mirrors that
// module's three event kinds exactly (`Wall` blocks a pair without adding anything, so it emits
// nothing here). Always the first source when present — see `mergeDebugSources` on the WASM
// boundary side (`maze-wasm/src/runner.rs`) and `Specs/event_log.md`'s "Preset Setup Source"
// section.

import { type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { validateStepShape, type Edge } from "./applyShared";
import { decodePresetSetupEvent, isMutatingPresetSetupEvent, type PresetSetupEvent } from "./generated/presetSetup";

export type { PresetSetupEvent } from "./generated/presetSetup";
export { decodePresetSetupEvent, isMutatingPresetSetupEvent, PRESET_SETUP_EVENT_TAG } from "./generated/presetSetup";

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

/** A `PassageEstablished`/two-way `TeleportEstablished`/two-way `VerticalPassageEstablished` is one
 *  logical connection but two directed graph edges (mirrors `applyRecursiveBacktracker`'s
 *  bidirectional `EdgeAdded` handling) — `OneWayEstablished` and a one-way
 *  `TeleportEstablished`/`VerticalPassageEstablished` contribute only their own direction.
 *  `ElevatorEstablished` (GitHub issue #357) is always two-way and connects every pair of its own
 *  `nodes` — mirrors `preset_state.rs`'s own all-pairs planting loop. */
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
    case "VerticalPassageEstablished":
      return event.twoWay
        ? [{ from: event.from, to: event.to, kind: "vertical_passage" }, { from: event.to, to: event.from, kind: "vertical_passage" }]
        : [{ from: event.from, to: event.to, kind: "vertical_passage" }];
    case "ElevatorEstablished": {
      const edges: Edge[] = [];
      for (let i = 0; i < event.nodes.length; i++) {
        for (let j = i + 1; j < event.nodes.length; j++) {
          edges.push({ from: event.nodes[i], to: event.nodes[j], kind: "elevator" });
          edges.push({ from: event.nodes[j], to: event.nodes[i], kind: "elevator" });
        }
      }
      return edges;
    }
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
