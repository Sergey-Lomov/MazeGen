import React, { useMemo, useState } from "react";
import type { PaperOrientation, PaperSize } from "../../store/storeTypes";
import { useMazeStore } from "../../store/mazeStore";
import { resolvePrintPaperSizeMm } from "../../pixi/fieldPrintSizing";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Stack } from "../Layout";
import { dialogSpacing, inset, radius, typography, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import { PaperLayoutFields } from "../features/PaperLayoutFields";

interface Props {
  onApply: (input: PageLayoutInput) => void;
  onClose: () => void;
}

export interface PageLayoutInput {
  paperSize: PaperSize;
  customWidthMm: number;
  customHeightMm: number;
  orientation: PaperOrientation;
  marginHMm: number;
  marginVMm: number;
}

/** Page-only counterpart of FieldPrintSizingDialog for underlays. It deliberately has no cell
 * size or field-shape controls: the current editor scale remains the source of page geometry. */
export function BackgroundImagePrintDialog({ onApply, onClose }: Props) {
  const print = useMazeStore((s) => s.pngExportSettings.print);
  const [paperSize, setPaperSize] = useState<PaperSize>(() => print.paperSize);
  const [customWidth, setCustomWidth] = useState(() => String(print.customWidthMm));
  const [customHeight, setCustomHeight] = useState(() => String(print.customHeightMm));
  const [orientation, setOrientation] = useState<PaperOrientation>(() => print.orientation);
  const [marginH, setMarginH] = useState(() => String(print.marginHMm));
  const [marginV, setMarginV] = useState(() => String(print.marginVMm));

  const values = {
    customWidthMm: parseNumber(customWidth),
    customHeightMm: parseNumber(customHeight),
    marginHMm: parseNumber(marginH),
    marginVMm: parseNumber(marginV),
  };
  const paper = useMemo(
    () => resolvePrintPaperSizeMm({ paperSize, ...values, orientation }),
    [paperSize, values.customWidthMm, values.customHeightMm, orientation],
  );
  const valid = Number.isFinite(paper.widthMm) && Number.isFinite(paper.heightMm)
    && paper.widthMm > 0 && paper.heightMm > 0
    && Number.isFinite(values.marginHMm) && values.marginHMm >= 0
    && Number.isFinite(values.marginVMm) && values.marginVMm >= 0
    && paper.widthMm > values.marginHMm * 2
    && paper.heightMm > values.marginVMm * 2;

  function confirm() {
    if (!valid) return;
    onApply({ paperSize, ...values, orientation });
    onClose();
  }

  return (
    <Modal title={m["background.print.title"]()} size="info" onClose={onClose} onConfirm={valid ? confirm : undefined}>
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
          inputNamePrefix="background-print"
        />
        {!valid && <span style={styles.error}>{m["background.print.invalid"]()}</span>}
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
  error: { ...typography.body, color: ui.text.error },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: 0 },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
