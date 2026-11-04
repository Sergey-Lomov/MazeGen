import type { MazeState } from "../../store/storeTypes";
import { buildMazeWalls, selectFloorScopedMaze } from "./mazeSelectors";
import { getSeamModel } from "./seams";
import { mergedFacePolylines } from "../topologyGeometry";
import { configAllCells } from "../tessellationCells";
import { getNeighborData } from "../tessellationGeometry";

/// The part of the maze state required to identify glued edge runs that are physically
/// interchangeable in the exported net. It deliberately has no warning or marker-style fields.
export type AmbiguousGlueSectionState = Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "nodes" | "edges" | "floors">;

/** One visible side of a glue whose wall/passage pattern is ambiguous with another glue. */
export interface AmbiguousGlueSection {
  /** Glue id, suitable for addressing its alignment marker (`g<group>`). */
  group: number;
  /** Which stored run of the glue this section is. */
  side: "a" | "b";
  /** Folds making up this run, in topology order. */
  folds: readonly number[];
  /** Display-space boundary bands of the run, for consumers that highlight it. */
  bands: [number, number][][];
}

/** Internal comparison data; callers only receive the reusable section identity and geometry. */
interface CandidateGlueSection extends AmbiguousGlueSection {
  signature: string;
  components: ReadonlySet<number>;
}

/// Components of the physical net: ordinary cell neighbours connect it, while glued faces do not.
/// Maze passages/walls deliberately play no part in this topology-only calculation.
function fieldComponents(state: AmbiguousGlueSectionState): Map<string, number> {
  const cells = configAllCells(state.activeFieldConfig);
  const byKey = new Set(cells.map(([x, y]) => `${x},${y}`));
  const components = new Map<string, number>();
  const seams = getSeamModel(state.activeFieldConfig);
  let component = 0;
  for (const cell of cells) {
    const key = `${cell[0]},${cell[1]}`;
    if (components.has(key)) continue;
    components.set(key, component);
    const pending = [cell];
    while (pending.length > 0) {
      const [x, y] = pending.pop()!;
      for (const [face, [dx, dy]] of getNeighborData(state.activeFieldConfig, x, y).offsets.entries()) {
        if ((dx === 0 && dy === 0) || seams.halfEdgeAt([x, y], face)) continue;
        const neighbor: [number, number] = [x + dx, y + dy];
        const neighborKey = `${neighbor[0]},${neighbor[1]}`;
        if (!byKey.has(neighborKey) || components.has(neighborKey)) continue;
        components.set(neighborKey, component);
        pending.push(neighbor);
      }
    }
    component++;
  }
  return components;
}

/**
 * Finds glue runs that can be confused during physical assembly: they have identical visible
 * wall/passage patterns but belong to separate connected pieces of the unglued field.
 *
 * This selector is independent of presentation. Export warnings can highlight its `bands`, while
 * alignment-marker modes can use `group` and `side` to decide which marks to render.
 */
export function selectAmbiguousGlueSections(state: AmbiguousGlueSectionState): AmbiguousGlueSection[] {
  const topology = state.floorTopology[state.activeFloorId];
  if (!topology || topology.groups.length < 2 || getSeamModel(state.activeFieldConfig).isEmpty) return [];
  const floorMaze = selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId);
  const wallKindByFace = new Map(buildMazeWalls(floorMaze.nodes, floorMaze.edges, state.activeFieldConfig)
    .filter((edge) => edge.face !== undefined)
    .map((edge) => [`${edge.a[0]},${edge.a[1]}#${edge.face}`, edge.kind]));
  const componentByCell = fieldComponents(state);

  const sections: CandidateGlueSection[] = [];
  for (const group of topology.groups) {
    for (const side of ["a", "b"] as const) {
      const ends = group.folds.flatMap((foldIndex) => {
        const fold = topology.folds[foldIndex];
        return fold ? [fold[side]] : [];
      });
      const bands = mergedFacePolylines(ends, [], state.activeFieldConfig);
      // No wall edge means an open two-way passage. The one-way direction is part of the visible
      // pattern (`forward` leaves this cell; `backward` enters it), and a reversed run is the same
      // physical edge pattern when its pieces are assembled in the opposite direction.
      const pattern = ends.map((end) => wallKindByFace.get(`${end.cell[0]},${end.cell[1]}#${end.face_idx}`) ?? "both");
      const signature = [pattern.join("|"), [...pattern].reverse().join("|")].sort()[0];
      const components = new Set(ends.flatMap((end) => {
        const component = componentByCell.get(`${end.cell[0]},${end.cell[1]}`);
        return component === undefined ? [] : [component];
      }));
      if (signature && components.size > 0) sections.push({ group: group.id, side, folds: group.folds, bands, signature, components });
    }
  }

  const ambiguous = new Set<AmbiguousGlueSection>();
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const shareComponent = [...sections[i].components].some((component) => sections[j].components.has(component));
      if (sections[i].group !== sections[j].group && !shareComponent && sections[i].signature === sections[j].signature) {
        ambiguous.add(sections[i]);
        ambiguous.add(sections[j]);
      }
    }
  }
  return sections.filter((section) => ambiguous.has(section));
}
