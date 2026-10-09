import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { TessellationKind, HexOrientation, TriOrientation } from "../../store/mazeStore";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { spacing, inset } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { selectTessellationWouldLoseData } from "../../pixi/selectors/mazeSelectors";
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
  const setPreviewKind = useMazeStore((s) => s.setPreviewKind);
  const setPreviewHexOrientation = useMazeStore((s) => s.setPreviewHexOrientation);
  const setPreviewTriOrientation = useMazeStore((s) => s.setPreviewTriOrientation);
  const confirmTessellation = useMazeStore((s) => s.confirmTessellation);
  const wouldLoseData = useMazeStore(selectTessellationWouldLoseData);

  const [showConfirm, setShowConfirm] = useState(false);

  const isHex = previewKind === "hex";
  const isTri = previewKind === "triangle";

  function handleConfirmTessellation() {
    if (wouldLoseData) {
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
          name="preview-tessellation"
          style={styles.select}
          value={previewKind}
          onChange={(e) => setPreviewKind(e.target.value as TessellationKind)}
        >
          <option value="square">{m["tessellation.square"]()}</option>
          <option value="hex">{m["tessellation.hex"]()}</option>
          <option value="triangle">{m["tessellation.triangle"]()}</option>
          <option value="cairo">{m["tessellation.cairo"]()}</option>
        </select>
      </label>
      {isHex && (
        <label style={styles.label}>
          {m["tessellation.orientation"]()}
          <select
            name="preview-hex-orientation"
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
            name="preview-triangle-orientation"
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
      <Button variant="primary" layoutStyle={styles.confirmBtn} onClick={handleConfirmTessellation}>
        {m["tessellation.confirm_btn"]()}
      </Button>
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
    gap: spacing.groupGap,
  },
  label: sharedStyles.fieldLabel,
  select: sharedStyles.select,
  confirmBtn: {
    marginTop: spacing.itemGap,
    padding: `${inset.buttonInsetY}px 0`,
  },
};
