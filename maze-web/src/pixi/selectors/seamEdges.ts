import type { FieldConfig } from "../../fieldConfig";
import { getFaceEdgeSegment, getSharedEdgeSegment, type SharedEdge } from "../tessellationGeometry";
import { getSeamModel } from "./seams";

/// The drawn copies of the logical edge between two cells, in display space: the one shared face of
/// ordinary neighbors, or, across a seam, each side's own copy of the glued face (side of `a` first).
/// Empty when the cells share neither a face nor a seam.
export function logicalEdgeSegments(a: [number, number], b: [number, number], cfg: FieldConfig): SharedEdge[] {
  const seams = getSeamModel(cfg);
  const half = seams.halfEdgeBetween(a, b);
  if (half) {
    const partner = seams.partnerOf(half);
    return [getFaceEdgeSegment(a, half.faceIdx, cfg), getFaceEdgeSegment(b, partner.faceIdx, cfg)].filter((seg): seg is SharedEdge => seg !== null);
  }
  const shared = getSharedEdgeSegment(a, b, cfg);
  return shared ? [shared] : [];
}
