import type { Zone } from "../wasm/mazeService";
import type { ZoneScopeWire } from "../wasm/types";
import type { ZoneGroup } from "../store/zonesTypes";
import type { QcZoneScopeTarget, CheckInstance } from "../store/qcRuleTypes";
import type { CheckDescriptor } from "../wasm/types";

type ScopedRule = { zoneScope?: QcZoneScopeTarget };

/** The rule is bound to a zone or group that no longer exists (GitHub issue #1039). Derived, never stored: the
 *  deleted zone's id is never reused, so the dangling target stays as the marker. */
export function zoneScopeHasNoZones(rule: ScopedRule, zones: readonly Zone[], groups: readonly ZoneGroup[]): boolean {
  const target = rule.zoneScope;
  if (!target) return false;
  return target.kind === "zone" ? !zones.some((z) => z.id === target.id) : !groups.some((g) => g.id === target.id);
}

/** The rule's scopes on the wire: a zone is one scope (`zone:<id>`), a `union` group is one scope over all its
 *  zones (`group:<id>`), an `iteration` group is one scope per zone. `zones` should be cut to the field already
 *  (`filterZonesToField`). `undefined` for a rule without a zone scope, empty for a target that is gone. */
export function buildZoneScopesWire(rule: ScopedRule, zones: readonly Zone[], groups: readonly ZoneGroup[]): ZoneScopeWire[] | undefined {
  const target = rule.zoneScope;
  if (!target) return undefined;
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const zoneScope = (id: number): ZoneScopeWire[] => {
    const zone = zoneById.get(id);
    return zone ? [{ id: `zone:${id}`, cells: zone.cells.map(([f, x, y]) => [f, x, y]) }] : [];
  };
  if (target.kind === "zone") return zoneScope(target.id);
  const group = groups.find((g) => g.id === target.id);
  if (!group) return [];
  if (target.mode === "iteration") return group.zoneIds.flatMap(zoneScope);
  const cells = new Map<string, [number, number, number]>();
  for (const id of group.zoneIds) for (const [f, x, y] of zoneById.get(id)?.cells ?? []) cells.set(`${f},${x},${y}`, [f, x, y]);
  return [{ id: `group:${group.id}`, cells: [...cells.values()] }];
}

/** The rule holds a check about the maze as a whole (start and finish, regions), which a zone scope cannot
 *  narrow, so the rule takes no scope. Such a check is alone in its issue kind, so no rule mixes it with
 *  checks that do take a scope. */
export function zoneScopeUnsupported(rule: { checks: readonly Pick<CheckInstance, "typeId">[] }, descriptors: readonly Pick<CheckDescriptor, "id" | "zone_scope_unsupported">[]): boolean {
  const unsupported = new Set(descriptors.filter((d) => d.zone_scope_unsupported).map((d) => d.id));
  return rule.checks.some((check) => unsupported.has(check.typeId));
}
