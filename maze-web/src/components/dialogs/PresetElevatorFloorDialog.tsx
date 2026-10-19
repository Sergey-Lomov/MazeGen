import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ElevatorFloorPicker, type ElevatorFloorRow, type ElevatorFloorStatus } from "./ElevatorFloorPicker";
import { cellExistsAt, resolveCells, presetConnectionsOnLevel } from "../../pixi/fieldEditUtils";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { resolvePresetSplitShapeLabel } from "../../pixi/presetSplitLabels";
import { resolveFieldAtOf, levelFieldsOf } from "../../store/storeHelpers";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}


/** Multi-floor picker for an in-progress preset elevator placement (GitHub issue #357) — the first
 * click (`presetElevatorPending.origin`) already fixed the elevator's own `(x, y)` point and its
 * origin floor; this dialog only decides *which other floors* it also reaches. Mirrors
 * `CopyFloorDialog`'s row layout (including bottom-to-top floor order — `floors[0]` is "Floor 1",
 * the bottom floor, same convention `FloorSwitcher`/`CopyFloorDialog` use), but every row is an
 * independent toggle (`Switch`) instead of a single-select list. Each row also carries a status:
 * `"current"` (the origin floor — always on, can't be turned off), `"available"` (has a cell at the
 * elevator's own point, off by default), or `"no_cell"` (no cell there — can't be selected at all,
 * GitHub issue #357 follow-up: silently letting a floor without a cell be picked would create a
 * client-invalid elevator, see `computeInvalidElevatorIds`). */
export function PresetElevatorFloorDialog({ onClose }: Props) {
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const tessellationParams = useMazeStore((s) => s.tessellationParams);
  const smoothPrimitives = useMazeStore((s) => s.smoothPrimitives);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const pending = useMazeStore((s) => s.presetElevatorPending);
  const toggleFloor = useMazeStore((s) => s.togglePresetElevatorFloor);
  const confirm = useMazeStore((s) => s.confirmPresetElevatorPlacement);
  const presetSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetActiveSplitNode = useMazeStore((s) => s.presetActiveSplitNode);

  const resolveFieldAt = useMemo(
    () => resolveFieldAtOf({ floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives }),
    [floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives],
  );
  const levelFields = useMemo(
    () => levelFieldsOf({ floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives }),
    [floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives],
  );

  // Per-floor split-shape name, for the row label (GitHub issue #594, parity with post-edit's own
  // `splitNameByFloor` from GitHub issue #567 follow-up) — a floor whose own elevator point resolves
  // to more than one declared node is split, and may match a named shape (bridge, diagonal, ...),
  // same recognition `PresetSplitTargetDialog`'s preview uses. Built once per floor set change
  // rather than inline per row, since it needs each floor's own cells/connections slice.
  const splitLabelByFloor = useMemo(() => {
    if (!pending) return new Map<number, string>();
    const result = new Map<number, string>();
    for (let index = 0; index < levelFields.length; index++) {
      const field = levelFields[index];
      const cells = resolveCells(field.cfg, field.customPoints);
      const inFieldCells = buildCellSet(cells);
      const label = resolvePresetSplitShapeLabel(
        {
          splitPoints: presetSplitPoints,
          presetConnections: presetConnectionsOnLevel(presetConnections, index === 0 ? undefined : index),
          activeSplitNode: presetActiveSplitNode,
          cfgAt: () => field.cfg,
          inFieldCellsAt: () => inFieldCells,
        },
        pending.origin.point,
        index,
      );
      if (label !== null) result.set(index, label);
    }
    return result;
  }, [pending, levelFields, presetSplitPoints, presetConnections, presetActiveSplitNode]);

  if (!pending) return null;
  const originLevel = pending.origin.level ?? 0;
  const statusOf = (index: number): ElevatorFloorStatus => {
    if (index === originLevel) return "current";
    return cellExistsAt(resolveFieldAt, pending.origin.point, index === 0 ? undefined : index) ? "available" : "no_cell";
  };
  const statusLabel: Record<ElevatorFloorStatus, string> = {
    current: m["preset.elevator_floor_status_current"](),
    available: m["preset.elevator_floor_status_available"](),
    no_cell: m["preset.elevator_floor_status_no_cell"](),
  };

  const rows: ElevatorFloorRow[] = floors.map((floor, index) => {
    const status = statusOf(index);
    const splitLabel = splitLabelByFloor.get(index);
    return {
      key: floor.id,
      index,
      label: `${index + 1}: ${floor.title}`,
      status,
      statusLabel: splitLabel ? `${statusLabel[status]}, ${splitLabel}` : statusLabel[status],
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
