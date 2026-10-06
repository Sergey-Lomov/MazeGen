import { useEffect, useRef, useState } from "react";
import { useMazeStore } from "../store/mazeStore";
import type { BackgroundAutoFillMode, BackgroundImageLayerMode } from "../store/tessellationTypes";
import { resolveCells } from "../pixi/fieldEditUtils";
import { backgroundImageCrop, calculateBackgroundImageLayout, calculateBackgroundImagePageLayout, fieldBounds } from "../pixi/BackgroundImageLayer";
import { buildBackgroundFieldPreviewFromImage, getBackgroundImageTopLeftColor } from "../pixi/backgroundFieldAutofill";
import { ToggleRow } from "./ToggleRow";
import { SettingsIconButton } from "./SettingsIconButton";
import { SidePanel } from "./SidePanel";
import { SelectRow } from "./SelectRow";
import { SliderRow } from "./SliderRow";
import { Button } from "./Button";
import { ColorRow } from "./ColorRow";
import { SectionHeader } from "./SectionHeader";
import { hasOpenModal } from "./Modal";
import { ConfirmModal } from "./ConfirmModal";
import { spacing, inset, indent } from "../styles/theme";
import * as m from "~/paraglide/messages";
import { BackgroundImagePrintDialog, type PageLayoutInput } from "./dialogs/BackgroundImagePrintDialog";

function readImageFile(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        reject(new Error("Image file did not produce a data URL"));
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          reject(new Error("Image has invalid dimensions"));
          return;
        }
        resolve({ dataUrl, width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => reject(new Error("Failed to decode image"));
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function currentFieldLayout() {
  const state = useMazeStore.getState();
  const field = state.floorFields[state.activeFloorId];
  const customPoints = field.fieldEditMode === "custom" && field.fieldPoints.size > 0
    ? field.fieldPoints
    : undefined;
  const cells = resolveCells(field.tessellationConfig, customPoints);
  return { bounds: fieldBounds(cells, field.tessellationConfig) };
}

export function BackgroundImageToggle() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showBackgroundImage = useMazeStore((s) => s.showBackgroundImage);
  const backgroundImage = useMazeStore((s) => s.backgroundImage);
  const showPaperLayout = useMazeStore((s) => s.showPaperLayout);
  const openCard = useMazeStore((s) => s.openCard);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const autoFillTessellationConfig = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const setShowBackgroundImage = useMazeStore((s) => s.setShowBackgroundImage);
  const setBackgroundImage = useMazeStore((s) => s.setBackgroundImage);
  const setBackgroundImageLayer = useMazeStore((s) => s.setBackgroundImageLayer);
  const setBackgroundImageOpacity = useMazeStore((s) => s.setBackgroundImageOpacity);
  const setBackgroundImageManualPositioning = useMazeStore((s) => s.setBackgroundImageManualPositioning);
  const backgroundImageManualPositioning = useMazeStore((s) => s.backgroundImageManualPositioning);
  const setBackgroundImageCropping = useMazeStore((s) => s.setBackgroundImageCropping);
  const backgroundImageCropping = useMazeStore((s) => s.backgroundImageCropping);
  const setPrintPaperSize = useMazeStore((s) => s.setPrintPaperSize);
  const setPrintCustomSize = useMazeStore((s) => s.setPrintCustomSize);
  const setPrintOrientation = useMazeStore((s) => s.setPrintOrientation);
  const setPrintMargins = useMazeStore((s) => s.setPrintMargins);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const hasDisplayedPaperLayout = openCard === "field_setup" && fieldEditMode === "custom" && showPaperLayout;
  const [autoFillSectionOpen, setAutoFillSectionOpen] = useState(true);
  const [autoFillMode, setAutoFillMode] = useState<BackgroundAutoFillMode>("transparent");
  const [autoFillColor, setAutoFillColor] = useState(0xffffff);
  const [autoFillThreshold, setAutoFillThreshold] = useState(0.5);
  const [autoFillPreviewActive, setAutoFillPreviewActive] = useState(false);
  const [autoFillCalculating, setAutoFillCalculating] = useState(false);
  const [autoFillError, setAutoFillError] = useState(false);
  const [autoFillConfirmOpen, setAutoFillConfirmOpen] = useState(false);
  const [pendingAutoFill, setPendingAutoFill] = useState<Set<number> | null>(null);
  const autoFillRequest = useRef(0);
  const backgroundAutoFillPreview = useMazeStore((s) => s.backgroundAutoFillPreview);
  const setBackgroundAutoFillPreview = useMazeStore((s) => s.setBackgroundAutoFillPreview);
  const applyBackgroundAutoFill = useMazeStore((s) => s.applyBackgroundAutoFill);
  const canAutoFill = settingsOpen && openCard === "field_setup" && fieldEditMode === "custom" && backgroundImage !== null;

  useEffect(() => {
    if (autoFillMode !== "color" || !backgroundImage) return;
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
  }, [autoFillMode]);

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

  function cancelAutoFillPreview() {
    autoFillRequest.current++;
    setAutoFillPreviewActive(false);
    setAutoFillCalculating(false);
    setAutoFillError(false);
    setPendingAutoFill(null);
    setBackgroundAutoFillPreview(null);
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
    setAutoFillConfirmOpen(false);
    cancelAutoFillPreview();
  }

  useEffect(() => {
    if (!autoFillPreviewActive || !canAutoFill || !backgroundImage) return;
    const request = ++autoFillRequest.current;
    setAutoFillCalculating(true);
    setAutoFillError(false);
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
    return () => { autoFillRequest.current++; };
  }, [autoFillPreviewActive, canAutoFill, backgroundImage, autoFillTessellationConfig, autoFillMode, autoFillColor, autoFillThreshold, setBackgroundAutoFillPreview]);

  useEffect(() => {
    if (!canAutoFill && (autoFillPreviewActive || backgroundAutoFillPreview !== null)) {
      cancelAutoFillPreview();
    }
  }, [canAutoFill, autoFillPreviewActive, backgroundAutoFillPreview]);

  useEffect(() => () => {
    setBackgroundAutoFillPreview(null);
  }, [setBackgroundAutoFillPreview]);

  useEffect(() => {
    if (!autoFillPreviewActive) return;
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
  }, [autoFillPreviewActive, autoFillCalculating]);

  function enable() {
    if (backgroundImage) {
      setShowBackgroundImage(true);
      return;
    }
    inputRef.current?.click();
  }

  function disable() {
    cancelAutoFillPreview();
    setSettingsOpen(false);
    setShowBackgroundImage(false);
  }

  function positionToField() {
    if (!backgroundImage) return;
    const { bounds } = currentFieldLayout();
    if (!bounds) return;
    const layout = calculateBackgroundImageLayout(
      backgroundImage.dataUrl,
      backgroundImage.naturalWidth,
      backgroundImage.naturalHeight,
      bounds,
      backgroundImageCrop(backgroundImage),
    );
    setBackgroundImage({
      ...layout,
      layer: backgroundImage.layer,
      opacity: backgroundImage.opacity,
    });
  }

  function positionToPage() {
    if (!backgroundImage) return;
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    try {
      const layout = calculateBackgroundImagePageLayout(
        backgroundImage.dataUrl,
        backgroundImage.naturalWidth,
        backgroundImage.naturalHeight,
        field.tessellationConfig,
        state.pngExportSettings.print,
        backgroundImageCrop(backgroundImage),
      );
      state.setBackgroundImage({
        ...layout,
        layer: backgroundImage.layer,
        opacity: backgroundImage.opacity,
      });
    } catch {
      // Invalid persisted print settings are ignored; the existing image transform remains intact.
    }
  }

  function applyPageLayout(input: PageLayoutInput) {
    setPrintPaperSize(input.paperSize);
    setPrintCustomSize(input.customWidthMm, input.customHeightMm);
    setPrintOrientation(input.orientation);
    setPrintMargins(input.marginHMm, input.marginVMm);
    positionToPage();
  }

  async function handleFile(file: File | undefined) {
    if (!file) {
      disable();
      return;
    }
    try {
      const loaded = await readImageFile(file);
      const { bounds } = currentFieldLayout();
      if (!bounds) {
        disable();
        return;
      }
      const layout = calculateBackgroundImageLayout(
        loaded.dataUrl,
        loaded.width,
        loaded.height,
        bounds,
      );
      setBackgroundImage({
        ...layout,
        layer: backgroundImage?.layer ?? "below_grid",
        opacity: backgroundImage?.opacity ?? 0.5,
      });
    } catch {
      disable();
    }
  }

  return (
    <>
      <ToggleRow
        label={m["background.show"]()}
        checked={showBackgroundImage}
        onChange={(show) => show ? enable() : disable()}
        action={<SettingsIconButton title={m["background.configure"]()} onClick={() => setSettingsOpen(true)} />}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label={m["background.upload"]()}
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void handleFile(file);
        }}
      />
      {settingsOpen && (
        <SidePanel title={m["background.settings_title"]()} onClose={() => { cancelAutoFillPreview(); setSettingsOpen(false); }}>
          <div style={styles.panelBody}>
            {backgroundImage && (
              <>
                <SelectRow
                  label={m["background.layer"]()}
                  value={backgroundImage.layer}
                  options={[
                    { value: "below_grid", label: m["background.layer.below_grid"]() },
                    { value: "above_grid", label: m["background.layer.above_grid"]() },
                    { value: "above_floor", label: m["background.layer.above_floor"]() },
                    { value: "above_everything", label: m["background.layer.above_everything"]() },
                  ]}
                  onChange={(value) => setBackgroundImageLayer(value as BackgroundImageLayerMode)}
                />
                <SliderRow
                  label={m["background.opacity"]()}
                  value={backgroundImage.opacity}
                  onChange={setBackgroundImageOpacity}
                />
                <div style={styles.buttonGroup}>
                  <div style={styles.modeButtonGroup}>
                    <Button
                      data-background-image-mode-control="true"
                      variant={backgroundImageCropping ? "toggle-selected" : "secondary"}
                      layoutStyle={{ flex: 1 }}
                      aria-pressed={backgroundImageCropping}
                      onClick={() => setBackgroundImageCropping(!backgroundImageCropping)}
                    >
                      {m["background.crop"]()}
                    </Button>
                    <Button
                      data-background-image-mode-control="true"
                      variant={backgroundImageManualPositioning ? "toggle-selected" : "secondary"}
                      layoutStyle={{ flex: 1 }}
                      aria-pressed={backgroundImageManualPositioning}
                      onClick={() => setBackgroundImageManualPositioning(!backgroundImageManualPositioning)}
                    >
                      {m["background.transform"]()}
                    </Button>
                  </div>
                  <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={positionToField}>
                    {m["background.position_to_field"]()}
                  </Button>
                  <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={() => hasDisplayedPaperLayout ? positionToPage() : setPrintDialogOpen(true)}>
                    {m["background.calculate_for_print"]()}
                  </Button>
                  <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={() => inputRef.current?.click()}>
                    {m["background.replace"]()}
                  </Button>
                </div>
                {canAutoFill && (
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
                          <ColorRow
                            label={m["background.autofill.color"]()}
                            color={autoFillColor}
                            onChange={setAutoFillColor}
                            fieldName={m["background.autofill.color"]()}
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
                        />
                        <div style={styles.autoFillButtons}>
                          <Button
                            variant={autoFillPreviewActive ? "toggle-selected" : "secondary"}
                            layoutStyle={{ flex: 1 }}
                            aria-pressed={autoFillPreviewActive}
                            disabled={autoFillCalculating && !autoFillPreviewActive}
                            onClick={() => autoFillPreviewActive ? cancelAutoFillPreview() : setAutoFillPreviewActive(true)}
                          >
                            {m["background.autofill.preview"]()}
                          </Button>
                          <Button
                            variant="primary"
                            layoutStyle={{ flex: 1 }}
                            disabled={autoFillCalculating || autoFillError}
                            onClick={() => void requestAutoFillConfirmation()}
                          >
                            {m["background.autofill.confirm"]()}
                          </Button>
                        </div>
                        {autoFillError && <div style={styles.autoFillError}>{m["background.autofill.error"]()}</div>}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {!backgroundImage && (
              <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={() => inputRef.current?.click()}>
                {m["background.replace"]()}
              </Button>
            )}
          </div>
        </SidePanel>
      )}
      {printDialogOpen && backgroundImage && (
        <BackgroundImagePrintDialog
          onApply={applyPageLayout}
          onClose={() => setPrintDialogOpen(false)}
        />
      )}
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
  panelBody: {
    display: "flex",
    flexDirection: "column" as const,
    gap: spacing.sectionGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
  },
  buttonGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: spacing.itemGap,
  },
  modeButtonGroup: {
    display: "flex",
    gap: spacing.itemGap,
  },
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
