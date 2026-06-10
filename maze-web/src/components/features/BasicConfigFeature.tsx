import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { TessellationKind, HexOrientation, TriOrientation } from "../../store/mazeStore";

export function BasicConfigFeature() {
  const previewKind = useMazeStore((s) => s.previewKind);
  const previewHexOrientation = useMazeStore((s) => s.previewHexOrientation);
  const previewTriOrientation = useMazeStore((s) => s.previewTriOrientation);
  const setPreviewKind = useMazeStore((s) => s.setPreviewKind);
  const setPreviewHexOrientation = useMazeStore((s) => s.setPreviewHexOrientation);
  const setPreviewTriOrientation = useMazeStore((s) => s.setPreviewTriOrientation);
  const confirmTessellation = useMazeStore((s) => s.confirmTessellation);

  const isHex = previewKind === "hex";
  const isTri = previewKind === "triangle";

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
            <option value="flat_top">Flat top</option>
            <option value="pointy_top">Pointy top</option>
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
            <option value="r0">0° — base bottom</option>
            <option value="r90">90° — base left</option>
            <option value="r180">180° — base top</option>
            <option value="r270">270° — base right</option>
          </select>
        </label>
      )}
      <button style={styles.confirmBtn} onClick={confirmTessellation}>
        Confirm tessellation
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: 11,
    color: "#aaa",
  },
  select: {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#e0e0e0",
    padding: "3px 6px",
    fontSize: 12,
    borderRadius: 3,
  },
  confirmBtn: {
    marginTop: 4,
    background: "#3a6ea8",
    border: "none",
    color: "#fff",
    padding: "6px 0",
    cursor: "pointer",
    borderRadius: 3,
    fontSize: 12,
    fontWeight: 600,
  },
};
