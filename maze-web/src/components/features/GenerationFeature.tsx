import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { AlgorithmSelectDialog, getAlgorithmLabel } from "../dialogs/AlgorithmSelectDialog";
import { ConfirmModal } from "../ConfirmModal";
import { sharedStyles } from "../../styles/shared";
import { ui, radius, typography, muted } from "../../styles/theme";
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
  const lastUsedSeed = useMazeStore((s) => s.lastUsedSeed);
  const generationStatus = useMazeStore((s) => s.generationStatus);
  const debugMode = useMazeStore((s) => s.debugMode);
  const error = useMazeStore((s) => s.error);
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const qcExperiment = useMazeStore((s) => s.qcExperiment);

  const setSeed = useMazeStore((s) => s.setSeed);
  const setRandomSeed = useMazeStore((s) => s.setRandomSeed);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setEdgeBasedParam = useMazeStore((s) => s.setEdgeBasedParam);
  const setElementsParam = useMazeStore((s) => s.setElementsParam);
  const setQcExperiment = useMazeStore((s) => s.setQcExperiment);
  const generate = useMazeStore((s) => s.generate);
  const regenerate = useMazeStore((s) => s.regenerate);
  const postEditDirty = useMazeStore(selectPostEditDirty);

  const [algorithmDialogOpen, setAlgorithmDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"generate" | "regenerate" | null>(null);

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

  function handleRegenerate() {
    if (postEditDirty) { setPendingAction("regenerate"); return; }
    regenerate();
  }

  function confirmPending() {
    if (pendingAction === "generate") generate();
    else if (pendingAction === "regenerate") regenerate();
    setPendingAction(null);
  }

  const canRegenerate = lastUsedSeed !== null && canGenerate;
  const regenTooltip = lastUsedSeed !== null
    ? m["generation.regenerate_tooltip"]({ seed: lastUsedSeed })
    : m["generation.generate_first"]();

  return (
    <div style={styles.root}>
      {/* Seed row */}
      <div style={styles.row}>
        <span style={styles.seedLabel}>{m["generation.seed"]()}</span>
        <input
          type="number"
          style={{ ...sharedStyles.input, width: 90, minWidth: 0, opacity: randomSeed ? 0.4 : 1 }}
          value={seed}
          readOnly={randomSeed}
          onChange={(e) => setSeed(Number(e.target.value))}
        />
        <span style={{ ...styles.switchLabel, marginLeft: "auto" }}>{m["generation.random"]()}</span>
        <Switch checked={randomSeed} onChange={setRandomSeed} />
      </div>

      {/* Algorithm block */}
      <div style={styles.algorithmBlock}>
        <span style={styles.sectionCaption}>{m["generation.algorithm"]()}</span>
        <div style={{ ...styles.row, paddingLeft: 8 }}>
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

      {/* Elements block */}
      <div style={styles.algorithmBlock}>
        <span style={styles.sectionCaption}>{m["generation.elements"]()}</span>
        {isCanonical ? (
          <WarningBubble message={m["generation.canonical_elements_warning"]({ qualityTitle: m["quality.title"]() })} severity="info" />
        ) : (
          <div style={styles.paramValues}>
            <SliderParam variant="primary" label={m["generation.one_way_chance"]()} value={elementsConfig.one_way_chance ?? 0.04} onChange={(v) => setElementsParam("one_way_chance", v)} />
            <SliderParam variant="primary" label={m["generation.teleport_chance"]()} value={elementsConfig.teleport_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_chance", v)} />
            <SliderParam variant="primary" label={m["generation.teleport_one_way_chance"]()} value={elementsConfig.teleport_one_way_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_one_way_chance", v)} />
          </div>
        )}
      </div>

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
        <button
          className={canRegenerate ? "hoverable" : undefined}
          style={{ ...styles.btnRegenerate, ...(!canRegenerate ? styles.btnDisabled : {}) }}
          disabled={!canRegenerate}
          title={regenTooltip}
          onClick={handleRegenerate}
        >
          {m["generation.regenerate"]()}
        </button>
      </div>

      {algorithmDialogOpen && (
        <AlgorithmSelectDialog onClose={() => setAlgorithmDialogOpen(false)} />
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
    gap: 8,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  seedLabel: {
    ...muted(typography.body),
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
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
    gap: 4,
  },
  sectionCaption: {
    ...typography.body,
    marginTop: 8,
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
    padding: "0 2px",
    cursor: "default",
    lineHeight: 1,
    flexShrink: 0,
    opacity: 0.7,
  },
  paramValues: {
    paddingLeft: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  divider: {
    borderTop: `1px solid ${ui.border.default}`,
    margin: "2px 0",
  },
  statusError: {
    ...typography.body,
    color: ui.text.error,
  },
  btnRow: {
    display: "flex",
    gap: 6,
  },
  btnGenerate: {
    ...typography.control,
    flex: 1,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 4px",
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnRegenerate: {
    ...typography.control,
    flex: 1,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 4px",
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
