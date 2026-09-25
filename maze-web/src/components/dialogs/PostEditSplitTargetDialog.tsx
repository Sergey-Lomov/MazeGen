import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { detectSplitSpecialShapeKind } from "../../pixi/splitFaceLayout";
import { splitNodeSemanticNamesFromKinds } from "../../pixi/splitNodeNames";
import { activeFloorLevel } from "../../store/storeHelpers";
import { buildSplitFloorGeometry } from "../../pixi/splitFloorPreview";
import { SplitPointPixiPreview } from "./SplitPointPixiPreview";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** "Which split node?" picker for an in-progress post-edit vertex-tool placement (GitHub issue
 * #474). The active-node concept must not decide which of a split point's nodes a vertical
 * passage / elevator / teleport endpoint / start-finish marker attaches to, so
 * `PostEditController` defers the placement and opens this dialog; picking a node calls
 * `applyPostEditSplitTargetPick`, which dispatches the deferred tool to that node. `nodeIds` are
 * the point's confirmed nodes in snapshot order — index 0 the original node, the rest its slots
 * (same order and palette `ManageSplitNodesDialog` uses).
 *
 * A pick does NOT call `onClose` itself — a `move_*`/`place_*` action's queue (GitHub issue #567)
 * can span several split floors, one prompt at a time, and `applyPostEditSplitTargetPick` already
 * decides on its own whether to advance `postEditSplitTargetPrompt` to the next queued floor or
 * clear it to `null` once every floor resolved; this component just renders whatever prompt state
 * comes back. Calling `onClose` (== `cancelPostEditSplitTarget`) after every pick used to
 * short-circuit that queue — it wiped the freshly-advanced prompt for the NEXT floor right after
 * `pick` set it, so a multi-split-floor elevator placement only ever got a dialog for its first
 * split floor and then silently never dispatched (`applyPostEditSplitTargetPick`'s dispatch only
 * fires once the queue is empty). `onClose` (the modal's own X/backdrop) still cancels explicitly.
 *

 * A small Pixi preview on the right (`SplitPointPixiPreview`) renders the point with the exact
 * same pipeline the main canvas uses — a recognised special shape (bridge/diagonal) draws with
 * its real geometry. On a special shape each node also gets a marker dot in its colour at its
 * real anchor position so the user can tell the nodes apart by position; on a plain split the
 * line colours already disambiguate, so no dots. */
export function PostEditSplitTargetDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.postEditSplitTargetPrompt);
  const pick = useMazeStore((s) => s.applyPostEditSplitTargetPick);
  const allNodes = useMazeStore((s) => s.nodes);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const draftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const activeLevel = useMazeStore(activeFloorLevel);

  const point = prompt?.point ?? null;
  // The prompted point can be on a floor OTHER than the currently active one — a vertical-passage/
  // elevator endpoint's drop target is always on a different floor than the dragged end, and the
  // queue can walk through several floors in turn (GitHub issue #567). The preview must build
  // against THAT floor, not the active one, or `pointNodes` never matches (wrong floor's node set)
  // and the whole preview silently renders nothing. `level` is `undefined` for floor 0 (established
  // convention, e.g. `PostEditController`'s own `toLevel === 0 ? undefined : toLevel`), so it must
  // be defaulted to 0 explicitly, not treated as "unset, fall back to active floor".
  const level = prompt ? (prompt.level ?? 0) : (activeLevel ?? 0);

  const preview = useMemo(() => {
    if (!point) return null;
    const geometry = buildSplitFloorGeometry(point, level ?? 0, allNodes, draftEdges, draftTeleports, splitPoints, cfg);
    if (!geometry) return null;
    const { pointNodes, floorNodes, edges, faceKindsByNode } = geometry;
    const special = detectSplitSpecialShapeKind(faceKindsByNode) !== null;
    const semanticNames = splitNodeSemanticNamesFromKinds(faceKindsByNode);

    return { pointNodes, floorNodes, edges, special, semanticNames };
  }, [point, allNodes, level, cfg, draftEdges, draftTeleports, splitPoints]);

  if (!prompt || !point) return null;

  const coords = formatTargetLabel(point, level, true, undefined);
  return (
    <Modal title={m["post_edit.split_target_title"]({ coords })} size="approve" onClose={onClose}>
      <p style={styles.hint}>{m["post_edit.split_target_hint"]()}</p>
      <div style={styles.body}>
        <div style={styles.list}>
          {prompt.nodeIds.map((id, index) => (
            <Button
              key={id}
              variant="secondary"
              layoutStyle={styles.item}
              onClick={() => pick(id)}
            >
              <span style={{ ...styles.dot, background: colorToCss(splitSlotColor(index, canvas.node.splitSlots)) }} />
              {preview?.semanticNames?.[index]?.full ?? m["post_edit.split_node_label"]({ slotId: index + 1 })}
            </Button>
          ))}
        </div>
        {preview && (
          <SplitPointPixiPreview
            point={point}
            cfg={cfg}
            pointNodes={preview.pointNodes}
            allNodes={preview.floorNodes}
            allEdges={preview.edges}
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

// Mirrors PostEditElevatorFloorDialog's row/footer styling.
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
};
