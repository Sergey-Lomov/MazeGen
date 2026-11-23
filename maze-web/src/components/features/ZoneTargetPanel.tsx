import React, { useEffect, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ZoneOverrideTarget } from "../../store/zonesTypes";
import type { QcZoneScopeMode } from "../../store/qcRuleTypes";
import { cssColor } from "../EntityColorSwatch";
import { Button } from "../Button";
import { SearchInput } from "../SearchInput";
import { SidePanel } from "../SidePanel";
import { ToggleRow } from "../ToggleRow";
import { SelectRow } from "../SelectRow";
import { CategoryInfoModal } from "../CategoryInfoModal";
import { Inline } from "../Layout";
import { zoneColors, zoneDisplayName, zoneGroupDisplayName } from "../../domain/selectors/zoneSelectors";
import { isAutoGroupId } from "../../domain/autoZones";
import { typography, disabled, spacing, ui } from "../../styles/theme";
import { ZoneCell } from "./ZonesPanel";
import { GroupCell } from "./ZoneGroupsPanel";
import * as m from "~/paraglide/messages";

type Mode = "zones" | "groups";

interface ZoneTargetPickerProps {
  /** Picks a zone, or a group with the mode chosen on the picker (`union` unless `groupModes` is set). */
  onPick: (target: ZoneOverrideTarget, groupMode: QcZoneScopeMode) => void;
  /** Shows a Union / Iteration switch over the groups (GitHub issue #1039). */
  groupModes?: boolean;
  /** Whether the automatic zones are shown at first; off by default. */
  showAutoByDefault?: boolean;
  /** Drops the panel's own padding and divider, for a host that pads its body already (a dialog). */
  embedded?: boolean;
}

/** The body that picks a zone or a group, for a zone override (GitHub issue #1038, in a side panel) or a QC rule's
 *  zone scope (GitHub issue #1039, in a dialog): a switch between the zones and the groups, a search, and a switch
 *  for the automatic ones. Hovering a zone cell lights the zone in its own colour, a group cell lights all the zones
 *  of the group in the info blue. */
export function ZoneTargetPicker({ onPick, groupModes = false, showAutoByDefault = false, embedded = false }: ZoneTargetPickerProps) {
  const styles = embedded ? embeddedStyles : panelStyles;
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const floors = useMazeStore((s) => s.floors);
  const colorOverrides = useMazeStore((s) => s.zoneColorOverrides);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const setHoverGroup = useMazeStore((s) => s.setHoveredZoneGroup);
  const [mode, setMode] = useState<Mode>("zones");
  const [query, setQuery] = useState("");
  const [showAuto, setShowAuto] = useState(showAutoByDefault);
  const [groupMode, setGroupMode] = useState<QcZoneScopeMode>("union");
  const [modeInfoOpen, setModeInfoOpen] = useState(false);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => { setHover(null); setHoverGroup(null); }, [setHover, setHoverGroup]);

  const needle = query.trim().toLowerCase();
  const palette = zoneColors(zones, colorOverrides);
  const shownZones = zones.flatMap((zone, index) => (
    (showAuto || zone.kind !== "auto") && zoneDisplayName(zone, floors).toLowerCase().includes(needle) ? [{ zone, color: cssColor(palette[index]) }] : []
  ));
  const shownGroups = groups.filter((g) => (showAuto || !isAutoGroupId(g.id)) && zoneGroupDisplayName(g).toLowerCase().includes(needle));

  return (
    <>
      <Inline gap="itemGap" style={styles.body}>
        {(["zones", "groups"] as const).map((option) => (
          <Button key={option} variant={mode === option ? "toggle-selected" : "toggle"} layoutStyle={{ flex: 1 }} onClick={() => { setMode(option); setHover(null); setHoverGroup(null); }}>
            {m[option === "zones" ? "zones.target_mode_zones" : "zones.target_mode_groups"]()}
          </Button>
        ))}
      </Inline>
      <div style={styles.body}>
        <SearchInput value={query} onValueChange={setQuery} placeholder={m["zones.target_search"]()} aria-label={m["zones.target_search"]()} />
      </div>
      <div style={styles.toggle}>
        <ToggleRow label={m["zones.target_show_auto"]()} checked={showAuto} onChange={setShowAuto} />
      </div>
      {groupModes && mode === "groups" && (
        <div style={styles.toggle}>
          <SelectRow
            label={m["zones.target_group_mode"]()}
            value={groupMode}
            options={[
              { value: "union", label: m["zones.target_group_union"]() },
              { value: "iteration", label: m["zones.target_group_iteration"]() },
            ]}
            onChange={setGroupMode}
            info={() => setModeInfoOpen(true)}
          />
        </div>
      )}
      {modeInfoOpen && (
        <CategoryInfoModal
          title={m["zones.target_group_mode"]()}
          params={[
            { label: m["zones.target_group_union"](), description: m["zones.target_group_union_info"]() },
            { label: m["zones.target_group_iteration"](), description: m["zones.target_group_iteration_info"]() },
          ]}
          onClose={() => setModeInfoOpen(false)}
        />
      )}
      <div style={styles.list}>
        {mode === "zones" && shownZones.length === 0 && <div style={styles.empty}>{m["zones.target_none"]()}</div>}
        {mode === "groups" && shownGroups.length === 0 && <div style={styles.empty}>{m["zones.target_none"]()}</div>}
        {mode === "zones" && shownZones.map(({ zone, color }) => <ZoneCell key={zone.id} zone={zone} color={color} onPick={() => onPick({ kind: "zone", id: zone.id }, groupMode)} />)}
        {mode === "groups" && shownGroups.map((group) => <GroupCell key={group.id} group={group} onPick={() => onPick({ kind: "group", id: group.id }, groupMode)} />)}
      </div>
    </>
  );
}

interface ZoneTargetPanelProps {
  title: string;
  onPick: (target: ZoneOverrideTarget) => void;
  onClose: () => void;
  stackKey?: string;
}

/** Side panel around the picker, for a zone override. */
export function ZoneTargetPanel({ title, onPick, onClose, stackKey = "zone-target" }: ZoneTargetPanelProps) {
  return (
    <SidePanel title={title} stackKey={stackKey} onClose={onClose}>
      <ZoneTargetPicker onPick={(target) => onPick(target)} />
    </SidePanel>
  );
}

const panelStyles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  toggle: { padding: `0 ${spacing.groupGap}px ${spacing.groupGap}px` },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
};

const embeddedStyles: Record<string, React.CSSProperties> = {
  body: {},
  toggle: {},
  list: { ...panelStyles.list, borderTop: "none" },
  empty: panelStyles.empty,
};
