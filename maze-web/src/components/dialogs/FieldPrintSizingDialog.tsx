import React, { useEffect, useMemo, useState } from "react";
import { RectangleHorizontal, RectangleVertical } from "lucide-react";
import type { FieldConfig } from "../../fieldConfig";
import { useMazeStore } from "../../store/mazeStore";
import type { PaperOrientation, PaperSize } from "../../store/storeTypes";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { SelectRow } from "../SelectRow";
import { Inline, Stack } from "../Layout";
import { Switch } from "../Switch";
import { buttonClass, buttonStyle, sharedStyles } from "../../styles/shared";
import { dialogSpacing, inset, radius, typography, ui } from "../../styles/theme";
import { calculatePrintFieldConfig, resolvePrintPaperSizeMm, type PredefinedFieldConfig, type PrintFieldSizingInput } from "../../pixi/fieldPrintSizing";
import { DPI_BY_DENSITY, printCellMeasureMm } from "../../pixi/imageExport/printFit";
import * as m from "~/paraglide/messages";

interface Props {
  config: PredefinedFieldConfig;
  hasMultipleFloors: boolean;
  onApply: (config: FieldConfig, input: PrintFieldSizingInput, applyToAllStandardFloors: boolean) => void;
  onClose: () => void;
}

const PAPER_SIZE_OPTIONS: { value: PaperSize; label: string; disabled?: boolean }[] = [
  { value: "a0", label: m["image_export.format.png.print.paper_a0"]() },
  { value: "a1", label: m["image_export.format.png.print.paper_a1"]() },
  { value: "a2", label: m["image_export.format.png.print.paper_a2"]() },
  { value: "a3", label: m["image_export.format.png.print.paper_a3"]() },
  { value: "a4", label: m["image_export.format.png.print.paper_a4"]() },
  { value: "a5", label: m["image_export.format.png.print.paper_a5"]() },
  { value: "letter", label: m["image_export.format.png.print.paper_letter"]() },
  { value: "legal", label: m["image_export.format.png.print.paper_legal"]() },
  { value: "tabloid", label: m["image_export.format.png.print.paper_tabloid"]() },
  { value: "custom", label: m["image_export.format.png.print.paper_custom"]() },
];

const CALCULATION_DEBOUNCE_MS = 120;
const DEFAULT_DIALOG_CELL_SIZE_MM = 10;

export function FieldPrintSizingDialog({ config, hasMultipleFloors, onApply, onClose }: Props) {
  const print = useMazeStore((s) => s.pngExportSettings.print);
  const initialCellSizeMm = print.scaleAutoFit
    ? DEFAULT_DIALOG_CELL_SIZE_MM
    : printCellMeasureMm(config, print.scale, DPI_BY_DENSITY[print.density]);
  const [paperSize, setPaperSize] = useState<PaperSize>(() => print.paperSize);
  const [customWidthText, setCustomWidthText] = useState(() => String(print.customWidthMm));
  const [customHeightText, setCustomHeightText] = useState(() => String(print.customHeightMm));
  const [orientation, setOrientation] = useState<PaperOrientation>(() => print.orientation);
  const [cellSizeText, setCellSizeText] = useState(() => String(round2(initialCellSizeMm)));
  const [marginHText, setMarginHText] = useState(() => String(print.marginHMm));
  const [marginVText, setMarginVText] = useState(() => String(print.marginVMm));
  const [applyToAllStandardFloors, setApplyToAllStandardFloors] = useState(() => hasMultipleFloors);
  const customWidthMm = parseNumber(customWidthText);
  const customHeightMm = parseNumber(customHeightText);
  const cellSizeMm = parseNumber(cellSizeText);
  const marginHMm = parseNumber(marginHText);
  const marginVMm = parseNumber(marginVText);
  const debouncedCellSizeMm = useDebouncedValue(cellSizeMm, CALCULATION_DEBOUNCE_MS);

  const paper = useMemo(
    () => resolvePrintPaperSizeMm({ paperSize, customWidthMm, customHeightMm, orientation }),
    [paperSize, customWidthMm, customHeightMm, orientation],
  );
  const result = useMemo(
    () => calculatePrintFieldConfig(config, {
      paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm: debouncedCellSizeMm, marginHMm, marginVMm,
    }),
    [config, paperSize, customWidthMm, customHeightMm, orientation, debouncedCellSizeMm, marginHMm, marginVMm],
  );

  function handleApply() {
    // The preview is debounced for responsive typing, but confirmation always uses the latest
    // value instead of waiting for the debounce timer.
    const latestResult = calculatePrintFieldConfig(config, {
      paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm,
    });
    if (!latestResult) return;
    onApply(latestResult.config, { paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm }, applyToAllStandardFloors);
    onClose();
  }

  return (
    <Modal title={m["field.print_sizing.title"]()} size="info" onClose={onClose}>
      <Stack gap="itemGap">
        <SelectRow<PaperSize>
          label={m["field.print_sizing.paper"]()}
          value={paperSize}
          options={PAPER_SIZE_OPTIONS}
          onChange={setPaperSize}
        />

        <Inline gap="itemGap" justify="space-between">
          <span style={styles.label}>{m["image_export.format.png.print.size_mm"]()}</span>
          <Inline gap="groupGap">
            <NumberInput label={m["image_export.format.png.print.width_short"]()} value={paperSize === "custom" ? customWidthText : String(paper.widthMm)} disabled={paperSize !== "custom"} onChange={setCustomWidthText} />
            <NumberInput label={m["image_export.format.png.print.height_short"]()} value={paperSize === "custom" ? customHeightText : String(paper.heightMm)} disabled={paperSize !== "custom"} onChange={setCustomHeightText} />
          </Inline>
        </Inline>

        <Inline gap="itemGap" justify="space-between">
          <span style={styles.label}>{m["image_export.format.png.print.orientation"]()}</span>
          <Inline gap="itemGap">
            <button
              className={buttonClass(orientation === "portrait" ? "toggle-selected" : "toggle")}
              style={{ ...buttonStyle(orientation === "portrait" ? "toggle-selected" : "toggle"), ...styles.iconButton }}
              title={m["image_export.format.png.print.orientation_portrait"]()}
              onClick={() => setOrientation("portrait")}
            >
              <RectangleVertical size={16} />
            </button>
            <button
              className={buttonClass(orientation === "landscape" ? "toggle-selected" : "toggle")}
              style={{ ...buttonStyle(orientation === "landscape" ? "toggle-selected" : "toggle"), ...styles.iconButton }}
              title={m["image_export.format.png.print.orientation_landscape"]()}
              onClick={() => setOrientation("landscape")}
            >
              <RectangleHorizontal size={16} />
            </button>
          </Inline>
        </Inline>

        <NumberInputRow
          label={config.type === "square" ? m["field.print_sizing.cell_size_side"]() : m["field.print_sizing.cell_size_diameter"]()}
          value={cellSizeText}
          suffix="mm"
          onChange={setCellSizeText}
        />
        <NumberInputPairRow
          label={m["field.print_sizing.margin"]()}
          firstLabel={m["image_export.format.png.print.margin_h_short"]()}
          secondLabel={m["image_export.format.png.print.margin_v_short"]()}
          firstValue={marginHText}
          secondValue={marginVText}
          onFirstChange={setMarginHText}
          onSecondChange={setMarginVText}
        />

        {hasMultipleFloors && (
          <Stack gap="elementsGap">
            <Inline justify="space-between" gap="itemGap">
              <span style={styles.label}>{m["field.print_sizing.apply_all_floors"]()}</span>
              <Switch checked={applyToAllStandardFloors} onChange={setApplyToAllStandardFloors} />
            </Inline>
            <span style={styles.note}>{m["field.print_sizing.apply_all_floors_note"]()}</span>
          </Stack>
        )}

        <div style={styles.divider} />
        <div style={styles.result}>
          {!Number.isFinite(cellSizeMm) || cellSizeMm <= 0 ? (
            <span style={styles.error}>{m["field.print_sizing.invalid_cell_size"]()}</span>
          ) : result ? (
            <Stack gap="elementsGap">
              <span style={typography.body}>{m["field.print_sizing.result"]({ description: configSizeDescription(result.config) })}</span>
              <span style={typography.caption}>{m["field.print_sizing.result_physical"]({ width: result.fieldWidthMm.toFixed(1), height: result.fieldHeightMm.toFixed(1) })}</span>
              <span style={typography.caption}>{m["field.print_sizing.result_area"]({ width: result.usableWidthMm.toFixed(1), height: result.usableHeightMm.toFixed(1) })}</span>
            </Stack>
          ) : (
            <span style={styles.error}>{m["field.print_sizing.invalid"]()}</span>
          )}
        </div>
      </Stack>

      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="primary" layoutStyle={styles.footerButton} disabled={!result} onClick={handleApply}>
          {m["common.confirm"]()}
        </Button>
      </div>
    </Modal>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function NumberInputRow({ label, value, suffix, onChange }: { label: string; value: string; suffix?: string; onChange: (value: string) => void }) {
  return (
    <Inline gap="itemGap" justify="space-between">
      <span style={styles.label}>{label}</span>
      <Inline gap="elementsGap">
        <input type="number" name={label} min={0} step="0.1" style={styles.input} value={value} onChange={(e) => onChange(e.target.value)} />
        {suffix && <span style={typography.caption}>{suffix}</span>}
      </Inline>
    </Inline>
  );
}

function NumberInputPairRow({ label, firstLabel, secondLabel, firstValue, secondValue, onFirstChange, onSecondChange }: {
  label: string;
  firstLabel: string;
  secondLabel: string;
  firstValue: string;
  secondValue: string;
  onFirstChange: (value: string) => void;
  onSecondChange: (value: string) => void;
}) {
  return (
    <Inline gap="itemGap" justify="space-between">
      <span style={styles.label}>{label}</span>
      <Inline gap="groupGap">
        <NumberInput label={firstLabel} value={firstValue} onChange={onFirstChange} />
        <NumberInput label={secondLabel} value={secondValue} onChange={onSecondChange} />
      </Inline>
    </Inline>
  );
}

function NumberInput({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <Inline gap="elementsGap">
      <span style={{ ...styles.shortLabel, ...(disabled ? styles.disabled : {}) }}>{label}</span>
      <input type="number" name={label} min={0} step="0.1" disabled={disabled} style={{ ...styles.input, ...(disabled ? styles.inputDisabled : {}) }} value={value} onChange={(e) => onChange(e.target.value)} />
    </Inline>
  );
}

export function configSizeDescription(config: FieldConfig): string {
  switch (config.type) {
    case "square": return m["field.print_sizing.result_size"]({ size: `${config.width} × ${config.height}` });
    case "hex_parallelogram":
    case "triangle_rect": return m["field.print_sizing.result_size"]({ size: `${config.cols} × ${config.rows}` });
    case "hex_hexagon":
    case "triangle_hexagon": return m["field.print_sizing.result_radius"]({ size: String(config.radius) });
    case "triangle_triangle": return m["field.print_sizing.result_side"]({ size: String(config.side) });
    case "square_custom":
    case "hex_custom":
    case "tri_custom": return "";
  }
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
  shortLabel: typography.caption,
  input: { ...sharedStyles.input, width: 72 },
  inputDisabled: { opacity: 0.45 },
  disabled: { opacity: 0.45 },
  iconButton: { width: 32, height: 28, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  result: { padding: `${dialogSpacing.paddingY}px 0` },
  divider: { borderTop: `1px solid ${ui.border.default}` },
  error: { ...typography.body, color: ui.text.error },
  note: typography.caption,
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
