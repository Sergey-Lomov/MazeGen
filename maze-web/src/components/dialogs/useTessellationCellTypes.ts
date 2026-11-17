import { useMemo } from "react";
import type { FieldConfig } from "../../fieldConfig";
import { getTessellationCellTypes } from "../../wasm/mazeService";

/** Every cell type of the tessellation, known before any calculation: the rows the cell sizes will
 * have, and whether core says the cells of a type vary in size. Cheap: no cells are sent. */
export function useTessellationCellTypes(tessellation: FieldConfig["tessellation"]): { keys: string[]; cellsVary: boolean } {
  return useMemo(() => {
    try {
      const { keys, cells_vary_in_size } = getTessellationCellTypes({ tessellation, points: [] });
      return { keys, cellsVary: cells_vary_in_size };
    } catch {
      return { keys: [], cellsVary: false };
    }
  }, [tessellation]);
}
