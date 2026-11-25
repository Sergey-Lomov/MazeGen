import type { Zone } from "../wasm/mazeService";
import type { ExportOverrideMode, ExportOverrideValue, ExportZoneOverride, ZoneGroup, ZoneOverrideTarget } from "./zonesTypes";
import type { ParamLink } from "./parameterLinks";
import { propagate, setParamValue } from "./slices/parameterLinksEngine";
import { encodePoint } from "../domain/tessellationProjection";
import { overrideHasNoZones, overrideZoneIds, zoneCellSets, zonesShareCell } from "../domain/zoneOverrides";

/** The parameters a zone cannot set (GitHub issue #1040), by render mode: an exact path in the mode's settings, or a
 *  prefix ending in a dot that covers every path below it. Everything else can differ per zone. What stays global has no
 *  meaningful zone: it belongs to the whole picture (background, outer grid, cut lines, glue tabs, creases, floor label,
 *  trimming at glued faces), changes the drawn geometry or its layout as a whole (marker layout and scale, how teleports
 *  merge, route and cross seams, how split points are drawn, which markers get an index) or is not a single value
 *  (links, split colours). A mode missing here has no zone context at all. */
const GLOBAL_ONLY: Partial<Record<ExportOverrideMode, readonly string[]>> = {
  walls: [
    "background", "showGrid", "gridColor", "showInnerGrid", "showCutLines", "cutLinesGlueColor", "cutLinesColor",
    "creases.", "glueTabs.", "edgeMarkers.", "trimWallsAtFaceBoundaries", "floorLabel.", "floorLabelType", "labelFont.",
    "markerLayout", "markerScale", "teleportMergeMode", "teleportAvoidFieldExit", "teleportThroughSeams", "teleportGroupCustomization",
    "teleportGroupOverrides", "manualTeleportConnectorPaths", "splitSpecialShapes", "splitNodeColors", "markerIndex.coverage.", "links",
  ],
  // Width, corner shape, junction rounding and look can differ per zone; the corridors then step at the zone's border.
  // The split points' identity colours and special shapes stay global, as in the walls mode.
  corridors: [
    "background", "showGrid", "gridColor", "showCutLines", "cutLinesGlueColor", "cutLinesColor",
    "creases.", "glueTabs.", "edgeMarkers.", "trimWallsAtFaceBoundaries", "floorLabel.", "floorLabelType", "labelFont.",
    "markerLayout", "markerScale", "teleportMergeMode", "teleportAvoidFieldExit", "teleportThroughSeams", "teleportGroupCustomization",
    "teleportGroupOverrides", "manualTeleportConnectorPaths", "splitSpecialShapes", "splitNodeColors",
    "markerIndex.coverage.", "links",
  ],
};

/** A zone can also turn a link on or off for its own cells (GitHub issue #1040): the override key `linkEnabled:<target>`
 *  holds that link's `enabled` flag, the link being the one that drives `<target>`. Everything else about a link stays global. */
const LINK_ENABLED_PREFIX = "linkEnabled:";
export const linkEnabledPath = (target: string) => `${LINK_ENABLED_PREFIX}${target}`;
/** The target parameter of a link flag key, or `null` when `path` is an ordinary parameter. */
export const linkTargetOfFlag = (path: string): string | null => (path.startsWith(LINK_ENABLED_PREFIX) ? path.slice(LINK_ENABLED_PREFIX.length) : null);

const isApplied = (mode: ExportOverrideMode, path: string) =>
  GLOBAL_ONLY[mode] !== undefined && (path.startsWith(LINK_ENABLED_PREFIX) || !GLOBAL_ONLY[mode].some((entry) => (entry.endsWith(".") ? path.startsWith(entry) : path === entry)));

/** Whether a zone can set `path` in `mode`: the image draws it, or a link carries it on to something the image draws. */
export function isExportOverridable(mode: ExportOverrideMode, path: string, links: readonly ParamLink[] = []): boolean {
  if (isApplied(mode, path)) return true;
  const seen = new Set([path]);
  const queue = [path];
  while (queue.length > 0) {
    const from = queue.pop() as string;
    for (const link of links) {
      if (link.source !== from || seen.has(link.target)) continue;
      if (isApplied(mode, link.target)) return true;
      seen.add(link.target);
      queue.push(link.target);
    }
  }
  return false;
}

/** Whether the mode draws any zone settings, so its panel offers the zone context. */
export const exportModeSupportsZones = (mode: ExportOverrideMode) => GLOBAL_ONLY[mode] !== undefined;

export interface ExportOverrideConflict {
  /** The other override that sets the same parameters differently on a common cell. */
  otherId: number;
  params: string[];
}

/** Overrides of one mode that set the same parameter to different values on a common cell, by override id. Overlapping
 *  zones are fine while they set different parameters, or the same value; otherwise the choice between the values is
 *  invisible to the user, so it is reported. */
export function exportOverrideConflicts(overrides: readonly ExportZoneOverride[], zones: readonly Zone[], groups: readonly ZoneGroup[]): Map<number, ExportOverrideConflict[]> {
  const cellsOfZone = zoneCellSets(zones);
  const reaches = overrides.map((override) => ({ override, zoneIds: overrideZoneIds(override, zones, groups) }));
  const result = new Map<number, ExportOverrideConflict[]>();
  for (let i = 0; i < reaches.length; i++) {
    for (let j = i + 1; j < reaches.length; j++) {
      const a = reaches[i].override;
      const b = reaches[j].override;
      if (a.mode !== b.mode) continue;
      const differing = Object.keys(a.params).filter((key) => b.params[key] !== undefined && b.params[key] !== a.params[key]);
      if (differing.length === 0 || !zonesShareCell(reaches[i].zoneIds, reaches[j].zoneIds, cellsOfZone)) continue;
      result.set(a.id, [...(result.get(a.id) ?? []), { otherId: b.id, params: differing }]);
      result.set(b.id, [...(result.get(b.id) ?? []), { otherId: a.id, params: differing }]);
    }
  }
  return result;
}

/** A parameter that several overrides set differently on a common cell, with every zone and group involved. */
export interface ExportParamConflict {
  mode: ExportOverrideMode;
  path: string;
  zoneIds: number[];
  groupIds: number[];
}

/** The conflicts of `exportOverrideConflicts` grouped by parameter: one entry per parameter, however many zones clash on it. */
export function exportParamConflicts(overrides: readonly ExportZoneOverride[], zones: readonly Zone[], groups: readonly ZoneGroup[]): ExportParamConflict[] {
  const byId = new Map(overrides.map((o) => [o.id, o]));
  const grouped = new Map<string, { mode: ExportOverrideMode; path: string; zoneIds: Set<number>; groupIds: Set<number> }>();
  for (const [id, list] of exportOverrideConflicts(overrides, zones, groups)) {
    const override = byId.get(id);
    if (!override) continue;
    for (const path of new Set(list.flatMap((c) => c.params))) {
      const key = `${override.mode}:${path}`;
      const entry = grouped.get(key) ?? { mode: override.mode, path, zoneIds: new Set<number>(), groupIds: new Set<number>() };
      override.zoneIds.forEach((zoneId) => entry.zoneIds.add(zoneId));
      override.groupIds.forEach((groupId) => entry.groupIds.add(groupId));
      grouped.set(key, entry);
    }
  }
  return [...grouped.values()].map((e) => ({ mode: e.mode, path: e.path, zoneIds: [...e.zoneIds], groupIds: [...e.groupIds] }));
}

/** How many overrides carry a warning of either kind: no zones left, or a parameter set differently on one cell. */
export function exportOverrideWarningCount(overrides: readonly ExportZoneOverride[], zones: readonly Zone[], groups: readonly ZoneGroup[]): number {
  const conflicts = exportOverrideConflicts(overrides, zones, groups);
  return overrides.filter((o) => overrideHasNoZones(o, zones, groups) || conflicts.has(o.id)).length;
}

type Cell = readonly [number, number];

/** `settings` with the zone's own `params` set, and every link that leaves one of them followed: a zone that sets a
 *  source takes its dependents along. A parameter the zone sets itself is never overwritten by a link into it. A link the
 *  zone turns on follows its source from the start; one it turns off lets its target keep the value it has. */
export function withZoneParams<S extends { links: ParamLink[] }>(settings: S, params: Readonly<Record<string, ExportOverrideValue>>): S {
  const paths = Object.keys(params);
  if (paths.length === 0) return settings;
  const valuePaths = paths.filter((path) => linkTargetOfFlag(path) === null);
  const turnedOn: string[] = [];
  const own = new Set(valuePaths);
  const links = settings.links.map((link) => {
    // A value the zone sets itself no longer follows its source, as a manual edit of a linked field breaks its link globally.
    if (own.has(link.target)) return link.enabled ? { ...link, enabled: false } : link;
    const flag = params[linkEnabledPath(link.target)];
    if (typeof flag !== "boolean" || flag === link.enabled) return link;
    if (flag) turnedOn.push(link.source);
    return { ...link, enabled: flag };
  });
  let next = links.some((link, i) => link !== settings.links[i]) ? { ...settings, links } : settings;
  for (const path of valuePaths) next = setParamValue(next, path, params[path]);
  return propagate(next, links, [...valuePaths, ...turnedOn]);
}

/** `settings` as one override sets them: its parameters the image draws on top, links followed. */
export function settingsWithOverride<S extends { links: ParamLink[] }>(mode: ExportOverrideMode, settings: S, override: ExportZoneOverride): S {
  return withZoneParams(settings, Object.fromEntries(Object.entries(override.params).filter(([path]) => isExportOverridable(mode, path, settings.links))));
}

/** The zone overrides of one render mode as a lookup by cell. */
export interface ExportZoneValues<S> {
  /** Whether some override of the mode sets a parameter on a zone with cells. */
  readonly any: boolean;
  /** The settings that apply to the cells (a wall belongs to the cells on both its sides): the global ones, with the
   *  parameters of every zone holding a cell set (one value per parameter, as the overlap rule picks), and the links
   *  followed. The very same object while no zone reaches the cells. */
  settingsAt(floor: number, cells: readonly Cell[]): S;
}

/** Builds the lookup of one mode for one render. `settings` are the global ones; a cell outside every zone keeps them. */
export function buildExportZoneValues<S extends { links: ParamLink[] }>(overrides: readonly ExportZoneOverride[], mode: ExportOverrideMode, zones: readonly Zone[], groups: readonly ZoneGroup[], settings: S): ExportZoneValues<S> {
  const cellsOfZone = zoneCellSets(zones);
  const entries: { zoneId: number; cells: Set<number>; params: Record<string, ExportOverrideValue> }[] = [];
  for (const override of overrides) {
    if (override.mode !== mode) continue;
    const params = Object.fromEntries(Object.entries(override.params).filter(([path]) => isExportOverridable(mode, path, settings.links)));
    if (Object.keys(params).length === 0) continue;
    for (const zoneId of overrideZoneIds(override, zones, groups)) entries.push({ zoneId, cells: cellsOfZone(zoneId), params });
  }
  entries.sort((a, b) => a.zoneId - b.zoneId);
  const any = entries.some((entry) => entry.cells.size > 0);
  if (!any) return { any, settingsAt: () => settings };
  const cache = new Map<string, S>();
  return {
    any,
    settingsAt: (floor, cells) => {
      const encoded = cells.map(([x, y]) => encodePoint(x, y) * 64 + floor);
      const merged: Record<string, ExportOverrideValue> = {};
      for (const entry of entries) {
        if (!encoded.some((cell) => entry.cells.has(cell))) continue;
        for (const [path, value] of Object.entries(entry.params)) if (!(path in merged)) merged[path] = value;
      }
      const key = JSON.stringify(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
      let result = cache.get(key);
      if (result === undefined) {
        result = withZoneParams(settings, merged);
        cache.set(key, result);
      }
      return result;
    },
  };
}

/** The override of `mode` that holds `target` alone: the one the settings panel edits while that zone or group is its
 *  context. */
export function exportOverrideOf(overrides: readonly ExportZoneOverride[], mode: ExportOverrideMode, target: ZoneOverrideTarget): ExportZoneOverride | undefined {
  return overrides.find((o) => o.mode === mode && (target.kind === "zone"
    ? o.zoneIds.length === 1 && o.zoneIds[0] === target.id && o.groupIds.length === 0
    : o.groupIds.length === 1 && o.groupIds[0] === target.id && o.zoneIds.length === 0));
}

/** `state`'s export overrides with `changes` written into the override of `target` (created when missing): a value sets
 *  a parameter, `null` takes it out; an override left without parameters is dropped. */
export function withExportOverrideParams(
  state: { exportZoneOverrides: ExportZoneOverride[]; nextExportZoneOverrideId: number },
  mode: ExportOverrideMode,
  target: ZoneOverrideTarget,
  changes: Readonly<Record<string, ExportOverrideValue | null>>,
): { exportZoneOverrides: ExportZoneOverride[]; nextExportZoneOverrideId: number } {
  const existing = exportOverrideOf(state.exportZoneOverrides, mode, target);
  const params = { ...(existing?.params ?? {}) };
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) delete params[path];
    else params[path] = value;
  }
  const empty = Object.keys(params).length === 0;
  if (existing) {
    return { ...state, exportZoneOverrides: state.exportZoneOverrides.flatMap((o) => (o !== existing ? [o] : empty ? [] : [{ ...o, params }])) };
  }
  if (empty) return state;
  const fresh: ExportZoneOverride = { id: state.nextExportZoneOverrideId, mode, zoneIds: target.kind === "zone" ? [target.id] : [], groupIds: target.kind === "group" ? [target.id] : [], params };
  return { exportZoneOverrides: [...state.exportZoneOverrides, fresh], nextExportZoneOverrideId: state.nextExportZoneOverrideId + 1 };
}
