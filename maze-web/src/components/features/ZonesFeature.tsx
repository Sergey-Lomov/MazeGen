import { useEffect } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ToggleRow } from "../ToggleRow";
import { Button } from "../Button";
import { Stack } from "../Layout";
import { startNewZone } from "./zoneEditorActions";
import { ZonesPanel } from "./ZonesPanel";
import { ZoneEditPanel } from "./ZoneEditPanel";
import { ZoneCombinePanel } from "./ZoneCombinePanel";
import { ZoneGroupsPanel, ZoneGroupEditPanel } from "./ZoneGroupsPanel";
import * as m from "~/paraglide/messages";

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
