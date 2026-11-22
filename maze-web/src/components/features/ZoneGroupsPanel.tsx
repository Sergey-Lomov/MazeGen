import React, { useEffect, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ZoneGroup } from "../../store/zonesTypes";
import type { Zone } from "../../wasm/mazeService";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import { zoneChipColors, zoneColors, zoneDisplayName, zoneFloors, zoneGroupDisplayName } from "../../domain/selectors/zoneSelectors";
import { Bubble } from "../Bubble";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { EditIconButton } from "../EditIconButton";
import { cssColor } from "../EntityColorSwatch";
import { ListCell, ListCellAction } from "../ListCell";
import { SearchInput } from "../SearchInput";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { Tooltip } from "../Tooltip";
import { SidePanel } from "../SidePanel";
import { Inline, Stack } from "../Layout";
import { TextFieldRow } from "../TextFieldRow";
import { typography, disabled, indent, spacing, ui } from "../../styles/theme";
import { isAutoGroupId } from "../../domain/autoZones";
import { CardDetails, ZoneCell } from "./ZonesPanel";
import { startNewGroup } from "./zoneEditorActions";
import * as m from "~/paraglide/messages";

/** Zone groups list side panel (GitHub issue #1035): one cell per group with its name and zone count,
 *  a pencil that opens the group's zones (`ZoneGroupEditPanel`) and a trash that deletes the group. */
export function ZoneGroupsPanel({ onClose }: { onClose: () => void }) {
  const allGroups = useMazeStore((s) => s.zoneGroups);
  const mode = useMazeStore((s) => s.zoneGroupsListMode);
  const setMode = useMazeStore((s) => s.setZoneGroupsListMode);

  const countOf = (kind: "auto" | "manual") => allGroups.filter((g) => isAutoGroupId(g.id) === (kind === "auto")).length;
  const groups = allGroups.filter((g) => isAutoGroupId(g.id) === (mode === "auto"));

  return (
    <SidePanel title={m["zone_groups.list_title"]()} stackKey="zone-groups" onClose={onClose}>
      <Inline gap="itemGap" style={styles.body}>
        {(["auto", "manual"] as const).map((option) => (
          <Button
            key={option}
            variant={mode === option ? "toggle-selected" : "toggle"}
            layoutStyle={{ flex: 1 }}
            onClick={() => setMode(option)}
          >
            {m[option === "auto" ? "zone_groups.mode_auto" : "zone_groups.mode_manual"]({ count: countOf(option) })}
          </Button>
        ))}
      </Inline>
      <div style={styles.list}>
        {groups.length === 0 && <div style={styles.empty}>{m[mode === "auto" ? "zone_groups.none_auto" : "zone_groups.none"]()}</div>}
        {groups.map((group) => <GroupCell key={group.id} group={group} />)}
      </div>
      {mode === "manual" && (
        <Stack gap="groupGap" style={styles.body}>
          <Button variant="primary" onClick={startNewGroup}>{m["zone_groups.add"]()}</Button>
        </Stack>
      )}
    </SidePanel>
  );
}

/** One group card. By default it has the pencil and trash, its zone
 *  bubbles go to the zone's floor on click, a click on the card opens the zones list grouped by groups, on this
 *  group's section (GitHub issue #1036); `onPick` makes the whole card a plain button instead (the dialog
 *  that adds a zone to a group): no actions, no bubble reactions. Hovering a group highlights nothing. */
export function GroupCell({ group, onPick }: { group: ZoneGroup; onPick?: () => void }) {
  const zones = useMazeStore((s) => s.zones);
  const overrides = useMazeStore((s) => s.zoneColorOverrides);
  const floorIds = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const removeZoneGroup = useMazeStore((s) => s.removeZoneGroup);
  const setEditing = useMazeStore((s) => s.setZoneGroupEditId);
  const showZonesOfGroup = useMazeStore((s) => s.showZonesOfGroup);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const name = zoneGroupDisplayName(group);
  const colors = zoneColors(zones, overrides);
  const members = zones.flatMap((zone, index) => (group.zoneIds.includes(zone.id) ? [{ zone, color: colors[index] }] : []));
  const floors = [...new Set(members.flatMap(({ zone }) => zoneFloors(zone)))].sort((a, b) => a - b);
  const cellCount = new Set(members.flatMap(({ zone }) => zone.cells.map((cell) => cell.join(",")))).size;
  const activeFloor = floorIds.findIndex((f) => f.id === activeFloorId);

  // A zone with no cell on the active floor is not visible there: its bubble goes to one of its floors.
  const goToZone = (zone: Zone) => {
    const zoneOn = zoneFloors(zone);
    if (zoneOn.length > 0 && !zoneOn.includes(activeFloor)) navigateToFloor(zoneOn[0]);
  };

  return (
    <>
      <ListCell
        data-testid="zone-group-cell"
        {...(onPick
          ? { onClick: onPick, style: { cursor: "pointer" } }
          : { onClick: () => showZonesOfGroup(group.id), style: { cursor: "pointer" } })}
        title={name}
        truncateTitle
        actionsPlacement="title"
        actions={onPick || isAutoGroupId(group.id) ? undefined : (
          <>
            <EditIconButton title={m["zone_groups.edit"]()} onClick={() => setEditing(group.id)} />
            <ListCellAction action="delete" title={m["zone_groups.delete"]()} danger onAction={() => setConfirmingRemove(true)} />
          </>
        )}
        details={
          <CardDetails levels={floors}>
            <span style={styles.hint}>{m["zone_groups.zones_info"]({ count: members.length })}</span>
            <span style={styles.hint}>{m["zone_groups.cells_info"]({ count: cellCount })}</span>
          </CardDetails>
        }
      >
        {members.length > 0 && (
          <div style={styles.bubbles}>
            {members.map(({ zone, color }) => {
              const chip = zoneChipColors(color);
              return (
                <Bubble
                  key={zone.id}
                  data-testid="zone-group-bubble"
                  colors={{ bg: cssColor(chip.bg), text: cssColor(chip.text) }}
                  interactive={!onPick}
                  onClick={onPick ? undefined : (event) => { event.stopPropagation(); goToZone(zone); }}
                >
                  {zoneDisplayName(zone, floorIds)}
                </Bubble>
              );
            })}
          </div>
        )}
      </ListCell>
      {confirmingRemove && (
        <ConfirmModal
          message={m["zone_groups.delete_confirm"]({ name })}
          onConfirm={() => { setConfirmingRemove(false); removeZoneGroup(group.id); }}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
    </>
  );
}

/** Side panel over the groups list: the group's name, its zones and the candidates (zones outside the
 *  group), the two as collapsible sections. A new group opens with Candidates expanded, an existing one with
 *  Zones. "Done" keeps the changes (and needs at least one zone); the close cross cancels them, deleting a
 *  group that was just created. */
export function ZoneGroupEditPanel({ groupId, onDone, onCancel }: { groupId: number; onDone: () => void; onCancel: () => void }) {
  const draft = useMazeStore((s) => s.zoneGroupEditDraft);
  const group = draft?.id === groupId ? draft : undefined;
  const isNew = useMazeStore((s) => s.zoneGroupEditIsNew);
  const zones = useMazeStore((s) => s.zones);
  const overrides = useMazeStore((s) => s.zoneColorOverrides);
  const setName = useMazeStore((s) => s.setZoneGroupName);
  const addZonesToGroup = useMazeStore((s) => s.addZonesToGroup);
  const removeZoneFromGroup = useMazeStore((s) => s.removeZoneFromGroup);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const [zonesExpanded, setZonesExpanded] = useState(!isNew);
  const [candidatesExpanded, setCandidatesExpanded] = useState(isNew);
  const floorList = useMazeStore((s) => s.floors);
  const [query, setQuery] = useState("");
  const [showAuto, setShowAuto] = useState(false);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => setHover(null), [setHover]);

  if (!group) return null;
  const colors = zoneColors(zones, overrides);
  const entries = zones.map((zone, index) => ({ zone, color: cssColor(colors[index]) }));
  const members = entries.filter(({ zone }) => group.zoneIds.includes(zone.id));
  const needle = query.trim().toLowerCase();
  const candidates = entries.filter(({ zone }) => !group.zoneIds.includes(zone.id)
    && (showAuto || zone.kind !== "auto")
    && (needle === "" || zoneDisplayName(zone, floorList).toLowerCase().includes(needle)));
  const anyCandidate = zones.some((zone) => !group.zoneIds.includes(zone.id) && (showAuto || zone.kind !== "auto"));
  const empty = members.length === 0;

  return (
    <SidePanel title={m["zone_groups.edit"]()} stackKey="zone-group-edit" onClose={onCancel}>
      <Stack gap="groupGap" style={styles.body}>
        <TextFieldRow label={m["zones.name"]()} value={zoneGroupDisplayName(group)} onChange={(name) => setName(group.id, name)} inputWidth={160} />
        <Stack gap="itemGap">
          <SectionHeader label={m["zone_groups.zones_section"]({ count: members.length })} expanded={zonesExpanded} onToggle={() => setZonesExpanded(!zonesExpanded)} />
          {zonesExpanded && (
            <Stack gap="itemGap" style={styles.sectionBody}>
              <div style={empty ? styles.listBare : styles.list}>
                {empty && <div style={styles.empty}>{m["zone_groups.no_zones"]()}</div>}
                {members.map(({ zone, color }) => (
                  <ZoneCell key={zone.id} zone={zone} color={color} onRemove={() => removeZoneFromGroup(group.id, zone.id)} />
                ))}
              </div>
            </Stack>
          )}
        </Stack>
        <Stack gap="itemGap">
          <SectionHeader label={m["zone_groups.candidates_section"]({ count: candidates.length })} expanded={candidatesExpanded} onToggle={() => setCandidatesExpanded(!candidatesExpanded)} />
          {candidatesExpanded && (
            <Stack gap="itemGap" style={styles.sectionBodySpaced}>
              <SearchInput value={query} onValueChange={setQuery} placeholder={m["zone_groups.search_zones"]()} data-testid="zone-group-candidates-search" />
              <ToggleRow label={m["zone_groups.show_auto"]()} checked={showAuto} onChange={setShowAuto} />
              <div style={candidates.length === 0 ? styles.listBare : styles.list}>
                {candidates.length === 0 && (
                  <div style={styles.empty}>{m[zones.length === 0 ? "zone_groups.no_zones_exist" : !anyCandidate ? "zone_groups.all_added" : "zone_groups.no_matches"]()}</div>
                )}
                {candidates.map(({ zone, color }) => (
                  <ZoneCell key={zone.id} zone={zone} color={color} onAdd={() => addZonesToGroup(group.id, [zone.id])} />
                ))}
              </div>
            </Stack>
          )}
        </Stack>
        <Tooltip block content={empty ? m["zone_groups.done_disabled"]() : ""}>
          <Button variant="primary" layoutStyle={{ width: "100%" }} disabled={empty} onClick={onDone}>{m["zones.edit_done"]()}</Button>
        </Tooltip>
      </Stack>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  // The content of a collapsible section sits one level in from its header.
  sectionBody: { paddingLeft: indent.tree },
  sectionBodySpaced: { paddingLeft: indent.tree, paddingTop: spacing.itemGap },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  // No separator above a placeholder: it has nothing to separate.
  listBare: { display: "flex", flexDirection: "column" },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  hint: { ...typography.body, color: ui.text.tertiary },
  bubbles: { display: "flex", flexWrap: "wrap", gap: spacing.itemGap },
};
