import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { presetConnectionsOnLevel, recordOnLevel } from "../../pixi/fieldEditUtils";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildPresetSplitPassages } from "../../pixi/selectors/presetSelectors";
import { activeFloorLevel } from "../../store/storeHelpers";
import { PresetSplitPointPixiPreview } from "./PresetSplitPointPixiPreview";
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
  const cfg = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const rawSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const rawConnections = useMazeStore((s) => s.presetConnections);
  const level = useMazeStore(activeFloorLevel);

  const point = prompt?.point ?? null;

  const preview = useMemo(() => {
    if (!point) return null;
    const cells = buildActiveCells(fieldPoints, fieldEditMode, cfg);
    const presetSplitPoints = recordOnLevel(rawSplitPoints, level);
    const presetConnections = presetConnectionsOnLevel(rawConnections, level);
    const { specialShapes } = buildPresetSplitPassages(presetSplitPoints, presetConnections, cfg, {}, cells);
    const pointKey = `${point[0]},${point[1]}`;
    const special = specialShapes.some((s) => s.pointKey === pointKey);
    return { cells, presetSplitPoints, presetConnections, special };
  }, [point, cfg, fieldPoints, fieldEditMode, rawSplitPoints, rawConnections, level]);

  if (!prompt || !point) return null;
  const [x, y] = point;
  // The picker always offers the original node first, then one row per declared slot.
  const options: (number | undefined)[] = [undefined, ...prompt.slotIds];

  return (
    <Modal title={m["preset.split_target_title"]({ x, y })} size="approve" onClose={onClose}>
      <p style={styles.hint}>{m["preset.split_target_hint"]()}</p>
      <div style={styles.body}>
        <div style={styles.list}>
          {options.map((slotId, index) => (
            <Button
              key={slotId ?? "original"}
              variant="secondary"
              layoutStyle={styles.item}
              onClick={() => { pick(slotId); onClose(); }}
            >
              <span style={{ ...styles.dot, background: colorToCss(splitSlotColor(index, canvas.node.splitSlots)) }} />
              {m["post_edit.split_node_label"]({ slotId: index + 1 })}
            </Button>
          ))}
        </div>
        {preview && (
          <PresetSplitPointPixiPreview
            point={point}
            cfg={cfg}
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
};
