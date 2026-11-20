import React, { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { editedZoneOf } from "../../pixi/fieldEditTarget";
import { overridesWithDraft, zoneColors, zoneDisplayName, zoneChipColors, zoneFloors, zoneGroupDisplayName, zoneIntersections, zonesWithDraft } from "../../pixi/selectors/zoneSelectors";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { UnregisteredColorRow } from "../ColorRow";
import { SidePanel } from "../SidePanel";
import { FlatIconButton } from "../FlatIconButton";
import { Inline, Stack } from "../Layout";
import { Bubble, BubbleArrow, BubbleHoverZone, BubbleHoverZones } from "../Bubble";
import { FloorBadgeRow } from "../FloorBadgeRow";
import { TextFieldRow } from "../TextFieldRow";
import { ToggleRow } from "../ToggleRow";
import { ToolTooltip } from "../ToolIconButton";
import { typography, disabled, spacing, indent } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { cssColor } from "../EntityColorSwatch";
import { ListCellAction } from "../ListCell";
import { ZoneGroupNameDialog, ZoneGroupPickerDialog } from "./ZoneGroupDialogs";
import { FieldToolsSection, SmoothingToggleRow } from "./FieldToolsSection";
import * as m from "~/paraglide/messages";

/** Zone editing side panel (GitHub issue #1031): the shape tools of the field editor, acting on the
 *  cells of one manual zone on the active floor. Changes go into a draft, not the zones list, and the
 *  tools can only reach cells that are part of the field. The close cross discards the draft; "Done" commits it. Sections: Properties (name, colour), Editing (modes,
 *  tools, smoothing, other zones) and Intersections (only while the zone overlaps another). */
export function ZoneEditPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const zone = useMazeStore((s) => editedZoneOf(s));
  const storedZones = useMazeStore((s) => s.zones);
  const storedOverrides = useMazeStore((s) => s.zoneColorOverrides);
  const draftColor = useMazeStore((s) => s.zoneEditDraftColor);
  const zones = useMemo(() => zonesWithDraft(storedZones, zone), [storedZones, zone]);
  const overrides = useMemo(() => overridesWithDraft(storedOverrides, zone, draftColor), [storedOverrides, zone, draftColor]);
  const showOtherZones = useMazeStore((s) => s.showOtherZones);
  const setShowOtherZones = useMazeStore((s) => s.setShowOtherZones);
  const setZoneName = useMazeStore((s) => s.setZoneName);
  const setZoneColor = useMazeStore((s) => s.setZoneColor);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const groups = useMazeStore((s) => s.zoneGroups);
  const draftGroupIds = useMazeStore((s) => s.zoneEditDraftGroupIds);
  const newGroups = useMazeStore((s) => s.zoneEditDraftNewGroups);
  const addToGroup = useMazeStore((s) => s.addZoneEditGroup);
  const removeFromGroup = useMazeStore((s) => s.removeZoneEditGroup);
  const addNewGroup = useMazeStore((s) => s.addZoneEditNewGroup);
  const removeNewGroup = useMazeStore((s) => s.removeZoneEditNewGroup);
  const clearCells = useMazeStore((s) => s.clearZoneCells);
  const [dialog, setDialog] = useState<"pick" | "name" | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => setHover(null), [setHover]);

  if (!zone) return null;
  const count = zone.cells.length;
  const zoneGroups = groups.filter((g) => draftGroupIds.includes(g.id));
  const multiFloor = zoneFloors(zone).length > 1;
  const crossing = zoneIntersections(zones, zone);
  const color = zoneColors(zones, overrides)[zones.findIndex((z) => z.id === zone.id)];
  // The zones' bubbles read as the zone's colour on the canvas, as in the groups list.
  const allColors = zoneColors(zones, overrides);
  const chipColorsOf = (id: number) => {
    const chip = zoneChipColors(allColors[zones.findIndex((z) => z.id === id)]);
    return { bg: cssColor(chip.bg), text: cssColor(chip.text) };
  };
  const automaticColor = !(zone.id in overrides);

  return (
    <SidePanel title={m["zones.edit"]()} stackKey="zone-edit" onClose={onCancel}>
      <Stack gap="groupGap" style={styles.body}>
        <Stack gap="itemGap">
        <div style={styles.sectionHeader}>{m["zones.properties"]()}</div>
        <Stack gap="itemGap" style={styles.content}>
            <TextFieldRow label={m["zones.name"]()} value={zoneDisplayName(zone)} onChange={(name) => setZoneName(name)} inputWidth={160} />
            <UnregisteredColorRow
              label={m["zones.color"]()}
              color={color}
              onChange={(next) => setZoneColor(next)}
              resetButton={
                <ToolTooltip
                  title={m["zones.color_reset"]()}
                  description={automaticColor ? m["zones.color_reset_applied"]() : undefined}
                >
                  <FlatIconButton
                    title={m["zones.color_reset"]()}
                    withTooltip={false}
                    disabled={automaticColor}
                    onClick={() => setZoneColor(null)}
                  >
                    <RotateCcw size={16} />
                  </FlatIconButton>
                </ToolTooltip>
              }
            />
        </Stack>
        </Stack>

        <Stack gap="itemGap">
          <div style={styles.sectionHeader}>{m["zones.editing"]()}</div>
          <Stack gap="itemGap" style={styles.content}>
            <FieldToolsSection leadingGap={false} />
            <SmoothingToggleRow customEditor />
            <ToggleRow label={m["zones.show_others"]()} checked={showOtherZones} onChange={setShowOtherZones} />
          </Stack>
        </Stack>

        <Stack gap="itemGap">
          <div style={styles.sectionHeaderRow}>
            <div style={styles.sectionHeader}>{m["zones.groups_title"]()}</div>
            <FlatIconButton title={m["zone_groups.add_to_group"]()} onClick={() => setDialog("pick")} layoutStyle={{ marginLeft: "auto" }}>
              <Plus size={16} />
            </FlatIconButton>
          </div>
          <Stack gap="itemGap" style={styles.content}>
            {zoneGroups.length + newGroups.length === 0 && <span style={styles.placeholder}>{m["zones.no_groups"]()}</span>}
            {zoneGroups.map((group) => (
              <div key={group.id} style={styles.groupRow} data-testid="zone-group-row">
                <span style={styles.groupName}>{zoneGroupDisplayName(group)}</span>
                <ListCellAction action="delete" title={m["zone_groups.remove_zone"]()} danger onAction={() => removeFromGroup(group.id)} />
              </div>
            ))}
            {newGroups.map((name, index) => (
              <div key={`new-${index}`} style={styles.groupRow} data-testid="zone-group-row">
                <span style={styles.groupName}>{name}</span>
                <ListCellAction action="delete" title={m["zone_groups.remove_zone"]()} danger onAction={() => removeNewGroup(index)} />
              </div>
            ))}
          </Stack>
        </Stack>

        {crossing.length > 0 && (
          <Stack gap="itemGap">
            <div style={styles.sectionHeader}>{m["zones.intersections_title"]()}</div>
            {/* Touching hover zones, as in the glue editor's side rows: no gap between the lines where the
                hover could drop and flash the edited zone. */}
            <BubbleHoverZones style={{ ...styles.content, flexDirection: "column" }}>
              {crossing.map(({ zone: other, floor }) => (
                <BubbleHoverZone key={`${other.id}-${floor}`} onMouseEnter={() => setHover(other.id)} onMouseLeave={() => setHover(null)}>
                  <Inline gap="itemGap">
                    <Bubble colors={chipColorsOf(other.id)}>{zoneDisplayName(other)}</Bubble>
                    {multiFloor && <BubbleArrow>-</BubbleArrow>}
                    {multiFloor && <FloorBadgeRow levels={[floor]} />}
                  </Inline>
                </BubbleHoverZone>
              ))}
            </BubbleHoverZones>
          </Stack>
        )}

        <Button variant="destructive" layoutStyle={{ width: "100%", marginTop: spacing.itemGap }} disabled={count === 0} onClick={() => setConfirmingClear(true)}>
          {m["zones.clear"]()}
        </Button>
        <Button variant="primary" layoutStyle={{ width: "100%" }} onClick={onDone}>
          {m["zones.edit_done"]()}
        </Button>
        <span style={styles.info}>{m[count === 1 ? "zones.size" : "zones.size_plural"]({ count })}</span>
      </Stack>
      {confirmingClear && (
        <ConfirmModal
          message={m["zones.clear_confirm"]({ name: zoneDisplayName(zone) })}
          onConfirm={() => { setConfirmingClear(false); clearCells(); }}
          onCancel={() => setConfirmingClear(false)}
        />
      )}
      {dialog === "pick" && <ZoneGroupPickerDialog excludeIds={draftGroupIds} onPick={addToGroup} onClose={() => setDialog(null)} onNew={() => setDialog("name")} />}
      {dialog === "name" && <ZoneGroupNameDialog onConfirm={addNewGroup} onClose={() => setDialog(null)} />}
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  sectionHeader: sharedStyles.sectionHeader,
  content: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%" },
  info: { ...typography.caption },
  placeholder: { ...disabled(typography.body) },
  sectionHeaderRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  groupRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0 },
  groupName: { ...typography.body, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
};
