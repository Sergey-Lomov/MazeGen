import { allNodesAt, presetSplitNodeFaceKinds, presetSplitPointKey, type PresetConnectionEntry } from "./fieldEditUtils";
import { presetEndpointsEqual, type PresetEndpoint } from "./presetEndpoint";
import { splitNodeSemanticNamesFromKinds, splitPointShapeName } from "./splitNodeNames";
import { detectSplitSpecialShapeKind } from "./splitFaceLayout";
import { splitNodeLabelShort } from "../components/features/SplitNodesDialogView";
import { formatTargetLabel } from "./targetLabel";
import type { FieldConfig } from "../fieldConfig";
import { splitShapeBinding } from "./splitShape";
import * as m from "~/paraglide/messages";

/** Inputs needed to resolve a preset endpoint's compact split-node label at any floor. */
export interface PresetSplitLabelContext {
  splitPoints: Record<string, number[]>;
  presetConnections: Map<string, PresetConnectionEntry>;
  activeSplitNode: Record<string, PresetEndpoint>;
  cfgAt: (level: number) => FieldConfig;
  inFieldCellsAt: (level: number) => Set<string>;
}

/** Shared lookup behind `resolvePresetSplitNodeShortLabel`/`resolvePresetSplitNodeFullLabel` —
 *  resolves `endpoint`'s split point to its declared nodes, their semantic names (when the face
 *  configuration matches a recognized special-split topology), and `endpoint`'s own index among
 *  them. `null` when the point has no split entry at all. */
function resolvePresetSplitNodeNames(
  ctx: PresetSplitLabelContext,
  endpoint: PresetEndpoint,
): { nodes: PresetEndpoint[]; names: ReturnType<typeof splitNodeSemanticNamesFromKinds>; index: number } | null {
  const level = endpoint.level ?? 0;
  const normalizedLevel = level === 0 ? undefined : level;
  const key = presetSplitPointKey(endpoint.point, normalizedLevel);
  if ((ctx.splitPoints[key]?.length ?? 0) === 0) return null;

  const nodes = allNodesAt(endpoint.point, ctx.splitPoints, normalizedLevel);
  const cfg = ctx.cfgAt(level);
  const names = splitNodeSemanticNamesFromKinds(nodes.map((node) => presetSplitNodeFaceKinds(
    node,
    endpoint.point,
    cfg,
    ctx.inFieldCellsAt(level),
    ctx.presetConnections,
    ctx.splitPoints,
    ctx.activeSplitNode,
    normalizedLevel,
  )), splitShapeBinding(cfg, endpoint.point[0], endpoint.point[1]));
  const index = nodes.findIndex((node) => presetEndpointsEqual(node, endpoint));
  return { nodes, names, index };
}

/** Returns the semantic short name for a preset endpoint (for example `Cor1`) when its split
 * topology is recognized, with the compact `N{n}` label as fallback. Returns undefined for an
 * unsplit point, so callers can omit the parenthetical entirely. */
export function resolvePresetSplitNodeShortLabel(
  ctx: PresetSplitLabelContext,
  endpoint: PresetEndpoint,
): string | undefined {
  const resolved = resolvePresetSplitNodeNames(ctx, endpoint);
  if (!resolved) return undefined;
  const { nodes, names, index } = resolved;
  if (index < 0) return splitNodeLabelShort(endpoint.slotId);
  return names?.[index]?.short ?? splitNodeLabelShort(nodes[index].slotId);
}

/** Full-form counterpart of `resolvePresetSplitNodeShortLabel` (e.g. "Corridor 1" instead of
 *  "Cor1") — used where the split-node row itself is the row's whole title (entity-delete dialog's
 *  "split_node" row), not a parenthetical suffix on a coordinate. `undefined` for an unsplit
 *  point, same fallback contract as the short form. */
export function resolvePresetSplitNodeFullLabel(
  ctx: PresetSplitLabelContext,
  endpoint: PresetEndpoint,
): string | undefined {
  const resolved = resolvePresetSplitNodeNames(ctx, endpoint);
  if (!resolved || resolved.index < 0) return undefined;
  return resolved.names?.[resolved.index]?.full;
}

/** The single preset-stage point-label formatter (GitHub issue #602) — every preset UI spot that
 *  shows a point's coordinates (status bar, entity-delete dialog bubbles, split-node dialog links)
 *  goes through this, instead of each resolving coordinates/floor/split-node independently. Always
 *  resolves the split-node suffix via `resolvePresetSplitNodeShortLabel` (semantic name when the
 *  point's face configuration matches a recognized special-split topology, else the generic
 *  "N{n}" short label) — `formatTarget`'s two previous callers never resolved this at all (GitHub
 *  issue #595's follow-up).
 *
 *  `includeFloor` is the caller's own call, same as every one of the ten call sites unified here
 *  had before this refactor — cross-floor-relative-to-the-active-floor for a same-point/teleport-
 *  style bubble, or always-true for a cross-floor target bubble (vertical passage/elevator, whose
 *  other end is by construction never on the endpoint's own floor). */
export function presetTargetLabel(
  ctx: PresetSplitLabelContext,
  endpoint: PresetEndpoint,
  includeFloor: boolean,
  floorOnly = false,
): string {
  const suffix = resolvePresetSplitNodeShortLabel(ctx, endpoint);
  return formatTargetLabel(endpoint.point, endpoint.level ?? 0, includeFloor, suffix, floorOnly);
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
  const kind = detectSplitSpecialShapeKind(faceKindsByNode, splitShapeBinding(ctx.cfgAt(level), point[0], point[1]));
  return kind !== null ? splitPointShapeName(kind) : m["preset.split_tile"]();
}
