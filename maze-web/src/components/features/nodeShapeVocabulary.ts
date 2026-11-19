import type { TessellationConfig } from "../../fieldConfig";
import { useMazeStore } from "../../store/mazeStore";
import { getTessellationNodeShapes, type CellTypeShapes } from "../../wasm/mazeService";
import { registerNodeShapeSiblingsSource } from "./nodeShapeSiblings";

const vocabularyCache = new Map<string, CellTypeShapes[]>();

/** Node shapes per cell type of `tessellation`, asked from core once per config (a config fully
 *  identifies the built instance, same key `tessellationTraitsOf` uses). */
export function nodeShapesOf(tessellation: TessellationConfig): CellTypeShapes[] {
  const key = JSON.stringify(tessellation);
  let shapes = vocabularyCache.get(key);
  if (shapes === undefined) {
    shapes = getTessellationNodeShapes(tessellation);
    vocabularyCache.set(key, shapes);
  }
  return shapes;
}

/** Every shape key of `cellType` on the maze's applied tessellation. Issues are dropped when the
 *  tessellation changes, so the applied one is the one they were found on. `undefined` when core
 *  cannot tell. */
export function appliedNodeShapesOf(cellType: string): readonly string[] | undefined {
  const { tessellationKind: kind, tessellationParams: params } = useMazeStore.getState();
  try {
    return nodeShapesOf({ kind, params }).find((t) => t.cellType === cellType)?.shapes;
  } catch (error) {
    console.error("Node shapes unavailable", error);
    return undefined;
  }
}

registerNodeShapeSiblingsSource(appliedNodeShapesOf);
