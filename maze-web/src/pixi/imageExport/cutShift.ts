import { DPI_BY_DENSITY, pxToMm } from "./printFit";
import type { DigitalExportSettings, PrintExportSettings } from "../../store/storeTypes";

/// How a manual cut line's offset is shown to the user (GitHub issue #909): the shift from the automatic line in the unit of
/// the active output mode, not a fraction of the glue's period.
export type CutShiftOutput = { mode: "digital"; digital: Pick<DigitalExportSettings, "scale"> } | { mode: "print"; print: Pick<PrintExportSettings, "scale" | "density"> };

const signed = (amount: number, digits: number, unit: string): string => {
  const rounded = Number(amount.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded} ${unit}`;
};

/// A signed shift: pixels of the digital image, or millimetres on the printed sheet. `distancePerOffset` is `GroupCut.distancePerOffset`.
export function formatCutShift(offset: number, distancePerOffset: number, output: CutShiftOutput): string {
  const distance = offset * distancePerOffset;
  if (output.mode === "print") return signed(pxToMm(distance * output.print.scale, DPI_BY_DENSITY[output.print.density]), 1, "mm");
  return signed(distance * output.digital.scale, 0, "px");
}
