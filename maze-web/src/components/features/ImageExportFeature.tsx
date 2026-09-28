import { Settings } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { RenderModeId, ExportFormatId, PngExportSettings } from "../../store/mazeStore";
import { Button } from "../Button";
import { ui } from "../../styles/theme";
import { Stack, Inline } from "../Layout";
import { SidePanel } from "../SidePanel";
import { HoverIconButton } from "../HoverIconButton";
import { RENDER_MODES, resolveRenderMode } from "./imageExportRegistry";
import { EXPORT_FORMATS, resolveExportFormat } from "./exportFormatRegistry";
import { downloadPngExport } from "./pngExport";
import * as m from "~/paraglide/messages";

export function ImageExportFeature({ onExportPng }: { onExportPng: (settings: PngExportSettings) => Promise<Blob | null> }) {
  const activeRenderMode = useMazeStore((s) => s.activeRenderMode);
  const setActiveRenderMode = useMazeStore((s) => s.setActiveRenderMode);
  const openRenderModeSettings = useMazeStore((s) => s.openRenderModeSettings);
  const setOpenRenderModeSettings = useMazeStore((s) => s.setOpenRenderModeSettings);
  const openExportFormatSettings = useMazeStore((s) => s.openExportFormatSettings);
  const setOpenExportFormatSettings = useMazeStore((s) => s.setOpenExportFormatSettings);
  const pngExportSettings = useMazeStore((s) => s.pngExportSettings);

  function handleClick(mode: RenderModeId) {
    if (mode === activeRenderMode) {
      setOpenRenderModeSettings(openRenderModeSettings === mode ? null : mode);
    } else {
      setActiveRenderMode(mode);
      setOpenRenderModeSettings(mode);
    }
  }

  function handleFormatGearClick(format: ExportFormatId) {
    setOpenExportFormatSettings(openExportFormatSettings === format ? null : format);
  }

  async function handleExportClick(format: ExportFormatId) {
    if (format === "png") {
      const blob = await onExportPng(pngExportSettings);
      if (blob) downloadPngExport(blob);
    }
  }

  const openMode = openRenderModeSettings ? resolveRenderMode(openRenderModeSettings) : null;
  // A stale openRenderModeSettings (e.g. a removed/renamed mode from a loaded project) resolves
  // to null just like "nothing open" — the panel simply doesn't render for it.
  const openFormat = openExportFormatSettings ? resolveExportFormat(openExportFormatSettings) : null;

  return (
    <Stack gap="itemGap">
      {RENDER_MODES.map((mode) => (
        <Button
          key={mode.id}
          variant={mode.id === activeRenderMode ? "toggle-selected" : "toggle"}
          layoutStyle={{ width: "100%" }}
          onClick={() => handleClick(mode.id)}
        >
          {mode.label()}
        </Button>
      ))}

      <div style={{ borderTop: `1px solid ${ui.border.default}` }} />

      {EXPORT_FORMATS.map((format) => (
        <Inline key={format.id} gap="itemGap">
          <Button
            variant="primary"
            layoutStyle={{ flex: 1 }}
            disabled={activeRenderMode === null}
            onClick={() => handleExportClick(format.id)}
          >
            {format.label()}
          </Button>
          <HoverIconButton
            onClick={() => handleFormatGearClick(format.id)}
            title={m["image_export.format.settings_tooltip"]({ format: format.label() })}
          >
            <Settings size={16} />
          </HoverIconButton>
        </Inline>
      ))}

      {openMode && (
        <SidePanel title={openMode.label()} onClose={() => setOpenRenderModeSettings(null)}>
          {openMode.SettingsPanel ? <openMode.SettingsPanel /> : (
            <span>{m["image_export.settings_empty"]()}</span>
          )}
        </SidePanel>
      )}

      {openFormat && (
        <SidePanel title={openFormat.label()} onClose={() => setOpenExportFormatSettings(null)}>
          {openFormat.SettingsPanel ? <openFormat.SettingsPanel /> : (
            <span>{m["image_export.settings_empty"]()}</span>
          )}
        </SidePanel>
      )}
    </Stack>
  );
}
