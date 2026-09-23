import { allNodesAt, presetSplitNodeFaceKinds, type PresetConnectionEntry } from "./fieldEditUtils";
import { presetEndpointsEqual, type PresetEndpoint } from "./presetEndpoint";
import { splitNodeSemanticNamesFromKinds } from "./splitNodeNames";
import { splitNodeLabelShort } from "../components/features/SplitNodesDialogView";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

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
  const key = normalizedLevel === undefined
    ? `${endpoint.point[0]},${endpoint.point[1]}`
    : `${endpoint.point[0]},${endpoint.point[1]}@${normalizedLevel}`;
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
