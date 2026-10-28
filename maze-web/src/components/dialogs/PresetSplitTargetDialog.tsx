import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { presetConnectionsOnLevel, recordOnLevel, resolveCells } from "../../pixi/fieldEditUtils";
import { presetSplitNodeFaceKinds } from "../../pixi/presetSplitResolve";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { buildPresetSplitPassages } from "../../pixi/selectors/presetSelectors";
import { presetEndpoint } from "../../pixi/presetEndpoint";
import type { NodeLockKind } from "../../wasm/types";
import { splitNodeSemanticNamesFromKinds } from "../../pixi/splitNodeNames";
import { splitShapeBinding } from "../../pixi/splitShape";
import { levelFieldsOf } from "../../store/storeHelpers";
import { PresetSplitPointPixiPreview } from "./PresetSplitPointPixiPreview";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { SplitTargetPicker, numberToCssColor, shownSplitTargets, type SplitTargetOption } from "./SplitTargetPicker";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** "Which split node?" picker for an in-progress preset vertex-tool placement (GitHub issue #474,
 * extended to the preset stage). The active-node concept (`presetActiveSplitNode`) must not decide
 * which of a split point's nodes a start/finish marker, teleport endpoint, vertical passage or
 * elevator attaches to, so `PresetConnectionsController` defers the placement and opens this
 * dialog; picking a node calls `applyPresetSplitTargetPick(slotId)` (`undefined` = the original
 * node), which dispatches the deferred tool to that node.
 *
 * A small Pixi preview on the right renders the point with the same pipeline the main canvas uses;
 * on a recognised special shape (bridge/diagonal) each node also gets a marker dot in its colour
 * at its real anchor position so the user can tell the nodes apart by position. */
export function PresetSplitTargetDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.presetSplitTargetPrompt);
  const pick = useMazeStore((s) => s.applyPresetSplitTargetPick);
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const tessellationParams = useMazeStore((s) => s.tessellationParams);
  const smoothPrimitives = useMazeStore((s) => s.smoothPrimitives);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const rawSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const rawConnections = useMazeStore((s) => s.presetConnections);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const autoLockedNodes = useMazeStore((s) => s.autoLockedNodes);

  const point = prompt?.point ?? null;
  // The prompt's own floor (GitHub issue #594) — NOT necessarily the active floor: a target-floor/
  // drag placement (`place_vertical_passage_target`/`place_elevator_target`/`move_*_endpoint`) can
  // prompt for a point on a floor other than the one currently being edited (e.g. the floor a
  // vertical passage lands ON, one above/below the active floor). Reading `cfg`/cells/`level` off
  // `activeFloorId` here — the pre-#594 behavior — silently resolved node names/preview against the
  // WRONG floor's data whenever that happened, showing generic `Node N` labels and no preview
  // instead of semantic names, even though the point genuinely is a recognized special shape.
  const level = prompt?.level;

  const preview = useMemo(() => {
    if (!point || !prompt) return null;
    const levelFields = levelFieldsOf({ floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives });
    const field = levelFields[level ?? 0];
    if (!field) return null;
    const cfg = field.cfg;
    const cells = resolveCells(cfg, field.customPoints);
    const presetSplitPoints = recordOnLevel(rawSplitPoints, level);
    const presetConnections = presetConnectionsOnLevel(rawConnections, level);
    const { specialShapes } = buildPresetSplitPassages(presetSplitPoints, presetConnections, cfg, {}, cells);
    const pointKey = `${point[0]},${point[1]}`;
    const special = specialShapes.some((s) => s.pointKey === pointKey);

    // Semantic per-node names when this point's face configuration matches a recognized
    // special-split topology (GitHub issue #487) — offered here first, then one row per slot, so
    // the node order matches the picker's own `options` below.
    const inFieldCells = buildCellSet(cells);
    const slotOrder: (number | undefined)[] = [undefined, ...prompt.slotIds];
    // The split-point records and connections above are scoped to this floor and have had their
    // `@level`/endpoint level stripped. Keep the endpoints passed to the shared face-kind helper
    // in that same representation; retaining the target floor here makes presetEdgeKey look for
    // level-suffixed entries that cannot exist in the scoped map (GitHub issue #596).
    const faceKindsByNode = slotOrder.map((slotId) => presetSplitNodeFaceKinds(
      presetEndpoint(point, slotId), point, cfg, inFieldCells, presetConnections, presetSplitPoints, {}, undefined,
    ));
    const semanticNames = splitNodeSemanticNamesFromKinds(
      faceKindsByNode, splitShapeBinding(cfg, point[0], point[1]),
    );

    return { cfg, cells, presetSplitPoints, presetConnections, special, semanticNames };
  }, [point, floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives, rawSplitPoints, rawConnections, level, prompt]);

  if (!prompt || !point) return null;
  const [x, y] = point;
  // The picker always offers the original node first, then one row per declared slot.
  const options: (number | undefined)[] = [undefined, ...prompt.slotIds];
  const lockAction = prompt.action.tool === "lock_in" || prompt.action.tool === "lock_out" || prompt.action.tool === "full_lock";
  const requestedLock: NodeLockKind | undefined = lockAction
    ? prompt.action.tool === "lock_in" ? "in" : prompt.action.tool === "lock_out" ? "out" : "both"
    : undefined;
  const lockStatus = (slotId: number | undefined): "cancel" | "replace" | null => {
    if (!requestedLock) return null;
    const key = `${x},${y}${slotId === undefined ? "" : `:${slotId}`}${level === undefined ? "" : `@${level}`}`;
    const existing = lockedNodes.get(key);
    if (existing !== undefined) return existing === requestedLock ? "cancel" : "replace";
    return autoLockedNodes.has(key) ? "replace" : null;
  };

  const coords = formatTargetLabel(point, level ?? 0, true, undefined);
  // Colors and names follow each node's index on the full list, so a node left out by `excluded`
  // keeps every other node's own color and name.
  const shown = shownSplitTargets(options, (slotId) => prompt.excluded !== undefined && prompt.excluded.slotId === slotId);
  const targetOptions: SplitTargetOption[] = shown.map(({ node: slotId, index }) => ({
    key: slotId === undefined ? "original" : String(slotId),
    color: numberToCssColor(splitSlotColor(index, canvas.node.splitSlots)),
    label: preview?.semanticNames?.[index]?.full ?? m["post_edit.split_node_label"]({ slotId: index + 1 }),
    state: lockStatus(slotId) === "cancel" ? m["preset.lock_target_cancel"]() : lockStatus(slotId) === "replace" ? m["preset.lock_target_replace"]() : undefined,
  }));
  return <SplitTargetPicker
    title={lockAction ? m["preset.lock_target_title"]({ coords }) : m["preset.split_target_title"]({ coords })}
    hint={lockAction ? m["preset.lock_target_hint"]() : m["preset.split_target_hint"]()}
    options={targetOptions}
    preview={preview ? <PresetSplitPointPixiPreview point={point} cfg={preview.cfg} slotIds={prompt.slotIds} presetSplitPoints={preview.presetSplitPoints} presetConnections={preview.presetConnections} cells={preview.cells} showMarkers={preview.special} /> : undefined}
    onSelect={(option) => pick(shown[targetOptions.indexOf(option)]?.node)}
    onClose={onClose}
  />;
}
