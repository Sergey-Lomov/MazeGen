import { allNodesAt, presetSplitNodeFaceKinds, presetSplitPointKey, type PresetConnectionEntry } from "./fieldEditUtils";
import { presetEndpointsEqual, type PresetEndpoint } from "./presetEndpoint";
import { splitNodeSemanticNamesFromKinds, splitPointShapeName } from "./splitNodeNames";
import { detectSplitSpecialShapeKind } from "./splitFaceLayout";
import { splitNodeLabelShort } from "../components/features/SplitNodesDialogView";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import * as m from "~/paraglide/messages";

/** Inputs needed to resolve a preset endpoint's compact split-node label at any floor. */
export interface PresetSplitLabelContext {
  splitPoints: Record<string, number[]>;
  presetConnections: Map<string, PresetConnectionEntry>;
  activeSplitNode: Record<string, PresetEndpoint>;
  cfgAt: (level: number) => TessellationConfig;
  inFieldCellsAt: (level: number) => Set<string>;
}

/** Returns the semantic short name for a preset endpoint (for example `Cor1`) when its split
 * topology is recognized, with the compact `N{n}` label as fallback. Returns undefined for an
 * unsplit point, so callers can omit the parenthetical entirely. */
export function resolvePresetSplitNodeShortLabel(
  ctx: PresetSplitLabelContext,
  endpoint: PresetEndpoint,
): string | undefined {
  const level = endpoint.level ?? 0;
  const normalizedLevel = level === 0 ? undefined : level;
  const key = presetSplitPointKey(endpoint.point, normalizedLevel);
  if ((ctx.splitPoints[key]?.length ?? 0) === 0) return undefined;

  const nodes = allNodesAt(endpoint.point, ctx.splitPoints, normalizedLevel);
  const names = splitNodeSemanticNamesFromKinds(nodes.map((node) => presetSplitNodeFaceKinds(
    node,
    endpoint.point,
    ctx.cfgAt(level),
    ctx.inFieldCellsAt(level),
    ctx.presetConnections,
    ctx.splitPoints,
    ctx.activeSplitNode,
    normalizedLevel,
  )));
  const index = nodes.findIndex((node) => presetEndpointsEqual(node, endpoint));
  if (index < 0) return splitNodeLabelShort(endpoint.slotId);
  return names?.[index]?.short ?? splitNodeLabelShort(nodes[index].slotId);
}

/** Whether `point`/`level` is a declared split point at all, per `ctx.splitPoints` — used to gate
 *  `resolvePresetSplitShapeLabel` below (and any other caller that only needs a plain yes/no before
 *  paying for the face-kind computation). */
export function isPresetSplitPoint(
  splitPoints: Record<string, number[]>,
  point: [number, number],
  level: number,
): boolean {
  return (splitPoints[presetSplitPointKey(point, level)]?.length ?? 0) > 0;
}

/** One label for a whole preset split point's shape at `point`/`level` (GitHub issue #594) — the
 *  recognized special-shape name (bridge, diagonal, ...) when the point's face configuration
 *  matches one, else the generic "Split cell" fallback. `null` if the point isn't declared split on
 *  this floor at all. Mirrors post-edit's own `splitNameByFloor` computation
 *  (`PostEditElevatorFloorDialog.tsx`, GitHub issue #567 follow-up) so `PresetElevatorFloorDialog`'s
 *  per-floor row can show the same "which floors are split" hint the post-edit dialog already has. */
export function resolvePresetSplitShapeLabel(
  ctx: PresetSplitLabelContext,
  point: [number, number],
  level: number,
): string | null {
  if (!isPresetSplitPoint(ctx.splitPoints, point, level)) return null;
  const normalizedLevel = level === 0 ? undefined : level;
  const nodes = allNodesAt(point, ctx.splitPoints, normalizedLevel);
  const faceKindsByNode = nodes.map((node) => presetSplitNodeFaceKinds(
    node, point, ctx.cfgAt(level), ctx.inFieldCellsAt(level),
    ctx.presetConnections, ctx.splitPoints, ctx.activeSplitNode, normalizedLevel,
  ));
  const kind = detectSplitSpecialShapeKind(faceKindsByNode);
  return kind !== null ? splitPointShapeName(kind) : m["post_edit.split_cell_label"]();
}
