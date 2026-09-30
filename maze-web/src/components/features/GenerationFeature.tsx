import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { AlgorithmSelectDialog, getAlgorithmLabel } from "../dialogs/AlgorithmSelectDialog";
import { SeedHistoryDialog } from "../dialogs/SeedHistoryDialog";
import { ConfirmModal } from "../ConfirmModal";
import { VertexBasedSettingsPanel } from "./VertexBasedSettingsPanel";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { SettingsIconButton } from "../SettingsIconButton";
import { ui, radius, typography, muted, spacing, inset, indent } from "../../styles/theme";
import { Switch } from "../Switch";
import { selectPostEditDirty } from "../../pixi/selectors/mazeSelectors";
import * as m from "~/paraglide/messages";

interface Props {
  canGenerate: boolean;
}

export function GenerationFeature({ canGenerate }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const randomSeed = useMazeStore((s) => s.randomSeed);
  const seedHistory = useMazeStore((s) => s.seedHistory);
  const seedHistoryIndex = useMazeStore((s) => s.seedHistoryIndex);
  const generationStatus = useMazeStore((s) => s.generationStatus);
  const debugMode = useMazeStore((s) => s.debugMode);
  const error = useMazeStore((s) => s.error);
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const qcExperiment = useMazeStore((s) => s.qcExperiment);
  const vertexSettingsPanelOpen = useMazeStore((s) => s.vertexSettingsPanelOpen);
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const generationSourceMode = useMazeStore((s) => s.generationSourceMode);

  const setSeed = useMazeStore((s) => s.setSeed);
  const setRandomSeed = useMazeStore((s) => s.setRandomSeed);
  const seedHistoryBack = useMazeStore((s) => s.seedHistoryBack);
  const seedHistoryForward = useMazeStore((s) => s.seedHistoryForward);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);
  const setQcExperiment = useMazeStore((s) => s.setQcExperiment);
  const setGenerationSourceMode = useMazeStore((s) => s.setGenerationSourceMode);
  const setVertexSettingsPanelOpen = useMazeStore((s) => s.setVertexSettingsPanelOpen);
  const generate = useMazeStore((s) => s.generate);
  const postEditDirty = useMazeStore(selectPostEditDirty);

  const [algorithmDialogOpen, setAlgorithmDialogOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"generate" | null>(null);
  const [seedDraft, setSeedDraft] = useState(String(seed));

  useEffect(() => { setSeedDraft(String(seed)); }, [seed]);

  const method = initialConfig.method;
  const isVertexBased = method === "custom_vertex_based";

  function handleGenerate() {
    if (postEditDirty) { setPendingAction("generate"); return; }
    generate();
  }

  function confirmPending() {
    if (pendingAction === "generate") generate();
    setPendingAction(null);
  }

  const canSeedBack = seedHistory.length > 0 && seedHistoryIndex > 0;
  const canSeedForward = seedHistoryIndex < seedHistory.length - 1;

  return (
    <div style={styles.root}>
      {/* Seed block */}
      <div style={styles.algorithmBlock}>
        <span style={styles.sectionCaption}>{m["generation.seed_section"]()}</span>
        <div style={{ ...styles.row, paddingLeft: indent.tree, gap: spacing.itemGap }}>
          <span style={styles.algorithmLabel}>{m["generation.seed_value"]()}</span>
          <input
            type="number"
            name="generation-seed"
            style={{ ...sharedStyles.input, width: 110, minWidth: 0, opacity: randomSeed ? 0.4 : 1 }}
            value={seedDraft}
            readOnly={randomSeed}
            onChange={(e) => {
              setSeedDraft(e.target.value);
              const parsed = Number(e.target.value);
              if (Number.isSafeInteger(parsed)) setSeed(parsed);
            }}
          />
          <button
            className={canSeedBack ? "hoverable" : undefined}
            style={{ ...styles.seedToolbarBtn, ...(!canSeedBack ? styles.seedToolbarBtnDisabled : {}) }}
            disabled={!canSeedBack}
            onClick={seedHistoryBack}
            title={m["generation.seed_history_prev_tooltip"]()}
          >
            <ChevronLeft size={16} color={ui.text.tertiary} />
          </button>
          <button
            className={canSeedForward ? "hoverable" : undefined}
            style={{ ...styles.seedToolbarBtn, ...(!canSeedForward ? styles.seedToolbarBtnDisabled : {}) }}
            disabled={!canSeedForward}
            onClick={seedHistoryForward}
            title={m["generation.seed_history_next_tooltip"]()}
          >
            <ChevronRight size={16} color={ui.text.tertiary} />
          </button>
          <button
            className="hoverable"
            style={styles.seedToolbarBtn}
            onClick={() => setHistoryDialogOpen(true)}
            title={m["generation.seed_history_open_tooltip"]()}
          >
            <History size={16} color={ui.text.tertiary} />
          </button>
        </div>
        <div style={{ ...styles.row, paddingLeft: indent.tree }}>
          <span style={styles.algorithmLabel}>{m["generation.random"]()}</span>
          <div style={styles.switchRight}>
            <Switch checked={randomSeed} onChange={setRandomSeed} />
          </div>
        </div>
      </div>
      <div style={styles.divider} />

      {/* Algorithm block */}
      <div style={styles.algorithmBlock}>
        <span style={styles.sectionCaption}>{m["generation.algorithm"]()}</span>
        <div style={{ ...styles.row, paddingLeft: indent.tree }}>
          <span style={styles.algorithmLabel}>{getAlgorithmLabel(method)}</span>
          {isVertexBased && (
            <SettingsIconButton title={m["generation.vertex_settings"]()} onClick={() => setVertexSettingsPanelOpen(true)} />
          )}
          <button className="hoverable" style={styles.editBtn} onClick={() => setAlgorithmDialogOpen(true)} title={m["generation.edit"]()}>✎</button>
        </div>
      </div>

      {isVertexBased && vertexSettingsPanelOpen && (
        <VertexBasedSettingsPanel onClose={() => setVertexSettingsPanelOpen(false)} />
      )}

      {/* Status line */}
      {generationStatus === "error" && error && (
        <div style={styles.statusError}>{error}</div>
      )}

      {/* Debug toggle */}
      <div style={styles.divider} />
      <div style={styles.row}>
        <span style={styles.switchLabel}>{m["generation.debug_mode"]()}</span>
        <div style={styles.switchRight}>
          <Switch checked={debugMode} onChange={setDebugMode} />
        </div>
      </div>

      {/* QC Only toggle */}
      <div style={styles.row} title={m["generation.qc_experiment_tooltip"]()}>
        <span style={styles.switchLabel}>{m["generation.qc_experiment"]()}</span>
        <div style={styles.switchRight}>
          <Switch checked={qcExperiment} onChange={setQcExperiment} />
        </div>
      </div>

      {/* Random generation source toggle */}
      <div
        style={styles.row}
        title={presetGenSource ? m["generation.random_source_disabled_tooltip"]() : undefined}
      >
        <span style={{ ...styles.switchLabel, ...(presetGenSource ? styles.disabledLabel : {}) }}>
          {m["generation.random_source"]()}
        </span>
        <div style={styles.switchRight}>
          <Switch
            checked={generationSourceMode === "random"}
            disabled={presetGenSource !== null}
            onChange={(checked) => setGenerationSourceMode(checked ? "random" : "default")}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div style={styles.btnRow}>
        <Button
          variant="primary"
          layoutStyle={{ ...styles.btnGenerate, ...(!canGenerate ? styles.btnDisabled : {}) }}
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          {m["generation.generate"]()}
        </Button>
      </div>

      {algorithmDialogOpen && (
        <AlgorithmSelectDialog onClose={() => setAlgorithmDialogOpen(false)} />
      )}
      {historyDialogOpen && (
        <SeedHistoryDialog onClose={() => setHistoryDialogOpen(false)} />
      )}
      {pendingAction !== null && (
        <ConfirmModal
          message={m["post_edit.confirm_regenerate"]()}
          onConfirm={confirmPending}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: spacing.groupGap,
  },
  switchLabel: {
    ...muted(typography.body),
    flexShrink: 0,
  },
  disabledLabel: {
    opacity: 0.4,
  },
  switchRight: {
    marginLeft: "auto",
  },
  algorithmBlock: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
  },
  sectionCaption: {
    ...typography.body,
    marginTop: spacing.groupGap,
  },
  algorithmLabel: {
    flex: 1,
    ...muted(typography.body),
  },
  editBtn: {
    ...typography.icon,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    padding: `0 ${inset.iconButtonInset}px`,
    cursor: "default",
    lineHeight: 1,
    flexShrink: 0,
    opacity: 0.7,
  },
  seedToolbarBtn: {
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    padding: "2px 1px",
    cursor: "default",
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    borderRadius: radius.sm,
    opacity: 0.85,
  },
  seedToolbarBtnDisabled: {
    opacity: 0.3,
    cursor: "default",
  },
  paramValues: {
    paddingLeft: indent.tree * 2,
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
  },
  divider: {
    borderTop: `1px solid ${ui.border.default}`,
    margin: `${spacing.elementsGap}px 0`,
  },
  statusError: {
    ...typography.body,
    color: ui.text.error,
  },
  btnRow: {
    display: "flex",
    gap: spacing.itemGap,
  },
  btnGenerate: {
    flex: 1,
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
