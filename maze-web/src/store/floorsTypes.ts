export interface RootActions {
  loadProject: (file: import("./projectExport").ProjectFile) => void;
}

/** One floor (level) in the floor set — GitHub issue #335, epic #333. Purely a client-side list
 * entry today: no field/preset/generation data is attached per-floor yet (see Specs/space.md's
 * "Not yet built on top of this layer" note), and this `id` is never sent to maze-core. */
export interface FloorState {
  id: string;
  title: string;
}

export interface FloorsState {
  /** Always >= 1 through the UI — `removeFloor` refuses to drop the last floor. Stored
   * bottom-to-top: `floors[0]` is "Floor 1" (the bottom floor), the last entry is the newest/
   * topmost floor — `addFloor` appends, which is exactly "add on top". FloorsFeature renders the
   * reverse of this order (newest/topmost first on screen) and maps its visual up/down arrows
   * accordingly — see that component's own comment. */
  floors: FloorState[];
  /** Monotonic counter for default "Floor N" titles — never reused, even after the floor bearing
   * that number is removed (otherwise removing "Floor 2" and adding a new floor would mint
   * "Floor 2" again, colliding with a title the user may have since renamed something else to).
   * Not derivable from `floors` at load time: the user may rename "Floor 5" and remove "Floor
   * 2..4", after which recomputing from remaining titles would yield 3 instead of the true 6,
   * reissuing an already-used number. Persisted in the project file for this reason. */
  nextFloorNumber: number;
  /** Floor the shared `FloorSwitcher` panel (GitHub issue #336) currently displays — a purely
   * client-side, non-persisted UI cursor into `floors`. No floor-scoped feature data exists yet
   * (see `Specs/floors.md`'s non-goals), so nothing besides the switcher itself reads this today.
   * Always a valid id into `floors`; kept in sync by `floorsSlice`'s own actions whenever a
   * mutation could otherwise leave it dangling (removing the active floor) or out of range
   * (project load). */
  activeFloorId: string;
}

export interface FloorsActions {
  addFloor: () => void;
  /** No-op if `id` is the only remaining floor. No confirmation here — the caller (FloorsFeature)
   * gates destructive removal behind ConfirmModal before calling this. */
  removeFloor: (id: string) => void;
  /** No-op on an empty/whitespace-only title. */
  renameFloor: (id: string, title: string) => void;
  /** Adjacent swap in `floors` order. No-op at either end of the list. */
  moveFloor: (id: string, direction: "up" | "down") => void;
  /** Sets `activeFloorId` directly. No-op if `id` isn't a current floor id. */
  setActiveFloorId: (id: string) => void;
}
