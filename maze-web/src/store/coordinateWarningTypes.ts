import type { CoordinateWarning } from "../domain/coordinateWarning";

export interface CoordinateWarningState {
  /** The coordinate warning (or one of its targets) under the cursor in a panel; `null` while none is.
   *  Drawn by `CoordinateWarningHighlight` on the active floor, colored by its severity. */
  hoveredCoordinateWarning: CoordinateWarning | null;
}

export interface CoordinateWarningActions {
  setHoveredCoordinateWarning: (warning: CoordinateWarning | null) => void;
}
