import { useEffect, useRef, useState } from "react";
import { useMazeStore } from "../store/mazeStore";
import type { BackgroundAutoFillMode } from "../store/tessellationTypes";
import { buildBackgroundFieldPreviewFromImage, getBackgroundImageTopLeftColor } from "../pixi/backgroundFieldAutofill";
import { UnregisteredColorRow } from "./ColorRow";
import { ConfirmModal } from "./ConfirmModal";
import { SectionHeader } from "./SectionHeader";
import { SelectRow } from "./SelectRow";
import { SliderRow } from "./SliderRow";
import { Button } from "./Button";
import { hasOpenModal } from "./Modal";
import { indent, spacing } from "../styles/theme";
import * as m from "~/paraglide/messages";

const BACKGROUND_AUTOFILL_DEBOUNCE_MS = 150;

interface Props {
  enabled: boolean;
}

export function BackgroundImageAutoFillControls({ enabled }: Props) {
  const backgroundImage = useMazeStore((s) => s.backgroundImage);
  const autoFillTessellationConfig = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const backgroundAutoFillPreview = useMazeStore((s) => s.backgroundAutoFillPreview);
  const setBackgroundAutoFillPreview = useMazeStore((s) => s.setBackgroundAutoFillPreview);
  const applyBackgroundAutoFill = useMazeStore((s) => s.applyBackgroundAutoFill);
  const [autoFillSectionOpen, setAutoFillSectionOpen] = useState(true);
  const [autoFillMode, setAutoFillMode] = useState<BackgroundAutoFillMode>("transparent");
  const [autoFillColor, setAutoFillColor] = useState(0xffffff);
  const [autoFillThreshold, setAutoFillThreshold] = useState(0.5);
  const [autoFillPreviewActive, setAutoFillPreviewActive] = useState(false);
  const [autoFillCalculating, setAutoFillCalculating] = useState(false);
  const [autoFillThresholdAdjusting, setAutoFillThresholdAdjusting] = useState(false);
  const [autoFillError, setAutoFillError] = useState(false);
  const [autoFillConfirmOpen, setAutoFillConfirmOpen] = useState(false);
  const [pendingAutoFill, setPendingAutoFill] = useState<Set<number> | null>(null);
  const autoFillRequest = useRef(0);

  useEffect(() => {
    if (!enabled || autoFillMode !== "color" || !backgroundImage) return;
    let active = true;
    void getBackgroundImageTopLeftColor(backgroundImage.dataUrl).then((color) => {
      if (active) setAutoFillColor(color);
    }).catch(() => {
      // Keep the safe default when the source image cannot be decoded for color sampling.
    });
    return () => { active = false; };
    // The inferred color is intentionally refreshed only when the detection mode changes.
    // Manual color edits and other auto-fill setting changes must remain untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, autoFillMode]);

  function cancelAutoFillPreview() {
    autoFillRequest.current++;
    setAutoFillPreviewActive(false);
    setAutoFillCalculating(false);
    setAutoFillThresholdAdjusting(false);
    setAutoFillError(false);
    setPendingAutoFill(null);
    setAutoFillConfirmOpen(false);
    setBackgroundAutoFillPreview(null);
  }

  function startAutoFillPreview() {
    const state = useMazeStore.getState();
    setBackgroundAutoFillPreview(new Set(state.floorFields[state.activeFloorId].fieldPoints));
    setAutoFillCalculating(true);
    setAutoFillError(false);
    setAutoFillPreviewActive(true);
  }

  async function calculateAutoFill(): Promise<Set<number> | null> {
    const state = useMazeStore.getState();
    const image = state.backgroundImage;
    if (!image || state.openCard !== "field_setup" || state.floorFields[state.activeFloorId].fieldEditMode !== "custom") return null;
    return buildBackgroundFieldPreviewFromImage(
      image,
      state.floorFields[state.activeFloorId].tessellationConfig,
      autoFillMode,
      autoFillColor,
      autoFillThreshold,
    );
  }

  async function requestAutoFillConfirmation() {
    if (autoFillCalculating || autoFillError) return;
    let candidate = backgroundAutoFillPreview;
    if (candidate === null) {
      setAutoFillCalculating(true);
      setAutoFillError(false);
      try {
        candidate = await calculateAutoFill();
      } catch {
        setAutoFillError(true);
      } finally {
        setAutoFillCalculating(false);
      }
    }
    if (candidate === null) return;
    setPendingAutoFill(new Set(candidate));
    setAutoFillConfirmOpen(true);
  }

  function confirmAutoFill() {
    if (!pendingAutoFill) return;
    applyBackgroundAutoFill(pendingAutoFill);
    cancelAutoFillPreview();
  }

  useEffect(() => {
    if (!enabled || !autoFillPreviewActive || !backgroundImage) return;
    const request = ++autoFillRequest.current;
    setAutoFillCalculating(true);
    setAutoFillError(false);
    const timeout = window.setTimeout(() => {
      void buildBackgroundFieldPreviewFromImage(
        backgroundImage,
        autoFillTessellationConfig,
        autoFillMode,
        autoFillColor,
        autoFillThreshold,
      ).then((points) => {
        if (request !== autoFillRequest.current) return;
        setBackgroundAutoFillPreview(points);
        setAutoFillCalculating(false);
      }).catch(() => {
        if (request !== autoFillRequest.current) return;
        setAutoFillError(true);
        setAutoFillCalculating(false);
      });
    }, BACKGROUND_AUTOFILL_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timeout);
      autoFillRequest.current++;
    };
  }, [enabled, autoFillPreviewActive, backgroundImage, autoFillTessellationConfig, autoFillMode, autoFillColor, autoFillThreshold, setBackgroundAutoFillPreview]);

  useEffect(() => {
    if (!enabled && (autoFillPreviewActive || backgroundAutoFillPreview !== null || autoFillConfirmOpen)) {
      cancelAutoFillPreview();
    }
  }, [enabled, autoFillPreviewActive, backgroundAutoFillPreview, autoFillConfirmOpen]);

  useEffect(() => () => {
    setBackgroundAutoFillPreview(null);
  }, [setBackgroundAutoFillPreview]);

  useEffect(() => {
    if (!enabled || !autoFillPreviewActive) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (hasOpenModal()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        cancelAutoFillPreview();
      } else if (event.key === "Enter" && !autoFillCalculating) {
        event.preventDefault();
        void requestAutoFillConfirmation();
      }
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [enabled, autoFillPreviewActive, autoFillCalculating]);

  if (!enabled) return null;

  return (
    <>
      <div style={styles.autoFillSection}>
        <SectionHeader
          label={m["background.autofill.section"]()}
          expanded={autoFillSectionOpen}
          onToggle={() => setAutoFillSectionOpen((open) => !open)}
        />
        {autoFillSectionOpen && (
          <div style={styles.autoFillBody}>
            <SelectRow
              label={m["background.autofill.mode"]()}
              value={autoFillMode}
              options={[
                { value: "transparent", label: m["background.autofill.mode.transparent"]() },
                { value: "color", label: m["background.autofill.mode.color"]() },
              ]}
              onChange={(value) => setAutoFillMode(value as BackgroundAutoFillMode)}
            />
            {autoFillMode === "color" && (
              <UnregisteredColorRow
                label={m["background.autofill.color"]()}
                color={autoFillColor}
                onChange={setAutoFillColor}
              />
            )}
            <SliderRow
              label={m["background.autofill.threshold"]()}
              value={autoFillThreshold}
              min={0}
              max={1}
              step={0.01}
              format={(value) => `${Math.round(value * 100)}%`}
              onChange={setAutoFillThreshold}
              onPointerDown={() => setAutoFillThresholdAdjusting(true)}
              onPointerUp={() => setAutoFillThresholdAdjusting(false)}
              onPointerCancel={() => setAutoFillThresholdAdjusting(false)}
              onBlur={() => setAutoFillThresholdAdjusting(false)}
            />
            <div style={styles.autoFillButtons}>
              <Button
                variant={autoFillPreviewActive ? "toggle-selected" : "secondary"}
                layoutStyle={{ flex: 1 }}
                aria-pressed={autoFillPreviewActive}
                disabled={autoFillCalculating && !autoFillPreviewActive}
                onClick={() => autoFillPreviewActive ? cancelAutoFillPreview() : startAutoFillPreview()}
              >
                {m["background.autofill.preview"]()}
              </Button>
              <Button
                variant="primary"
                layoutStyle={{ flex: 1 }}
                disabled={autoFillCalculating || autoFillThresholdAdjusting || autoFillError}
                onClick={() => void requestAutoFillConfirmation()}
              >
                {m["background.autofill.confirm"]()}
              </Button>
            </div>
            {autoFillError && <div style={styles.autoFillError}>{m["background.autofill.error"]()}</div>}
          </div>
        )}
      </div>
      {autoFillConfirmOpen && (
        <ConfirmModal
          title={m["background.autofill.warning_title"]()}
          message={m["background.autofill.warning"]()}
          onConfirm={confirmAutoFill}
          onCancel={() => setAutoFillConfirmOpen(false)}
        />
      )}
    </>
  );
}

const styles = {
  autoFillSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: spacing.itemGap,
    borderTop: "1px solid rgba(255, 255, 255, 0.12)",
    paddingTop: spacing.sectionGap,
  },
  autoFillBody: {
    display: "flex",
    flexDirection: "column" as const,
    gap: spacing.itemGap,
    paddingLeft: indent.tree,
  },
  autoFillButtons: {
    display: "flex",
    gap: spacing.itemGap,
  },
  autoFillError: {
    color: "#f28b82",
    fontSize: 12,
  },
};
