import React, { useMemo, useRef, useState } from "react";
import type { FieldConfig } from "../../fieldConfig";
import type { PaperOrientation, PaperSize, PrintFieldSizingInput } from "../../store/storeTypes";
import { useMazeStore } from "../../store/mazeStore";
import { MIN_PRINT_CELL_SIZE_MM, resolvePrintPaperSizeMm } from "../../pixi/fieldPrintSizing";
import { DPI_BY_DENSITY, printCellMeasureMm } from "../../pixi/imageExport/printFit";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Inline, Stack } from "../Layout";
import { sharedStyles } from "../../styles/shared";
import { dialogSpacing, inset, radius, typography, ui } from "../../styles/theme";
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
  const initialCellSizeMm = printCellMeasureMm(config, print.scale, DPI_BY_DENSITY[print.density]);
  const [paperSize, setPaperSize] = useState<PaperSize>(print.paperSize);
  const [customWidth, setCustomWidth] = useState(String(print.customWidthMm));
  const [customHeight, setCustomHeight] = useState(String(print.customHeightMm));
  const [orientation, setOrientation] = useState<PaperOrientation>(print.orientation);
  const [cellSize, setCellSize] = useState(String(round2(Math.max(MIN_PRINT_CELL_SIZE_MM, initialCellSizeMm))));
  const [marginH, setMarginH] = useState(String(print.marginHMm));
  const [marginV, setMarginV] = useState(String(print.marginVMm));

  // What is typed in the cell size field until it is committed (on blur or on confirming the dialog).
  const cellSizeDraft = useRef<string | null>(null);

  const values = {
    customWidthMm: parseNumber(customWidth),
    customHeightMm: parseNumber(customHeight),
    cellSizeMm: parseNumber(cellSize),
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
    const committed = normalizeNumberCommit(text, cellSize, { min: MIN_PRINT_CELL_SIZE_MM }).value;
    setCellSize(committed);
    return committed;
  }

  function confirm() {
    if (!valid) return;
    // Confirming (Enter included) takes a value still being typed as if the field was left.
    const cellSizeMm = cellSizeDraft.current === null ? values.cellSizeMm : parseNumber(commitCellSize(cellSizeDraft.current));
    onApply({ paperSize, ...values, cellSizeMm, orientation });
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
        <Inline gap="itemGap" justify="space-between">
          <span style={styles.label}>
            {m["field.print_sizing.cell_size_diameter"]()}
          </span>
          <Inline gap="elementsGap">
            <NumberInput
              name="cell-size"
              value={cellSize}
              min={MIN_PRINT_CELL_SIZE_MM}
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
function round2(value: number): number { return Math.round(value * 100) / 100; }

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
  input: { ...sharedStyles.input, width: 72 },
  error: { ...typography.body, color: ui.text.error },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: 0 },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
