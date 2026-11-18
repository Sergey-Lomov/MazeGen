import { useMazeStore } from "../../store/mazeStore";
import { ToggleRow } from "../ToggleRow";
import { Stack } from "../Layout";
import * as m from "~/paraglide/messages";

export function ZonesFeature() {
  const showAutoZones = useMazeStore((s) => s.showAutoZones);
  const showManualZones = useMazeStore((s) => s.showManualZones);
  const setShowAutoZones = useMazeStore((s) => s.setShowAutoZones);
  const setShowManualZones = useMazeStore((s) => s.setShowManualZones);

  return (
    <Stack gap="itemGap">
      <ToggleRow label={m["zones.show_auto"]()} checked={showAutoZones} onChange={setShowAutoZones} />
      <ToggleRow label={m["zones.show_manual"]()} checked={showManualZones} onChange={setShowManualZones} />
    </Stack>
  );
}
