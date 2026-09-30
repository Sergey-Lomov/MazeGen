import { RectangleHorizontal, RectangleVertical } from "lucide-react";
import type { PaperOrientation, PaperSize } from "../../store/storeTypes";
import { resolvePrintPaperSizeMm } from "../../pixi/fieldPrintSizing";
import { SelectRow } from "../SelectRow";
import { Inline } from "../Layout";
import { buttonClass, buttonStyle, sharedStyles } from "../../styles/shared";
import { controlRowHeight, typography } from "../../styles/theme";
import * as m from "~/paraglide/messages";

export const PAPER_SIZE_OPTIONS: { value: PaperSize; label: string; disabled?: boolean }[] = [
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

interface Props {
  paperSize: PaperSize;
  customWidthMm: number | string;
  customHeightMm: number | string;
  orientation: PaperOrientation;
  marginHMm: number | string;
  marginVMm: number | string;
  onPaperSizeChange: (value: PaperSize) => void;
  onCustomWidthChange: (value: string) => void;
  onCustomHeightChange: (value: string) => void;
  onOrientationChange: (value: PaperOrientation) => void;
  onMarginHChange: (value: string) => void;
  onMarginVChange: (value: string) => void;
  paperLabel?: string;
  marginLabel?: string;
  inputNamePrefix?: string;
}

export function PaperLayoutFields({
  paperSize, customWidthMm, customHeightMm, orientation, marginHMm, marginVMm,
  onPaperSizeChange, onCustomWidthChange, onCustomHeightChange, onOrientationChange,
  onMarginHChange, onMarginVChange,
  paperLabel = m["image_export.format.png.print.paper_size"](),
  marginLabel = m["image_export.format.png.print.margin_mm"](),
  inputNamePrefix = "paper-layout",
}: Props) {
  const paper = resolvePrintPaperSizeMm({
    paperSize,
    customWidthMm: Number(customWidthMm),
    customHeightMm: Number(customHeightMm),
    orientation,
  });
  const isCustom = paperSize === "custom";

  return (
    <>
      <SelectRow<PaperSize> label={paperLabel} value={paperSize} options={PAPER_SIZE_OPTIONS} onChange={onPaperSizeChange} />
      <Inline gap="itemGap" justify="space-between">
        <span style={styles.label}>{m["image_export.format.png.print.size_mm"]()}</span>
        <Inline gap="groupGap">
          <DimensionInput
            name={`${inputNamePrefix}-width`}
            label={m["image_export.format.png.print.width_short"]()}
            value={isCustom ? customWidthMm : paper.widthMm}
            disabled={!isCustom}
            onChange={onCustomWidthChange}
          />
          <DimensionInput
            name={`${inputNamePrefix}-height`}
            label={m["image_export.format.png.print.height_short"]()}
            value={isCustom ? customHeightMm : paper.heightMm}
            disabled={!isCustom}
            onChange={onCustomHeightChange}
          />
        </Inline>
      </Inline>
      <Inline gap="itemGap" justify="space-between">
        <span style={styles.label}>{m["image_export.format.png.print.orientation"]()}</span>
        <Inline gap="itemGap">
          <button
            className={buttonClass(orientation === "portrait" ? "toggle-selected" : "toggle")}
            style={{ ...buttonStyle(orientation === "portrait" ? "toggle-selected" : "toggle"), ...styles.iconToggle }}
            title={m["image_export.format.png.print.orientation_portrait"]()}
            onClick={() => onOrientationChange("portrait")}
          >
            <RectangleVertical size={16} />
          </button>
          <button
            className={buttonClass(orientation === "landscape" ? "toggle-selected" : "toggle")}
            style={{ ...buttonStyle(orientation === "landscape" ? "toggle-selected" : "toggle"), ...styles.iconToggle }}
            title={m["image_export.format.png.print.orientation_landscape"]()}
            onClick={() => onOrientationChange("landscape")}
          >
            <RectangleHorizontal size={16} />
          </button>
        </Inline>
      </Inline>
      <Inline gap="itemGap" justify="space-between">
        <span style={styles.label}>{marginLabel}</span>
        <Inline gap="groupGap">
          <DimensionInput name={`${inputNamePrefix}-margin-horizontal`} label={m["image_export.format.png.print.margin_h_short"]()} value={marginHMm} onChange={onMarginHChange} />
          <DimensionInput name={`${inputNamePrefix}-margin-vertical`} label={m["image_export.format.png.print.margin_v_short"]()} value={marginVMm} onChange={onMarginVChange} />
        </Inline>
      </Inline>
    </>
  );
}

function DimensionInput({ name, label, value, disabled, onChange }: { name: string; label: string; value: number | string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <Inline gap="elementsGap">
      <span style={{ ...styles.shortLabel, ...(disabled ? styles.labelDisabled : {}) }}>{label}</span>
      <input
        type="number"
        name={name}
        min={0}
        step="0.1"
        style={{ ...sharedStyles.input, ...styles.input, ...(disabled ? styles.inputDisabled : {}) }}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Inline>
  );
}

const styles = {
  label: { ...typography.body, minWidth: 70 },
  shortLabel: { ...typography.body },
  labelDisabled: { opacity: 0.4 },
  input: { width: 70, height: controlRowHeight, boxSizing: "border-box" as const },
  inputDisabled: { opacity: 0.4, cursor: "not-allowed" as const },
  iconToggle: { flex: "none" as const, width: controlRowHeight, height: controlRowHeight, padding: 0, display: "flex" as const, alignItems: "center" as const, justifyContent: "center" as const },
} as const;
