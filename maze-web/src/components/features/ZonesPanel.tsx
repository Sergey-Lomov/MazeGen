import React, { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { Zone } from "../../wasm/mazeService";
import { countZonesOfKind, zoneColors, zoneDisplayName, zoneFloors } from "../../pixi/selectors/zoneSelectors";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { EditIconButton } from "../EditIconButton";
import { EntityColorSwatch, cssColor } from "../EntityColorSwatch";
import { FloorBadgeRow } from "../FloorBadgeRow";
import { ListCell, ListCellAction } from "../ListCell";
import { SidePanel } from "../SidePanel";
import { Inline, Stack } from "../Layout";
import { typography, disabled, muted, spacing, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Zones list side panel of the zones card (GitHub issue #1030): a switch between the auto and the
 *  manual zones, and one card per zone of the section. Hovering a card highlights the zone on the
 *  canvas (`ZonesRenderer`) without changing the floor. */
export function ZonesPanel({ onClose }: { onClose: () => void }) {
  const zones = useMazeStore((s) => s.zones);
  const mode = useMazeStore((s) => s.zonesListMode);
  const setMode = useMazeStore((s) => s.setZonesListMode);
  const addManualZone = useMazeStore((s) => s.addManualZone);
  const setHover = useMazeStore((s) => s.setHoveredZone);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => setHover(null), [setHover]);

  const colors = zoneColors(zones);
  const shown = zones.flatMap((zone, index) => (zone.kind === mode ? [{ zone, color: cssColor(colors[index]) }] : []));

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
      <div style={styles.list}>
        {shown.length === 0 && <div style={styles.empty}>{m[mode === "auto" ? "zones.no_auto" : "zones.no_manual"]()}</div>}
        {shown.map(({ zone, color }) => <ZoneCell key={zone.id} zone={zone} color={color} />)}
      </div>
      {mode === "manual" && (
        <Stack gap="groupGap" style={styles.body}>
          <Button variant="primary" onClick={addManualZone}>{m["zones.add"]()}</Button>
        </Stack>
      )}
    </SidePanel>
  );
}

function ZoneCell({ zone, color }: { zone: Zone; color: string }) {
  const hidden = useMazeStore((s) => s.hiddenZoneIds.includes(zone.id));
  const toggleVisibility = useMazeStore((s) => s.toggleZoneVisibility);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const removeZone = useMazeStore((s) => s.removeZone);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const name = zoneDisplayName(zone);
  const manual = zone.kind === "manual";

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
        actions={
          <>
            <ListCellAction
              title={m[hidden ? "zones.show" : "zones.hide"]()}
              onAction={() => toggleVisibility(zone.id)}
            >
              {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
            </ListCellAction>
            {manual && (
              // Zone editing is tracked separately: the button is in place, but has nothing to open yet.
              <EditIconButton title={m["zones.edit"]()} disabled onClick={() => {}} />
            )}
            {manual && (
              <ListCellAction action="delete" title={m["zones.delete"]()} danger onAction={() => setConfirmingRemove(true)} />
            )}
          </>
        }
        details={
          <>
            <span style={styles.hint}>{m[zone.cells.length === 1 ? "zones.cell_count" : "zones.cell_count_plural"]({ count: zone.cells.length })}</span>
            <FloorBadgeRow levels={zoneFloors(zone)} />
          </>
        }
      />
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
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  hint: { ...muted(typography.body) },
};
