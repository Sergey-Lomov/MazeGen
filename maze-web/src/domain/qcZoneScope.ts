import type { Zone } from "../wasm/mazeService";
import type { ZoneScopeWire } from "../wasm/types";
import type { ZoneGroup } from "../store/zonesTypes";
import type { QcZoneScopeTarget, CheckInstance } from "../store/qcRuleTypes";
import type { CheckDescriptor } from "../wasm/types";
import { zonesHaveCells } from "./zoneOverrides";

type ScopedRule = { zoneScope?: QcZoneScopeTarget };

/** The rule is bound to a zone or group with nothing to scope to (GitHub issue #1039): it no longer exists, or it holds no
 *  cell (an empty zone, or a group of such zones; GitHub issue #1034). Derived, never stored: the deleted zone's id is
 *  never reused, so the dangling target stays as the marker. */
export function zoneScopeHasNoZones(rule: ScopedRule, zones: readonly Zone[], groups: readonly ZoneGroup[]): boolean {
  return zoneScopeProblem(rule, zones, groups) !== null;
}

/** Why the rule has nothing to scope to: its zone or group is `missing` (deleted), or it exists but is `empty`. `null`
 *  for a rule with a target that has cells, and for a rule without a zone scope. */
export function zoneScopeProblem(rule: ScopedRule, zones: readonly Zone[], groups: readonly ZoneGroup[]): "missing" | "empty" | null {
  const target = rule.zoneScope;
  if (!target) return null;
  if (target.kind === "zone") {
    if (!zones.some((z) => z.id === target.id)) return "missing";
    return zonesHaveCells([target.id], zones) ? null : "empty";
  }
  const group = groups.find((g) => g.id === target.id);
  if (!group) return "missing";
  return zonesHaveCells(group.zoneIds, zones) ? null : "empty";
}

/** The wire id of a scope (`zone:<id>` / `group:<id>`); `parseZoneScopeId` is its inverse. */
export const zoneScopeId = (kind: "zone" | "group", id: number): string => `${kind}:${id}`;

/** The rule's scopes on the wire: a zone is one scope (`zone:<id>`), a `union` group is one scope over all its
 *  zones (`group:<id>`), an `iteration` group is one scope per zone. `zones` should be cut to the field already
 *  (`filterZonesToField`). `undefined` for a rule without a zone scope, empty for a target that is gone. */
export function buildZoneScopesWire(rule: ScopedRule, zones: readonly Zone[], groups: readonly ZoneGroup[]): ZoneScopeWire[] | undefined {
  const target = rule.zoneScope;
  if (!target) return undefined;
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const zoneScope = (id: number): ZoneScopeWire[] => {
    const zone = zoneById.get(id);
    return zone ? [{ id: zoneScopeId("zone", id), cells: zone.cells.map(([f, x, y]) => [f, x, y]) }] : [];
  };
  if (target.kind === "zone") return zoneScope(target.id);
  const group = groups.find((g) => g.id === target.id);
  if (!group) return [];
  if (target.mode === "iteration") return group.zoneIds.flatMap(zoneScope);
  const cells = new Map<string, [number, number, number]>();
  for (const id of group.zoneIds) for (const [f, x, y] of zoneById.get(id)?.cells ?? []) cells.set(`${f},${x},${y}`, [f, x, y]);
  return [{ id: zoneScopeId("group", group.id), cells: [...cells.values()] }];
}

/** Some rule is bound to one of these zones or groups (GitHub issue #1093): a change to them changes what that rule sees. */
export function anyRuleScopedTo(rules: readonly ScopedRule[], zoneIds: readonly number[], groupIds: readonly number[]): boolean {
  return rules.some((r) => r.zoneScope !== undefined && (r.zoneScope.kind === "zone" ? zoneIds : groupIds).includes(r.zoneScope.id));
}

/** Inverse of the wire scope id (`IssueDto.scope_id`): the zone or group an issue was found in. `null` for an absent or
 *  malformed id. */
export function parseZoneScopeId(scopeId: string | null | undefined): { kind: "zone" | "group"; id: number } | null {
  const match = /^(zone|group):(\d+)$/.exec(scopeId ?? "");
  return match ? { kind: match[1] as "zone" | "group", id: Number(match[2]) } : null;
}

/** The rule holds a check about the maze as a whole (start and finish, regions), which a zone scope cannot
 *  narrow, so the rule takes no scope. Such a check is alone in its issue kind, so no rule mixes it with
 *  checks that do take a scope. */
export function zoneScopeUnsupported(rule: { checks: readonly Pick<CheckInstance, "typeId">[] }, descriptors: readonly Pick<CheckDescriptor, "id" | "zone_scope_unsupported">[]): boolean {
  const unsupported = new Set(descriptors.filter((d) => d.zone_scope_unsupported).map((d) => d.id));
  return rule.checks.some((check) => unsupported.has(check.typeId));
}
