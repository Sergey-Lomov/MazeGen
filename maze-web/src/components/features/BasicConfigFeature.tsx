import React, { useEffect, useState } from "react";
import { TESSELLATION_UI } from "../../pixi/geometry/tessellationUi";
import { useMazeStore } from "../../store/mazeStore";
import type { TessellationKind, HexOrientation, TriOrientation } from "../../store/mazeStore";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { SizeParam } from "./SizeParam";
import { spacing, inset } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { hasOpenModal } from "../Modal";
import { isFeatureCardConfirmShortcut } from "../keyboardShortcuts";
import { blurActiveElement } from "../../pixi/toolShortcuts";
import { selectTessellationWouldLoseData } from "../../pixi/selectors/mazeSelectors";
import * as m from "~/paraglide/messages";

/** Message keys of the labels of every kind's `paramSpecs` entry. */
type TessellationParamMessage = "tessellation.param.first_ring_cells" | "tessellation.param.ring_layout" | "tessellation.param.max_cells";
type TessellationChoiceMessage = "tessellation.param.ring_layout.classic" | "tessellation.param.ring_layout.smooth";

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
  const previewParams = useMazeStore((s) => s.previewParams);
  const setPreviewParams = useMazeStore((s) => s.setPreviewParams);
  const previewHexOrientation = useMazeStore((s) => s.previewHexOrientation);
  const previewTriOrientation = useMazeStore((s) => s.previewTriOrientation);
  const setPreviewKind = useMazeStore((s) => s.setPreviewKind);
  const setPreviewHexOrientation = useMazeStore((s) => s.setPreviewHexOrientation);
  const setPreviewTriOrientation = useMazeStore((s) => s.setPreviewTriOrientation);
  const confirmTessellation = useMazeStore((s) => s.confirmTessellation);

  const [showConfirm, setShowConfirm] = useState(false);

  const isHex = TESSELLATION_UI[previewKind].orientationSlot === "hex";
  const isTri = TESSELLATION_UI[previewKind].orientationSlot === "tri";

  // Read once on click rather than subscribed: the predicate filters every QC pattern list, and
  // a subscription would rerun it on each unrelated store update while the preview differs.
  function handleConfirmTessellation() {
    if (selectTessellationWouldLoseData(useMazeStore.getState())) {
      setShowConfirm(true);
    } else {
      confirmTessellation();
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (useMazeStore.getState().openCard !== "basic_config" || showConfirm || hasOpenModal() || !isFeatureCardConfirmShortcut(event)) return;
      event.preventDefault();
      blurActiveElement();
      handleConfirmTessellation();
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [showConfirm, confirmTessellation]);

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
          <option value="tri">{m["tessellation.triangle"]()}</option>
          <option value="cairo">{m["tessellation.cairo"]()}</option>
          <option value="square_octagon">{m["tessellation.square_octagon"]()}</option>
          <option value="brick">{m["tessellation.brick"]()}</option>
          <option value="trihexagonal">{m["tessellation.trihexagonal"]()}</option>
          <option value="snub_hexagonal">{m["tessellation.snub_hexagonal"]()}</option>
          <option value="rhombitrihexagonal">{m["tessellation.rhombitrihexagonal"]()}</option>
          <option value="truncated_hexagonal">{m["tessellation.truncated_hexagonal"]()}</option>
          <option value="truncated_trihexagonal">{m["tessellation.truncated_trihexagonal"]()}</option>
          <option value="elongated_triangular">{m["tessellation.elongated_triangular"]()}</option>
          <option value="curved_quadrilateral">{m["tessellation.curved_quadrilateral"]()}</option>
          <option value="radial">{m["tessellation.radial"]()}</option>
        </select>
      </label>
      {TESSELLATION_UI[previewKind].paramSpecs.map((spec) => {
        const label = m[`tessellation.param.${spec.name}` as TessellationParamMessage]();
        if (spec.type === "integer")
          return (
            <SizeParam
              key={`${previewKind}:${spec.name}`}
              label={label}
              value={Number(previewParams[spec.name])}
              min={spec.min}
              max={spec.max}
              onCommit={(value) => setPreviewParams({ ...previewParams, [spec.name]: value })}
            />
          );
        return (
          <label key={`${previewKind}:${spec.name}`} style={styles.label}>
            {label}
            <select
              name={`preview-${spec.name}`}
              style={styles.select}
              value={String(previewParams[spec.name])}
              onChange={(e) => setPreviewParams({ ...previewParams, [spec.name]: e.target.value })}
            >
              {spec.options.map((option) => (
                <option key={option} value={option}>
                  {m[`tessellation.param.${spec.name}.${option}` as TessellationChoiceMessage]()}
                </option>
              ))}
            </select>
          </label>
        );
      })}
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
