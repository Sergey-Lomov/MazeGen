import type { StoreApi } from "zustand";
import type { MazeStore } from "./storeTypes";
import { VECTOR_FONT_FAMILY, isMsdfFamily } from "../pixi/renderers/fontChoice";
import { loadMsdfFamily } from "../pixi/renderers/msdfLoader";

/** Lazy families found under each settings node. Settings are updated immutably, so a subtree that did
 *  not change keeps its identity and is answered from here: a settings change that touches one slider
 *  re-walks only the path to it, not the whole tree (manual connector paths can be large). */
const familiesUnder = new WeakMap<object, readonly string[]>();

/** Families of the on-demand MSDF fonts (everything but the default Roboto, which is always loaded)
 *  named by any `LabelFont` (`{ family, weight }`) inside `value`, a plain, immutably updated settings tree. */
export function collectLazyMsdfFamilies(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value !== "object" || value === null) return into;
  let found = familiesUnder.get(value);
  if (!found) {
    const { family, weight } = value as { family?: unknown; weight?: unknown };
    if (typeof family === "string" && typeof weight === "number") {
      found = family !== VECTOR_FONT_FAMILY && isMsdfFamily(family) ? [family] : [];
    } else {
      const children = new Set<string>();
      for (const child of Object.values(value)) collectLazyMsdfFamilies(child, children);
      found = [...children];
    }
    familiesUnder.set(value, found);
  }
  for (const family of found) into.add(family);
  return into;
}

/** Loads the MSDF fonts the export settings reference (GitHub issue #982). Settings arrive from a project
 *  file, a visual preset, a shared-style link or a picker, and none of those is guaranteed to render a
 *  font row, so the fetch is tied to the settings themselves: whatever puts a font name into them starts
 *  its download, and labels switch from the default font once it lands. Each family is requested once
 *  from here; a failed download falls back to the default font and is retried by a later pick. */
export function installLabelFontSync(store: StoreApi<MazeStore>): void {
  const requested = new Set<string>();
  const request = (state: MazeStore) => {
    const families = collectLazyMsdfFamilies([state.vectorByWallsSettings, state.vectorByCorridorsSettings, state.pngExportSettings]);
    for (const family of families) {
      if (requested.has(family)) continue;
      requested.add(family);
      void loadMsdfFamily(family);
    }
  };
  store.subscribe((state, prev) => {
    if (
      state.vectorByWallsSettings === prev.vectorByWallsSettings
      && state.vectorByCorridorsSettings === prev.vectorByCorridorsSettings
      && state.pngExportSettings === prev.pngExportSettings
    ) return;
    request(state);
  });
  request(store.getState());
}
