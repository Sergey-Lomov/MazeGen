import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { floorTopologyInfo } from "../../store/topologyInfo";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { SidePanel } from "../SidePanel";
import { GlueEditorPanel } from "./GlueEditorPanel";
import { GlueCell, glueDotColors } from "./GlueCell";
import { TopologyProblemBubble } from "./TopologyProblemBubble";
import { Stack } from "../Layout";
import { typography, disabled, spacing, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Glue editor side panel of the field setup card (GitHub issue #839). A glue is a set of cell-face
 * pairs; the panel lists every glue with its pairs (hovering a glue highlights its faces on the
 * canvas) and glues two boundary runs picked on the canvas. All state lives in
 * the store; the canvas side is `TopologyBandRenderer` in `FieldEditorOverlay`. */
export function TopologyPanel({ onClose }: { onClose: () => void }) {
  const fieldConfig = useMazeStore((s) => s.floorFields[s.activeFloorId]?.fieldConfig);
  const topology = useMazeStore((s) => s.floorTopology[s.activeFloorId] ?? null);
  const result = useMazeStore((s) => floorTopologyInfo(s, s.activeFloorId));
  const locked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);
  const clearRuns = useMazeStore((s) => s.clearTopologyRuns);
  const glueEditor = useMazeStore((s) => s.topologyGlueEditor);
  const openGlueEditor = useMazeStore((s) => s.openTopologyGlueEditor);
  const removeGroup = useMazeStore((s) => s.removeTopologyGroup);
  const clearGroups = useMazeStore((s) => s.clearTopologyGroups);
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false);
  const setHover = useMazeStore((s) => s.setTopologyHover);
  const panelError = useMazeStore((s) => s.topologyPanelError);

  function close() {
    setHover(null);
    clearRuns();
    onClose();
  }

  if (!result.ok) {
    return (
      <SidePanel title={m["topology.title"]()} stackKey="topology" onClose={close}>
        <Stack gap="groupGap" style={styles.panelBody}>
          <TopologyProblemBubble problem={{ code: "internal", message: result.error }} cfg={fieldConfig} />
        </Stack>
      </SidePanel>
    );
  }
  const { info } = result;
  const glues = topology?.groups ?? [];
  const dotColors = glueDotColors(fieldConfig, topology);

  return (
    <>
    <SidePanel title={m["topology.title"]()} stackKey="topology" onClose={close}>
      {panelError !== null && (
        <Stack gap="groupGap" style={styles.panelBody}>
          <TopologyProblemBubble problem={panelError} cfg={fieldConfig} />
        </Stack>
      )}
      <div style={styles.list}>
        {glues.length === 0 && <div style={styles.empty}>{m["topology.no_glues"]()}</div>}
        {glues.map((glueItem) => (
          <GlueCell
            key={glueItem.id}
            glue={glueItem}
            topology={topology!}
            info={info}
            fieldConfig={fieldConfig}
            dotColor={dotColors.get(glueItem.id) ?? null}
            setHover={setHover}
            editing={{ canEdit: !locked, onEdit: () => openGlueEditor(glueItem.id), onDelete: () => removeGroup(glueItem.id) }}
          />
        ))}
      </div>

      <Stack gap="groupGap" style={styles.panelBody}>
        <Button variant="primary" disabled={locked} onClick={() => openGlueEditor()}>
          {m["topology.add"]()}
        </Button>
        <Button variant="destructive" disabled={locked || glues.length === 0} onClick={() => setDeleteAllOpen(true)}>
          {m["topology.delete_all"]()}
        </Button>
      </Stack>
    </SidePanel>
    {deleteAllOpen && (
      <ConfirmModal
        message={m["topology.confirm_delete_all"]()}
        onConfirm={() => {
          setDeleteAllOpen(false);
          clearGroups();
        }}
        onCancel={() => setDeleteAllOpen(false)}
      />
    )}
    {glueEditor !== null && <GlueEditorPanel />}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panelBody: { padding: spacing.groupGap },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
};
