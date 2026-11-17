import type { MazeState } from "../../store/storeTypes";
import { canvas } from "../colorTokens";
import { creaseDisplayPoint } from "../creaseGeometry";
import type { CreaseLine } from "../renderers/CreaseRenderer";

/// The crease lines the topology editor draws on the active floor (GitHub issue #898), in display space: every
/// crease (the one hovered in the panel lighter and thicker, the one being redrawn hidden) and the segment being drawn, whose
/// free end follows the pointer. Everything is read from the store; the ends are stored in world units.
export function selectCreaseLines(state: MazeState): CreaseLine[] {
  const floor = state.activeFloorId;
  const field = state.floorFields[floor];
  if (!field) return [];
  const cfg = field.fieldConfig;
  const draft = state.creaseDraft;
  const lines: CreaseLine[] = [];
  for (const crease of state.floorCreases[floor] ?? []) {
    if (draft !== null && draft.replace === crease.id) continue;
    const hovered = state.creaseHover === crease.id;
    lines.push({
      from: creaseDisplayPoint(crease.a, cfg),
      to: creaseDisplayPoint(crease.b, cfg),
      color: hovered ? canvas.topology.creaseHover : canvas.topology.crease,
      emphasized: hovered,
    });
  }
  if (draft !== null) {
    const start = draft.a ?? draft.cursor;
    const end = draft.a !== null ? draft.cursor : null;
    if (start !== null) {
      const from = creaseDisplayPoint(start, cfg);
      lines.push({ from, to: end !== null ? creaseDisplayPoint(end, cfg) : from, color: canvas.topology.crease, preview: true });
    }
  }
  return lines;
}
