import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { decodePoint } from "../../store/mazeStore";
import { configAllCells } from "../tessellationCells";

export function buildActiveCells(
  fieldPoints: Set<number>,
  fieldEditMode: "default" | "custom",
  cfg: TessellationConfig,
): [number, number][] {
  if (fieldEditMode === "default") {
    return configAllCells(cfg) as [number, number][];
  }
  return Array.from(fieldPoints).map(k => decodePoint(k) as [number, number]);
}
