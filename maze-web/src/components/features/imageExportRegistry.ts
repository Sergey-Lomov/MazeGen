import type React from "react";
import type { RenderModeId } from "../../store/mazeStore";
import { VectorByWallsSettingsPanel } from "./VectorByWallsSettingsPanel";
import { VectorByCorridorsSettingsPanel } from "./VectorByCorridorsSettingsPanel";
import * as m from "~/paraglide/messages";

export interface RenderModeDescriptor {
  id: RenderModeId;
  label: () => string;
  /** Settings panel content shown in the mode's `SidePanel`, or `null` for a mode with no
   * settings yet. */
  SettingsPanel: React.ComponentType | null;
}

/// Single source of truth for the Image Export card's switcher — one entry per rendering mode.
/// Adding a mode means adding one entry here (plus its own renderer, wired into
/// `ImageExportRenderer.createModeRenderer`) — no other list to keep in sync.
export const RENDER_MODES: RenderModeDescriptor[] = [
  { id: "vector_by_walls", label: () => m["image_export.mode.vector_by_walls.label"](), SettingsPanel: VectorByWallsSettingsPanel },
  { id: "vector_by_corridors", label: () => m["image_export.mode.vector_by_corridors.label"](), SettingsPanel: VectorByCorridorsSettingsPanel },
];

/** Looks up a mode's descriptor, or `null` if `id` isn't registered — e.g. a project file saved
 * with a render mode from a since-removed/renamed registry entry. Callers treat `null` the same
 * as "no mode selected" rather than crashing on stale persisted state. */
export function resolveRenderMode(id: RenderModeId): RenderModeDescriptor | null {
  return RENDER_MODES.find((mode) => mode.id === id) ?? null;
}
