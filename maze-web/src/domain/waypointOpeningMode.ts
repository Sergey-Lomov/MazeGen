/** What a start/finish "External passage" (GitHub issue #330) does to the field's outer wall:
 *  `"none"` leaves the wall alone, `"opening"` leaves the chosen wall segment out, `"pointer"` keeps
 *  the wall and draws a pointer over it, `"both"` does both. */
export type WaypointOpeningMode = "none" | "opening" | "pointer" | "both";
export const WAYPOINT_OPENING_MODES: readonly WaypointOpeningMode[] = ["none", "opening", "pointer", "both"];
/** Whether the chosen outer wall segment is left out in `mode`. */
export function openingCutsWall(mode: WaypointOpeningMode): boolean {
  return mode === "opening" || mode === "both";
}
/** Whether the direction pointer is drawn in `mode`. */
export function openingShowsPointer(mode: WaypointOpeningMode): boolean {
  return mode === "pointer" || mode === "both";
}
