import type { Container } from "pixi.js";
import type { MazeStore } from "../store/storeTypes";
import { useMazeStore } from "../store/mazeStore";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { watchStoreInputs } from "./storeWatch";
import { canvas } from "../domain/colorTokens";
import { presetEndpointKey, type PresetEndpoint } from "../domain/presetEndpoint";
import type { NodeDto } from "../wasm/types";
import { WALL_THICKNESS } from "../domain/renderConstants";

/// What the highlight is drawn from: it redraws only when one of these changes.
function highlightInputs(st: MazeStore): readonly unknown[] {
  return [st.hoveredCoordinateWarning, st.floors, st.activeFloorId, st.activeFieldConfig, st.openCard];
}

/// Draws the hovered coordinate warning (`CoordinateWarning`, set by `useCoordinateWarningHover`) on the active floor, in
/// the color of the warning's severity: groups as merged contours, every other target as a single cell. Targets on other
/// floors are not drawn: their floor badges are the way to reach them. The drawing logic every coordinate warning shares;
/// each feature-renderer owns an instance of its own in its own layers (never shares one) and says when it is `isActive`
/// (usually "its card is open"), so a warning is highlighted only in the panel that shows it.
export class CoordinateWarningHighlight {
  private readonly cells: RegionHighlightRenderer;
  private readonly unsubscribe: () => void;

  constructor(container: Container, private readonly isActive: (state: MazeStore) => boolean) {
    this.cells = new RegionHighlightRenderer(container);
    this.unsubscribe = watchStoreInputs(highlightInputs, () => this.redraw());
  }

  private redraw(): void {
    const st = useMazeStore.getState();
    const warning = st.hoveredCoordinateWarning;
    if (!warning || !this.isActive(st)) {
      this.cells.clear();
      return;
    }
    const activeLevel = Math.max(0, st.floors.findIndex((floor) => floor.id === st.activeFloorId));
    const onFloor = (target: PresetEndpoint) => (target.level ?? 0) === activeLevel;
    const groups = warning.groups ?? [];
    const grouped = new Set(groups.flatMap((group) => group.targets.map(presetEndpointKey)));
    // A contour is built from node-like cells: one pseudo node per target, ids local to this draw.
    const nodes: NodeDto[] = [];
    const contourGroups = groups.map((group) => ({
      outset: group.outset,
      ids: group.targets.filter(onFloor).map((target) => {
        const id = nodes.length;
        nodes.push({ id, x: target.point[0], y: target.point[1], i: 0, level: activeLevel });
        return id;
      }),
    })).filter((group) => group.ids.length > 0);
    const color = canvas.coordinateWarning[warning.severity];
    this.cells.render({
      nodes, regionGroups: [],
      cells: warning.targets.filter((target) => onFloor(target) && !grouped.has(presetEndpointKey(target))).map((target) => target.point),
      color, width: WALL_THICKNESS * 2, alpha: 1, cfg: st.activeFieldConfig, skipPerimeter: true,
      groups: [
        { regionGroups: contourGroups.filter((group) => !group.outset).map((group) => group.ids), color, insetMode: "inset" },
        { regionGroups: contourGroups.filter((group) => group.outset).map((group) => group.ids), color, insetMode: "outset" },
      ],
    });
  }

  destroy(): void {
    this.unsubscribe();
    this.cells.destroy();
  }
}
