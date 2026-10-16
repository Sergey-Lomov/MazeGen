import { useMemo, useEffect, useState } from "react";
import { Maximize2, Ruler } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { Stack, Inline } from "../Layout";
import { HoverIconButton } from "../HoverIconButton";
import { ToggleRow } from "../ToggleRow";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { typography, spacing, inset, controlRowHeight, ui } from "../../styles/theme";
import { PngOverflowWarningBubble, PngFitWarningBubble } from "./PngOverflowWarningBubble";
import { computeDigitalExportFit } from "../../pixi/imageExport/exportFit";
import { computePrintExportFit, computeAutoFitPrintScale, printCellMeasureMm, DPI_BY_DENSITY, computePhysicalOneToOneViewportScale } from "../../pixi/imageExport/printFit";
import { applyPhysicalZoom } from "../../pixi/viewportScaleBridge";
import { useCalibratedCssPpi } from "./useCalibratedCssPpi";
import { ScreenDpiCalibrationModal } from "./ScreenDpiCalibrationModal";
import { resolveContentBoundsBasis } from "../../pixi/imageExport/exportMargins";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/VectorByWallsRenderer";
import { createModeRenderer } from "../../pixi/imageExport/modeRendererFactory";
import { Container } from "pixi.js";
import { getCurrentViewportScale } from "../../pixi/viewportScaleBridge";
import { TILE_SIZE } from "../../pixi/constants";
import type { PngCanvasMode, PrintDensity, PrintAnchor } from "../../store/storeTypes";
import * as m from "~/paraglide/messages";
import { PaperLayoutFields } from "./PaperLayoutFields";
import { NumberInput } from "../NumberInput";

const CANVAS_MODE_OPTIONS: { value: PngCanvasMode; label: string }[] = [
  { value: "edge_to_edge", label: m["image_export.format.png.digital.canvas_edge_to_edge"]() },
  { value: "margin_px", label: m["image_export.format.png.digital.canvas_margin_px"]() },
  { value: "margin_cells", label: m["image_export.format.png.digital.canvas_margin_cells"]() },
  { value: "fixed_size", label: m["image_export.format.png.digital.canvas_fixed_size"]() },
];

const DENSITY_OPTIONS: { value: PrintDensity; label: string }[] = [
  { value: "screen_96", label: m["image_export.format.png.print.density_screen_96"]() },
  { value: "draft_150", label: m["image_export.format.png.print.density_draft_150"]() },
  { value: "print_300", label: m["image_export.format.png.print.density_print_300"]() },
  { value: "high_600", label: m["image_export.format.png.print.density_high_600"]() },
];

// Separator options use sentinel values distinct from every real `PaperSize` (and from each
// other) — a native `<select>` resolves a controlled `value` to the *first* `<option>` sharing it,
// so reusing "custom" for the separators made the select display the separator's dash text instead
// of "Custom" whenever `paperSize === "custom"` was actually selected.
// "custom" is never manually selectable from the dropdown — it's set automatically when the user
// pans/zooms the maze under the on-canvas print frame (ExportFrameOverlay / setPrintCustomPlacement).
// Listed as a disabled option purely so the select has something to display while that state holds
// (a controlled <select>'s value must match one of its own <option>s).
const ANCHOR_OPTIONS: { value: PrintAnchor; label: string; disabled?: boolean }[] = [
  { value: "top_left", label: m["image_export.format.png.print.anchor_top_left"]() },
  { value: "top_center", label: m["image_export.format.png.print.anchor_top_center"]() },
  { value: "top_right", label: m["image_export.format.png.print.anchor_top_right"]() },
  { value: "center_left", label: m["image_export.format.png.print.anchor_center_left"]() },
  { value: "center", label: m["image_export.format.png.print.anchor_center"]() },
  { value: "center_right", label: m["image_export.format.png.print.anchor_center_right"]() },
  { value: "bottom_left", label: m["image_export.format.png.print.anchor_bottom_left"]() },
  { value: "bottom_center", label: m["image_export.format.png.print.anchor_bottom_center"]() },
  { value: "bottom_right", label: m["image_export.format.png.print.anchor_bottom_right"]() },
  { value: "custom", label: m["image_export.format.png.print.anchor_custom"](), disabled: true },
];

const DEFAULT_MARGIN_PX = 20;
const DEFAULT_MARGIN_CELLS = 1;

// Always rounds down — an up-rounded auto-fit scale can push content a fraction of a percent past
// the available area/margins, flagging a spurious overflow warning even though the true (unrounded)
// fit was exact.
function floor2(value: number): number {
  return Math.floor(value * 100) / 100;
}

export function PngExportSettingsPanel() {
  const outputMode = useMazeStore((s) => s.pngExportSettings.outputMode);
  const setPngOutputMode = useMazeStore((s) => s.setPngOutputMode);
  const digital = useMazeStore((s) => s.pngExportSettings.digital);
  const setDigitalScale = useMazeStore((s) => s.setDigitalScale);
  const setDigitalCanvasMode = useMazeStore((s) => s.setDigitalCanvasMode);
  const setDigitalMarginValue = useMazeStore((s) => s.setDigitalMarginValue);
  const setDigitalFixedSize = useMazeStore((s) => s.setDigitalFixedSize);
  const print = useMazeStore((s) => s.pngExportSettings.print);
  const setPrintDensity = useMazeStore((s) => s.setPrintDensity);
  const setPrintPaperSize = useMazeStore((s) => s.setPrintPaperSize);
  const setPrintCustomSize = useMazeStore((s) => s.setPrintCustomSize);
  const setPrintOrientation = useMazeStore((s) => s.setPrintOrientation);
  const setPrintMargins = useMazeStore((s) => s.setPrintMargins);
  const setPrintScale = useMazeStore((s) => s.setPrintScale);
  const setPrintScaleAutoFit = useMazeStore((s) => s.setPrintScaleAutoFit);
  const setPrintAnchor = useMazeStore((s) => s.setPrintAnchor);

  const calibratedCssPpi = useCalibratedCssPpi();
  const [calibrationOpen, setCalibrationOpen] = useState(false);

  const activeRenderMode = useMazeStore((s) => s.activeRenderMode);
  const nodes = useMazeStore((s) => s.nodes);
  const edges = useMazeStore((s) => s.edges);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const rawStart = useMazeStore((s) => s.start);
  const rawFinish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  // Only subscribed to the currently active mode's own settings — the inactive mode's settings
  // can't affect this panel's margin/fit computation below, so subscribing to both unconditionally
  // would re-render this panel on every edit to a render mode's settings the user isn't even
  // exporting with right now.
  const vectorByWallsSettings = useMazeStore((s) => (activeRenderMode === "vector_by_walls" ? s.vectorByWallsSettings : null));
  const vectorByCorridorsSettings = useMazeStore((s) => (activeRenderMode === "vector_by_corridors" ? s.vectorByCorridorsSettings : null));

  const { start: effStart, finish: effFinish } = useMemo(
    () => resolveEffectiveEndpoints({ nodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [nodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  // Pixel-accurate (GitHub issue #324 follow-up): a throwaway, never-rendered-to-screen mode
  // renderer instance reads the real drawn geometry's own bounds (`getRequiredExportMargin`,
  // same method `PngExporter`'s actual export pass uses) instead of a settings-derived
  // approximation of it. Construct/render/measure/destroy is pure bounds math (no GPU/canvas
  // work — nothing is ever drawn to a screen or texture here).
  const margin = useMemo(() => {
    if (!activeRenderMode || nodes.length === 0) return { left: 0, right: 0, top: 0, bottom: 0 };
    const container = new Container();
    const renderer = createModeRenderer(activeRenderMode, container);
    try {
      return renderer.getRequiredExportMargin();
    } finally {
      renderer.destroy();
      container.destroy();
    }
  }, [activeRenderMode, vectorByWallsSettings, vectorByCorridorsSettings, cfg, nodes, edges, effStart, effFinish]);

  const basis = activeRenderMode ? resolveContentBoundsBasis(activeRenderMode) : "cell";

  const digitalFit = useMemo(
    () => (nodes.length > 0 ? computeDigitalExportFit(cfg, nodes, margin, digital, basis) : null),
    [cfg, nodes, margin, digital, basis],
  );

  const printFit = useMemo(
    () => (nodes.length > 0 ? computePrintExportFit(cfg, nodes, margin, print, basis) : null),
    [cfg, nodes, margin, print, basis],
  );

  function handleCanvasModeChange(mode: PngCanvasMode) {
    setDigitalCanvasMode(mode);
    if (mode === "margin_px" && digital.canvasMode !== "margin_px") setDigitalMarginValue(DEFAULT_MARGIN_PX);
    else if (mode === "margin_cells" && digital.canvasMode !== "margin_cells") setDigitalMarginValue(DEFAULT_MARGIN_CELLS);
  }

  function handleScaleFromZoom() {
    setDigitalScale(floor2(getCurrentViewportScale()));
  }

  // While print.scaleAutoFit is on, keeps print.scale in lockstep with computeAutoFitPrintScale —
  // recomputed on every change that could affect the fit (sheet size/orientation/DPI, margins, or
  // the maze itself, all folded into margin/cfg/nodes/print's own dependencies).
  useEffect(() => {
    if (!print.scaleAutoFit || nodes.length === 0) return;
    const autoScale = floor2(computeAutoFitPrintScale(cfg, nodes, margin, print, basis));
    if (autoScale !== print.scale) setPrintScale(autoScale);
  }, [print.scaleAutoFit, print.scale, cfg, nodes, margin, print, basis, setPrintScale]);

  const digitalCellSizePx = TILE_SIZE * digital.scale;
  const printDpi = DPI_BY_DENSITY[print.density];
  const printCellSizeMm = printCellMeasureMm(cfg, print.scale, printDpi);

  return (
    <div style={styles.root}>
      <Stack gap="itemGap">
        <Inline gap="itemGap">
          <Button
            variant={outputMode === "digital" ? "toggle-selected" : "toggle"}
            layoutStyle={{ flex: 1 }}
            onClick={() => setPngOutputMode("digital")}
          >
            {m["image_export.format.png.mode.digital"]()}
          </Button>
          <Button
            variant={outputMode === "print" ? "toggle-selected" : "toggle"}
            layoutStyle={{ flex: 1 }}
            onClick={() => setPngOutputMode("print")}
          >
            {m["image_export.format.png.mode.print"]()}
          </Button>
        </Inline>

        {outputMode === "digital" && (
          <div style={styles.paramsBlock}>
          <Stack gap="itemGap">
            <Inline gap="itemGap" justify="space-between">
              <div style={{ flex: 1 }}>
                <SliderRow
                  label={m["image_export.format.png.digital.scale"]()}
                  value={digital.scale}
                  onChange={setDigitalScale}
                  min={1}
                  max={8}
                  step={0.1}
                  format={(v) => `${v.toFixed(1)}x`}
                />
              </div>
              <HoverIconButton onClick={handleScaleFromZoom} title={m["image_export.format.png.digital.scale_from_zoom_tooltip"]()}>
                <Maximize2 size={16} />
              </HoverIconButton>
            </Inline>

            <SelectRow<PngCanvasMode>
              label={m["image_export.format.png.digital.canvas"]()}
              value={digital.canvasMode}
              options={CANVAS_MODE_OPTIONS}
              onChange={handleCanvasModeChange}
            />

            {(digital.canvasMode === "margin_px" || digital.canvasMode === "margin_cells") && (
              <Inline gap="itemGap" justify="space-between">
                <span style={styles.label}>{m["image_export.format.png.digital.margin"]()}</span>
                <NumberInput
                  name="png-digital-margin"
                  min={0}
                  style={{ ...sharedStyles.input, ...styles.control, width: 90 }}
                  value={String(digital.marginValue)}
                  onChange={(value) => setDigitalMarginValue(Number(value))}
                />
              </Inline>
            )}

            {digital.canvasMode === "fixed_size" && (
              <Inline gap="itemGap">
                <span style={styles.label}>{m["image_export.format.png.digital.width"]()}</span>
                <NumberInput
                  name="png-digital-width"
                  min={1}
                  style={{ ...sharedStyles.input, ...styles.control, width: 90 }}
                  value={String(digital.fixedWidth)}
                  onChange={(value) => setDigitalFixedSize(Number(value), digital.fixedHeight)}
                />
                <span style={styles.label}>{m["image_export.format.png.digital.height"]()}</span>
                <NumberInput
                  name="png-digital-height"
                  min={1}
                  style={{ ...sharedStyles.input, ...styles.control, width: 90 }}
                  value={String(digital.fixedHeight)}
                  onChange={(value) => setDigitalFixedSize(digital.fixedWidth, Number(value))}
                />
              </Inline>
            )}

            {digitalFit && (
              <>
                <div style={styles.divider} />
                <Stack gap="elementsGap">
                  <span style={typography.caption}>
                    {m["image_export.format.png.result.image_size"]({
                      width: String(Math.round(digitalFit.width)),
                      height: String(Math.round(digitalFit.height)),
                    })}
                  </span>
                  <span style={typography.caption}>
                    {m["image_export.format.png.result.cell_size_px"]({ size: digitalCellSizePx.toFixed(1) })}
                  </span>
                </Stack>
              </>
            )}

            {digitalFit?.overflow && (
              <PngOverflowWarningBubble
                id="png_content_overflows_canvas"
                percent={(Math.max(digitalFit.contentWidth / digitalFit.width, digitalFit.contentHeight / digitalFit.height)) * 100}
              />
            )}
          </Stack>
          </div>
        )}

        {outputMode === "print" && (
          <div style={styles.paramsBlock}>
          <Stack gap="itemGap">
            <SelectRow<PrintDensity>
              label={m["image_export.format.png.print.density"]()}
              value={print.density}
              options={DENSITY_OPTIONS}
              onChange={setPrintDensity}
            />

            <PaperLayoutFields
              paperSize={print.paperSize}
              customWidthMm={print.customWidthMm}
              customHeightMm={print.customHeightMm}
              orientation={print.orientation}
              marginHMm={print.marginHMm}
              marginVMm={print.marginVMm}
              onPaperSizeChange={setPrintPaperSize}
              onCustomWidthChange={(value) => setPrintCustomSize(Number(value), print.customHeightMm)}
              onCustomHeightChange={(value) => setPrintCustomSize(print.customWidthMm, Number(value))}
              onOrientationChange={setPrintOrientation}
              onMarginHChange={(value) => setPrintMargins(Number(value), print.marginVMm)}
              onMarginVChange={(value) => setPrintMargins(print.marginHMm, Number(value))}
              inputNamePrefix="png-print"
            />

            <div style={styles.control}>
              <ToggleRow
                label={m["image_export.format.png.print.scale_auto_fit"]()}
                checked={print.scaleAutoFit}
                onChange={setPrintScaleAutoFit}
              />
            </div>

            <Inline gap="itemGap" justify="space-between">
              <span style={{ ...styles.label, ...(print.scaleAutoFit ? styles.labelDisabled : {}) }}>{m["image_export.format.png.print.scale"]()}</span>
              <input
                type="number"
                name="png-print-scale"
                step="0.01"
                style={{
                  ...sharedStyles.input, ...styles.control, width: 90,
                  ...(print.scaleAutoFit ? styles.inputDisabled : {}),
                }}
                value={print.scale}
                disabled={print.scaleAutoFit}
                onChange={(e) => setPrintScale(Number(e.target.value))}
              />
            </Inline>

            <SelectRow<PrintAnchor>
              label={m["image_export.format.png.print.anchor"]()}
              value={print.anchor}
              options={ANCHOR_OPTIONS}
              onChange={setPrintAnchor}
            />

            {printFit && (
              <>
                <div style={styles.divider} />
                <Stack gap="elementsGap">
                  <span style={typography.caption}>
                    {m["image_export.format.png.result.image_size"]({
                      width: String(Math.round(printFit.sheetWidthPx)),
                      height: String(Math.round(printFit.sheetHeightPx)),
                    })}
                  </span>
                  <span style={typography.caption}>
                    {(cfg.type === "hex_rectangle" || cfg.type === "hex_circle" || cfg.type === "hex_triangle" || cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom"
                      || cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_circle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom"
                      ? m["image_export.format.png.result.cell_size_mm_diameter"]
                      : m["image_export.format.png.result.cell_size_mm_side"]
                    )({ size: printCellSizeMm.toFixed(2) })}
                  </span>
                </Stack>
              </>
            )}

            {printFit?.clipsSheetBounds && <PngFitWarningBubble id="png_content_clips_sheet" />}
            {printFit?.entersMarginZone && <PngFitWarningBubble id="png_content_in_margin_zone" />}

            <div style={styles.divider} />

            <Inline gap="itemGap" justify="space-between">
              <span style={styles.label}>{m["image_export.format.png.print.screen_calibration"]()}</span>
              <Inline gap="elementsGap">
                <span style={typography.caption}>
                  {calibratedCssPpi == null
                    ? m["image_export.format.png.print.screen_calibration_uncalibrated"]()
                    : m["image_export.format.png.print.screen_calibration_value"]({ ppi: calibratedCssPpi.toFixed(0) })}
                </span>
                <HoverIconButton
                  fixedHeight
                  onClick={() => setCalibrationOpen(true)}
                  title={m["image_export.format.png.print.calibrate_tooltip"]()}
                >
                  <Ruler size={16} />
                </HoverIconButton>
              </Inline>
            </Inline>

            <Button
              variant="secondary"
              layoutStyle={{ width: "100%" }}
              disabled={nodes.length === 0 || !activeRenderMode}
              title={m["image_export.format.png.print.physical_size_tooltip"]()}
              onClick={() => {
                if (calibratedCssPpi == null) {
                  setCalibrationOpen(true);
                  return;
                }
                applyPhysicalZoom(computePhysicalOneToOneViewportScale(print.scale, print.density, calibratedCssPpi));
              }}
            >
              {m["image_export.format.png.print.physical_size"]()}
            </Button>
          </Stack>
          </div>
        )}

        {calibrationOpen && <ScreenDpiCalibrationModal onClose={() => setCalibrationOpen(false)} />}
      </Stack>
    </div>
  );
}

const styles = {
  root: { padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  paramsBlock: { marginTop: spacing.groupGap },
  label: { ...typography.body, minWidth: 70 },
  shortLabel: { ...typography.body },
  labelDisabled: { opacity: 0.4 },
  control: { height: controlRowHeight, boxSizing: "border-box" as const },
  iconToggle: { flex: "none" as const, width: controlRowHeight, padding: 0, display: "flex" as const, alignItems: "center" as const, justifyContent: "center" as const },
  inputDisabled: { opacity: 0.4, cursor: "not-allowed" as const },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
} as const;
