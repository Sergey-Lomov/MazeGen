import type { Tessellation as TessellationConfig } from "../../fieldConfig";
import { decodePoint } from "../../store/mazeStore";
import { configAllCells } from "../tessellationCells";

export function buildActiveCells(
  fieldPoints: Set<number>,
  fieldEditMode: "default" | "custom",
  cfg: TessellationConfig,
): [number, number][] {
  if (fieldEditMode === "default") {
    if ("kind" in cfg) return cfg.cells;
    return configAllCells(cfg) as [number, number][];
  }
  return Array.from(fieldPoints).map(k => decodePoint(k) as [number, number]);
}
