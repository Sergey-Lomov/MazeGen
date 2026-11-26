import type { ProjectFileZones } from "./types";
import type { Zone, ZoneCellWire, ZoneKind } from "../../wasm/mazeService";
import type { ExportZoneOverride, ZoneGroup, ZoneOverride, ZoneOverrideParamKey } from "../zonesTypes";
import { ZONE_OVERRIDE_PARAM_KEYS, ZONE_OVERRIDE_SWITCH_KEYS } from "../../domain/zoneOverrides";
import { assertArray, assertNumber, assertObject, assertString } from "../../validation/validatePrimitives";
import { isAutoGroupId, isAutoZoneId } from "../../domain/autoZones";

const ZONE_KINDS: readonly ZoneKind[] = ["auto", "manual"];

function assertId(v: unknown, path: string): number {
  const n = assertNumber(v, path);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected ${path} to be a non-negative integer`);
  return n;
}

function validateCell(v: unknown, path: string): ZoneCellWire {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== "number" || !Number.isInteger(n))) {
    throw new Error(`Expected ${path} to be [floor, x, y] of integers`);
  }
  return [v[0], v[1], v[2]];
}

function validateZone(v: unknown, path: string): Zone {
  const obj = assertObject(v, path);
  const kind = assertString(obj.kind, `${path}.kind`) as ZoneKind;
  if (!ZONE_KINDS.includes(kind)) throw new Error(`Expected ${path}.kind to be one of ${ZONE_KINDS.join(", ")}`);
  return {
    id: assertId(obj.id, `${path}.id`),
    name: assertString(obj.name, `${path}.name`),
    kind,
    cells: assertArray(obj.cells, `${path}.cells`).map((c, i) => validateCell(c, `${path}.cells[${i}]`)),
  };
}

/** Zones and zone groups of a project file (GitHub issue #1048). Structure only: a cell that no longer
 *  belongs to the field is kept and dropped at use (`filterZonesToField`). Group members that name no zone
 *  are dropped, except automatic zones, which are not saved but computed again with stable ids (GitHub
 *  issue #1033); an empty group stays. */
export function validateZones(raw: unknown, path: string): ProjectFileZones {
  const obj = assertObject(raw, path);
  const zones = assertArray(obj.zones, `${path}.zones`).map((z, i) => validateZone(z, `${path}.zones[${i}]`));
  const zoneIds = new Set<number>();
  for (const zone of zones) {
    if (zoneIds.has(zone.id)) throw new Error(`${path}.zones: duplicate zone id ${zone.id}`);
    zoneIds.add(zone.id);
  }

  const groupIds = new Set<number>();
  const groups = assertArray(obj.groups ?? [], `${path}.groups`).flatMap((g, i): ZoneGroup[] => {
    const where = `${path}.groups[${i}]`;
    const group = assertObject(g, where);
    const id = assertId(group.id, `${where}.id`);
    if (groupIds.has(id)) throw new Error(`${path}.groups: duplicate group id ${id}`);
    groupIds.add(id);
    const members = assertArray(group.zoneIds, `${where}.zoneIds`).map((z, k) => assertId(z, `${where}.zoneIds[${k}]`));
    // Automatic groups are computed, never saved: one in a file is dropped (GitHub issue #1037).
    if (isAutoGroupId(id)) return [];
    return [{ id, name: assertString(group.name, `${where}.name`), zoneIds: [...new Set(members)].filter((z) => zoneIds.has(z) || isAutoZoneId(z)) }];
  });

  const overridesObj = obj.colorOverrides == null ? {} : assertObject(obj.colorOverrides, `${path}.colorOverrides`);
  const colorOverrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(overridesObj)) {
    if (zoneIds.has(Number(key)) || isAutoZoneId(Number(key))) colorOverrides[key] = assertNumber(value, `${path}.colorOverrides.${key}`);
  }

  const overrideIds = new Set<number>();
  const generationOverrides = assertArray(obj.generationOverrides ?? [], `${path}.generationOverrides`).map((o, i): ZoneOverride => {
    const where = `${path}.generationOverrides[${i}]`;
    const item = assertObject(o, where);
    const id = assertId(item.id, `${where}.id`);
    if (overrideIds.has(id)) throw new Error(`${path}.generationOverrides: duplicate override id ${id}`);
    overrideIds.add(id);
    const ids = (key: "zoneIds" | "groupIds") => [...new Set(assertArray(item[key], `${where}.${key}`).map((n, k) => assertId(n, `${where}.${key}[${k}]`)))];
    const paramsObj = assertObject(item.params ?? {}, `${where}.params`);
    const params: ZoneOverride["params"] = {};
    for (const [key, value] of Object.entries(paramsObj)) {
      if (!(ZONE_OVERRIDE_PARAM_KEYS as readonly string[]).includes(key)) throw new Error(`${where}.params: unknown parameter ${key}`);
      const num = assertNumber(value, `${where}.params.${key}`);
      if ((ZONE_OVERRIDE_SWITCH_KEYS as readonly string[]).includes(key) && num !== 0 && num !== 1) throw new Error(`${where}.params.${key}: expected 0 or 1`);
      params[key as ZoneOverrideParamKey] = num;
    }
    return {
      id,
      zoneIds: ids("zoneIds").filter((z) => zoneIds.has(z) || isAutoZoneId(z)),
      groupIds: ids("groupIds").filter((g) => groupIds.has(g) || isAutoGroupId(g)),
      params,
    };
  });

  const exportOverrideIds = new Set<number>();
  const exportOverrides = assertArray(obj.exportOverrides ?? [], `${path}.exportOverrides`).map((o, i): ExportZoneOverride => {
    const where = `${path}.exportOverrides[${i}]`;
    const item = assertObject(o, where);
    const id = assertId(item.id, `${where}.id`);
    if (exportOverrideIds.has(id)) throw new Error(`${path}.exportOverrides: duplicate override id ${id}`);
    exportOverrideIds.add(id);
    const ids = (key: "zoneIds" | "groupIds") => [...new Set(assertArray(item[key], `${where}.${key}`).map((n, k) => assertId(n, `${where}.${key}[${k}]`)))];
    const paramsObj = assertObject(item.params ?? {}, `${where}.params`);
    const mode = item.mode;
    if (mode !== "walls" && mode !== "corridors") throw new Error(`${where}.mode: expected "walls" or "corridors"`);
    const params: ExportZoneOverride["params"] = {};
    for (const [key, value] of Object.entries(paramsObj)) {
      if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") throw new Error(`${where}.params.${key}: expected a number, boolean or string`);
      params[key] = value;
    }
    return {
      id,
      mode,
      zoneIds: ids("zoneIds").filter((z) => zoneIds.has(z) || isAutoZoneId(z)),
      groupIds: ids("groupIds").filter((g) => groupIds.has(g) || isAutoGroupId(g)),
      params,
    };
  });

  const maxZone = Math.max(-1, ...zoneIds);
  const maxGroup = Math.max(-1, ...groupIds);
  const maxOverride = Math.max(-1, ...overrideIds);
  const maxExportOverride = Math.max(-1, ...exportOverrideIds);
  return {
    generationOverrides,
    ...(exportOverrides.length > 0 ? {
      exportOverrides,
      nextExportOverrideId: Math.max(maxExportOverride + 1, obj.nextExportOverrideId == null ? 0 : assertId(obj.nextExportOverrideId, `${path}.nextExportOverrideId`)),
    } : {}),
    nextOverrideId: Math.max(maxOverride + 1, obj.nextOverrideId == null ? 0 : assertId(obj.nextOverrideId, `${path}.nextOverrideId`)),
    zones,
    nextZoneId: Math.max(maxZone + 1, obj.nextZoneId == null ? 0 : assertId(obj.nextZoneId, `${path}.nextZoneId`)),
    groups,
    nextGroupId: Math.max(maxGroup + 1, obj.nextGroupId == null ? 0 : assertId(obj.nextGroupId, `${path}.nextGroupId`)),
    colorOverrides,
  };
}
