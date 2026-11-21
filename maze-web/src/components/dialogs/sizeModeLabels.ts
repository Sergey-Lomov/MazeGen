import type { PrintSizeMode } from "../../domain/geometry/tessellationUi";
import * as m from "~/paraglide/messages";

/** What the size field takes in each mode: the label of the field, and the name in the mode select. */
export const SIZE_MODE_LABELS: Record<PrintSizeMode, { field: () => string; option: () => string }> = {
  cell_size: { field: () => m["field.print_sizing.cell_size_diameter"](), option: () => m["field.print_sizing.input_mode_cell_size"]() },
  min_side: { field: () => m["field.print_sizing.min_side"](), option: () => m["field.print_sizing.input_mode_min_side"]() },
  average_size: { field: () => m["field.print_sizing.average_size"](), option: () => m["field.print_sizing.average_size"]() },
  ring_thickness: { field: () => m["field.print_sizing.ring_thickness"](), option: () => m["field.print_sizing.ring_thickness"]() },
};
