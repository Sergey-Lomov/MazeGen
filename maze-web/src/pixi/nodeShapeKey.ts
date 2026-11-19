/** A parsed `NodeShape::key()`: `dead_end`, `straight`, `turn_<deg>`, `junction_<sides>_<ranks>`
 *  (`ranks`: the angular ranks of the junction's faces, `-`-joined) or the unresolved
 *  `junction_<n>` (`ranks` is `null`, `degree` is `n`). */
export type NodeShapeKey =
  | { type: "dead_end" }
  | { type: "straight" }
  | { type: "turn"; angle: number }
  | { type: "junction"; degree: number; ranks: number[] | null };

const TURN = /^turn_(\d+)$/;
const JUNCTION_LAYOUT = /^junction_\d+_(\d+(?:-\d+)*)$/;
const JUNCTION_UNRESOLVED = /^junction_(\d+)$/;

/** The single parser of a shape key; `null` for a key of no known family. */
export function parseNodeShapeKey(key: string): NodeShapeKey | null {
  if (key === "dead_end") return { type: "dead_end" };
  if (key === "straight") return { type: "straight" };
  const turn = TURN.exec(key);
  if (turn) return { type: "turn", angle: Number(turn[1]) };
  const layout = JUNCTION_LAYOUT.exec(key);
  if (layout) {
    const ranks = layout[1].split("-").map(Number);
    return { type: "junction", degree: ranks.length, ranks };
  }
  const unresolved = JUNCTION_UNRESOLVED.exec(key);
  if (unresolved) return { type: "junction", degree: Number(unresolved[1]), ranks: null };
  return null;
}
