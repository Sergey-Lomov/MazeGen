import { presetEndpoint, presetEndpointFromKey, type PresetEndpoint } from "../../domain/presetEndpoint";
import { presetSplitNodeFaceKinds } from "../../domain/presetSplitResolve";
import type { PresetSplitLabelContext } from "../../domain/presetSplitLabels";
import { resolveFaceNeighbors } from "../../domain/faceNeighbors";
import type { TileFaceNode } from "../../domain/tileFace";
import { splitNodeDiagnostics } from "../splitNodeDiagnostics";

/** Problems of one preset split point (GitHub issue #1107): the face diagnostics shared with the
 *  split edit panel, as ready-to-show messages. The list cell tooltip, the presets warnings section
 *  and the feature map warnings count all derive from this one result. */
export interface PresetSplitPointProblems {
  key: string;
  /** The split point's own endpoint (no slot) — highlight/focus target. */
  endpoint: PresetEndpoint;
  messages: string[];
}

/** Computes the problems of every declared preset split point that has at least one; points without
 *  any are left out. Level-agnostic: every floor's split points are checked. */
export function computePresetSplitProblems(ctx: PresetSplitLabelContext): PresetSplitPointProblems[] {
  const result: PresetSplitPointProblems[] = [];
  // Building the in-field cell set is the costly part; split points on one floor share it.
  const cellsByLevel = new Map<number, Set<string>>();
  const cellsAt = (level: number) => {
    let cells = cellsByLevel.get(level);
    if (cells === undefined) {
      cells = ctx.inFieldCellsAt(level);
      cellsByLevel.set(level, cells);
    }
    return cells;
  };
  for (const [key, rawSlots] of Object.entries(ctx.splitPoints)) {
    if (rawSlots.length === 0) continue;
    const base = presetEndpointFromKey(key);
    if (!base) continue;
    const level = base.level ?? 0;
    const cfg = ctx.cfgAt(level);
    const inFieldCells = cellsAt(level);
    const neighbors = resolveFaceNeighbors(cfg, base.point, inFieldCells);
    // Same node order as the split edit panel: the original node first, then each slot ascending.
    const slots = [...rawSlots].sort((a, b) => a - b);
    const endpoints = [presetEndpoint(base.point, undefined, base.level), ...slots.map((slotId) => presetEndpoint(base.point, slotId, base.level))];
    const nodes: TileFaceNode[] = endpoints.map((endpoint) => {
      const kinds = presetSplitNodeFaceKinds(endpoint, base.point, cfg, inFieldCells, ctx.presetConnections, ctx.splitPoints, ctx.activeSplitNode, base.level);
      return { color: "", faces: neighbors.map((neighbor, i) => ({ kind: kinds[i], boundary: neighbor === null })) };
    });
    const messages = splitNodeDiagnostics(nodes);
    if (messages.length > 0) result.push({ key, endpoint: base, messages });
  }
  return result;
}
