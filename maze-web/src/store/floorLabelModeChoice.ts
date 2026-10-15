import type { MazeStore } from "./storeTypes";
import { defaultFloorLabelMode, withFloorLabelMode } from "./slices/imageExportDefaults";
import { markLinked } from "./slices/parameterLinksEngine";

/** Picks both renderers' floor-label mode from the current floor titles the first time the Image
 *  Export card opens (GitHub issue #747); a no-op once chosen. */
export function chooseFloorLabelModeOnce(s: MazeStore): Partial<MazeStore> {
  if (s.floorLabelModeChosen) return {};
  const mode = defaultFloorLabelMode(s.floors);
  return {
    floorLabelModeChosen: true,
    vectorByWallsSettings: markLinked(withFloorLabelMode(s.vectorByWallsSettings, mode)),
    vectorByCorridorsSettings: markLinked(withFloorLabelMode(s.vectorByCorridorsSettings, mode)),
  };
}
