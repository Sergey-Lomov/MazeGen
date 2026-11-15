import type { MazeState } from "../../store/storeTypes";
import type { ParamActivityContext } from "../../store/parameterLinksActivity";
import type { EdgeDto } from "../../wasm/types";
import { maxSplitNodeCount } from "./mazeSelectors";
import { hasCrossFloorTeleport } from "./mazeSelectors/teleport";

// The maze-derived gates the parameter link schema's activity rules read (GitHub issues #965, #1012): which
// elements the project's maze has. Shared by everything that asks "is this setting's element drawn" over the
// whole project: the color field registry (`colorFieldRegistry.ts`) and the label font sync (`labelFontSync.ts`).

/** Project-wide maze input: the unscoped maze graph. */
export interface ProjectMaze {
  nodes: MazeState["nodes"];
  edges: EdgeDto[];
  floors: MazeState["floors"];
  /** Whether some floor has a glue (GitHub issue #901); the glue tab fields are hidden without one. Unknown counts as yes. */
  hasGlues?: boolean;
}

function hasDirectionalBasicEdge(edges: EdgeDto[]): boolean {
  const basic = edges.filter((e) => e.kind === "basic");
  const forward = new Set(basic.map((e) => `${e.from}->${e.to}`));
  return basic.some((e) => !forward.has(`${e.to}->${e.from}`));
}

function verticalVisibility(edges: EdgeDto[], replaceTwoFloorElevatorsWithStairs: boolean) {
  const passageEdges = edges.filter((e) => e.kind === "vertical_passage");
  const forward = new Set(passageEdges.map((e) => `${e.from}->${e.to}`));
  const oneWayPassages = passageEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
  const elevators = edges.some((e) => e.kind === "elevator");
  const twoWayPassages =
    passageEdges.some((e) => forward.has(`${e.to}->${e.from}`)) ||
    (replaceTwoFloorElevatorsWithStairs && elevators);
  return { twoWayPassages, oneWayPassages, elevators };
}

export function memoized<T>(compute: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}

/** The maze-derived gates the parameter link schema's rules read, over the whole project (GitHub issues #965, #1012).
 *  Every flag is a getter computed on access (maze scans memoized). Only the flags a project-wide question can
 *  answer are available; the floor-scoped ones throw instead of answering from the wrong scope. */
export function buildProjectActivity(maze: ProjectMaze, replaceTwoFloorElevatorsWithStairs: boolean): ParamActivityContext {
  const vertical = memoized(() => verticalVisibility(maze.edges, replaceTwoFloorElevatorsWithStairs));
  const teleports = memoized(() => maze.edges.some((e) => e.kind === "teleport"));
  const markerIndexAvailable = memoized(() => teleports() || vertical().elevators || maze.edges.some((e) => e.kind === "vertical_passage"));
  const slotCount = memoized(() => maxSplitNodeCount(maze.nodes));
  const oneWayIndicator = memoized(() => hasDirectionalBasicEdge(maze.edges));
  const crossFloorTeleports = memoized(() => hasCrossFloorTeleport(maze.nodes, maze.edges));
  const unavailable = (flag: string) => () => { throw new Error(`Schema rule reads "${flag}", which a project-wide visibility cannot answer`); };
  return {
    get hasOneWays() { return oneWayIndicator(); },
    get hasTeleports() { return teleports(); },
    get hasCrossFloorTeleports() { return crossFloorTeleports(); },
    get hasTwoWayPassages() { return vertical().twoWayPassages; },
    get hasOneWayPassages() { return vertical().oneWayPassages; },
    get hasElevators() { return vertical().elevators; },
    get hasVerticalSection() { const v = vertical(); return v.twoWayPassages || v.oneWayPassages || v.elevators; },
    get hasMarkerIndexSource() { return markerIndexAvailable(); },
    get hasMultipleFloors() { return maze.floors.length > 1; },
    get hasSplits() { return slotCount() > 0; },
    get hasGlues() { return maze.hasGlues ?? true; },
    get hasAreaSpread(): boolean { return unavailable("hasAreaSpread")(); },
    get hasSeams(): boolean { return unavailable("hasSeams")(); },
    get hasCreases(): boolean { return unavailable("hasCreases")(); },
  };
}
