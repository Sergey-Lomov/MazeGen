import type { WireFoldEnd } from "../../wasm/types";
import type { MazeState } from "../../store/storeTypes";
import { floorTopologyInfo, selectionRun } from "../../store/topologyInfo";
import { canvas } from "../colorTokens";
import type { TopologyBand } from "../renderers/TopologyBandRenderer";
import { mergedFacePolylines } from "../topologyGeometry";

/// The bands the topology editor highlights on the field boundary (GitHub issue #839), bottom to top: the face
/// under the pointer while a run is drawn, the runs being picked, the sides hovered in the glue editor and, last
/// so it reads red over the run it belongs to, the flagged sides. A glue or pair hovered in the topology panel is
/// shown by the seam arrows instead. Everything is read from the store and core's contours; nothing is derived
/// from coordinates.
export function selectTopologyBands(state: MazeState): TopologyBand[] {
  const floor = state.activeFloorId;
  const field = state.floorFields[floor];
  const result = floorTopologyInfo(state, floor);
  if (!result.ok || !field) return [];
  const cfg = field.fieldConfig;
  const { info } = result;
  const bands: TopologyBand[] = [];
  const add = (ends: readonly WireFoldEnd[], color: number) => {
    for (const polyline of mergedFacePolylines(ends, info.contours, cfg)) bands.push({ polyline, color });
  };

  const faceHover = state.topologyFaceHover;
  if (faceHover !== null && state.topologyPick !== null) {
    const face = info.contours[faceHover.contour]?.[faceHover.face];
    if (face) add([face], state.topologyPick === "a" ? canvas.topology.runA : canvas.topology.runB);
  }
  // A hovered side stands alone: the highlight of the whole runs is hidden meanwhile.
  const sideHover = state.topologySideHover;
  if (sideHover === null) {
    for (const [selection, color] of [[state.topologyRunA, canvas.topology.runA], [state.topologyRunB, canvas.topology.runB]] as const) {
      const run = selectionRun(selection, info.contours);
      if (run) add(run, color);
    }
  } else {
    add(sideHover.a, canvas.topology.runA);
    add(sideHover.b, canvas.topology.runB);
  }
  if (state.topologyFlagged.length > 0) add(state.topologyFlagged, canvas.topology.flagged);
  return bands;
}
