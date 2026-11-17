import type { FieldConfig } from "../fieldConfig";
import type { WireFoldEnd } from "../wasm/types";
import { getCellGeometry } from "./cartesianCache";
import { applyTransform } from "./geometry/worldTransform";
import { formatTargetLabel } from "./targetLabel";
import { displayTransform } from "./tessellationGeometry";

const SIDE_ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"] as const;

/// An arrow for the side of its cell a face lies on, in the space the canvas draws in (screen y
/// grows downwards). Only a label: the face itself is always addressed by its index.
export function faceSideArrow(end: WireFoldEnd, cfg: FieldConfig): string {
  const geometry = getCellGeometry(end.cell[0], end.cell[1], cfg);
  const face = geometry.faces[end.face_idx];
  if (!face) return "";
  const transform = displayTransform(cfg);
  const [cx, cy] = applyTransform(transform, geometry.center);
  const [fx, fy] = applyTransform(transform, face.contact_point);
  const sector = Math.round(Math.atan2(fy - cy, fx - cx) / (Math.PI / 4));
  return SIDE_ARROWS[((sector % 8) + 8) % 8];
}

/// A face as a coordinate bubble: the cell's `x:y` plus an arrow for the side it lies on.
export function faceLabel(end: WireFoldEnd, cfg: FieldConfig): string {
  const side = faceSideArrow(end, cfg);
  const cell = formatTargetLabel(end.cell, 0, false, undefined);
  return side ? `${cell} ${side}` : cell;
}
