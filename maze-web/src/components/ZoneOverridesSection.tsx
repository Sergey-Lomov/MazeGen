import React from "react";
import { ChevronDown, ChevronRight, ListPlus } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import type { ZoneOverride, ZoneOverrideParamKey, ZoneOverrideTarget } from "../store/zonesTypes";
import { NumberInput } from "./NumberInput";
import { Switch } from "./Switch";
import { Bubble } from "./Bubble";
import { cssColor } from "./EntityColorSwatch";
import { FlatIconButton } from "./FlatIconButton";
import { DeleteIconButton } from "./DeleteIconButton";
import { EditIconButton } from "./EditIconButton";
import { WarningIcon } from "./WarningIcon";
import { sharedStyles } from "../styles/shared";
import { font, spacing, indent, ui } from "../styles/theme";
import { zoneChipColors, zoneColors, zoneDisplayName, zoneFloors, zoneGroupDisplayName } from "../domain/selectors/zoneSelectors";
import { ZONE_OVERRIDE_SWITCH_KEYS, overrideHasNoZones, zoneOverrideConflicts } from "../domain/zoneOverrides";
import * as m from "~/paraglide/messages";

/** What the target picker is asked for: a new override of `params`, or the new target of the override `overrideId`. */
export interface ZoneOverridePickRequest {
  params: ZoneOverride["params"];
  overrideId?: number;
}

const toShown = (value: number, integer?: boolean): string => String(integer ? value : Math.round(value * 10000) / 100);
const fromShown = (raw: string, integer?: boolean): number => (integer ? Number(raw) : Number(raw) / 100);

/** The controls at the end of a parameter's row (GitHub issue #1038): a flat chevron button showing or hiding the
 *  parameter's zone overrides (only while it has some), left of a "+" asking for a zone or group to give the parameter
 *  another value in. The new override starts from the parameter's current global value. */
export function ZoneOverrideControls({ paramKeys, globalValues, expanded, onToggle, onRequest }: {
  paramKeys: ZoneOverrideParamKey[];
  globalValues: number[];
  expanded: boolean;
  onToggle: () => void;
  onRequest: (request: ZoneOverridePickRequest) => void;
}) {
  const hasOverrides = useMazeStore((s) => s.zoneOverrides.some((o) => o.params[paramKeys[0]] !== undefined));
  return (
    <span style={styles.controls}>
      {hasOverrides && (
        <FlatIconButton
          title={m[expanded ? "generation.zone_overrides_hide" : "generation.zone_overrides_show"]()}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </FlatIconButton>
      )}
      <FlatIconButton
        title={m["generation.zone_override_add"]()}
        onClick={() => onRequest({ params: Object.fromEntries(paramKeys.map((key, i) => [key, globalValues[i]])) })}
      >
        <ListPlus size={16} />
      </FlatIconButton>
    </span>
  );
}

/** List of the zone overrides of one parameter, under that parameter's row; absent while collapsed or without any. Each
 *  row is a bubble naming the zone (in its colour) or the group (blue, prefixed) and the value used inside it; hovering
 *  the bubble lights the zone or the group's zones on the canvas, a click picks another target. */
export function ZoneOverridesSection({ paramKeys, integer, expanded, onRequest }: { paramKeys: ZoneOverrideParamKey[]; integer?: boolean; expanded: boolean; onRequest: (request: ZoneOverridePickRequest) => void }) {
  const overrides = useMazeStore((s) => s.zoneOverrides);
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const floors = useMazeStore((s) => s.floors);
  const colorOverrides = useMazeStore((s) => s.zoneColorOverrides);
  const removeZoneOverride = useMazeStore((s) => s.removeZoneOverride);
  const setParam = useMazeStore((s) => s.setZoneOverrideParam);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const setHoverGroup = useMazeStore((s) => s.setHoveredZoneGroup);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const setActiveFloorId = useMazeStore((s) => s.setActiveFloorId);

  const first = paramKeys[0];
  const rows = overrides.filter((o) => o.params[first] !== undefined);
  if (!expanded || rows.length === 0) return null;
  const conflicts = zoneOverrideConflicts(overrides, zones, groups);
  const palette = zoneColors(zones, colorOverrides);

  const targets = (o: ZoneOverride): { key: string; label: string; colors: { bg: string; text: string }; target: ZoneOverrideTarget }[] => [
    ...groups.filter((g) => o.groupIds.includes(g.id)).map((g) => ({
      key: `g${g.id}`,
      label: `${m["zones.group_prefix"]()} ${zoneGroupDisplayName(g)}`,
      colors: { bg: ui.bg.info, text: ui.text.info },
      target: { kind: "group" as const, id: g.id },
    })),
    ...zones.flatMap((z, index) => (o.zoneIds.includes(z.id) ? [{
      key: `z${z.id}`,
      label: zoneDisplayName(z, floors),
      colors: ((chip) => ({ bg: cssColor(chip.bg), text: cssColor(chip.text) }))(zoneChipColors(palette[index])),
      target: { kind: "zone" as const, id: z.id },
    }] : [])),
  ];
  // Shows a floor that holds the target's cells, unless the active one already does.
  const showTarget = (target: ZoneOverrideTarget) => {
    const ids = target.kind === "zone" ? [target.id] : groups.find((g) => g.id === target.id)?.zoneIds ?? [];
    const onFloors = new Set(zones.filter((z) => ids.includes(z.id)).flatMap(zoneFloors));
    if (onFloors.size === 0 || onFloors.has(floors.findIndex((f) => f.id === activeFloorId))) return;
    const floor = floors[Math.min(...onFloors)];
    if (floor) setActiveFloorId(floor.id);
  };
  const hover = (target: ZoneOverrideTarget | null) => {
    setHover(target?.kind === "zone" ? target.id : null);
    setHoverGroup(target?.kind === "group" ? target.id : null);
  };

  return (
    <div style={styles.body}>
      {rows.map((o) => (
        <div key={o.id} style={styles.item}>
          <div style={styles.row}>
            <div style={styles.targets}>
              {targets(o).map((t) => (
                <Bubble
                  key={t.key}
                  data-testid="zone-override-target"
                  colors={t.colors}
                  interactive
                  onMouseEnter={() => hover(t.target)}
                  onMouseLeave={() => hover(null)}
                  onClick={() => showTarget(t.target)}
                >
                  {t.label}
                </Bubble>
              ))}
              {overrideHasNoZones(o, zones, groups) && (
                <Bubble variant="warning" interactive onClick={() => onRequest({ params: o.params, overrideId: o.id })}>{m["generation.zone_override_choose"]()}</Bubble>
              )}
              {(conflicts.get(o.id) ?? []).some((c) => c.params.includes(first)) && <WarningIcon title={m["generation.zone_override_conflict"]()} />}
            </div>
            {paramKeys.map((key) => ZONE_OVERRIDE_SWITCH_KEYS.includes(key) ? (
              <Switch
                key={key}
                checked={(o.params[key] ?? 0) !== 0}
                onChange={(v) => setParam(o.id, key, v ? 1 : 0)}
                ariaLabel={m["generation.zone_override_value"]()}
                height={18}
              />
            ) : (
              <NumberInput
                key={key}
                name={`zone-override-${key}`}
                ariaLabel={m["generation.zone_override_value"]()}
                min={integer ? 1 : 0}
                max={integer ? undefined : 100}
                integer={integer}
                style={{ ...sharedStyles.input, width: 40, height: 18, padding: "0 4px", fontSize: font.sm, boxSizing: "border-box" }}
                value={toShown(o.params[key] ?? 0, integer)}
                onChange={(raw) => setParam(o.id, key, fromShown(raw, integer))}
              />
            ))}
            <EditIconButton title={m["generation.zone_override_edit"]()} onClick={() => { hover(null); onRequest({ params: o.params, overrideId: o.id }); }} />
            <DeleteIconButton title={m["generation.zone_override_remove"]()} onClick={() => { hover(null); removeZoneOverride(o.id); }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // The row's own gap is `spacing.rowGap`; the pull-back keeps the buttons close to the value.
  controls: { display: "flex", alignItems: "center", gap: spacing.elementsGap, marginLeft: spacing.itemGap - spacing.rowGap },
  body: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  item: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  row: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  targets: { flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap },
};
