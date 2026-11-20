import React, { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { editedZoneOf } from "../../pixi/fieldEditTarget";
import { zoneColors, zoneDisplayName, zoneFloors, zoneIntersections } from "../../pixi/selectors/zoneSelectors";
import { Button } from "../Button";
import { UnregisteredColorRow } from "../ColorRow";
import { SidePanel } from "../SidePanel";
import { FlatIconButton } from "../FlatIconButton";
import { Inline, Stack } from "../Layout";
import { Bubble, BubbleArrow, BubbleHoverZone, BubbleHoverZones } from "../Bubble";
import { FloorBadgeRow } from "../FloorBadgeRow";
import { TextFieldRow } from "../TextFieldRow";
import { ToggleRow } from "../ToggleRow";
import { ToolTooltip } from "../ToolIconButton";
import { typography, spacing, indent } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { FieldToolsSection, SmoothingToggleRow } from "./FieldToolsSection";
import * as m from "~/paraglide/messages";

/** Zone editing side panel (GitHub issue #1031): the shape tools of the field editor, acting on the
 *  cells of one manual zone on the active floor. Every change goes straight into the zone, and the
 *  tools can only reach cells that are part of the field. The close cross cancels (a zone added in this
 *  session is deleted); "Done" keeps the zone. Sections: Properties (name, colour), Editing (modes,
 *  tools, smoothing, other zones) and Intersections (only while the zone overlaps another). */
export function ZoneEditPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const zone = useMazeStore((s) => editedZoneOf(s));
  const zones = useMazeStore((s) => s.zones);
  const overrides = useMazeStore((s) => s.zoneColorOverrides);
  const showOtherZones = useMazeStore((s) => s.showOtherZones);
  const setShowOtherZones = useMazeStore((s) => s.setShowOtherZones);
  const setZoneName = useMazeStore((s) => s.setZoneName);
  const setZoneColor = useMazeStore((s) => s.setZoneColor);
  const setHover = useMazeStore((s) => s.setHoveredZone);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => setHover(null), [setHover]);

  if (!zone) return null;
  const count = zone.cells.length;
  const multiFloor = zoneFloors(zone).length > 1;
  const crossing = zoneIntersections(zones, zone);
  const color = zoneColors(zones, overrides)[zones.findIndex((z) => z.id === zone.id)];
  const automaticColor = !(zone.id in overrides);

  return (
    <SidePanel title={m["zones.edit"]()} stackKey="zone-edit" onClose={onCancel}>
      <Stack gap="groupGap" style={styles.body}>
        <Stack gap="itemGap">
        <div style={styles.sectionHeader}>{m["zones.properties"]()}</div>
        <Stack gap="itemGap" style={styles.content}>
            <TextFieldRow label={m["zones.name"]()} value={zoneDisplayName(zone)} onChange={(name) => setZoneName(zone.id, name)} inputWidth={160} />
            <UnregisteredColorRow
              label={m["zones.color"]()}
              color={color}
              onChange={(next) => setZoneColor(zone.id, next)}
              resetButton={
                <ToolTooltip
                  title={m["zones.color_reset"]()}
                  description={automaticColor ? m["zones.color_reset_applied"]() : undefined}
                >
                  <FlatIconButton
                    title={m["zones.color_reset"]()}
                    withTooltip={false}
                    disabled={automaticColor}
                    onClick={() => setZoneColor(zone.id, null)}
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

        {crossing.length > 0 && (
          <Stack gap="itemGap">
            <div style={styles.sectionHeader}>{m["zones.intersections_title"]()}</div>
            {/* Touching hover zones, as in the glue editor's side rows: no gap between the lines where the
                hover could drop and flash the edited zone. */}
            <BubbleHoverZones style={{ ...styles.content, flexDirection: "column" }}>
              {crossing.map(({ zone: other, floor }) => (
                <BubbleHoverZone key={`${other.id}-${floor}`} onMouseEnter={() => setHover(other.id)} onMouseLeave={() => setHover(null)}>
                  <Inline gap="itemGap">
                    <Bubble>{zoneDisplayName(other)}</Bubble>
                    {multiFloor && <BubbleArrow>-</BubbleArrow>}
                    {multiFloor && <FloorBadgeRow levels={[floor]} />}
                  </Inline>
                </BubbleHoverZone>
              ))}
            </BubbleHoverZones>
          </Stack>
        )}

        <Button variant="primary" layoutStyle={{ width: "100%", marginTop: spacing.itemGap }} onClick={onDone}>
          {m["zones.edit_done"]()}
        </Button>
        <span style={styles.info}>{m[count === 1 ? "zones.size" : "zones.size_plural"]({ count })}</span>
      </Stack>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  sectionHeader: sharedStyles.sectionHeader,
  content: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%" },
  info: { ...typography.caption },
};
