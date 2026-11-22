import React, { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { Zone } from "../../wasm/mazeService";
import { countZonesOfKind, zoneColors, zoneDisplayName, zoneFloors, zoneGroupDisplayName } from "../../domain/selectors/zoneSelectors";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { EditIconButton } from "../EditIconButton";
import { EntityColorSwatch, cssColor } from "../EntityColorSwatch";
import { FloorBadgeRow } from "../FloorBadgeRow";
import { ListCell, ListCellAction } from "../ListCell";
import { SidePanel } from "../SidePanel";
import { startNewZone } from "./zoneEditorActions";
import { groupZones, sortZones, type ZonesGrouping } from "../../store/zoneListSort";
import { SectionHeader } from "../SectionHeader";
import { SelectRow } from "../SelectRow";
import { Inline, Stack } from "../Layout";
import { typography, disabled, spacing, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Zones list side panel of the zones card (GitHub issue #1030): a switch between the auto and the
 *  manual zones, and one card per zone of the section. Hovering a card highlights the zone on the
 *  canvas (`ZonesRenderer`) without changing the floor. */
export function ZonesPanel({ onClose }: { onClose: () => void }) {
  const zones = useMazeStore((s) => s.zones);
  const mode = useMazeStore((s) => s.zonesListMode);
  const setMode = useMazeStore((s) => s.setZonesListMode);
  const setHover = useMazeStore((s) => s.setHoveredZone);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => setHover(null), [setHover]);

  const overrides = useMazeStore((s) => s.zoneColorOverrides);
  const colors = zoneColors(zones, overrides);
  const colorOf = new Map(zones.map((zone, index) => [zone.id, cssColor(colors[index])]));
  const shown = sortZones(zones.filter((zone) => zone.kind === mode));
  const grouping = useMazeStore((s) => s.zonesGrouping[mode]);
  const setGroupingOf = useMazeStore((s) => s.setZonesGrouping);
  const floors = useMazeStore((s) => s.floors);
  // Keys of the expanded sections; every grouping change collapses them all.
  const [expanded, setExpanded] = useState<string[]>([]);
  const sections = groupZones(shown, grouping, floors);
  const hiddenIds = useMazeStore((s) => s.hiddenZoneIds);
  const setZonesVisible = useMazeStore((s) => s.setZonesVisible);
  const toggleSection = (key: string) => setExpanded((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));

  return (
    <SidePanel title={m["zones.list_title"]()} stackKey="zones" onClose={onClose}>
      <Inline gap="itemGap" style={styles.body}>
        {(["auto", "manual"] as const).map((option) => (
          <Button
            key={option}
            variant={mode === option ? "toggle-selected" : "toggle"}
            layoutStyle={{ flex: 1 }}
            onClick={() => setMode(option)}
          >
            {m[option === "auto" ? "zones.mode_auto" : "zones.mode_manual"]({ count: countZonesOfKind(zones, option) })}
          </Button>
        ))}
      </Inline>
      <Stack gap="itemGap" style={styles.groupingRow}>
        <SelectRow<ZonesGrouping>
          label={m["zones.grouping"]()}
          value={grouping}
          options={[
            { value: "none", label: m["zones.group_none"]() },
            { value: "floor", label: m["zones.group_floor"]() },
            ...(mode === "auto" ? [{ value: "type" as const, label: m["zones.group_type"]() }] : []),
          ]}
          onChange={(next) => { setGroupingOf(mode, next); setExpanded([]); }}
          testId="zones-grouping"
        />
      </Stack>
      <div style={styles.list}>
        {shown.length === 0 && <div style={styles.empty}>{m[mode === "auto" ? "zones.no_auto" : "zones.no_manual"]()}</div>}
        {grouping === "none"
          ? shown.map((zone) => <ZoneCell key={zone.id} zone={zone} color={colorOf.get(zone.id)!} />)
          : sections.map((section) => (
            <div key={section.key} data-testid="zone-section">
              <div style={styles.sectionHeader}>
                <SectionHeader
                  label={`${section.label} (${section.zones.length})`}
                  expanded={expanded.includes(section.key)}
                  onToggle={() => toggleSection(section.key)}
                  actions={<SectionEye ids={section.zones.map((zone) => zone.id)} hiddenIds={hiddenIds} onSet={setZonesVisible} />}
                />
              </div>
              {expanded.includes(section.key) && section.zones.map((zone) => <ZoneCell key={zone.id} zone={zone} color={colorOf.get(zone.id)!} />)}
            </div>
          ))}
      </div>
      {mode === "manual" && (
        <Stack gap="groupGap" style={styles.body}>
          <Button variant="primary" onClick={startNewZone}>{m["zones.add"]()}</Button>
        </Stack>
      )}
    </SidePanel>
  );
}

/** The eye of a section: hides all its zones, or shows them all when any of them is hidden. */
function SectionEye({ ids, hiddenIds, onSet }: { ids: number[]; hiddenIds: number[]; onSet: (ids: number[], visible: boolean) => void }) {
  const allVisible = ids.every((id) => !hiddenIds.includes(id));
  return (
    <ListCellAction
      data-testid="zone-section-eye"
      title={m[allVisible ? "zones.hide_section" : "zones.show_section"]()}
      onAction={() => onSet(ids, !allVisible)}
    >
      {allVisible ? <Eye size={16} /> : <EyeOff size={16} />}
    </ListCellAction>
  );
}

/** The details row of a zone or group card: the sizes, then the floor badges on the same line when they fit, else on
 *  their own line, wrapping over several lines when even that is too narrow. */
export function CardDetails({ levels, children }: { levels: number[]; children: React.ReactNode }) {
  return (
    <div style={styles.details}>
      <span style={styles.sizes}>{children}</span>
      <FloorBadgeRow levels={levels} style={styles.badges} />
    </div>
  );
}

/** One zone card. By default it carries the list's actions; `onAdd` leaves a single add icon (a group's
 *  candidates), `onRemove` a single delete icon (a group's zones). */
export function ZoneCell({ zone, color, onAdd, onRemove }: { zone: Zone; color: string; onAdd?: () => void; onRemove?: () => void }) {
  const hidden = useMazeStore((s) => s.hiddenZoneIds.includes(zone.id));
  const toggleVisibility = useMazeStore((s) => s.toggleZoneVisibility);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const removeZone = useMazeStore((s) => s.removeZone);
  const setEditing = useMazeStore((s) => s.setZoneEditId);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const floors = useMazeStore((s) => s.floors);
  const name = zoneDisplayName(zone, floors);
  const manual = zone.kind === "manual";
  const listActions = !onAdd && !onRemove;
  const groups = useMazeStore((s) => s.zoneGroups);
  const groupNames = groups.filter((g) => g.zoneIds.includes(zone.id)).map(zoneGroupDisplayName);


  return (
    <>
      <ListCell
        data-testid="zone-cell"
        onMouseEnter={() => setHover(zone.id)}
        onMouseLeave={() => setHover(null)}
        title={name}
        truncateTitle
        titleAddon={<EntityColorSwatch data-testid="zone-color-dot" color={color} />}
        actionsPlacement="title"
        actions={onRemove ? (
          <ListCellAction action="delete" title={m["zone_groups.remove_zone"]()} danger onAction={onRemove} />
        ) : onAdd ? (
          <ListCellAction action="add" title={m["zone_groups.add_zone"]()} onAction={onAdd} />
        ) : !listActions ? undefined : (
          <>
            <ListCellAction
              title={m[hidden ? "zones.show" : "zones.hide"]()}
              onAction={() => toggleVisibility(zone.id)}
            >
              {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
            </ListCellAction>
            {manual && (
              <EditIconButton title={m["zones.edit"]()} onClick={() => setEditing(zone.id)} />
            )}
            {manual && (
              <ListCellAction action="delete" title={m["zones.delete"]()} danger onAction={() => setConfirmingRemove(true)} />
            )}
          </>
        )}
        details={<CardDetails levels={zoneFloors(zone)}><span style={styles.hint}>{m["zones.cells_info"]({ count: zone.cells.length })}</span></CardDetails>}
      >
        {listActions && (
          <span style={groupNames.length === 0 ? styles.placeholder : styles.hint} data-testid="zone-groups-line">
            {groupNames.length === 0 ? m["zones.no_groups"]() : m["zones.groups_info"]({ names: groupNames.join(", ") })}
          </span>
        )}
      </ListCell>
      {confirmingRemove && (
        <ConfirmModal
          message={m["zones.delete_confirm"]({ name })}
          onConfirm={() => { setConfirmingRemove(false); removeZone(zone.id); }}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  sectionHeader: { padding: `${spacing.groupGap}px`, borderBottom: `1px solid ${ui.border.default}` },
  groupingRow: { padding: `0 ${spacing.groupGap}px ${spacing.groupGap}px` },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  placeholder: { ...disabled(typography.body) },
  hint: { ...typography.body, color: ui.text.tertiary },
  details: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: spacing.itemGap, rowGap: spacing.itemGap, minWidth: 0, flex: 1 },
  sizes: { display: "inline-flex", gap: spacing.itemGap, whiteSpace: "nowrap" },
  badges: { flexShrink: 1, minWidth: 0 },
};
