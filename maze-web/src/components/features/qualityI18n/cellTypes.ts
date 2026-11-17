import * as m from "~/paraglide/messages";

type MessageFn = () => string;

/** Display names of the tessellation cell type keys (core `CellType::key`). A key missing here
 *  (a tessellation gained a new type) falls back to the raw key. */
const CELL_TYPE_I18N: Record<string, MessageFn> = {
  cell: m["cell_type.cell"] as MessageFn,
  triangle: m["cell_type.triangle"] as MessageFn,
  square: m["cell_type.square"] as MessageFn,
  hexagon: m["cell_type.hexagon"] as MessageFn,
  octagon: m["cell_type.octagon"] as MessageFn,
  dodecagon: m["cell_type.dodecagon"] as MessageFn,
};

export function resolveCellTypeLabel(key: string): string {
  return CELL_TYPE_I18N[key]?.() ?? key;
}
