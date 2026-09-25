import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { presetConnectionsOnLevel, recordOnLevel, presetSplitNodeFaceKinds, resolveCells } from "../../pixi/fieldEditUtils";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { buildPresetSplitPassages } from "../../pixi/selectors/presetSelectors";
import { presetEndpoint } from "../../pixi/presetEndpoint";
import type { NodeLockKind } from "../../wasm/types";
import { splitNodeSemanticNamesFromKinds } from "../../pixi/splitNodeNames";
import { levelFieldsOf } from "../../store/storeHelpers";
import { PresetSplitPointPixiPreview } from "./PresetSplitPointPixiPreview";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
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
    const levelFields = levelFieldsOf({ floors, floorFields, tessellationKind, hexOrientation, triOrientation });
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
    const faceKindsByNode = slotOrder.map((slotId) => presetSplitNodeFaceKinds(
      presetEndpoint(point, slotId, level), point, cfg, inFieldCells, presetConnections, presetSplitPoints, {}, level,
    ));
    const semanticNames = splitNodeSemanticNamesFromKinds(faceKindsByNode);

    return { cfg, cells, presetSplitPoints, presetConnections, special, semanticNames };
  }, [point, floors, floorFields, tessellationKind, hexOrientation, triOrientation, rawSplitPoints, rawConnections, level, prompt]);

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
  return (
    <Modal
      title={lockAction
        ? m["preset.lock_target_title"]({ coords })
        : m["preset.split_target_title"]({ coords })}
      size="approve"
      onClose={onClose}
    >
      <p style={styles.hint}>{lockAction ? m["preset.lock_target_hint"]() : m["preset.split_target_hint"]()}</p>
      <div style={styles.body}>
        <div style={styles.list}>
          {options.map((slotId, index) => (
            <Button
              key={slotId ?? "original"}
              variant="secondary"
              layoutStyle={styles.item}
              // A pick does NOT call `onClose` itself — a `move_*`/`place_*_target` action's queue
              // (GitHub issue #594, same fix as post-edit's `PostEditSplitTargetDialog` for #567)
              // reopens this dialog for the NEXT queued point by re-setting `presetSplitTargetPrompt`
              // from inside `applyPresetSplitTargetPick` itself. Calling `onClose` (==
              // `cancelPresetSplitTarget`, which nulls the prompt unconditionally) right after would
              // immediately wipe out that freshly-set next prompt, so the dialog appeared to fire once
              // then silently stop, and any action gated on the queue draining (e.g. elevator
              // placement) never actually completed.
              onClick={() => pick(slotId)}
            >
              <span style={{ ...styles.dot, background: colorToCss(splitSlotColor(index, canvas.node.splitSlots)) }} />
              {preview?.semanticNames?.[index]?.full ?? m["post_edit.split_node_label"]({ slotId: index + 1 })}
              {lockStatus(slotId) === "cancel" && <span style={styles.lockState}>{m["preset.lock_target_cancel"]()}</span>}
              {lockStatus(slotId) === "replace" && <span style={styles.lockState}>{m["preset.lock_target_replace"]()}</span>}
            </Button>
          ))}
        </div>
        {preview && (
          <PresetSplitPointPixiPreview
            point={point}
            cfg={preview.cfg}
            slotIds={prompt.slotIds}
            presetSplitPoints={preview.presetSplitPoints}
            presetConnections={preview.presetConnections}
            cells={preview.cells}
            showMarkers={preview.special}
          />
        )}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: {
    ...typography.control,
    color: ui.text.secondary,
    margin: 0,
    paddingBottom: dialogSpacing.paddingY,
  },
  body: {
    display: "flex",
    gap: dialogSpacing.paddingX,
    alignItems: "flex-start",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: dialogSpacing.gap,
    flex: 1,
    minWidth: 0,
  },
  item: {
    ...typography.control,
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    justifyContent: "flex-start",
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    borderRadius: radius.sm,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flex: "0 0 auto",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: dialogSpacing.gap,
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  btnCancel: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  lockState: {
    marginLeft: "auto",
    color: ui.text.secondary,
    fontSize: 11,
  },
};
