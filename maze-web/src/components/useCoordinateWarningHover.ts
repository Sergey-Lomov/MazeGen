import { useCallback, useEffect, useRef } from "react";
import type { PresetEndpoint } from "../domain/presetEndpoint";
import { uniqueCoordinateTargets, type CoordinateGroup, type CoordinateWarning } from "../domain/coordinateWarning";
import { useMazeStore } from "../store/mazeStore";

export interface CoordinateWarningHover {
  /** Hover of the whole warning: all its targets light up. */
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Hover of one target (a coordinate bubble): only that cell lights up (as a single cell); leaving it falls back to the whole warning. */
  onTargetEnter: (target: PresetEndpoint) => void;
  onTargetLeave: () => void;
}

/** The hover state of one coordinate warning: the handlers a panel puts on the warning's bubble and on its coordinate
 *  bubbles. Everything else (which cells, which color, which floor) is drawn by `CoordinateWarningHighlight` from the
 *  warning's `severity`, `targets` and `groups`. A warning that unmounts while hovered takes its highlight with it. */
export function useCoordinateWarningHover(warning: CoordinateWarning): CoordinateWarningHover {
  const setHovered = useMazeStore((s) => s.setHoveredCoordinateWarning);
  const hovering = useRef(false);
  const { severity, targets, groups } = warning;

  const show = useCallback((shown: PresetEndpoint[], shownGroups?: CoordinateGroup[]) => {
    hovering.current = true;
    setHovered({ severity, targets: shown, groups: shownGroups });
  }, [setHovered, severity]);
  const hide = useCallback(() => {
    hovering.current = false;
    setHovered(null);
  }, [setHovered]);

  useEffect(() => () => {
    if (hovering.current) setHovered(null);
  }, [setHovered]);

  return {
    onMouseEnter: () => show(uniqueCoordinateTargets(targets), groups),
    onMouseLeave: hide,
    onTargetEnter: (target) => show([target]),
    onTargetLeave: () => show(uniqueCoordinateTargets(targets), groups),
  };
}
