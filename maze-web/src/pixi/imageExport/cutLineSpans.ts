import type { useMazeStore } from "../../store/mazeStore";
import { cutLineSides, lineSpans, sheetSpan, sideSpans, type Vec2 } from "./cutLines";
import { activeFloorNodes, fieldGeometry, type CutLineHandle } from "./exportContent";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** Where each glue's line runs over the tiles, for the line as last asked: a dragged line replaces its entry rather
 *  than adding one per pointer position. Dropped with the tiles. */
const spansByGroup = new Map<number, { key: string; spans: [Vec2, Vec2][] }>();
let spansTiles: Vec2[][] | null = null;

/** The stretch of a cut line that is drawn and can be grabbed, on each of its two sides (the line, and its twin one
 *  period over where the cut halves land): one unbroken line across the cells, or the sheet's edge when `all` holds another cut. */
export function drawnSideSpans(st: MazeState, handle: CutLineHandle, all: readonly CutLineHandle[]): [[Vec2, Vec2][], [Vec2, Vec2][]] {
  const { point, cut } = handle.line;
  const key = `${point[0]}|${point[1]}|${cut.direction[0]}|${cut.direction[1]}`;
  // First: new tiles drop every cached entry, so a stale one is never read back.
  const floorTiles = fieldGeometry(activeFloorNodes(st), st.activeFieldConfig).tiles;
  if (floorTiles !== spansTiles) {
    spansTiles = floorTiles;
    spansByGroup.clear();
  }
  let entry = spansByGroup.get(handle.group);
  if (entry?.key !== key) {
    entry = { key, spans: lineSpans(floorTiles, point, cut.direction) };
    spansByGroup.set(handle.group, entry);
  }
  // With another cut the sheet is a parallelogram: the line runs from that line to its twin, as the plan's guides do.
  const others = all.filter((other) => other !== handle).map((other) => other.line);
  const side = (n: 0 | 1): [Vec2, Vec2][] => {
    const sheet = entry.spans.length > 0 ? sheetSpan({ point: cutLineSides(handle.line)[n], cut }, others) : null;
    return sheet ? [sheet] : sideSpans(entry.spans, cut.period, n);
  };
  return [side(0), side(1)];
}
