import React, { useMemo, useState } from "react";
import { TESSELLATION_UI } from "../../pixi/geometry/tessellationUi";
import type { FieldConfig } from "../../fieldConfig";
import type { PaperOrientation, PaperSize, PrintFieldSizingInput } from "../../store/storeTypes";
import { useMazeStore } from "../../store/mazeStore";
import { DEFAULT_PRINT_CELL_SIZE_MM, resolvePrintPaperSizeMm } from "../../pixi/fieldPrintSizing";
import { DPI_BY_DENSITY, printCellMeasureMm } from "../../pixi/imageExport/printFit";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Inline, Stack } from "../Layout";
import { sharedStyles } from "../../styles/shared";
import { dialogSpacing, inset, radius, typography, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import { PaperLayoutFields } from "../features/PaperLayoutFields";

interface Props {
  config: Pick<FieldConfig, "tessellation">;
  onApply: (input: PrintFieldSizingInput) => void;
  onClose: () => void;
}

export function PaperLayoutDialog({ config, onApply, onClose }: Props) {
  const print = useMazeStore((s) => s.pngExportSettings.print);
  const initialCellSizeMm = print.scaleAutoFit
    ? DEFAULT_PRINT_CELL_SIZE_MM
    : printCellMeasureMm(config, print.scale, DPI_BY_DENSITY[print.density]);
  const [paperSize, setPaperSize] = useState<PaperSize>(print.paperSize);
  const [customWidth, setCustomWidth] = useState(String(print.customWidthMm));
  const [customHeight, setCustomHeight] = useState(String(print.customHeightMm));
  const [orientation, setOrientation] = useState<PaperOrientation>(print.orientation);
  const [cellSize, setCellSize] = useState(String(round2(initialCellSizeMm)));
  const [marginH, setMarginH] = useState(String(print.marginHMm));
  const [marginV, setMarginV] = useState(String(print.marginVMm));

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

  function confirm() {
    if (!valid) return;
    onApply({ paperSize, ...values, orientation });
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
        <NumberInputRow label={TESSELLATION_UI[config.tessellation.kind].editor.printCellSize === "side" ? m["field.print_sizing.cell_size_side"]() : m["field.print_sizing.cell_size_diameter"]()} value={cellSize} onChange={setCellSize} />
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

function NumberInputRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <Inline gap="itemGap" justify="space-between"><span style={styles.label}>{label}</span><Inline gap="elementsGap"><input type="number" name={label} min={0} step="0.1" style={styles.input} value={value} onChange={(e) => onChange(e.target.value)} /><span style={typography.caption}>mm</span></Inline></Inline>;
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
  input: { ...sharedStyles.input, width: 72 },
  error: { ...typography.body, color: ui.text.error },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: 0 },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
