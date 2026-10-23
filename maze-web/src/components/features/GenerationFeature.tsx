import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { AlgorithmSelectDialog, getAlgorithmLabel } from "../dialogs/AlgorithmSelectDialog";
import { SeedHistoryDialog } from "../dialogs/SeedHistoryDialog";
import { ConfirmModal } from "../ConfirmModal";
import { hasOpenModal } from "../Modal";
import { isFeatureCardConfirmShortcut } from "../keyboardShortcuts";
import { blurActiveElement } from "../../pixi/toolShortcuts";
import { VertexBasedSettingsPanel } from "./VertexBasedSettingsPanel";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { SettingsIconButton } from "../SettingsIconButton";
import { ToolTooltip } from "../ToolIconButton";
import { Tooltip } from "../Tooltip";
import { ui, radius, typography, muted, spacing, inset, indent } from "../../styles/theme";
import { Switch } from "../Switch";
import { selectPostEditDirty } from "../../pixi/selectors/mazeSelectors";
import * as m from "~/paraglide/messages";

interface Props {
  canGenerate: boolean;
}

const SPINNER_SHOW_DELAY = 200;
const SPINNER_MIN_VISIBLE = 750;

type TimerHandle = ReturnType<typeof setTimeout>;

export function GenerationFeature({ canGenerate }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const randomSeed = useMazeStore((s) => s.randomSeed);
  const seedHistory = useMazeStore((s) => s.seedHistory);
  const seedHistoryIndex = useMazeStore((s) => s.seedHistoryIndex);
  const debugMode = useMazeStore((s) => s.debugMode);
  const registryError = useMazeStore((s) => s.registryError);
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
  const generateAsync = useMazeStore((s) => s.generateAsync);
  const postEditDirty = useMazeStore(selectPostEditDirty);

  const [algorithmDialogOpen, setAlgorithmDialogOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"generate" | null>(null);
  const [seedDraft, setSeedDraft] = useState(String(seed));
  const [generationInProgress, setGenerationInProgress] = useState(false);
  const [spinnerVisible, setSpinnerVisible] = useState(false);
  const generationToken = useRef(0);
  const generationInProgressRef = useRef(false);
  const spinnerVisibleRef = useRef(false);
  const spinnerShownAt = useRef<number | null>(null);
  const showTimer = useRef<TimerHandle | null>(null);
  const hideTimer = useRef<TimerHandle | null>(null);

  useEffect(() => { setSeedDraft(String(seed)); }, [seed]);

  useEffect(() => () => {
    if (showTimer.current !== null) clearTimeout(showTimer.current);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    generationToken.current += 1;
  }, []);

  const method = initialConfig.method;
  const isVertexBased = method === "custom_vertex_based";

  function clearGenerationTimers() {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }

  function finishGeneration(token: number) {
    if (token !== generationToken.current) return;

    generationInProgressRef.current = false;
    setGenerationInProgress(false);
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }

    if (!spinnerVisibleRef.current) return;
    const shownAt = spinnerShownAt.current ?? Date.now();
    const remaining = Math.max(0, SPINNER_MIN_VISIBLE - (Date.now() - shownAt));
    if (remaining === 0) {
      spinnerVisibleRef.current = false;
      spinnerShownAt.current = null;
      setSpinnerVisible(false);
      return;
    }
    hideTimer.current = setTimeout(() => {
      if (token !== generationToken.current) return;
      hideTimer.current = null;
      spinnerVisibleRef.current = false;
      spinnerShownAt.current = null;
      setSpinnerVisible(false);
    }, remaining);
  }

  function startGeneration() {
    if (generationInProgressRef.current) return;
    const keepVisibleSpinner = spinnerVisibleRef.current;
    clearGenerationTimers();

    const token = ++generationToken.current;
    generationInProgressRef.current = true;
    setGenerationInProgress(true);
    if (!keepVisibleSpinner) {
      spinnerVisibleRef.current = false;
      spinnerShownAt.current = null;
      setSpinnerVisible(false);
    }
    showTimer.current = setTimeout(() => {
      showTimer.current = null;
      if (token !== generationToken.current || !generationInProgressRef.current) return;
      spinnerVisibleRef.current = true;
      spinnerShownAt.current = Date.now();
      setSpinnerVisible(true);
    }, SPINNER_SHOW_DELAY);

    try {
      const result = generateAsync() as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void (result as PromiseLike<unknown>).then(
          () => finishGeneration(token),
          () => finishGeneration(token),
        );
      } else {
        finishGeneration(token);
      }
    } catch (error) {
      finishGeneration(token);
      throw error;
    }
  }

  function handleGenerate() {
    if (generationInProgressRef.current) return;
    if (postEditDirty) { setPendingAction("generate"); return; }
    startGeneration();
  }

  function confirmPending() {
    if (pendingAction === "generate") startGeneration();
    setPendingAction(null);
  }

  const generateBlocked = !canGenerate || registryError !== null;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        useMazeStore.getState().openCard !== "generation"
        || generateBlocked
        || generationInProgress
        || algorithmDialogOpen
        || historyDialogOpen
        || pendingAction !== null
        || hasOpenModal()
        || !isFeatureCardConfirmShortcut(event)
      ) return;
      event.preventDefault();
      blurActiveElement();
      handleGenerate();
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [algorithmDialogOpen, generateBlocked, generationInProgress, handleGenerate, historyDialogOpen, pendingAction]);
  const canSeedBack = seedHistory.length > 0 && seedHistoryIndex > 0;
  const canSeedForward = seedHistoryIndex < seedHistory.length - 1;
  const seedBackDescription = canSeedBack
    ? m["generation.seed_history_seed"]({ seed: seedHistory[seedHistoryIndex - 1] })
    : m["generation.seed_history_prev_unavailable_tooltip"]();
  const seedForwardDescription = canSeedForward
    ? m["generation.seed_history_seed"]({ seed: seedHistory[seedHistoryIndex + 1] })
    : m["generation.seed_history_next_unavailable_tooltip"]();

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
          <ToolTooltip title={m["generation.seed_history_prev_tooltip"]()} description={seedBackDescription}>
            <button
              className={canSeedBack ? "hoverable" : undefined}
              style={{ ...styles.seedToolbarBtn, ...(!canSeedBack ? styles.seedToolbarBtnDisabled : {}) }}
              disabled={!canSeedBack}
              onClick={seedHistoryBack}
              aria-label={m["generation.seed_history_prev_tooltip"]()}
            >
              <ChevronLeft size={16} color={ui.text.tertiary} />
            </button>
          </ToolTooltip>
          <ToolTooltip title={m["generation.seed_history_next_tooltip"]()} description={seedForwardDescription}>
            <button
              className={canSeedForward ? "hoverable" : undefined}
              style={{ ...styles.seedToolbarBtn, ...(!canSeedForward ? styles.seedToolbarBtnDisabled : {}) }}
              disabled={!canSeedForward}
              onClick={seedHistoryForward}
              aria-label={m["generation.seed_history_next_tooltip"]()}
            >
              <ChevronRight size={16} color={ui.text.tertiary} />
            </button>
          </ToolTooltip>
          <Tooltip content={m["generation.seed_history_open_tooltip"]()}><button
            className="hoverable"
            style={styles.seedToolbarBtn}
            onClick={() => setHistoryDialogOpen(true)}
          >
            <History size={16} color={ui.text.tertiary} />
          </button></Tooltip>
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
          <Tooltip content={m["generation.edit"]()}><button className="hoverable" style={styles.editBtn} onClick={() => setAlgorithmDialogOpen(true)}>✎</button></Tooltip>
        </div>
      </div>

      {isVertexBased && vertexSettingsPanelOpen && (
        <VertexBasedSettingsPanel onClose={() => setVertexSettingsPanelOpen(false)} />
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
      <Tooltip block content={m["generation.qc_experiment_tooltip"]()}><div style={styles.row}>
        <span style={styles.switchLabel}>{m["generation.qc_experiment"]()}</span>
        <div style={styles.switchRight}>
          <Switch checked={qcExperiment} onChange={setQcExperiment} />
        </div>
      </div></Tooltip>

      {/* Random generation source toggle */}
      <Tooltip block content={<><span style={{ color: ui.text.primary }}>{m["generation.random_source_tooltip"]()}</span>{presetGenSource && <span style={{ display: "block", marginTop: 2, color: ui.text.tertiary }}>{m["generation.random_source_disabled_tooltip"]()}</span>}</>}><div style={styles.row}>
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
      </div></Tooltip>

      {/* Action buttons */}
      <div style={styles.btnRow}>
          <Button
            variant="primary"
            layoutStyle={{ ...styles.btnGenerate, ...(generateBlocked ? styles.btnDisabled : {}) }}
            disabled={generateBlocked || generationInProgress}
            aria-busy={generationInProgress}
            onClick={handleGenerate}
          >
            {spinnerVisible
              ? <span className="generation-spinner" aria-hidden="true" />
              : m["generation.generate"]()}
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
