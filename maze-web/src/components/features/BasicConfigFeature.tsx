import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { TessellationKind, HexOrientation, TriOrientation } from "../../store/mazeStore";
import { sharedStyles, buttonStyle } from "../../styles/shared";
import { ConfirmModal } from "../ConfirmModal";

export const HEX_ORIENTATION_LABELS: Record<HexOrientation, string> = {
  flat_top: "Flat top",
  pointy_top: "Pointy top",
};

export const HEX_ORIENTATION_KEYS: HexOrientation[] = ["flat_top", "pointy_top"];

export const TRI_ORIENTATION_LABELS: Record<TriOrientation, string> = {
  r0: "0°",
  r90: "90°",
  r180: "180°",
  r270: "270°",
};

const TRI_ORIENTATION_OPTION_LABELS: Record<TriOrientation, string> = {
  r0: "0° — base bottom",
  r90: "90° — base left",
  r180: "180° — base top",
  r270: "270° — base right",
};

export const TRI_ORIENTATION_KEYS: TriOrientation[] = ["r0", "r90", "r180", "r270"];

export function BasicConfigFeature() {
  const previewKind = useMazeStore((s) => s.previewKind);
  const previewHexOrientation = useMazeStore((s) => s.previewHexOrientation);
  const previewTriOrientation = useMazeStore((s) => s.previewTriOrientation);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const fieldEditMode = useMazeStore((s) => s.fieldEditMode);
  const fieldPoints = useMazeStore((s) => s.fieldPoints);
  const setPreviewKind = useMazeStore((s) => s.setPreviewKind);
  const setPreviewHexOrientation = useMazeStore((s) => s.setPreviewHexOrientation);
  const setPreviewTriOrientation = useMazeStore((s) => s.setPreviewTriOrientation);
  const confirmTessellation = useMazeStore((s) => s.confirmTessellation);

  const [showConfirm, setShowConfirm] = useState(false);

  const isHex = previewKind === "hex";
  const isTri = previewKind === "triangle";

  const hasField = fieldEditMode === "custom" && fieldPoints.size > 0;
  const hasPresets = presetConnections.size > 0 || presetStart !== null || presetFinish !== null;

  function handleConfirmTessellation() {
    const kindChanges = previewKind !== tessellationKind;
    if (!kindChanges) {
      confirmTessellation();
      return;
    }
    if (hasField || hasPresets) {
      setShowConfirm(true);
    } else {
      confirmTessellation();
    }
  }

  function buildConfirmMessage(): string {
    const parts: string[] = [];
    if (hasField) parts.push("custom field");
    if (hasPresets) parts.push("preset connections");
    return `Changing tessellation type will reset: ${parts.join(" and ")}. Continue?`;
  }

  return (
    <div style={styles.root}>
      <label style={styles.label}>
        Tessellation
        <select
          style={styles.select}
          value={previewKind}
          onChange={(e) => setPreviewKind(e.target.value as TessellationKind)}
        >
          <option value="square">Square</option>
          <option value="hex">Hex</option>
          <option value="triangle">Triangle</option>
        </select>
      </label>
      {isHex && (
        <label style={styles.label}>
          Orientation
          <select
            style={styles.select}
            value={previewHexOrientation}
            onChange={(e) => setPreviewHexOrientation(e.target.value as HexOrientation)}
          >
            {HEX_ORIENTATION_KEYS.map((k) => (
              <option key={k} value={k}>{HEX_ORIENTATION_LABELS[k]}</option>
            ))}
          </select>
        </label>
      )}
      {isTri && (
        <label style={styles.label}>
          Orientation
          <select
            style={styles.select}
            value={previewTriOrientation}
            onChange={(e) => setPreviewTriOrientation(e.target.value as TriOrientation)}
          >
            {TRI_ORIENTATION_KEYS.map((k) => (
              <option key={k} value={k}>{TRI_ORIENTATION_OPTION_LABELS[k]}</option>
            ))}
          </select>
        </label>
      )}
      <button style={styles.confirmBtn} onClick={handleConfirmTessellation}>
        Confirm tessellation
      </button>
      {showConfirm && (
        <ConfirmModal
          message={buildConfirmMessage()}
          onConfirm={() => { confirmTessellation(); setShowConfirm(false); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  label: sharedStyles.fieldLabel,
  select: sharedStyles.select,
  confirmBtn: {
    marginTop: 4,
    ...buttonStyle("primary"),
    padding: "6px 0",
    fontWeight: 600,
  },
};
