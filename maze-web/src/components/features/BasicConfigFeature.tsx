import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { TessellationKind, HexOrientation, TriOrientation } from "../../store/mazeStore";
import { sharedStyles, buttonStyle } from "../../styles/shared";
import { ConfirmModal } from "../ConfirmModal";
import * as m from "~/paraglide/messages";

export function getHexOrientationLabel(o: HexOrientation): string {
  return o === "flat_top" ? m["tessellation.flat_top"]() : m["tessellation.pointy_top"]();
}

export function getTriOrientationLabel(o: TriOrientation): string {
  const labels: Record<TriOrientation, () => string> = {
    r0: m["tessellation.r0"],
    r90: m["tessellation.r90"],
    r180: m["tessellation.r180"],
    r270: m["tessellation.r270"],
  };
  return labels[o]();
}

export function BasicConfigFeature() {
  const previewKind = useMazeStore((s) => s.previewKind);
  const previewHexOrientation = useMazeStore((s) => s.previewHexOrientation);
  const previewTriOrientation = useMazeStore((s) => s.previewTriOrientation);
  const tessellationConfirmed = useMazeStore((s) => s.tessellationConfirmed);
  const setPreviewKind = useMazeStore((s) => s.setPreviewKind);
  const setPreviewHexOrientation = useMazeStore((s) => s.setPreviewHexOrientation);
  const setPreviewTriOrientation = useMazeStore((s) => s.setPreviewTriOrientation);
  const confirmTessellation = useMazeStore((s) => s.confirmTessellation);

  const [showConfirm, setShowConfirm] = useState(false);

  const isHex = previewKind === "hex";
  const isTri = previewKind === "triangle";

  function handleConfirmTessellation() {
    if (tessellationConfirmed) {
      setShowConfirm(true);
    } else {
      confirmTessellation();
    }
  }

  return (
    <div style={styles.root}>
      <label style={styles.label}>
        {m["tessellation.title"]()}
        <select
          style={styles.select}
          value={previewKind}
          onChange={(e) => setPreviewKind(e.target.value as TessellationKind)}
        >
          <option value="square">{m["tessellation.square"]()}</option>
          <option value="hex">{m["tessellation.hex"]()}</option>
          <option value="triangle">{m["tessellation.triangle"]()}</option>
        </select>
      </label>
      {isHex && (
        <label style={styles.label}>
          {m["tessellation.orientation"]()}
          <select
            style={styles.select}
            value={previewHexOrientation}
            onChange={(e) => setPreviewHexOrientation(e.target.value as HexOrientation)}
          >
            <option value="flat_top">{m["tessellation.flat_top"]()}</option>
            <option value="pointy_top">{m["tessellation.pointy_top"]()}</option>
          </select>
        </label>
      )}
      {isTri && (
        <label style={styles.label}>
          {m["tessellation.orientation"]()}
          <select
            style={styles.select}
            value={previewTriOrientation}
            onChange={(e) => setPreviewTriOrientation(e.target.value as TriOrientation)}
          >
            <option value="r0">{m["tessellation.r0_full"]()}</option>
            <option value="r90">{m["tessellation.r90_full"]()}</option>
            <option value="r180">{m["tessellation.r180_full"]()}</option>
            <option value="r270">{m["tessellation.r270_full"]()}</option>
          </select>
        </label>
      )}
      <button style={styles.confirmBtn} onClick={handleConfirmTessellation}>
        {m["tessellation.confirm_btn"]()}
      </button>
      {showConfirm && (
        <ConfirmModal
          message={m["tessellation.reset_warning"]()}
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
