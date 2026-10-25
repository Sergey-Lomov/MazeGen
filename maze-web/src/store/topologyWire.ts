import type { WireTopology, WireFold, WireFoldEnd, WireFoldGroup } from "../wasm/types";

/** Canonical rendering of a tessellation config (GitHub issue #836, `Specs/topology.md`, "Wire
 * form"): the kind name followed by the params as JSON with sorted keys, e.g. `square{}`. Must stay
 * byte-identical to Rust's `tessellation_fingerprint` (`maze-runner/src/topology_wire.rs`). */
export function tessellationFingerprint(kind: string, params: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) sorted[key] = params[key];
  return `${kind}${JSON.stringify(sorted)}`;
}

function object(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`Expected object at ${path}`);
  return v as Record<string, unknown>;
}

function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`Expected array at ${path}`);
  return v;
}

function integer(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min)
    throw new Error(`Expected integer >= ${min} at ${path}, got ${JSON.stringify(v)}`);
  return v;
}

const MIN_COORD = -2147483648;

function foldEnd(v: unknown, path: string): WireFoldEnd {
  const obj = object(v, path);
  const cell = array(obj.cell, `${path}.cell`);
  if (cell.length !== 2) throw new Error(`Expected a [x, y] point at ${path}.cell`);
  return {
    cell: [integer(cell[0], `${path}.cell[0]`, MIN_COORD), integer(cell[1], `${path}.cell[1]`, MIN_COORD)],
    face_idx: integer(obj.face_idx, `${path}.face_idx`, 0),
  };
}

/** Structural validation of one floor's topology at the file boundary (GitHub issue #836): shape,
 * the fingerprint against the current tessellation config, no face in two folds or glued to itself,
 * every fold in exactly one existing group. Cell validity and face ranges depend on the tessellation
 * and are checked by core when the topology is installed on a field. */
export function validateWireTopology(v: unknown, path: string, expectedFingerprint: string): WireTopology {
  const obj = object(v, path);
  const fingerprint = obj.fingerprint;
  if (typeof fingerprint !== "string") throw new Error(`Expected string at ${path}.fingerprint`);
  if (fingerprint !== expectedFingerprint)
    throw new Error(`${path}: topology was authored for tessellation \`${fingerprint}\`, current is \`${expectedFingerprint}\``);

  const folds: WireFold[] = array(obj.folds ?? [], `${path}.folds`).map((raw, i) => {
    const fold = object(raw, `${path}.folds[${i}]`);
    if (fold.twist !== undefined && typeof fold.twist !== "boolean") throw new Error(`Expected boolean at ${path}.folds[${i}].twist`);
    return {
      a: foldEnd(fold.a, `${path}.folds[${i}].a`),
      b: foldEnd(fold.b, `${path}.folds[${i}].b`),
      twist: fold.twist === true,
      group: integer(fold.group, `${path}.folds[${i}].group`, 0),
    };
  });
  const groups: WireFoldGroup[] = array(obj.groups ?? [], `${path}.groups`).map((raw, i) => {
    const group = object(raw, `${path}.groups[${i}]`);
    return {
      id: integer(group.id, `${path}.groups[${i}].id`, 0),
      folds: array(group.folds, `${path}.groups[${i}].folds`).map((fold, j) => integer(fold, `${path}.groups[${i}].folds[${j}]`, 0)),
    };
  });

  const faces = new Map<string, number>();
  folds.forEach((fold, i) => {
    if (fold.a.cell[0] === fold.b.cell[0] && fold.a.cell[1] === fold.b.cell[1] && fold.a.face_idx === fold.b.face_idx)
      throw new Error(`${path}.folds[${i}]: face is glued to itself`);
    for (const end of [fold.a, fold.b]) {
      const key = `${end.cell[0]},${end.cell[1]}#${end.face_idx}`;
      const other = faces.get(key);
      if (other !== undefined)
        throw new Error(`${path}.folds[${i}]: face ${end.face_idx} of cell [${end.cell[0]}, ${end.cell[1]}] also belongs to fold ${other}`);
      faces.set(key, i);
    }
  });
  const groupIds = new Set<number>();
  const owner = new Map<number, number>();
  for (const group of groups) {
    if (groupIds.has(group.id)) throw new Error(`${path}: group ${group.id} is declared twice`);
    groupIds.add(group.id);
    for (const fold of group.folds) {
      if (fold >= folds.length) throw new Error(`${path}: group ${group.id} lists unknown fold ${fold}`);
      const other = owner.get(fold);
      if (other !== undefined) throw new Error(`${path}.folds[${fold}]: listed by both group ${other} and group ${group.id}`);
      owner.set(fold, group.id);
    }
  }
  folds.forEach((fold, i) => {
    if (!groupIds.has(fold.group)) throw new Error(`${path}.folds[${i}]: group ${fold.group} does not exist`);
    if (owner.get(i) !== fold.group) throw new Error(`${path}.folds[${i}]: group ${fold.group} does not list the fold`);
  });
  return { fingerprint, folds, groups };
}

/** The `topology` key of a wasm config: one entry per floor in `floors` order, `null` for a floor
 * without folds. `undefined` when no floor has any, so the key is omitted from the payload. */
export function floorTopologyPayload(
  floors: { id: string }[],
  floorTopology: Record<string, WireTopology>,
): (WireTopology | null)[] | undefined {
  const entries = floors.map((floor) => floorTopology[floor.id] ?? null);
  return entries.some((entry) => entry !== null) ? entries : undefined;
}

/** Spreadable `{ topology }` fragment of a wasm config; empty when no floor has folds. */
export function topologyKey(state: {
  floors: { id: string }[];
  floorTopology: Record<string, WireTopology>;
}): { topology?: (WireTopology | null)[] } {
  const topology = floorTopologyPayload(state.floors, state.floorTopology);
  return topology === undefined ? {} : { topology };
}
