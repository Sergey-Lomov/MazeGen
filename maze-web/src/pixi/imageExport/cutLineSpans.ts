import type { useMazeStore } from "../../store/mazeStore";
import { selectFloorScopedMaze } from "../selectors/mazeSelectors";
import { lineSpans, sideSpans, type Vec2 } from "./cutLines";
import { tilePolygons, type CutLineHandle } from "./exportContent";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** The active floor's cells, where a cut line has image to cut; recomputed when the floor's cells change. */
let tiles: Vec2[][] = [];
let tilesInputs: unknown[] = [];
/** Where each glue's line runs over the tiles, for the line as last asked: a dragged line replaces its entry rather
 *  than adding one per pointer position. Dropped with the tiles. */
const spansByGroup = new Map<number, { key: string; spans: [Vec2, Vec2][] }>();

function tilesOf(st: MazeState): Vec2[][] {
  const inputs = [st.nodes, st.floors, st.activeFloorId, st.activeFieldConfig];
  if (inputs.some((value, i) => value !== tilesInputs[i])) {
    tilesInputs = inputs;
    spansByGroup.clear();
    tiles = tilePolygons(selectFloorScopedMaze(st.nodes, [], st.floors, st.activeFloorId).nodes, st.activeFieldConfig);
  }
  return tiles;
}

/** The stretch of a cut line that is drawn and can be grabbed, on each of its two sides (the line, and its twin one
 *  period over where the cut halves land): one unbroken line across the cells. */
export function drawnSideSpans(st: MazeState, handle: CutLineHandle): [[Vec2, Vec2][], [Vec2, Vec2][]] {
  const { point, cut } = handle.line;
  const key = `${point[0]}|${point[1]}|${cut.direction[0]}|${cut.direction[1]}`;
  // First: new tiles drop every cached entry, so a stale one is never read back.
  const floorTiles = tilesOf(st);
  let entry = spansByGroup.get(handle.group);
  if (entry?.key !== key) {
    entry = { key, spans: lineSpans(floorTiles, point, cut.direction) };
    spansByGroup.set(handle.group, entry);
  }
  return [sideSpans(entry.spans, cut.period, 0), sideSpans(entry.spans, cut.period, 1)];
}
