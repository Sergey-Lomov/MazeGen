import { useEffect } from "react";
import type { FieldConfig } from "../../fieldConfig";
import type { InactiveFoldReason } from "../../wasm/mazeService";
import { faceLabel } from "../../pixi/topologyLabels";
import { useMazeStore } from "../../store/mazeStore";
import { problemSides, type TopologyProblem } from "../../store/topologyProblem";
import { Bubble, BubbleHoverZone, BubbleHoverZones } from "../Bubble";
import { WarningBubble } from "../WarningBubble";
import * as m from "~/paraglide/messages";

export const REASON_LABELS: Record<InactiveFoldReason, () => string> = {
  missing_cell: () => m["topology.inactive.missing_cell"](),
  interior_neighbor: () => m["topology.inactive.interior_neighbor"](),
  duplicate_neighbor: () => m["topology.inactive.duplicate_neighbor"](),
};


/** The translated explanation of a problem. Texts that point at sides end with a colon: the sides
 * follow (as bubbles in `TopologyProblemBubble`, as a list in `problemText`). */
function problemMessage(problem: TopologyProblem): string {
  switch (problem.code) {
    case "empty_run": return m["topology.error.empty_run"]();
    case "run_length_mismatch": return m["topology.error.run_length_mismatch"]({ a: problem.a, b: problem.b });
    case "open_contour": return m["topology.error.open_contour"]();
    case "inactive_fold":
      return problem.existing
        ? m["topology.error.inactive_existing"]({ reason: REASON_LABELS[problem.reason]() })
        : m[`topology.error.inactive_new.${problem.reason}`]();
    case "face_in_use": return m["topology.error.face_in_use"]();
    case "self_glued": return m["topology.error.self_glued"]();
    case "unknown_group": return m["topology.error.unknown_group"]({ id: problem.group + 1 });
    case "inconsistent": return m["topology.error.inconsistent"]({ message: problem.message });
    case "internal": return m["topology.error.internal"]({ message: problem.message });
    case "overlap": return m["topology.error.overlap"]();
    case "used": return m["topology.error.used"]();
  }
}

/** A problem as one line of text (a tooltip): the message followed by the sides it names. */
export function problemText(problem: TopologyProblem, cfg: FieldConfig | undefined): string {
  const sides = cfg ? problemSides(problem).map((end) => faceLabel(end, cfg)) : [];
  return sides.length > 0 ? `${problemMessage(problem)} ${sides.join(", ")}` : problemMessage(problem);
}

/** Red error bubble for a problem: the translated message and, below it, the sides it names as
 * coordinate bubbles (`x:y <side arrow>`, as everywhere in the topology editor). Hovering the
 * bubble flags all its sides red on the canvas, hovering one side bubble flags only that side. */
export function TopologyProblemBubble({ problem, cfg }: { problem: TopologyProblem; cfg: FieldConfig | undefined }) {
  const named = problemSides(problem);
  const setFlagged = useMazeStore((s) => s.setTopologyFlagged);
  useEffect(() => () => setFlagged([]), [setFlagged]);
  return (
    <div onMouseEnter={() => setFlagged(named)} onMouseLeave={() => setFlagged([])}>
      <WarningBubble severity="critical" message={problemMessage(problem)}>
        {cfg && named.length > 0 && (
          <BubbleHoverZones data-testid="topology-problem-sides">
            {named.map((end, i) => (
              <BubbleHoverZone
                key={i}
                onMouseEnter={() => setFlagged([end])}
                onMouseLeave={() => setFlagged(named)}
              >
                <Bubble variant="danger">{faceLabel(end, cfg)}</Bubble>
              </BubbleHoverZone>
            ))}
          </BubbleHoverZones>
        )}
      </WarningBubble>
    </div>
  );
}
