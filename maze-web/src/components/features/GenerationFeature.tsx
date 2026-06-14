import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { AlgorithmSelectDialog, getAlgorithmLabel } from "../dialogs/AlgorithmSelectDialog";
import { sharedStyles } from "../../styles/shared";
import { colors, font, radius } from "../../styles/theme";
import type { GenerationParams, EdgeBasedParams } from "../../wasm/types";
import { Switch } from "../Switch";
import { SliderParam } from "../SliderParam";
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

  const setSeed = useMazeStore((s) => s.setSeed);
  const setRandomSeed = useMazeStore((s) => s.setRandomSeed);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setEdgeBasedParam = useMazeStore((s) => s.setEdgeBasedParam);
  const generate = useMazeStore((s) => s.generate);
  const regenerate = useMazeStore((s) => s.regenerate);

  const [algorithmDialogOpen, setAlgorithmDialogOpen] = useState(false);

  const method = initialConfig.method;
  const isVertexBased = method === "custom_vertex_based";
  const isEdgeBased = method === "custom_edge_based";

  const vertexParams = isVertexBased ? (initialConfig as { method: string } & GenerationParams) : null;
  const edgeParams = isEdgeBased ? (initialConfig as { method: string } & EdgeBasedParams) : null;

  function handleGenerate() {
    generate();
  }

  function handleRegenerate() {
    regenerate();
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
        <div style={styles.row}>
          <span style={styles.algorithmLabel}>{getAlgorithmLabel(method)}</span>
          <button style={styles.editBtn} onClick={() => setAlgorithmDialogOpen(true)} title={m["generation.edit"]()}>✎</button>
        </div>
        {isVertexBased && vertexParams && (
          <div style={styles.paramValues}>
            <SliderParam label={m["generation.depth_first"]()} value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
            <SliderParam label={m["generation.corridor_chance"]()} value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} />
            <SliderParam label={m["generation.branching"]()} value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} />
            <SliderParam label={m["generation.directionality"]()} value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} />
          </div>
        )}
        {isEdgeBased && edgeParams && (
          <div style={styles.paramValues}>
            <SliderParam label={m["generation.corridor_length"]()} value={edgeParams.corridor_length ?? 0.5} onChange={(v) => setEdgeBasedParam("corridor_length", v)} />
            <SliderParam label={m["generation.branching"]()} value={edgeParams.branching ?? 0.5} onChange={(v) => setEdgeBasedParam("branching", v)} />
            <SliderParam label={m["generation.depth_first"]()} value={edgeParams.depth_first ?? 0.5} onChange={(v) => setEdgeBasedParam("depth_first", v)} />
            <SliderParam label={m["generation.directionality"]()} value={edgeParams.directionality ?? 0.0} onChange={(v) => setEdgeBasedParam("directionality", v)} />
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

      {/* Action buttons */}
      <div style={styles.btnRow}>
        <button
          style={{ ...styles.btnGenerate, ...(!canGenerate ? styles.btnDisabled : {}) }}
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          {m["generation.generate"]()}
        </button>
        <button
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
    fontSize: font.sm,
    color: colors.textMuted,
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  switchLabel: {
    fontSize: font.sm,
    color: colors.textMuted,
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
    fontSize: font.sm,
    color: colors.textVeryDim,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  algorithmLabel: {
    flex: 1,
    fontSize: font.lg,
    color: colors.textMuted,
  },
  editBtn: {
    background: "none",
    border: "none",
    color: colors.textDim,
    padding: "0 2px",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
    flexShrink: 0,
    opacity: 0.7,
  },
  paramValues: {
    paddingLeft: 8,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  divider: {
    borderTop: `1px solid ${colors.borderMid}`,
    margin: "2px 0",
  },
  statusError: {
    fontSize: font.sm,
    color: colors.textError,
  },
  btnRow: {
    display: "flex",
    gap: 6,
  },
  btnGenerate: {
    flex: 1,
    background: colors.bgBtnPrimary,
    border: "none",
    color: colors.textWhite,
    padding: "5px 0",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.md,
  },
  btnRegenerate: {
    flex: 1,
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    padding: "5px 0",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.md,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
