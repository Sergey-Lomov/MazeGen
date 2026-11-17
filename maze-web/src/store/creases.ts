/** A topological crease line (GitHub issue #898): a free segment of the floor's plane, in core world units, along
 * which the shape is pressed flush when folded. It is not tied to cells or faces and never changes adjacency, so
 * it is stored beside the floor's topology, not inside it. See `Specs/topology.md`, "Creases". */
export interface Crease {
  /** Unique within a floor's list; a new crease takes `max + 1`. */
  id: number;
  a: readonly [number, number];
  b: readonly [number, number];
}

/** Which list the topology panel edits. */
export type TopologyMode = "gluings" | "creases";

/** The crease being drawn: `a` is placed by the first click, `cursor` follows the pointer. `replace` is the id of
 * the crease being redrawn. */
export interface CreaseDraft {
  replace: number | null;
  a: readonly [number, number] | null;
  cursor: readonly [number, number] | null;
}

export function nextCreaseId(creases: readonly Crease[]): number {
  return creases.reduce((max, crease) => Math.max(max, crease.id + 1), 0);
}

export function isDegenerateCrease(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** The list after adding a crease, or replacing the crease `replace` in place. `null` when the ends coincide. */
export function withCrease(
  creases: readonly Crease[],
  a: readonly [number, number],
  b: readonly [number, number],
  replace: number | null,
): Crease[] | null {
  if (isDegenerateCrease(a, b)) return null;
  if (replace !== null && creases.some((crease) => crease.id === replace)) {
    return creases.map((crease) => (crease.id === replace ? { id: replace, a, b } : crease));
  }
  return [...creases, { id: nextCreaseId(creases), a, b }];
}

/** `floorCreases` with the targets' lists replaced by the source floor's (lists are immutable, so they are shared);
 * a source without creases clears the targets', so a copy never keeps stale creases of the replaced field. */
export function creasesCopiedTo(
  floorCreases: Record<string, Crease[]>,
  sourceFloorId: string,
  targetIds: readonly string[],
): Record<string, Crease[]> {
  const next = { ...floorCreases };
  const source = floorCreases[sourceFloorId];
  for (const id of targetIds) {
    if (source) next[id] = source;
    else delete next[id];
  }
  return next;
}

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n));

/** Parses a project-file crease list; throws with the path of the first violation. */
export function validateCreases(raw: unknown, path: string): Crease[] {
  if (!Array.isArray(raw)) throw new Error(`${path} must be an array`);
  const seen = new Set<number>();
  return raw.map((entry, index) => {
    const where = `${path}[${index}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} must be an object`);
    const { id, a, b } = entry as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) throw new Error(`${where}.id must be a non-negative integer`);
    if (seen.has(id)) throw new Error(`${where}.id ${id} is not unique`);
    seen.add(id);
    if (!isPoint(a)) throw new Error(`${where}.a must be [x, y]`);
    if (!isPoint(b)) throw new Error(`${where}.b must be [x, y]`);
    if (isDegenerateCrease(a, b)) throw new Error(`${where} has equal ends`);
    return { id, a, b };
  });
}
