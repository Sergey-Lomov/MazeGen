import { useRef, useState } from "react";
import { useMazeStore } from "../store/mazeStore";
import { ToggleRow } from "./ToggleRow";
import { SettingsIconButton } from "./SettingsIconButton";
import { BackgroundImageSettingsPanel } from "./BackgroundImageSettingsPanel";
import { bringSidePanelToFront } from "./SidePanel";
import type { PageLayoutInput } from "./dialogs/BackgroundImagePrintDialog";
import * as m from "~/paraglide/messages";

interface Props {
  onFileSelected: (file: File) => Promise<boolean>;
  onPositionToField: () => void;
  onPositionToPage: () => void;
  onApplyPageLayout: (input: PageLayoutInput) => void;
}

export function BackgroundImageControls({
  onFileSelected,
  onPositionToField,
  onPositionToPage,
  onApplyPageLayout,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showBackgroundImage = useMazeStore((s) => s.showBackgroundImage);
  const backgroundImage = useMazeStore((s) => s.backgroundImage);
  const setShowBackgroundImage = useMazeStore((s) => s.setShowBackgroundImage);
  const setBackgroundAutoFillPreview = useMazeStore((s) => s.setBackgroundAutoFillPreview);

  function disable() {
    setBackgroundAutoFillPreview(null);
    setShowBackgroundImage(false);
    setSettingsOpen(false);
  }

  function enable() {
    if (backgroundImage) {
      setShowBackgroundImage(true);
      return;
    }
    inputRef.current?.click();
  }

  async function handleFile(file: File | undefined) {
    if (!file) {
      disable();
      return;
    }
    if (!await onFileSelected(file)) disable();
  }

  return (
    <>
      <ToggleRow
        label={m["background.show"]()}
        checked={showBackgroundImage}
        onChange={(show) => show ? enable() : disable()}
        action={<SettingsIconButton title={m["background.configure"]()} onClick={() => {
          bringSidePanelToFront("background-image-settings");
          setSettingsOpen(true);
        }} />}
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
        <BackgroundImageSettingsPanel
          inputRef={inputRef}
          onClose={() => { setBackgroundAutoFillPreview(null); setSettingsOpen(false); }}
          onPositionToField={onPositionToField}
          onPositionToPage={onPositionToPage}
          onApplyPageLayout={onApplyPageLayout}
        />
      )}
    </>
  );
}
