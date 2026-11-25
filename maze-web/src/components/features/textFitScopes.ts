import type { EdgeDto, NodeDto } from "../../wasm/types";
import type { Zone } from "../../wasm/mazeService";
import type { FieldConfig } from "../../fieldConfig";
import type { ParamLink } from "../../store/parameterLinks";
import type { ExportOverrideMode, ExportZoneOverride, ZoneGroup, ZoneOverrideTarget } from "../../store/zonesTypes";
import { buildExportZoneValues } from "../../store/exportZoneOverrides";
import { overrideZoneIds, zoneCellSets } from "../../domain/zoneOverrides";
import { encodePoint } from "../../domain/tessellationProjection";
import { selectFloorScopedMaze } from "../../domain/selectors/mazeSelectors";
import { computeTextFitItemsAcrossFloors, textSizeOf, type TextFitKind, type TextFitOwner, type TextFitSettings } from "../../pixi/selectors/exportTextFit";
import type { TextFitItem } from "../../pixi/textFit";
import type { WarningFloor } from "../../pixi/selectors/exportWarnings";
import { maxFittingFontSize } from "../../pixi/textFit";

/** The labels of one settings variant: the global one, or the settings a zone produces (GitHub issue #1040). */
export interface TextFitGroup<S> {
  settings: S;
  items: Record<TextFitKind, TextFitItem[]>;
}

export interface TextFitScopeInput<S> {
  nodes: NodeDto[];
  edges: EdgeDto[];
  floors: WarningFloor[];
  cfg: FieldConfig;
  start: number | null;
  finish: number | null;
  /** The settings the panel edits: the global ones, or the global plus the open zone's override. */
  settings: S;
  mode: ExportOverrideMode;
  overrides: readonly ExportZoneOverride[];
  zones: readonly Zone[];
  groups: readonly ZoneGroup[];
  /** The zone or group whose settings the panel edits; null while it edits the global ones. */
  target: ZoneOverrideTarget | null;
}

/** Splits the project's labels by the settings each is drawn with, so an auto-fit measures every label against the plate it
 *  really sits on. In a zone's context only that zone's labels are counted, with the zone's settings. In the global context
 *  there is one group per distinct settings variant of the zones, the global one first. */
export function computeTextFitGroups<S extends TextFitSettings & { links: ParamLink[] }>(input: TextFitScopeInput<S>): TextFitGroup<S>[] {
  const { nodes, edges, floors, cfg, start, finish, settings, mode, overrides, zones, groups, target } = input;
  const compute = (variant: TextFitSettings, owns?: TextFitOwner) => computeTextFitItemsAcrossFloors(nodes, edges, floors, cfg, variant, start, finish, owns);

  if (target) {
    const cellsOf = zoneCellSets(zones);
    const ids = overrideZoneIds(
      { zoneIds: target.kind === "zone" ? [target.id] : [], groupIds: target.kind === "group" ? [target.id] : [] },
      zones, groups,
    );
    const inTarget = (floor: number, cells: readonly (readonly [number, number])[]) => (
      ids.some((id) => { const set = cellsOf(id); return cells.some(([x, y]) => set.has(encodePoint(x, y) * 64 + floor)); })
    );
    return [{ settings, items: compute(settings, inTarget) }];
  }

  const zoneValues = buildExportZoneValues(overrides, mode, zones, groups, settings);
  if (!zoneValues.any) return [{ settings, items: compute(settings) }];

  // A variant can enable a label kind the global settings leave off, so the variants come from the cells, not from the labels.
  const variants = new Set<S>([settings]);
  for (const [index, floor] of floors.entries()) {
    for (const node of selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish).nodes) variants.add(zoneValues.settingsAt(index, [[node.x, node.y]]));
  }
  return [...variants].map((variant) => ({
    settings: variant,
    items: compute(variant, (floor, cells) => (cells.length === 0 ? variant === settings : zoneValues.settingsAt(floor, cells) === variant)),
  }));
}

/** The largest size one size control can take so that every label it drives fits. A zone that sets its own size for `kind`
 *  is out of the count: the global size never reaches it. */
export function fitAcrossGroups<S extends TextFitSettings>(groups: readonly TextFitGroup<S>[], kinds: readonly TextFitKind[], range?: { min: number; max: number; step: number }): number | null {
  const base = groups[0]?.settings;
  if (!base) return null;
  let best: number | null = null;
  for (const group of groups) {
    const items = kinds.flatMap((kind) => (group === groups[0] || textSizeOf(kind, group.settings) === textSizeOf(kind, base) ? group.items[kind] : []));
    const fit = maxFittingFontSize(items, range);
    if (fit !== null && (best === null || fit < best)) best = fit;
  }
  return best;
}
