import { useEffect, useRef } from "react";
import { Settings } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { RenderModeId, ExportFormatId, PngExportSettings } from "../../store/mazeStore";
import { Button } from "../Button";
import { ui } from "../../styles/theme";
import { Stack, Inline } from "../Layout";
import { bringSidePanelToFront, SidePanel } from "../SidePanel";
import { HoverIconButton } from "../HoverIconButton";
import { ExportTopologyPanel } from "./ExportTopologyPanel";
import { RENDER_MODES, resolveRenderMode } from "./imageExportRegistry";
import { EXPORT_FORMATS, resolveExportFormat } from "./exportFormatRegistry";
import { downloadPngExport } from "./pngExport";
import { readJsonFile } from "../jsonFile";
import { registerNotificationCode } from "../../notifications/notificationRegistry";
import { notify } from "../../notifications/notificationStore";
import { downloadVisualPresetFile, parseVisualPreset, visualPresetFileAccept, FileKindMismatchError } from "../../store/projectExport";
import * as m from "~/paraglide/messages";

const VISUAL_PRESET_LOAD_SOURCE = "visual_preset_load";

const VISUAL_PRESET_LOAD_CODES = {
  invalid: "image_export.visual_preset.load_error",
  projectFile: "image_export.visual_preset.load_error_project_file",
  qualityPreset: "image_export.visual_preset.load_error_quality_preset",
} as const;
for (const code of Object.values(VISUAL_PRESET_LOAD_CODES)) {
  registerNotificationCode(code, { category: "error", message: () => m[code]() });
}

export function ImageExportFeature({ onExportPng }: { onExportPng: (settings: PngExportSettings) => Promise<Blob | null> }) {
  const activeRenderMode = useMazeStore((s) => s.activeRenderMode);
  const setActiveRenderMode = useMazeStore((s) => s.setActiveRenderMode);
  const openRenderModeSettings = useMazeStore((s) => s.openRenderModeSettings);
  const setOpenRenderModeSettings = useMazeStore((s) => s.setOpenRenderModeSettings);
  const openExportFormatSettings = useMazeStore((s) => s.openExportFormatSettings);
  const setOpenExportFormatSettings = useMazeStore((s) => s.setOpenExportFormatSettings);
  const setExportFormatSettingsCovered = useMazeStore((s) => s.setExportFormatSettingsCovered);
  const pngExportSettings = useMazeStore((s) => s.pngExportSettings);
  const loadVisualPreset = useMazeStore((s) => s.loadVisualPreset);
  const presetInputRef = useRef<HTMLInputElement>(null);
  // The topology panel (GitHub issue #859) exists only for a floor that has glues.
  const hasGlues = useMazeStore((s) => (s.floorTopology[s.activeFloorId]?.groups.length ?? 0) > 0);
  const exportTopologyOpen = useMazeStore((s) => s.exportTopologyOpen);
  const setExportTopologyOpen = useMazeStore((s) => s.setExportTopologyOpen);
  useEffect(() => {
    if (!hasGlues && exportTopologyOpen) setExportTopologyOpen(false);
  }, [hasGlues, exportTopologyOpen, setExportTopologyOpen]);

  function handleClick(mode: RenderModeId) {
    bringSidePanelToFront("image-export-render-mode");
    if (mode !== activeRenderMode) setActiveRenderMode(mode);
    setOpenRenderModeSettings(mode);
  }

  function handleFormatGearClick(format: ExportFormatId) {
    bringSidePanelToFront("image-export-format");
    setOpenExportFormatSettings(format);
  }

  async function handleExportClick(format: ExportFormatId) {
    if (format === "png") {
      const blob = await onExportPng(pngExportSettings);
      if (blob) downloadPngExport(blob);
    }
  }

  function handlePresetFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    readJsonFile(file, VISUAL_PRESET_LOAD_SOURCE, (json) => {
      // Parsed before `loadVisualPreset`, so a rejected file leaves the store untouched.
      let preset: ReturnType<typeof parseVisualPreset>;
      try {
        preset = parseVisualPreset(json);
      } catch (err) {
        if (err instanceof FileKindMismatchError) {
          notify({
            source: VISUAL_PRESET_LOAD_SOURCE,
            code: err.found === "quality_preset" ? VISUAL_PRESET_LOAD_CODES.qualityPreset : VISUAL_PRESET_LOAD_CODES.projectFile,
          });
          return;
        }
        notify({ source: VISUAL_PRESET_LOAD_SOURCE, code: VISUAL_PRESET_LOAD_CODES.invalid, details: err instanceof Error ? err.message : String(err) });
        return;
      }
      loadVisualPreset(preset);
    });
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
            stretch
            onClick={() => handleFormatGearClick(format.id)}
            title={m["image_export.format.settings_tooltip"]({ format: format.label() })}
          >
            <Settings size={16} />
          </HoverIconButton>
        </Inline>
      ))}

      <div style={{ borderTop: `1px solid ${ui.border.default}` }} />

      <Inline gap="itemGap" align="stretch">
        <Button variant="secondary" layoutStyle={{ flex: 1 }} onClick={() => downloadVisualPresetFile(useMazeStore.getState())}>
          {m["image_export.visual_preset.save"]()}
        </Button>
        <Button variant="secondary" layoutStyle={{ flex: 1 }} onClick={() => presetInputRef.current?.click()}>
          {m["image_export.visual_preset.load"]()}
        </Button>
      </Inline>
      <input
        ref={presetInputRef}
        type="file"
        name="visual-preset-file"
        accept={visualPresetFileAccept(navigator)}
        style={{ display: "none" }}
        onChange={handlePresetFileChange}
      />

      {openMode && (
        <SidePanel title={openMode.label()} stackKey="image-export-render-mode" onClose={() => setOpenRenderModeSettings(null)}>
          {openMode.SettingsPanel ? <openMode.SettingsPanel /> : (
            <span>{m["image_export.settings_empty"]()}</span>
          )}
        </SidePanel>
      )}

      {hasGlues && exportTopologyOpen && <ExportTopologyPanel />}

      {openFormat && (
        <SidePanel
          title={openFormat.label()}
          stackKey="image-export-format"
          onClose={() => setOpenExportFormatSettings(null)}
          onTopChange={(isTop) => setExportFormatSettingsCovered(!isTop)}
        >
          {openFormat.SettingsPanel ? <openFormat.SettingsPanel /> : (
            <span>{m["image_export.settings_empty"]()}</span>
          )}
        </SidePanel>
      )}
    </Stack>
  );
}
