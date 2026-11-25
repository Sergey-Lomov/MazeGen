import { useMazeStore } from "../../store/mazeStore";
import { nodeShapesOf } from "../../domain/shapeTemplates";
import { registerNodeShapeSiblingsSource } from "./nodeShapeSiblings";

export { nodeShapesOf };

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
