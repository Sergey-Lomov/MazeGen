import { useEffect, useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ToggleRow } from "../ToggleRow";
import { Button } from "../Button";
import { Stack } from "../Layout";
import { startNewZone } from "./zoneEditorActions";
import { ZonesPanel } from "./ZonesPanel";
import { ZoneEditPanel } from "./ZoneEditPanel";
import { ZoneCombinePanel } from "./ZoneCombinePanel";
import { ZoneGroupsPanel, ZoneGroupEditPanel } from "./ZoneGroupsPanel";
import { SectionHeader } from "../SectionHeader";
import { Tooltip } from "../Tooltip";
import { WarningBubble } from "../WarningBubble";
import { CoordinateWarningBubble } from "../CoordinateWarningBubble";
import { useCoordinateWarningHover } from "../useCoordinateWarningHover";
import { selectZoneProblems, zoneWarningCount } from "../../store/zoneProblemsSelector";
import { invalidCellsWarning } from "../../domain/zoneProblems";
import { ZoneProblemChips } from "./ZoneProblemChips";
import type { CoordinateWarning } from "../../domain/coordinateWarning";
import { indent, spacing, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** The zone problems (GitHub issue #1034), collapsed by default; its count is the number of its bubbles, as in the card status.
 *  One warning for the zones beyond the field: hovering it lights all their cells outside it on the current floor (merged
 *  into contours), hovering a zone chip lights that zone and its own cells outside; it has no floor badges, the
 *  chips go to the floors. One each for the empty zones and groups together and for the unused zones, naming them as bubbles below
 *  (`ZoneProblemChips`). */
function ZoneWarningsSection() {
  const problems = useMazeStore(selectZoneProblems);
  const { invalid, unused, emptyZones, emptyGroups } = problems;
  const invalidWarning = useMemo(() => invalidCellsWarning(invalid), [invalid]);
  const [expanded, setExpanded] = useState(false);
  const count = zoneWarningCount(problems);
  return (
    <div data-testid="zone-warnings">
      <SectionHeader
        label={<span className={count > 0 ? "problem-section-attention" : undefined}>{m["common.warnings"]({ count: String(count) })}</span>}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && count > 0 && (
        <div style={styles.list}>
          {invalid.length > 0 && (
            <CoordinateWarningBubble warning={invalidWarning} message={m["zones.warning_invalid_cells"]()} hideFloorBadges>
              <ZoneProblemChips invalid={invalid} />
            </CoordinateWarningBubble>
          )}
          {emptyZones.length + emptyGroups.length > 0 && (
            <WarningBubble message={m["zones.warning_empty"]()}><ZoneProblemChips zones={emptyZones} groups={emptyGroups} /></WarningBubble>
          )}
          {unused.length > 0 && (
            <WarningBubble message={m["zones.warning_unused"]()}><ZoneProblemChips zones={unused} /></WarningBubble>
          )}
        </div>
      )}
      <div style={styles.divider} />
    </div>
  );
}

/** "Remove unavailable cells": active only while a manual zone has cells outside the field; hovering it lights them
 *  on the current floor, as the invalid-cells warning does. */
function RemoveInvalidCellsButton() {
  const { invalid } = useMazeStore(selectZoneProblems);
  const removeInvalidZoneCells = useMazeStore((s) => s.removeInvalidZoneCells);
  const warning = useMemo<CoordinateWarning>(() => invalidCellsWarning(invalid), [invalid]);
  const hover = useCoordinateWarningHover(warning);
  const none = invalid.length === 0;
  return (
    <Tooltip block content={none ? m["zones.remove_invalid_none"]() : ""}>
      <Button
        variant="destructive"
        layoutStyle={{ width: "100%" }}
        disabled={none}
        onClick={() => {
          // The cells are gone and the button turns disabled, which swallows the mouse leave: the highlight is cleared here.
          hover.onMouseLeave();
          removeInvalidZoneCells();
        }}
        onMouseEnter={hover.onMouseEnter}
        onMouseLeave={hover.onMouseLeave}
      >
        {m["zones.remove_invalid"]()}
      </Button>
    </Tooltip>
  );
}

export function ZonesFeature() {
  const showAutoZones = useMazeStore((s) => s.showAutoZones);
  const showManualZones = useMazeStore((s) => s.showManualZones);
  const setShowAutoZones = useMazeStore((s) => s.setShowAutoZones);
  const setShowManualZones = useMazeStore((s) => s.setShowManualZones);
  const zonesPanelOpen = useMazeStore((s) => s.zonesPanelOpen);
  const setZonesPanelOpen = useMazeStore((s) => s.setZonesPanelOpen);
  const zoneEditing = useMazeStore((s) => s.zoneEditDraft !== null);
  const commitZoneEdit = useMazeStore((s) => s.commitZoneEdit);
  const cancelZoneEdit = useMazeStore((s) => s.cancelZoneEdit);
  const combineOpen = useMazeStore((s) => s.zoneCombine !== null);
  const zoneGroupsPanelOpen = useMazeStore((s) => s.zoneGroupsPanelOpen);
  const setZoneGroupsPanelOpen = useMazeStore((s) => s.setZoneGroupsPanelOpen);
  const zoneGroupEditId = useMazeStore((s) => s.zoneGroupEditId);
  const commitZoneGroupEdit = useMazeStore((s) => s.commitZoneGroupEdit);
  const cancelZoneGroupEdit = useMazeStore((s) => s.cancelZoneGroupEdit);

  // Leaving the zones card ends editing: unconfirmed drafts are dropped, the lists stay as they are.
  useEffect(() => () => {
    useMazeStore.getState().cancelZoneEdit();
    useMazeStore.getState().cancelZoneGroupEdit();
  }, []);

  return (
    <Stack gap="itemGap">
      <ZoneWarningsSection />
      <ToggleRow label={m["zones.show_auto"]()} checked={showAutoZones} onChange={setShowAutoZones} />
      <ToggleRow label={m["zones.show_manual"]()} checked={showManualZones} onChange={setShowManualZones} />
      <Button
        variant="primary"
        layoutStyle={{ width: "100%" }}
        onClick={startNewZone}
      >
        {m["zones.add"]()}
      </Button>
      <Button
        variant="secondary"
        layoutStyle={{ width: "100%" }}
        onClick={() => {
          setZonesPanelOpen(true);
        }}
      >
        {m["zones.open_list"]()}
      </Button>
      <Button
        variant="secondary"
        layoutStyle={{ width: "100%" }}
        onClick={() => {
          setZoneGroupsPanelOpen(true);
        }}
      >
        {m["zone_groups.open_list"]()}
      </Button>
      <RemoveInvalidCellsButton />
      {zoneGroupsPanelOpen && <ZoneGroupsPanel onClose={() => setZoneGroupsPanelOpen(false)} />}
      {zoneGroupsPanelOpen && zoneGroupEditId !== null && (
        <ZoneGroupEditPanel groupId={zoneGroupEditId} onDone={commitZoneGroupEdit} onCancel={cancelZoneGroupEdit} />
      )}
      {zonesPanelOpen && <ZonesPanel onClose={() => setZonesPanelOpen(false)} />}
      {zonesPanelOpen && zoneEditing && <ZoneEditPanel onDone={commitZoneEdit} onCancel={cancelZoneEdit} />}
      {zonesPanelOpen && zoneEditing && combineOpen && <ZoneCombinePanel />}
    </Stack>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column", gap: spacing.groupGap, paddingLeft: indent.tree, marginTop: spacing.groupGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.groupGap}px 0 ${spacing.itemGap}px` },
};
