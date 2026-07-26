import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History, Settings } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { AlgorithmSelectDialog, getAlgorithmLabel } from "../dialogs/AlgorithmSelectDialog";
import { SeedHistoryDialog } from "../dialogs/SeedHistoryDialog";
import { SplitSettingsDialog } from "../dialogs/SplitSettingsDialog";
import { ConfirmModal } from "../ConfirmModal";
import { sharedStyles } from "../../styles/shared";
import { ui, radius, typography, muted, spacing, inset, indent } from "../../styles/theme";
import type { GenerationParams, EdgeBasedParams } from "../../wasm/types";
import { Switch } from "../Switch";
import { SliderParam } from "../SliderParam";
import { WarningBubble } from "../WarningBubble";
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
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const qcExperiment = useMazeStore((s) => s.qcExperiment);

  const setSeed = useMazeStore((s) => s.setSeed);
  const setRandomSeed = useMazeStore((s) => s.setRandomSeed);
  const seedHistoryBack = useMazeStore((s) => s.seedHistoryBack);
  const seedHistoryForward = useMazeStore((s) => s.seedHistoryForward);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setEdgeBasedParam = useMazeStore((s) => s.setEdgeBasedParam);
  const setElementsParam = useMazeStore((s) => s.setElementsParam);
  const setQcExperiment = useMazeStore((s) => s.setQcExperiment);
  const generate = useMazeStore((s) => s.generate);
  const postEditDirty = useMazeStore(selectPostEditDirty);

  const [algorithmDialogOpen, setAlgorithmDialogOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [splitSettingsDialogOpen, setSplitSettingsDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"generate" | null>(null);
  const [seedDraft, setSeedDraft] = useState(String(seed));

  useEffect(() => { setSeedDraft(String(seed)); }, [seed]);

  const method = initialConfig.method;
  const isVertexBased = method === "custom_vertex_based";
  const isEdgeBased = method === "custom_edge_based";
  const isCanonical = !isVertexBased && !isEdgeBased;

  const vertexParams = isVertexBased ? (initialConfig as { method: string } & GenerationParams) : null;
  const edgeParams = isEdgeBased ? (initialConfig as { method: string } & EdgeBasedParams) : null;

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
          <button className="hoverable" style={styles.editBtn} onClick={() => setAlgorithmDialogOpen(true)} title={m["generation.edit"]()}>✎</button>
        </div>
        {isVertexBased && vertexParams && (
          <div style={styles.paramValues}>
            <SliderParam variant="primary" label={m["generation.depth_first"]()} value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
            <SliderParam variant="primary" label={m["generation.corridor_chance"]()} value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} />
            <SliderParam variant="primary" label={m["generation.branching"]()} value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} />
            <SliderParam variant="primary" label={m["generation.directionality"]()} value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} />
            <SliderParam variant="primary" label={m["generation.cyclicity"]()} value={vertexParams.cyclicity ?? 0.0} onChange={(v) => setGenerationParam("cyclicity", v)} />
          </div>
        )}
        {isEdgeBased && edgeParams && (
          <div style={styles.paramValues}>
            <SliderParam variant="primary" label={m["generation.corridor_length"]()} value={edgeParams.corridor_length ?? 0.5} onChange={(v) => setEdgeBasedParam("corridor_length", v)} />
            <SliderParam variant="primary" label={m["generation.branching"]()} value={edgeParams.branching ?? 0.5} onChange={(v) => setEdgeBasedParam("branching", v)} />
            <SliderParam variant="primary" label={m["generation.depth_first"]()} value={edgeParams.depth_first ?? 0.5} onChange={(v) => setEdgeBasedParam("depth_first", v)} />
            <SliderParam variant="primary" label={m["generation.directionality"]()} value={edgeParams.directionality ?? 0.0} onChange={(v) => setEdgeBasedParam("directionality", v)} />
            <SliderParam variant="primary" label={m["generation.cyclicity"]()} value={edgeParams.cyclicity ?? 0.0} onChange={(v) => setEdgeBasedParam("cyclicity", v)} />
          </div>
        )}
      </div>
      <div style={styles.divider} />

      {/* Elements block */}
      <div style={styles.algorithmBlock}>
        <span style={styles.sectionCaption}>{m["generation.elements"]()}</span>
        <div style={{ ...styles.paramValues, paddingLeft: indent.tree }}>
          {isCanonical ? (
            <WarningBubble message={m["generation.canonical_elements_warning"]({ qualityTitle: m["quality.title"]() })} severity="info" />
          ) : (
            <>
              <SliderParam variant="primary" label={m["generation.one_way_chance"]()} value={elementsConfig.one_way_chance ?? 0.04} onChange={(v) => setElementsParam("one_way_chance", v)} />
              <SliderParam variant="primary" label={m["generation.teleport_chance"]()} value={elementsConfig.teleport_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_chance", v)} />
              <SliderParam variant="primary" label={m["generation.teleport_one_way_chance"]()} value={elementsConfig.teleport_one_way_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_one_way_chance", v)} />
              {isVertexBased && (
                <div style={styles.row}>
                  <div style={{ flex: 1 }}>
                    <SliderParam variant="primary" label={m["generation.split_chance"]()} value={elementsConfig.split_chance ?? 0.0} onChange={(v) => setElementsParam("split_chance", v)} />
                  </div>
                  <button className="hoverable" style={styles.gearBtn} onClick={() => setSplitSettingsDialogOpen(true)} title={m["generation.split_settings"]()}>
                    <Settings size={16} color={ui.text.tertiary} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {isVertexBased && splitSettingsDialogOpen && (
        <SplitSettingsDialog onClose={() => setSplitSettingsDialogOpen(false)} />
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

      {/* Action buttons */}
      <div style={styles.btnRow}>
        <button
          className={canGenerate ? "hoverable-accent" : undefined}
          style={{ ...styles.btnGenerate, ...(!canGenerate ? styles.btnDisabled : {}) }}
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          {m["generation.generate"]()}
        </button>
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
  // `lucide-react` icon instead of the `⚙` glyph (GitHub issue #237 follow-up) — the glyph read
  // thin/blurry at small sizes across fonts; a real SVG icon looks crisp instead.
  gearBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    padding: `0 ${inset.iconButtonInset}px`,
    cursor: "default",
    flexShrink: 0,
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
    ...typography.control,
    flex: 1,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: inset.toolButtonInset,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
