import type { FieldConfig } from "../../fieldConfig";
import { decodePoint } from "../../store/mazeStore";
import { configAllCells } from "../tessellationCells";

export function buildActiveCells(
  fieldPoints: Set<number>,
  fieldEditMode: "default" | "custom",
  cfg: FieldConfig,
  smooth = false,
): [number, number][] {
  if (fieldEditMode === "default") {
    return configAllCells(cfg, smooth);
  }
  return Array.from(fieldPoints).map(k => decodePoint(k) as [number, number]);
}
