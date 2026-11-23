import type { NodeDto } from "../wasm/types";
import type { NotificationSeverity } from "./notificationSeverity";
import { presetEndpoint, presetEndpointKey, type PresetEndpoint } from "./presetEndpoint";

/** A warning that points at concrete cells. It declares only what it targets and how severe it is;
 *  the floor badges, the hover highlight on the canvas and the bubble colors all derive from these
 *  two fields (`CoordinateWarningBubble`, `useCoordinateWarningHover`, `CoordinateWarningHighlight`).
 *  A target is a cell address (point, optional split slot, floor), the same shape every preset
 *  entry uses, so a target may lie outside the field. */
export interface CoordinateWarning {
  severity: NotificationSeverity;
  targets: PresetEndpoint[];
  /** How the warning draws its targets. Targets inside a group are merged into one contour per group; every other
   *  target is a single cell. Each warning chooses this itself: a region is one contour, a set of unrelated cells is not. */
  groups?: CoordinateGroup[];
  /** Cells that only add their floors to the floor badges, without being highlighted (the ends of a connection the
   *  warning frames by other means). */
  floorTargets?: PresetEndpoint[];
}

/** Targets drawn as one merged contour. `outset` draws the contour around the cells (split tiles) instead of inside them. */
export interface CoordinateGroup {
  targets: PresetEndpoint[];
  outset: boolean;
}

/** Targets without duplicates, in first-seen order. */
export function uniqueCoordinateTargets(targets: readonly PresetEndpoint[]): PresetEndpoint[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = presetEndpointKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Distinct, ascending floor indices (`level ?? 0`) the targets lie on. */
export function coordinateWarningLevels(targets: readonly PresetEndpoint[]): number[] {
  return Array.from(new Set(targets.map((target) => target.level ?? 0))).sort((a, b) => a - b);
}

/** Targets of generated maze nodes: each node's own cell and floor. Ids that resolve to no node are skipped. */
export function nodeCoordinateTargets(nodeIds: readonly number[], nodes: readonly Pick<NodeDto, "id" | "x" | "y" | "level">[]): PresetEndpoint[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const targets: PresetEndpoint[] = [];
  for (const id of nodeIds) {
    const node = byId.get(id);
    if (node) targets.push(presetEndpoint([node.x, node.y], undefined, node.level ?? undefined));
  }
  return uniqueCoordinateTargets(targets);
}
