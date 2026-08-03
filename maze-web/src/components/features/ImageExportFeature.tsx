import { useMazeStore } from "../../store/mazeStore";
import type { RenderModeId } from "../../store/mazeStore";
import { buttonStyle } from "../../styles/shared";
import { Stack } from "../Layout";
import { SidePanel } from "../SidePanel";
import { RENDER_MODES, resolveRenderMode } from "./imageExportRegistry";
import * as m from "~/paraglide/messages";

export function ImageExportFeature() {
  const activeRenderMode = useMazeStore((s) => s.activeRenderMode);
  const setActiveRenderMode = useMazeStore((s) => s.setActiveRenderMode);
  const openRenderModeSettings = useMazeStore((s) => s.openRenderModeSettings);
  const setOpenRenderModeSettings = useMazeStore((s) => s.setOpenRenderModeSettings);

  function handleClick(mode: RenderModeId) {
    if (mode === activeRenderMode) {
      setOpenRenderModeSettings(openRenderModeSettings === mode ? null : mode);
    } else {
      setActiveRenderMode(mode);
      setOpenRenderModeSettings(mode);
    }
  }

  const openMode = openRenderModeSettings ? resolveRenderMode(openRenderModeSettings) : null;
  // A stale openRenderModeSettings (e.g. a removed/renamed mode from a loaded project) resolves
  // to null just like "nothing open" — the panel simply doesn't render for it.

  return (
    <Stack gap="itemGap">
      {RENDER_MODES.map((mode) => (
        <button
          key={mode.id}
          className={mode.id === activeRenderMode ? "hoverable-accent" : "hoverable"}
          style={{ ...buttonStyle(mode.id === activeRenderMode ? "toggle-active" : "toggle"), width: "100%" }}
          onClick={() => handleClick(mode.id)}
        >
          {mode.label()}
        </button>
      ))}

      {openMode && (
        <SidePanel title={openMode.label()} onClose={() => setOpenRenderModeSettings(null)}>
          {openMode.SettingsPanel ? <openMode.SettingsPanel /> : (
            <span>{m["image_export.settings_empty"]()}</span>
          )}
        </SidePanel>
      )}
    </Stack>
  );
}
