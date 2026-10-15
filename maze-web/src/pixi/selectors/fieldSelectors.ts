import type { FieldConfig } from "../../fieldConfig";
import { decodePoint } from "../../store/mazeStore";
import { configAllCells } from "../tessellationCells";

export function buildActiveCells(
  fieldPoints: Set<number>,
  fieldEditMode: "default" | "custom",
  cfg: FieldConfig,
): [number, number][] {
  if (fieldEditMode === "default") {
    return configAllCells(cfg);
  }
  return Array.from(fieldPoints).map(k => decodePoint(k) as [number, number]);
}
