import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ElevatorFloorPicker, type ElevatorFloorRow, type ElevatorFloorStatus } from "./ElevatorFloorPicker";
import { cellExistsAt } from "../../pixi/fieldEditUtils";
import { resolveFieldAtOf } from "../../store/storeHelpers";
import { detectSplitSpecialShapeKind } from "../../pixi/splitFaceLayout";
import { splitShapeBinding } from "../../pixi/splitShape";
import { splitPointShapeName } from "../../pixi/splitNodeNames";
import { buildSplitFloorGeometry } from "../../pixi/splitFloorPreview";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}


/** Multi-floor picker for an in-progress post-edit elevator placement (GitHub issue #341) —
 * mirrors `PresetElevatorFloorDialog`, addressed by the clicked node's own `(x, y)` point instead
 * of a `PresetEndpoint`'s cell. */
export function PostEditElevatorFloorDialog({ onClose }: Props) {
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const tessellationParams = useMazeStore((s) => s.tessellationParams);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const nodes = useMazeStore((s) => s.nodes);
  const pending = useMazeStore((s) => s.postEditElevatorPending);
  const toggleFloor = useMazeStore((s) => s.togglePostEditElevatorFloor);
  const confirm = useMazeStore((s) => s.confirmPostEditElevatorPlacement);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const draftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);

  const resolveFieldAt = useMemo(
    () => resolveFieldAtOf({ floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation }),
    [floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation],
  );

  const origin = pending?.origin;
  const originNode = origin?.kind === "node" ? nodes.find((n) => n.id === origin.id) : undefined;
  const point: [number, number] | null = originNode ? [originNode.x, originNode.y] : null;

  // Per-floor split-shape name, for the row label (GitHub issue #567 follow-up): a floor whose own
  // `(point, index)` resolves to more than one node is split, and — same recognition
  // `PostEditSplitTargetDialog`'s preview uses — may match a named shape (bridge, diagonal, ...).
  // Built once per floor set change rather than inline per row, since it needs each floor's own
  // node/edge slice.
  const splitNameByFloor = useMemo(() => {
    if (!point) return new Map<number, string>();
    const result = new Map<number, string>();
    for (let index = 0; index < floors.length; index++) {
      // Each row's own floor config (GitHub issue #611's bug class) — a shared active-floor config
      // would mis-resolve face topology for every floor row other than the currently active one.
      const rowCfg = floorFields[floors[index].id].fieldConfig;
      const geometry = buildSplitFloorGeometry(point, index, nodes, draftEdges, draftTeleports, splitPoints, rowCfg);
      if (!geometry) continue;
      const kind = detectSplitSpecialShapeKind(
        geometry.faceKindsByNode, splitShapeBinding(rowCfg, point[0], point[1]),
      );
      result.set(index, kind !== null ? splitPointShapeName(kind) : m["post_edit.split_cell_label"]());
    }
    return result;
  }, [point, floors, floorFields, nodes, draftEdges, draftTeleports, splitPoints]);

  if (!pending || pending.origin.kind !== "node" || !originNode || !point) return null;
  const originLevel = originNode.level ?? 0;
  const statusOf = (index: number): ElevatorFloorStatus => {
    if (index === originLevel) return "current";
    return cellExistsAt(resolveFieldAt, point, index === 0 ? undefined : index) ? "available" : "no_cell";
  };
  const statusLabel: Record<ElevatorFloorStatus, string> = {
    current: m["preset.elevator_floor_status_current"](),
    available: m["preset.elevator_floor_status_available"](),
    no_cell: m["preset.elevator_floor_status_no_cell"](),
  };

  const rows: ElevatorFloorRow[] = floors.map((floor, index) => {
    const status = statusOf(index);
    const splitName = splitNameByFloor.get(index);
    return {
      key: floor.id,
      index,
      label: `${index + 1}: ${floor.title}`,
      status,
      statusLabel: splitName ? `${statusLabel[status]}, ${splitName}` : statusLabel[status],
      checked: pending.floors.has(index),
    };
  }).reverse();
  return <ElevatorFloorPicker
    title={m["preset.elevator_floor_dialog_title"]()}
    hint={m["preset.elevator_floor_dialog_hint"]()}
    rows={rows}
    selectedFloorCount={pending.floors.size}
    onToggle={(row) => toggleFloor(row.index)}
    onConfirm={() => { confirm(); onClose(); }}
    onClose={onClose}
  />;
}
