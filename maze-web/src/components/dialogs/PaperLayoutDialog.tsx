import React, { useMemo, useRef, useState } from "react";
import type { FieldConfig } from "../../fieldConfig";
import type { PaperOrientation, PaperSize, PrintFieldSizingInput } from "../../store/storeTypes";
import { useMazeStore } from "../../store/mazeStore";
import { minPrintEnteredSize, resolvePrintPaperSizeMm } from "../../pixi/fieldPrintSizing";
import { defaultPrintEnteredSize, printMeasureFromEntered, resolvePrintSizeMode, roundedEnteredFromMeasure } from "../../pixi/imageExport/printFit";
import { TESSELLATION_UI, type PrintSizeMode } from "../../pixi/geometry/tessellationUi";
import { SelectRow } from "../SelectRow";
import { SIZE_MODE_LABELS } from "./sizeModeLabels";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Inline, Stack } from "../Layout";
import { sharedStyles } from "../../styles/shared";
import { controlRowHeight, dialogSpacing, inset, radius, typography, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import { PaperLayoutFields } from "../features/PaperLayoutFields";
import { NumberInput } from "../NumberInput";
import { normalizeNumberCommit } from "../inputNormalization";

interface Props {
  config: Pick<FieldConfig, "tessellation">;
  onApply: (input: PrintFieldSizingInput) => void;
  onClose: () => void;
}

export function PaperLayoutDialog({ config, onApply, onClose }: Props) {
  const print = useMazeStore((s) => s.pngExportSettings.print);
  const [paperSize, setPaperSize] = useState<PaperSize>(print.paperSize);
  const [customWidth, setCustomWidth] = useState(String(print.customWidthMm));
  const [customHeight, setCustomHeight] = useState(String(print.customHeightMm));
  const [orientation, setOrientation] = useState<PaperOrientation>(print.orientation);
  const sizeModes = TESSELLATION_UI[config.tessellation.kind].editor.sizeModes;
  const [sizeMode, setSizeMode] = useState<PrintSizeMode>(() => resolvePrintSizeMode(config, print.sizeMode));
  // Opens with the same default as the print calculator, not with the size of `print.scale`.
  const [cellSize, setCellSize] = useState(() => String(defaultPrintEnteredSize(config, resolvePrintSizeMode(config, print.sizeMode))));
  // The field takes the value of the chosen mode; the dialog applies the cell size (diameter).
  const minEnteredMm = minPrintEnteredSize(config, sizeMode);
  const [marginH, setMarginH] = useState(String(print.marginHMm));
  const [marginV, setMarginV] = useState(String(print.marginVMm));

  // What is typed in the cell size field until it is committed (on blur or on confirming the dialog).
  const cellSizeDraft = useRef<string | null>(null);

  const values = {
    customWidthMm: parseNumber(customWidth),
    customHeightMm: parseNumber(customHeight),
    cellSizeMm: printMeasureFromEntered(config, sizeMode, parseNumber(cellSize)),
    marginHMm: parseNumber(marginH),
    marginVMm: parseNumber(marginV),
  };
  const paper = useMemo(() => resolvePrintPaperSizeMm({ paperSize, ...values, orientation }), [paperSize, values.customWidthMm, values.customHeightMm, orientation]);
  const valid = Number.isFinite(values.cellSizeMm) && values.cellSizeMm > 0
    && Number.isFinite(values.marginHMm) && values.marginHMm >= 0
    && Number.isFinite(values.marginVMm) && values.marginVMm >= 0
    && Number.isFinite(paper.widthMm) && Number.isFinite(paper.heightMm)
    && paper.widthMm > values.marginHMm * 2 && paper.heightMm > values.marginVMm * 2;

  /** Commits the typed cell size as leaving the field does: an unreadable value goes back to the
   * last committed one, a value under the minimum is raised to it. */
  function commitCellSize(text: string): string {
    cellSizeDraft.current = null;
    const committed = normalizeNumberCommit(text, cellSize, { min: minEnteredMm }).value;
    setCellSize(committed);
    return committed;
  }

  /** Switching the mode keeps the physical size: the field shows the same cells in the other measure. */
  function handleSizeModeChange(mode: PrintSizeMode) {
    if (mode === sizeMode) return;
    cellSizeDraft.current = null;
    const measure = values.cellSizeMm;
    setSizeMode(mode);
    if (Number.isFinite(measure) && measure > 0) setCellSize(String(roundedEnteredFromMeasure(config, mode, measure)));
  }

  function confirm() {
    if (!valid) return;
    // Confirming (Enter included) takes a value still being typed as if the field was left.
    const cellSizeMm = cellSizeDraft.current === null
      ? values.cellSizeMm
      : printMeasureFromEntered(config, sizeMode, parseNumber(commitCellSize(cellSizeDraft.current)));
    onApply({ paperSize, ...values, cellSizeMm, orientation, sizeMode });
    onClose();
  }

  return (
    <Modal title={m["field.paper_layout.title"]()} size="info" onClose={onClose} onConfirm={valid ? confirm : undefined}>
      <Stack gap="itemGap">
        <PaperLayoutFields
          paperSize={paperSize}
          customWidthMm={customWidth}
          customHeightMm={customHeight}
          orientation={orientation}
          marginHMm={marginH}
          marginVMm={marginV}
          onPaperSizeChange={setPaperSize}
          onCustomWidthChange={setCustomWidth}
          onCustomHeightChange={setCustomHeight}
          onOrientationChange={setOrientation}
          onMarginHChange={setMarginH}
          onMarginVChange={setMarginV}
          paperLabel={m["field.print_sizing.paper"]()}
          marginLabel={m["field.print_sizing.margin"]()}
          inputNamePrefix="field-paper-layout"
        />
        {sizeModes.length > 1 && (
          <SelectRow<PrintSizeMode>
            label={m["field.print_sizing.input_mode"]()}
            value={sizeMode}
            options={sizeModes.map((mode) => ({ value: mode, label: SIZE_MODE_LABELS[mode].option() }))}
            onChange={handleSizeModeChange}
          />
        )}
        <Inline gap="itemGap" justify="space-between">
          <span style={styles.label}>
            {SIZE_MODE_LABELS[sizeMode].field()}
          </span>
          <Inline gap="elementsGap">
            <NumberInput
              name="cell-size"
              value={cellSize}
              min={minEnteredMm}
              style={styles.input}
              onChange={(text) => { cellSizeDraft.current = text; }}
              onBlurCommit={commitCellSize}
            />
            <span style={typography.caption}>mm</span>
          </Inline>
        </Inline>
        {!valid && <span style={styles.error}>{m["field.paper_layout.invalid"]()}</span>}
      </Stack>
      <div style={styles.footer}>
        <Button variant="secondary" dialogAction layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="primary" dialogAction layoutStyle={styles.footerButton} disabled={!valid} onClick={confirm}>{m["common.confirm"]()}</Button>
      </div>
    </Modal>
  );
}

function parseNumber(value: string): number { return value.trim() === "" ? Number.NaN : Number(value); }

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
  input: { ...sharedStyles.input, width: 70, height: controlRowHeight, boxSizing: "border-box" },
  error: { ...typography.body, color: ui.text.error },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: 0 },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
