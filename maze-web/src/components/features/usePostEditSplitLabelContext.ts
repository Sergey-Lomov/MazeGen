import { useMemo } from "react";
import type { NodeDto } from "../../wasm/types";
import { useMazeStore } from "../../store/mazeStore";
import { buildNodeByIdMap } from "../../pixi/postEditCommandLabels";
import type { SplitLabelContext } from "../../pixi/postEditSplitLabels";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";

/** Everything needed to label an entity endpoint with the post-edit bubble format
 *  (`endpointBubble`): the node lookup, whether the project has several floors, and the
 *  `SplitLabelContext` that resolves a split tile's node to its semantic/short-name suffix.
 *  Shared by the post-edit "Changes" panel and the Teleports section's group list so both resolve
 *  split nodes identically.
 *
 *  Each floor's own `fieldConfig` (GitHub issue #611's bug class) — a single list entry's
 *  bubbles can span several floors, each potentially needing a different floor's own field shape,
 *  not one maze-wide snapshot. */
export function usePostEditSplitLabelContext(): {
  nodeById: Map<number, NodeDto>;
  multiFloor: boolean;
  splitCtx: SplitLabelContext;
} {
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const activeSplitNode = useMazeStore((s) => s.postEditActiveSplitNode);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const floorFields = useMazeStore((s) => s.floorFields);
  const nodeById = useMemo(() => buildNodeByIdMap(nodes), [nodes]);
  const multiFloor = floors.length > 1;
  const cfgByLevel = useMemo(() => {
    return (level: number | undefined) => {
      const index = level ?? 0;
      const floor = floors[index];
      return floor ? floorFields[floor.id].fieldConfig : floorFields[floors[0].id].fieldConfig;
    };
  }, [floors, floorFields]);
  const inFieldCellsByLevel = useMemo(() => {
    const cache = new Map<number, ReadonlySet<string>>();
    return (level: number | undefined) => {
      const index = level ?? 0;
      const cached = cache.get(index);
      if (cached) return cached;
      const floor = floors[index];
      const field = floor ? floorFields[floor.id] : undefined;
      const cells = field ? buildCellSet(buildActiveCells(field.fieldPoints, field.fieldEditMode, field.fieldConfig)) : new Set<string>();
      cache.set(index, cells);
      return cells;
    };
  }, [floors, floorFields]);
  const splitCtx: SplitLabelContext = useMemo(
    () => ({ allNodes: nodes, splitPoints, activeSplitNode, draftEdges, cfgAt: cfgByLevel, inFieldCellsAt: inFieldCellsByLevel }),
    [nodes, splitPoints, activeSplitNode, draftEdges, cfgByLevel, inFieldCellsByLevel],
  );
  return { nodeById, multiFloor, splitCtx };
}
