import { useMemo, useEffect } from "react";
import { Maximize2, RectangleVertical, RectangleHorizontal } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { Stack, Inline } from "../Layout";
import { HoverIconButton } from "../HoverIconButton";
import { ToggleRow } from "../ToggleRow";
import { buttonStyle, sharedStyles } from "../../styles/shared";
import { typography, spacing, inset, controlRowHeight, ui } from "../../styles/theme";
import { PngOverflowWarningBubble, PngFitWarningBubble } from "./PngOverflowWarningBubble";
import { computeDigitalExportFit } from "../../pixi/imageExport/exportFit";
import { computePrintExportFit, computeAutoFitPrintScale, resolveSheetSizeMm, DPI_BY_DENSITY, pxToMm } from "../../pixi/imageExport/printFit";
import { resolveExportMargin, resolveWallExportMargin } from "../../pixi/imageExport/exportMargins";
import { getCurrentViewportScale } from "../../pixi/viewportScaleBridge";
import { TILE_SIZE } from "../../pixi/constants";
import type { PngCanvasMode, PrintDensity, PaperSize, PrintAnchor } from "../../store/storeTypes";
import * as m from "~/paraglide/messages";

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
const PAPER_SIZE_OPTIONS: { value: PaperSize; label: string; disabled?: boolean }[] = [
  { value: "a0", label: m["image_export.format.png.print.paper_a0"]() },
  { value: "a1", label: m["image_export.format.png.print.paper_a1"]() },
  { value: "a2", label: m["image_export.format.png.print.paper_a2"]() },
  { value: "a3", label: m["image_export.format.png.print.paper_a3"]() },
  { value: "a4", label: m["image_export.format.png.print.paper_a4"]() },
  { value: "a5", label: m["image_export.format.png.print.paper_a5"]() },
  { value: "__sep_iso__" as PaperSize, label: m["image_export.format.png.print.paper_separator"](), disabled: true },
  { value: "letter", label: m["image_export.format.png.print.paper_letter"]() },
  { value: "legal", label: m["image_export.format.png.print.paper_legal"]() },
  { value: "tabloid", label: m["image_export.format.png.print.paper_tabloid"]() },
  { value: "__sep_us__" as PaperSize, label: m["image_export.format.png.print.paper_separator"](), disabled: true },
  { value: "custom", label: m["image_export.format.png.print.paper_custom"]() },
];

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

  const activeRenderMode = useMazeStore((s) => s.activeRenderMode);
  const nodes = useMazeStore((s) => s.nodes);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const vectorByWallsSettings = useMazeStore((s) => s.vectorByWallsSettings);

  const margin = useMemo(
    () => (activeRenderMode ? resolveExportMargin(activeRenderMode, { vectorByWallsSettings }) : { left: 0, right: 0, top: 0, bottom: 0 }),
    [activeRenderMode, vectorByWallsSettings],
  );

  const wallMargin = useMemo(
    () => (activeRenderMode ? resolveWallExportMargin(activeRenderMode, { vectorByWallsSettings }) : { left: 0, right: 0, top: 0, bottom: 0 }),
    [activeRenderMode, vectorByWallsSettings],
  );

  const digitalFit = useMemo(
    () => (nodes.length > 0 ? computeDigitalExportFit(cfg, nodes, margin, digital, wallMargin) : null),
    [cfg, nodes, margin, digital, wallMargin],
  );

  const printFit = useMemo(
    () => (nodes.length > 0 ? computePrintExportFit(cfg, nodes, wallMargin, print) : null),
    [cfg, nodes, wallMargin, print],
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
  // the maze itself, all folded into wallMargin/cfg/nodes/print's own dependencies).
  useEffect(() => {
    if (!print.scaleAutoFit || nodes.length === 0) return;
    const autoScale = floor2(computeAutoFitPrintScale(cfg, nodes, wallMargin, print));
    if (autoScale !== print.scale) setPrintScale(autoScale);
  }, [print.scaleAutoFit, print.scale, cfg, nodes, wallMargin, print, setPrintScale]);

  const digitalCellSizePx = TILE_SIZE * digital.scale;
  const printDpi = DPI_BY_DENSITY[print.density];
  const printCellSizeMm = pxToMm(TILE_SIZE * print.scale, printDpi);

  return (
    <div style={styles.root}>
      <Stack gap="itemGap">
        <Inline gap="itemGap">
          <button
            className={outputMode === "digital" ? "hoverable-accent" : "hoverable"}
            style={{ ...buttonStyle(outputMode === "digital" ? "toggle-active" : "toggle"), flex: 1 }}
            onClick={() => setPngOutputMode("digital")}
          >
            {m["image_export.format.png.mode.digital"]()}
          </button>
          <button
            className={outputMode === "print" ? "hoverable-accent" : "hoverable"}
            style={{ ...buttonStyle(outputMode === "print" ? "toggle-active" : "toggle"), flex: 1 }}
            onClick={() => setPngOutputMode("print")}
          >
            {m["image_export.format.png.mode.print"]()}
          </button>
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
                <input
                  type="number"
                  style={{ ...sharedStyles.input, ...styles.control, width: 90 }}
                  value={digital.marginValue}
                  onChange={(e) => setDigitalMarginValue(Number(e.target.value))}
                />
              </Inline>
            )}

            {digital.canvasMode === "fixed_size" && (
              <Inline gap="itemGap">
                <span style={styles.label}>{m["image_export.format.png.digital.width"]()}</span>
                <input
                  type="number"
                  style={{ ...sharedStyles.input, ...styles.control, width: 90 }}
                  value={digital.fixedWidth}
                  onChange={(e) => setDigitalFixedSize(Number(e.target.value), digital.fixedHeight)}
                />
                <span style={styles.label}>{m["image_export.format.png.digital.height"]()}</span>
                <input
                  type="number"
                  style={{ ...sharedStyles.input, ...styles.control, width: 90 }}
                  value={digital.fixedHeight}
                  onChange={(e) => setDigitalFixedSize(digital.fixedWidth, Number(e.target.value))}
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

            <SelectRow<PaperSize>
              label={m["image_export.format.png.print.paper_size"]()}
              value={print.paperSize}
              options={PAPER_SIZE_OPTIONS}
              onChange={setPrintPaperSize}
            />

            <Inline gap="itemGap" justify="space-between">
              <span style={styles.label}>{m["image_export.format.png.print.size_mm"]()}</span>
              <Inline gap="groupGap">
                <Inline gap="elementsGap">
                  <span style={{ ...styles.shortLabel, ...(print.paperSize !== "custom" ? styles.labelDisabled : {}) }}>
                    {m["image_export.format.png.print.width_short"]()}
                  </span>
                  <input
                    type="number"
                    style={{
                      ...sharedStyles.input, ...styles.control, width: 70,
                      ...(print.paperSize !== "custom" ? styles.inputDisabled : {}),
                    }}
                    value={print.paperSize === "custom" ? print.customWidthMm : resolveSheetSizeMm(print).widthMm}
                    disabled={print.paperSize !== "custom"}
                    onChange={(e) => setPrintCustomSize(Number(e.target.value), print.customHeightMm)}
                  />
                </Inline>
                <Inline gap="elementsGap">
                  <span style={{ ...styles.shortLabel, ...(print.paperSize !== "custom" ? styles.labelDisabled : {}) }}>
                    {m["image_export.format.png.print.height_short"]()}
                  </span>
                  <input
                    type="number"
                    style={{
                      ...sharedStyles.input, ...styles.control, width: 70,
                      ...(print.paperSize !== "custom" ? styles.inputDisabled : {}),
                    }}
                    value={print.paperSize === "custom" ? print.customHeightMm : resolveSheetSizeMm(print).heightMm}
                    disabled={print.paperSize !== "custom"}
                    onChange={(e) => setPrintCustomSize(print.customWidthMm, Number(e.target.value))}
                  />
                </Inline>
              </Inline>
            </Inline>

            <Inline gap="itemGap" justify="space-between">
              <span style={styles.label}>{m["image_export.format.png.print.orientation"]()}</span>
              <Inline gap="itemGap">
                <button
                  className={print.orientation === "portrait" ? "hoverable-accent" : "hoverable"}
                  style={{ ...buttonStyle(print.orientation === "portrait" ? "toggle-active" : "toggle"), ...styles.control, ...styles.iconToggle }}
                  title={m["image_export.format.png.print.orientation_portrait"]()}
                  onClick={() => setPrintOrientation("portrait")}
                >
                  <RectangleVertical size={16} />
                </button>
                <button
                  className={print.orientation === "landscape" ? "hoverable-accent" : "hoverable"}
                  style={{ ...buttonStyle(print.orientation === "landscape" ? "toggle-active" : "toggle"), ...styles.control, ...styles.iconToggle }}
                  title={m["image_export.format.png.print.orientation_landscape"]()}
                  onClick={() => setPrintOrientation("landscape")}
                >
                  <RectangleHorizontal size={16} />
                </button>
              </Inline>
            </Inline>

            <Inline gap="itemGap" justify="space-between">
              <span style={styles.label}>{m["image_export.format.png.print.margin_mm"]()}</span>
              <Inline gap="groupGap">
                <Inline gap="elementsGap">
                  <span style={styles.shortLabel}>{m["image_export.format.png.print.margin_h_short"]()}</span>
                  <input
                    type="number"
                    style={{ ...sharedStyles.input, ...styles.control, width: 70 }}
                    value={print.marginHMm}
                    onChange={(e) => setPrintMargins(Number(e.target.value), print.marginVMm)}
                  />
                </Inline>
                <Inline gap="elementsGap">
                  <span style={styles.shortLabel}>{m["image_export.format.png.print.margin_v_short"]()}</span>
                  <input
                    type="number"
                    style={{ ...sharedStyles.input, ...styles.control, width: 70 }}
                    value={print.marginVMm}
                    onChange={(e) => setPrintMargins(print.marginHMm, Number(e.target.value))}
                  />
                </Inline>
              </Inline>
            </Inline>

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
                    {m["image_export.format.png.result.cell_size_mm"]({ size: printCellSizeMm.toFixed(2) })}
                  </span>
                </Stack>
              </>
            )}

            {printFit?.clipsSheetBounds && <PngFitWarningBubble id="png_content_clips_sheet" />}
            {printFit?.entersMarginZone && <PngFitWarningBubble id="png_content_in_margin_zone" />}
          </Stack>
          </div>
        )}
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
