import * as m from "~/paraglide/messages";

/** Returns the localized label for a tessellation cell type used by placement UI and debug events. */
export function cellTypeLabel(key: string): string {
  switch (key) {
    case "cell": return m["generation.cell_type.cell"]();
    case "triangle": return m["generation.cell_type.triangle"]();
    case "square": return m["generation.cell_type.square"]();
    case "hexagon": return m["generation.cell_type.hexagon"]();
    case "octagon": return m["generation.cell_type.octagon"]();
    case "dodecagon": return m["generation.cell_type.dodecagon"]();
    default: return key;
  }
}

/** Returns the localized label for a generated element used by generation events. */
export function generatedElementLabel(key: string): string {
  switch (key) {
    case "start": return m["generation.element.start"]();
    case "finish": return m["generation.element.finish"]();
    case "one_way": return m["generation.element.one_way"]();
    case "teleport": return m["generation.element.teleport"]();
    case "split": return m["generation.element.split"]();
    case "vertical_passage": return m["generation.element.vertical_passage"]();
    case "elevator": return m["generation.element.elevator"]();
    default: return key;
  }
}
