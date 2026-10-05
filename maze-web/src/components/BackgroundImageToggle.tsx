import { useRef, useState } from "react";
import { useMazeStore } from "../store/mazeStore";
import type { BackgroundImageLayerMode } from "../store/tessellationTypes";
import { resolveCells } from "../pixi/fieldEditUtils";
import { calculateBackgroundImageLayout, fieldBounds } from "../pixi/BackgroundImageLayer";
import { ToggleRow } from "./ToggleRow";
import { SettingsIconButton } from "./SettingsIconButton";
import { SidePanel } from "./SidePanel";
import { SelectRow } from "./SelectRow";
import { SliderRow } from "./SliderRow";
import { Button } from "./Button";
import { spacing, inset } from "../styles/theme";
import * as m from "~/paraglide/messages";

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
  const backgroundImageManualPositioning = useMazeStore((s) => s.backgroundImageManualPositioning);
  const setShowBackgroundImage = useMazeStore((s) => s.setShowBackgroundImage);
  const setBackgroundImage = useMazeStore((s) => s.setBackgroundImage);
  const setBackgroundImageLayer = useMazeStore((s) => s.setBackgroundImageLayer);
  const setBackgroundImageOpacity = useMazeStore((s) => s.setBackgroundImageOpacity);
  const setBackgroundImageManualPositioning = useMazeStore((s) => s.setBackgroundImageManualPositioning);

  function enable() {
    if (backgroundImage) {
      setShowBackgroundImage(true);
      return;
    }
    inputRef.current?.click();
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
    );
    setBackgroundImage({ ...layout, layer: backgroundImage.layer, opacity: backgroundImage.opacity });
  }

  async function handleFile(file: File | undefined) {
    if (!file) {
      setShowBackgroundImage(false);
      return;
    }
    try {
      const loaded = await readImageFile(file);
      const { bounds } = currentFieldLayout();
      if (!bounds) {
        setShowBackgroundImage(false);
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
      setShowBackgroundImage(false);
    }
  }

  return (
    <>
      <ToggleRow
        label={m["background.show"]()}
        checked={showBackgroundImage}
        onChange={(show) => show ? enable() : setShowBackgroundImage(false)}
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
        <SidePanel title={m["background.settings_title"]()} onClose={() => setSettingsOpen(false)}>
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
                  <Button
                    variant={backgroundImageManualPositioning ? "toggle-selected" : "toggle"}
                    layoutStyle={{ width: "100%" }}
                    onClick={() => setBackgroundImageManualPositioning(true)}
                  >
                    {m["background.manual_positioning"]()}
                  </Button>
                  <Button variant="toggle" layoutStyle={{ width: "100%" }} onClick={positionToField}>
                    {m["background.position_to_field"]()}
                  </Button>
                  <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={() => inputRef.current?.click()}>
                    {m["background.replace"]()}
                  </Button>
                </div>
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
};
