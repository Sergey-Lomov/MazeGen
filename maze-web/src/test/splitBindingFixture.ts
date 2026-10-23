import { detectSplitSpecialShapeKind, type SplitFaceKind } from "../pixi/splitFaceLayout";
import type { SplitShapeBinding } from "../pixi/splitShape";
import { splitNodeSemanticNames, type SplitNodeFaces } from "../pixi/splitNodeNames";

const SHAPE_BY_DEGREE: Record<number, string> = { 3: "regular:3", 4: "regular:4", 5: "cairo_pentagon", 6: "regular:6" };

/** Identity-ordered shape binding for a cell with `degree` faces (every built-in template today). */
export function identityBinding(degree: number): SplitShapeBinding | null {
  const shape = SHAPE_BY_DEGREE[degree];
  if (!shape) return null;
  const order = Array.from({ length: degree }, (_, i) => i);
  return { shape, canonicalOfLocal: order, localOfCanonical: order, group: [order] };
}

/** `detectSplitSpecialShapeKind` with the identity binding implied by the kinds' own face count. */
export function detectIdentity(kinds: SplitFaceKind[][]) {
  return detectSplitSpecialShapeKind(kinds, identityBinding(kinds[0]?.length ?? 0));
}

/** `splitNodeSemanticNames` with the identity binding implied by the nodes' own face count. */
export function namesIdentity(nodes: SplitNodeFaces[]) {
  return splitNodeSemanticNames(nodes, identityBinding(nodes[0]?.faces.length ?? 0));
}
