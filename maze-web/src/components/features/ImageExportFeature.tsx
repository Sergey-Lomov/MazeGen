import { useRef, useState, type CSSProperties } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { RenderModeId, ExportFormatId, PngExportSettings } from "../../store/mazeStore";
import { Button } from "../Button";
import { LoadIconButton } from "../LoadIconButton";
import { SaveIconButton } from "../SaveIconButton";
import { ui, inset, spacing } from "../../styles/theme";
import { Stack } from "../Layout";
import { SidePanel } from "../SidePanel";
import { ExportTopologyPanel } from "./ExportTopologyPanel";
import { TeleportConnectorEditorPanel } from "./TeleportConnectorEditorPanel";
import { RENDER_MODES, resolveRenderMode } from "./imageExportRegistry";
import { EXPORT_FORMATS, resolveExportFormat } from "./exportFormatRegistry";
import { downloadPngExport } from "./pngExport";
import { FileNameModal, timestampedBaseName } from "../FileNameModal";
import { readJsonFile } from "../jsonFile";
import { registerNotificationCode } from "../../notifications/notificationRegistry";
import { notify } from "../../notifications/notificationStore";
import { downloadVisualPresetFile, parseVisualPreset, visualPresetFileAccept, FileKindMismatchError, VISUAL_PRESET_FILE_EXTENSION } from "../../store/projectExport";
import * as m from "~/paraglide/messages";

const VISUAL_PRESET_LOAD_SOURCE = "visual_preset_load";

const VISUAL_PRESET_LOAD_CODES = {
  invalid: "image_export.visual_preset.load_error",
  projectFile: "image_export.visual_preset.load_error_project_file",
  qualityPreset: "image_export.visual_preset.load_error_quality_preset",
} as const;
for (const code of Object.values(VISUAL_PRESET_LOAD_CODES)) {
  registerNotificationCode(code, { severity: "error", message: () => m[code]() });
}

export function ImageExportFeature({ onExportPng, onFocusTeleportConnector = () => {} }: { onExportPng: (settings: PngExportSettings) => Promise<Blob | null>; onFocusTeleportConnector?: (points: readonly [number, number][]) => void }) {
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
  const exportTopologyOpen = useMazeStore((s) => s.exportTopologyOpen);
  const teleportConnectorEdit = useMazeStore((s) => s.teleportConnectorEdit);
  const finishTeleportConnectorEdit = useMazeStore((s) => s.finishTeleportConnectorEdit);
  const [pendingDownload, setPendingDownload] = useState<{ kind: "png" | "style"; defaultBaseName: string; extension: string } | null>(null);

  function handleClick(mode: RenderModeId) {
    if (mode !== activeRenderMode) setActiveRenderMode(mode);
    setOpenRenderModeSettings(mode);
  }

  function handleFormatGearClick(format: ExportFormatId) {
    setOpenExportFormatSettings(format);
  }

  function handleExportClick(format: ExportFormatId) {
    if (format === "png") setPendingDownload({ kind: "png", defaultBaseName: timestampedBaseName("maze-export"), extension: ".png" });
  }

  async function confirmDownload(fileName: string) {
    const kind = pendingDownload?.kind;
    setPendingDownload(null);
    if (kind === "style") {
      downloadVisualPresetFile(useMazeStore.getState(), fileName);
      return;
    }
    if (kind !== "png") return;
    const blob = await onExportPng(pngExportSettings);
    if (blob) downloadPngExport(blob, fileName);
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
        <Stack key={format.id} gap="itemGap">
          {format.id === "png" && (
            <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={() => handleFormatGearClick(format.id)}>
              {m["image_export.format.settings"]()}
            </Button>
          )}
          <Button
            variant="primary"
            layoutStyle={{ width: "100%" }}
            disabled={activeRenderMode === null}
            title={activeRenderMode === null ? m["image_export.no_renderer_hint"]() : undefined}
            onClick={() => handleExportClick(format.id)}
          >
            {format.label()}
          </Button>
        </Stack>
      ))}

      <div style={styles.presetActions}>
        <SaveIconButton
          title={m["image_export.visual_preset.save"]()}
          onClick={() => setPendingDownload({ kind: "style", defaultBaseName: timestampedBaseName("maze-style"), extension: VISUAL_PRESET_FILE_EXTENSION })}
        />
        <LoadIconButton title={m["image_export.visual_preset.load"]()} onClick={() => presetInputRef.current?.click()} />
      </div>
      <input
        ref={presetInputRef}
        type="file"
        name="visual-preset-file"
        accept={visualPresetFileAccept(navigator)}
        style={{ display: "none" }}
        onChange={handlePresetFileChange}
      />

      {pendingDownload !== null && (
        <FileNameModal
          defaultBaseName={pendingDownload.defaultBaseName}
          extension={pendingDownload.extension}
          onConfirm={confirmDownload}
          onCancel={() => setPendingDownload(null)}
        />
      )}

      {openMode && (
        <SidePanel title={openMode.label()} stackKey="image-export-render-mode" onClose={() => setOpenRenderModeSettings(null)}>
          {openMode.SettingsPanel ? <openMode.SettingsPanel /> : (
            <span>{m["image_export.settings_empty"]()}</span>
          )}
        </SidePanel>
      )}

      {exportTopologyOpen && <ExportTopologyPanel />}
      {teleportConnectorEdit && <TeleportConnectorEditorPanel onClose={finishTeleportConnectorEdit} onFocusPath={onFocusTeleportConnector} />}

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

const styles: Record<string, CSSProperties> = {
  presetActions: {
    position: "absolute",
    top: inset.panelInsetY,
    right: inset.panelInsetX,
    display: "flex",
    gap: spacing.itemGap,
  },
};
