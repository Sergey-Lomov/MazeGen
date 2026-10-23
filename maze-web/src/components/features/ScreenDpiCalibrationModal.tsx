import React, { useState } from "react";
import { CreditCard, MoveHorizontal } from "lucide-react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { SliderRow } from "../SliderRow";
import { Stack } from "../Layout";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import {
  CALIBRATION_CARD_WIDTH_MM,
  CALIBRATION_CARD_HEIGHT_MM,
  CALIBRATION_CARD_CORNER_RADIUS_MM,
  CALIBRATION_START_CSS_PPI,
  MIN_CSS_PPI,
  MAX_CSS_PPI,
  mmToCssPx,
  loadCalibratedCssPpi,
  saveCalibratedCssPpi,
} from "../../pixi/imageExport/screenCalibration";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Screen calibration for the print-preview "Physical size (1:1)" zoom (GitHub issue #476). The
 * user holds a standard bank / ID card (ISO/IEC 7810 ID-1, 85.6 mm wide) against the on-screen bar
 * and drags the slider until the widths match; Apply stores the resulting effective CSS PPI in
 * `localStorage` (device property, not project state). */
export function ScreenDpiCalibrationModal({ onClose }: Props) {
  const [draft, setDraft] = useState<number>(() => loadCalibratedCssPpi() ?? CALIBRATION_START_CSS_PPI);

  const barWidth = mmToCssPx(CALIBRATION_CARD_WIDTH_MM, draft);
  const barHeight = mmToCssPx(CALIBRATION_CARD_HEIGHT_MM, draft);
  const barRadius = mmToCssPx(CALIBRATION_CARD_CORNER_RADIUS_MM, draft);

  function handleApply() {
    saveCalibratedCssPpi(draft);
    onClose();
  }

  return (
    <Modal title={m["image_export.calibration.title"]()} size="complex" onClose={onClose} onConfirm={handleApply}>
      <Stack gap="itemGap">
        <span style={typography.body}>{m["image_export.calibration.instruction"]()}</span>

        <div style={styles.barScroll}>
          <div style={{ ...styles.bar, width: barWidth, height: barHeight, borderRadius: barRadius }}>
            <CreditCard size={20} style={{ opacity: 0.5 }} />
            <MoveHorizontal size={16} style={{ position: "absolute", right: 6, opacity: 0.6 }} />
          </div>
        </div>

        <SliderRow
          label={m["image_export.calibration.fit_label"]()}
          value={draft}
          onChange={setDraft}
          min={MIN_CSS_PPI}
          max={MAX_CSS_PPI}
          step={0.5}
          format={(v) => `${v.toFixed(0)} CSS PPI`}
        />

        <span style={{ ...typography.caption, color: ui.text.secondary }}>
          {m["image_export.calibration.warning"]()}
        </span>
      </Stack>

      <div style={styles.footer}>
        <Button variant="secondary" dialogAction layoutStyle={styles.btn} onClick={onClose}>
          {m["image_export.calibration.cancel"]()}
        </Button>
        <Button variant="primary" dialogAction layoutStyle={styles.btn} onClick={handleApply}>
          {m["image_export.calibration.apply"]()}
        </Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  barScroll: {
    overflowX: "auto",
    padding: `${dialogSpacing.paddingY}px 0`,
  },
  bar: {
    position: "relative",
    boxSizing: "border-box",
    border: `2px solid ${ui.accent.base}`,
    background: ui.bg.input,
    display: "flex",
    alignItems: "center",
    paddingLeft: 8,
    color: ui.text.secondary,
    flexShrink: 0,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: dialogSpacing.gap,
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  btn: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
