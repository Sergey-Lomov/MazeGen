import type { BackgroundImage, BackgroundImageLayerMode } from "../store/tessellationTypes";
import { Button } from "./Button";
import { SelectRow } from "./SelectRow";
import { SliderRow } from "./SliderRow";
import { spacing } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  backgroundImage: BackgroundImage;
  backgroundImageCropping: boolean;
  backgroundImageManualPositioning: boolean;
  hasDisplayedPaperLayout: boolean;
  onLayerChange: (layer: BackgroundImageLayerMode) => void;
  onOpacityChange: (opacity: number) => void;
  onCroppingChange: (enabled: boolean) => void;
  onManualPositioningChange: (enabled: boolean) => void;
  onPositionToField: () => void;
  onPositionToPage: () => void;
  onOpenPrintDialog: () => void;
  onReplace: () => void;
}

export function BackgroundImageTransformControls({
  backgroundImage,
  backgroundImageCropping,
  backgroundImageManualPositioning,
  hasDisplayedPaperLayout,
  onLayerChange,
  onOpacityChange,
  onCroppingChange,
  onManualPositioningChange,
  onPositionToField,
  onPositionToPage,
  onOpenPrintDialog,
  onReplace,
}: Props) {
  return (
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
        onChange={(value) => onLayerChange(value as BackgroundImageLayerMode)}
      />
      <SliderRow
        label={m["background.opacity"]()}
        value={backgroundImage.opacity}
        onChange={onOpacityChange}
      />
      <div style={styles.buttonGroup}>
        <div style={styles.modeButtonGroup}>
          <Button
            data-background-image-mode-control="true"
            variant={backgroundImageCropping ? "toggle-selected" : "secondary"}
            layoutStyle={{ flex: 1 }}
            aria-pressed={backgroundImageCropping}
            onClick={() => onCroppingChange(!backgroundImageCropping)}
          >
            {m["background.crop"]()}
          </Button>
          <Button
            data-background-image-mode-control="true"
            variant={backgroundImageManualPositioning ? "toggle-selected" : "secondary"}
            layoutStyle={{ flex: 1 }}
            aria-pressed={backgroundImageManualPositioning}
            onClick={() => onManualPositioningChange(!backgroundImageManualPositioning)}
          >
            {m["background.transform"]()}
          </Button>
        </div>
        <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={onPositionToField}>
          {m["background.position_to_field"]()}
        </Button>
        <Button
          variant="secondary"
          layoutStyle={{ width: "100%" }}
          onClick={hasDisplayedPaperLayout ? onPositionToPage : onOpenPrintDialog}
        >
          {m["background.calculate_for_print"]()}
        </Button>
        <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={onReplace}>
          {m["background.replace"]()}
        </Button>
      </div>
    </>
  );
}

const styles = {
  buttonGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: spacing.itemGap,
  },
  modeButtonGroup: {
    display: "flex",
    gap: spacing.itemGap,
  },
};
