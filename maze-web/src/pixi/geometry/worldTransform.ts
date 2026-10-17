import type { PathCommand, WorldPoint } from "../../wasm/mazeService";

/// Similarity transform (rotation, reflection, uniform scale, translation) from world units to a
/// target space: `[x', y'] = [a·x + c·y + tx, b·x + d·y + ty]`. Similarities keep circles
/// circular, so a path's arc commands survive the transform as arcs. This is the display
/// transform of `Specs/space.md`; core geometry never sees it.
export interface WorldTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const IDENTITY_TRANSFORM: WorldTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/// Relative tolerance for "is this matrix a similarity" (equal-length, perpendicular columns).
const SIMILARITY_TOLERANCE = 1e-9;

export function isSimilarity(t: WorldTransform): boolean {
  const scale = Math.max(Math.hypot(t.a, t.b), Math.hypot(t.c, t.d));
  if (scale === 0) return false;
  const lengthGap = Math.abs(Math.hypot(t.a, t.b) - Math.hypot(t.c, t.d));
  const dot = t.a * t.c + t.b * t.d;
  return lengthGap <= SIMILARITY_TOLERANCE * scale && Math.abs(dot) <= SIMILARITY_TOLERANCE * scale * scale;
}

export function applyTransform(t: WorldTransform, [x, y]: WorldPoint): WorldPoint {
  return [t.a * x + t.c * y + t.tx, t.b * x + t.d * y + t.ty];
}

/// The inverse of a non-degenerate transform.
export function invertTransform(t: WorldTransform): WorldTransform {
  const det = t.a * t.d - t.b * t.c;
  const a = t.d / det;
  const b = -t.b / det;
  const c = -t.c / det;
  const d = t.a / det;
  return { a, b, c, d, tx: -(a * t.tx + c * t.ty), ty: -(b * t.tx + d * t.ty) };
}

/// Determinant sign: negative for a reflection (e.g. the world Y-up to screen Y-down flip).
export function isReflection(t: WorldTransform): boolean {
  return t.a * t.d - t.b * t.c < 0;
}

export function transformCommand(t: WorldTransform, command: PathCommand): PathCommand {
  if (command.op !== "arc_to") return { op: command.op, to: applyTransform(t, command.to) };
  if (!isSimilarity(t)) throw new Error("arc_to needs a similarity transform");
  const det = t.a * t.d - t.b * t.c;
  const angle = (source: number) => Math.atan2(t.b * Math.cos(source) + t.d * Math.sin(source), t.a * Math.cos(source) + t.c * Math.sin(source));
  return {
    op: "arc_to",
    center: applyTransform(t, command.center),
    radius: command.radius * Math.sqrt(Math.abs(det)),
    start_angle: angle(command.start_angle),
    end_angle: angle(command.end_angle),
    // Angles keep their numeric direction under a rotation and reverse under a reflection.
    ccw: det < 0 ? !command.ccw : command.ccw,
  };
}
