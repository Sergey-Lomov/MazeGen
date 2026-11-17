import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { SelectableList, SelectableRow } from "../SelectableList";
import { CopyDialogText, CopyDialogSection, CopyTopologyOption, copyDialogListStyle } from "./CopyFieldDialogParts";
import { radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  /** The floor that receives the copied field. */
  targetFloorId: string;
  onClose: () => void;
}

export function CopyFloorDialog({ targetFloorId, onClose }: Props) {
  const floors = useMazeStore((s) => s.floors);
  const copyFloorField = useMazeStore((s) => s.copyFloorField);

  // Topmost floor first; the receiving floor is named in the text instead of listed.
  const sources = [...floors].reverse().filter((floor) => floor.id !== targetFloorId);
  const targetTitle = floors.find((floor) => floor.id === targetFloorId)?.title ?? "";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeTopology, setIncludeTopology] = useState(true);

  function handleConfirm() {
    if (!selectedId) return;
    copyFloorField(selectedId, includeTopology, targetFloorId);
    onClose();
  }

  return (
    <Modal title={m["field.copy_floor_title"]()} size="approve" onClose={onClose} onConfirm={selectedId ? handleConfirm : undefined}>
      <CopyDialogText>{m["field.copy_floor_text"]({ floor: targetTitle })}</CopyDialogText>
      <CopyDialogSection label={m["field.copy_floor_from"]()}>
        <SelectableList
          appearance="dialog"
          autoFocus
          compact
          selected={selectedId}
          values={sources.map((floor) => floor.id)}
          onSelect={setSelectedId}
          ariaLabel={m["field.copy_floor_from"]()}
          style={copyDialogListStyle}
        >
          {sources.map((floor) => (
            <SelectableRow key={floor.id} value={floor.id} selected={floor.id === selectedId} indented>
              {floor.title}
            </SelectableRow>
          ))}
        </SelectableList>
      </CopyDialogSection>
      <CopyTopologyOption checked={includeTopology} onChange={setIncludeTopology} />
      <Button variant="primary" dialogAction layoutStyle={styles.btn} disabled={!selectedId} onClick={handleConfirm}>
        {m["common.confirm"]()}
      </Button>
    </Modal>
  );
}

// Footer button styling mirrors `ConfirmModal`.
const styles: Record<string, React.CSSProperties> = {
  btn: {
    ...typography.control,
    width: "100%",
    marginTop: dialogSpacing.gap / 2,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
