import type { FieldConfig } from "../../fieldConfig";
import type { WireTopology } from "../../wasm/types";
import { glueColor } from "../renderers/SeamArrowRenderer";
import { seamArrowsFor } from "./seamArrows";

/// The colour (0xRRGGBB) each glue's arrow is drawn in on the canvas, by glue id. A glue that glues
/// nothing has no arrow and no entry. Everything that marks a glue on the canvas or beside it takes its
/// colour from here, so the glue reads the same everywhere.
export function glueColorsByGroup(cfg: FieldConfig | undefined, topology: WireTopology | null | undefined): Map<number, number> {
  const colors = new Map<number, number>();
  if (!cfg) return colors;
  try {
    const arrows = seamArrowsFor(cfg, topology ?? null);
    arrows.forEach((arrow, index) => {
      if (arrow.group !== null) colors.set(arrow.group, glueColor(index, arrows.length, false));
    });
  } catch {
    // A field mid-reset has no geometry to read; the colours come back with the next render.
  }
  return colors;
}
