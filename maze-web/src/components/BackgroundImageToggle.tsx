import { useRef } from "react";
import { useMazeStore } from "../store/mazeStore";
import { resolveCells } from "../pixi/fieldEditUtils";
import { calculateBackgroundImageLayout, fieldBounds } from "../pixi/BackgroundImageLayer";
import { ToggleRow } from "./ToggleRow";
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
  const showBackgroundImage = useMazeStore((s) => s.showBackgroundImage);
  const backgroundImage = useMazeStore((s) => s.backgroundImage);
  const setShowBackgroundImage = useMazeStore((s) => s.setShowBackgroundImage);
  const setBackgroundImage = useMazeStore((s) => s.setBackgroundImage);

  function enable() {
    if (backgroundImage) {
      const { bounds } = currentFieldLayout();
      if (!bounds) return;
      setBackgroundImage(calculateBackgroundImageLayout(
        backgroundImage.dataUrl,
        backgroundImage.naturalWidth,
        backgroundImage.naturalHeight,
        bounds,
      ));
      return;
    }
    inputRef.current?.click();
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
      setBackgroundImage(calculateBackgroundImageLayout(
        loaded.dataUrl,
        loaded.width,
        loaded.height,
        bounds,
      ));
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
    </>
  );
}
