import type { PaperSize } from "../../store/storeTypes";

/** Standard paper sizes in millimeters, portrait orientation (`w < h`). Landscape swaps
 * `w`/`h` at the call site (`computePrintExportFit`), not here. */
export const PAPER_SIZES_MM: Record<Exclude<PaperSize, "custom">, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
  a5: { w: 148, h: 210 },
  a2: { w: 420, h: 594 },
  a1: { w: 594, h: 841 },
  a0: { w: 841, h: 1189 },
  letter: { w: 215.9, h: 279.4 },
  legal: { w: 215.9, h: 355.6 },
  tabloid: { w: 279.4, h: 431.8 },
};
