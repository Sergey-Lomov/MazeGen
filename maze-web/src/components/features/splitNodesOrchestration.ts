import { useMemo } from "react";
import { blueprintsFor } from "../../pixi/splitBlueprints";
import { splitShapeBinding } from "../../pixi/splitShape";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import type { TileFace, TileFaceNode } from "./TileFaceEditor";
import type { ElementInfo, LinkInfo, SplitNodesRow } from "./SplitNodesDialogView";

export interface SplitNodesOrchestrationArgs<E> {
  point: [number, number];
  cfg: Parameters<typeof getNeighborData>[0];
  slots: number[];
  originalEndpoint: E | null;
  endpointForSlot: (slotId: number) => E;
  endpointKey: (endpoint: E) => string;
  activeEndpoint: E | null;
  semanticNames?: Array<{ full: string }> | null;
  fallbackTitle?: (rowIndex: number) => string;
  lockKindFor?: (endpoint: E) => SplitNodesRow<E>["lockKind"];
  describeEndpoint: (endpoint: E) => string;
  linksFor: (endpoint: E) => LinkInfo<E>[];
  elementsFor: (endpoint: E) => ElementInfo<E>[];
  facesOf: (endpoint: E) => TileFace[];
}

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function splitPointKey(point: [number, number], level: number | undefined): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

export function useSplitDialogFieldCells(
  fieldPoints: Parameters<typeof buildActiveCells>[0],
  fieldEditMode: Parameters<typeof buildActiveCells>[1],
  cfg: Parameters<typeof buildActiveCells>[2],
) {
  return useMemo(
    () => buildCellSet(buildActiveCells(fieldPoints, fieldEditMode, cfg)),
    [fieldPoints, fieldEditMode, cfg],
  );
}

export function resolveActiveSplitEndpoint<E>(activeSplitNode: Record<string, E>, key: string, originalEndpoint: E): E {
  return activeSplitNode[key] ?? originalEndpoint;
}

/** Shared split-node orchestration. Feature dialogs provide only endpoint/domain adapters; this
 * hook owns stable slot ordering, row construction, palette/semantic labels, tile nodes, and the
 * blueprint list handed to `SplitNodesDialogView`. */
export function useSplitNodesDialogOrchestration<E>({
  point, cfg, slots, originalEndpoint, endpointForSlot, endpointKey, activeEndpoint, semanticNames, fallbackTitle, lockKindFor,
  describeEndpoint, linksFor, elementsFor, facesOf,
}: SplitNodesOrchestrationArgs<E>) {
  const rows = useMemo(() => {
    const endpoints = [
      ...(originalEndpoint === null ? [] : [originalEndpoint]),
      ...slots.map(endpointForSlot),
    ];
    return endpoints.map((endpoint, index): SplitNodesRow<E> => ({
      key: endpointKey(endpoint),
      endpoint,
      title: semanticNames?.[index]?.full ?? fallbackTitle?.(index) ?? (index === 0 && originalEndpoint !== null ? "Node 1" : `Node ${index + 1}`),
      color: colorToCss(splitSlotColor(index, canvas.node.splitSlots)),
      removable: index >= (originalEndpoint === null ? 0 : 1),
      active: activeEndpoint !== null && endpointKey(activeEndpoint) === endpointKey(endpoint),
      ownLabel: describeEndpoint(endpoint),
      links: linksFor(endpoint),
      elements: elementsFor(endpoint),
      lockKind: lockKindFor?.(endpoint),
    }));
  }, [activeEndpoint, describeEndpoint, elementsFor, endpointForSlot, endpointKey, fallbackTitle, facesOf, linksFor, lockKindFor, originalEndpoint, semanticNames, slots]);

  const tileNodes = useMemo<TileFaceNode[]>(
    () => rows.map((row) => ({ color: row.color, faces: facesOf(row.endpoint) })),
    [facesOf, rows],
  );

  const blueprints = useMemo(
    () => blueprintsFor(
      splitShapeBinding(cfg, point[0], point[1])?.shape ?? null,
      getNeighborData(cfg, point[0], point[1]).offsets.length,
    ),
    [cfg, point],
  );

  return { rows, tileNodes, blueprints };
}
