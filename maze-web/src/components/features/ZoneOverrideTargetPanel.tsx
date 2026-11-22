import React, { useEffect, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ZoneOverrideTarget } from "../../store/zonesTypes";
import { cssColor } from "../EntityColorSwatch";
import { Button } from "../Button";
import { SearchInput } from "../SearchInput";
import { SidePanel } from "../SidePanel";
import { ToggleRow } from "../ToggleRow";
import { Inline } from "../Layout";
import { zoneColors, zoneDisplayName, zoneGroupDisplayName } from "../../domain/selectors/zoneSelectors";
import { isAutoGroupId } from "../../domain/autoZones";
import { typography, disabled, spacing, ui } from "../../styles/theme";
import { ZoneCell } from "./ZonesPanel";
import { GroupCell } from "./ZoneGroupsPanel";
import * as m from "~/paraglide/messages";

type Mode = "zones" | "groups";

/** Side panel that picks the zone or group a zone override applies to (GitHub issue #1038): a switch between the
 *  zones and the groups, a search, and a switch for the automatic ones (off by default). Hovering a zone cell lights
 *  the zone in its own colour, a group cell lights all the zones of the group in the info blue. */
export function ZoneOverrideTargetPanel({ onPick, onClose }: { onPick: (target: ZoneOverrideTarget) => void; onClose: () => void }) {
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const floors = useMazeStore((s) => s.floors);
  const colorOverrides = useMazeStore((s) => s.zoneColorOverrides);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const setHoverGroup = useMazeStore((s) => s.setHoveredZoneGroup);
  const [mode, setMode] = useState<Mode>("zones");
  const [query, setQuery] = useState("");
  const [showAuto, setShowAuto] = useState(false);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => { setHover(null); setHoverGroup(null); }, [setHover, setHoverGroup]);

  const needle = query.trim().toLowerCase();
  const palette = zoneColors(zones, colorOverrides);
  const shownZones = zones.flatMap((zone, index) => (
    (showAuto || zone.kind !== "auto") && zoneDisplayName(zone, floors).toLowerCase().includes(needle) ? [{ zone, color: cssColor(palette[index]) }] : []
  ));
  const shownGroups = groups.filter((g) => (showAuto || !isAutoGroupId(g.id)) && zoneGroupDisplayName(g).toLowerCase().includes(needle));

  return (
    <SidePanel title={m["generation.zone_override_pick_title"]()} stackKey="zone-override-target" onClose={onClose}>
      <Inline gap="itemGap" style={styles.body}>
        {(["zones", "groups"] as const).map((option) => (
          <Button key={option} variant={mode === option ? "toggle-selected" : "toggle"} layoutStyle={{ flex: 1 }} onClick={() => { setMode(option); setHover(null); setHoverGroup(null); }}>
            {m[option === "zones" ? "generation.zone_override_mode_zones" : "generation.zone_override_mode_groups"]()}
          </Button>
        ))}
      </Inline>
      <div style={styles.body}>
        <SearchInput value={query} onValueChange={setQuery} placeholder={m["generation.zone_override_search"]()} aria-label={m["generation.zone_override_search"]()} />
      </div>
      <div style={styles.toggle}>
        <ToggleRow label={m["generation.zone_override_show_auto"]()} checked={showAuto} onChange={setShowAuto} />
      </div>
      <div style={styles.list}>
        {mode === "zones" && shownZones.length === 0 && <div style={styles.empty}>{m["generation.zone_override_pick_none"]()}</div>}
        {mode === "groups" && shownGroups.length === 0 && <div style={styles.empty}>{m["generation.zone_override_pick_none"]()}</div>}
        {mode === "zones" && shownZones.map(({ zone, color }) => <ZoneCell key={zone.id} zone={zone} color={color} onPick={() => onPick({ kind: "zone", id: zone.id })} />)}
        {mode === "groups" && shownGroups.map((group) => <GroupCell key={group.id} group={group} onPick={() => onPick({ kind: "group", id: group.id })} />)}
      </div>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  toggle: { padding: `0 ${spacing.groupGap}px ${spacing.groupGap}px` },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
};
