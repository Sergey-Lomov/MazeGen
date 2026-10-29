import type { FieldConfig } from "../../fieldConfig";
import type { CutLineStyleFields, RenderModeId } from "../../store/imageExportTypes";
import type { MazeStore } from "../../store/storeTypes";
import type { WireTopology } from "../../wasm/types";
import { glueColorsByGroup } from "../selectors/glueColors";

/// The cut-line style of a render mode (GitHub issue #859): both modes carry the same fields.
export function cutLineStyleOf(
  state: Pick<MazeStore, "vectorByWallsSettings" | "vectorByCorridorsSettings">,
  mode: RenderModeId,
): CutLineStyleFields {
  return mode === "vector_by_walls" ? state.vectorByWallsSettings : state.vectorByCorridorsSettings;
}

/// Colour (0xRRGGBB) of each glue's cut lines on the image: the colour of the glue, or the style's single colour.
export function cutLineColors(
  style: CutLineStyleFields,
  cfg: FieldConfig | undefined,
  topology: WireTopology | null | undefined,
): (group: number) => number {
  if (!style.cutLinesGlueColor) return () => style.cutLinesColor;
  const byGroup = glueColorsByGroup(cfg, topology);
  return (group) => byGroup.get(group) ?? style.cutLinesColor;
}
