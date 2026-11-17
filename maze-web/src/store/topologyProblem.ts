import type { TopologyErrorDto } from "../wasm/mazeService";
import type { WireFoldEnd } from "../wasm/types";

/// Why a topology edit cannot be done: core's refusals (`TopologyErrorDto`) plus the two
/// checks the add-glue panel makes itself before asking core (GitHub issue #839). Every problem
/// that concerns particular sides carries them, so the UI can name them.
export type TopologyProblem =
  | TopologyErrorDto
  | { code: "overlap"; sides: WireFoldEnd[] }
  | { code: "used"; sides: WireFoldEnd[] };

/// The sides a problem points at, in the order it names them.
export function problemSides(problem: TopologyProblem): WireFoldEnd[] {
  switch (problem.code) {
    case "self_glued":
      return [problem.a, problem.b];
    case "inactive_fold":
      return [problem.a, problem.b, ...(problem.connections ?? []).flat()];
    case "open_contour":
    case "face_in_use":
      return [problem.face];
    case "overlap":
    case "used":
      return problem.sides;
    default:
      return [];
  }
}
