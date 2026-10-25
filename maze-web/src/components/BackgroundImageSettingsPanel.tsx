import { useState, type RefObject } from "react";
import { useMazeStore } from "../store/mazeStore";
import { BackgroundImageAutoFillControls } from "./BackgroundImageAutoFillControls";
import { BackgroundImageTransformControls } from "./BackgroundImageTransformControls";
import { SidePanel } from "./SidePanel";
import { Button } from "./Button";
import { spacing, inset } from "../styles/theme";
import * as m from "~/paraglide/messages";
import { BackgroundImagePrintDialog, type PageLayoutInput } from "./dialogs/BackgroundImagePrintDialog";

interface Props {
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onPositionToField: () => void;
  onPositionToPage: () => void;
  onApplyPageLayout: (input: PageLayoutInput) => void;
}

export function BackgroundImageSettingsPanel({
  inputRef,
  onClose,
  onPositionToField,
  onPositionToPage,
  onApplyPageLayout,
}: Props) {
  const backgroundImage = useMazeStore((s) => s.backgroundImage);
  const showPaperLayout = useMazeStore((s) => s.showPaperLayout);
  const openCard = useMazeStore((s) => s.openCard);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const backgroundImageManualPositioning = useMazeStore((s) => s.backgroundImageManualPositioning);
  const backgroundImageCropping = useMazeStore((s) => s.backgroundImageCropping);
  const setBackgroundImageLayer = useMazeStore((s) => s.setBackgroundImageLayer);
  const setBackgroundImageOpacity = useMazeStore((s) => s.setBackgroundImageOpacity);
  const setBackgroundImageManualPositioning = useMazeStore((s) => s.setBackgroundImageManualPositioning);
  const setBackgroundImageCropping = useMazeStore((s) => s.setBackgroundImageCropping);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const hasDisplayedPaperLayout = openCard === "field_setup" && fieldEditMode === "custom" && showPaperLayout;

  return (
    <>
      <SidePanel title={m["background.settings_title"]()} stackKey="background-image-settings" onClose={onClose}>
        <div style={styles.panelBody}>
          {backgroundImage && (
            <>
              <BackgroundImageTransformControls
                backgroundImage={backgroundImage}
                backgroundImageCropping={backgroundImageCropping}
                backgroundImageManualPositioning={backgroundImageManualPositioning}
                hasDisplayedPaperLayout={hasDisplayedPaperLayout}
                onLayerChange={setBackgroundImageLayer}
                onOpacityChange={setBackgroundImageOpacity}
                onCroppingChange={setBackgroundImageCropping}
                onManualPositioningChange={setBackgroundImageManualPositioning}
                onPositionToField={onPositionToField}
                onPositionToPage={onPositionToPage}
                onOpenPrintDialog={() => setPrintDialogOpen(true)}
                onReplace={() => inputRef.current?.click()}
              />
              <BackgroundImageAutoFillControls
                enabled={openCard === "field_setup" && fieldEditMode === "custom"}
              />
            </>
          )}
          {!backgroundImage && (
            <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={() => inputRef.current?.click()}>
              {m["background.replace"]()}
            </Button>
          )}
        </div>
      </SidePanel>
      {printDialogOpen && backgroundImage && (
        <BackgroundImagePrintDialog
          onApply={onApplyPageLayout}
          onClose={() => setPrintDialogOpen(false)}
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
};
