import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "./ItemSelectDialog";
import { sharedStyles } from "../../styles/shared";
import { colors, font, radius } from "../../styles/theme";
import type { GenerationParams, EdgeBasedParams } from "../../wasm/types";

interface Props {
  onClose: () => void;
}

const ALGORITHMS: { id: string; label: string; description: string }[] = [
  {
    id: "custom_vertex_based",
    label: "Custom Vertex-Based",
    description:
      "A configurable algorithm that builds mazes by traversing vertices. Supports depth-first exploration, corridor chance, branching factor, and directional bias. Produces a wide variety of maze styles depending on parameters.",
  },
  {
    id: "custom_edge_based",
    label: "Custom Edge-Based",
    description:
      "A configurable algorithm that operates on edges rather than vertices. Controls corridor length, branching, locality (how clustered the passages are), and directionality. Good for producing organic-looking mazes.",
  },
  {
    id: "recursive_backtracker",
    label: "Recursive Backtracker",
    description:
      "Classic depth-first search maze generator. Produces mazes with long winding corridors and low branching. Guaranteed perfect maze (single solution). No configurable parameters.",
  },
  {
    id: "wilson_algorithm",
    label: "Wilson's Algorithm",
    description:
      "Generates a uniformly random spanning tree using loop-erased random walks. Every possible perfect maze is equally likely. Slower on large fields but produces statistically unbiased results. No configurable parameters.",
  },
  {
    id: "kruskal_algorithm",
    label: "Kruskal's Algorithm",
    description:
      "Generates a minimum spanning tree by randomly merging disjoint sets. Produces mazes with many short passages and high branching. No configurable parameters.",
  },
];

export const ALGORITHM_LABELS: Record<string, string> = Object.fromEntries(
  ALGORITHMS.map((a) => [a.id, a.label])
);

export function AlgorithmSelectDialog({ onClose }: Props) {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const setGenerationMethod = useMazeStore((s) => s.setGenerationMethod);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setEdgeBasedParam = useMazeStore((s) => s.setEdgeBasedParam);

  const [selectedId, setSelectedId] = useState<string>(initialConfig.method);

  const selectedAlgorithm = ALGORITHMS.find((a) => a.id === selectedId);

  const isVertexBased = selectedId === "custom_vertex_based";
  const isEdgeBased = selectedId === "custom_edge_based";

  const vertexParams = isVertexBased && initialConfig.method === "custom_vertex_based"
    ? (initialConfig as { method: string } & GenerationParams)
    : null;
  const edgeParams = isEdgeBased && initialConfig.method === "custom_edge_based"
    ? (initialConfig as { method: string } & EdgeBasedParams)
    : null;

  function handleSelectId(id: string) {
    setSelectedId(id);
    if (id !== initialConfig.method) setGenerationMethod(id);
  }

  function handleSelect() {
    onClose();
  }

  const items = ALGORITHMS.map((a) => ({ id: a.id, label: a.label }));

  const rightPanel = (
    <>
      {selectedAlgorithm ? (
        <div style={styles.description}>{selectedAlgorithm.description}</div>
      ) : (
        <div style={styles.description}>No algorithm selected.</div>
      )}
      {isVertexBased && vertexParams && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <SliderRow label="Depth first" value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
          <SliderRow label="Corridor chance" value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} />
          <SliderRow label="Branching" value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} />
          <SliderRow label="Directionality" value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} />
        </div>
      )}
      {isEdgeBased && edgeParams && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <SliderRow label="Corridor length" value={edgeParams.corridor_length ?? 0.5} onChange={(v) => setEdgeBasedParam("corridor_length", v)} />
          <SliderRow label="Branching" value={edgeParams.branching ?? 0.5} onChange={(v) => setEdgeBasedParam("branching", v)} />
          <SliderRow label="Depth first" value={edgeParams.depth_first ?? 0.5} onChange={(v) => setEdgeBasedParam("depth_first", v)} />
          <SliderRow label="Directionality" value={edgeParams.directionality ?? 0.0} onChange={(v) => setEdgeBasedParam("directionality", v)} />
        </div>
      )}
    </>
  );

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>Cancel</button>
      <button style={styles.btnPrimary} onClick={handleSelect}>Select</button>
    </>
  );

  return (
    <ItemSelectDialog
      title="Select Algorithm"
      items={items}
      selectedId={selectedId}
      onSelectId={handleSelectId}
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

function SliderRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={sharedStyles.sliderRow}>
      <span style={sharedStyles.sliderRowLabel}>{label}</span>
      <input
        type="range"
        className="maze-slider"
        style={{ flex: 1 }}
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span style={sharedStyles.sliderRowValue}>{value.toFixed(2)}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: colors.textFaint,
    lineHeight: 1.6,
  },
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  paramsSeparator: {
    borderTop: `1px solid ${colors.borderDim}`,
    marginBottom: 4,
  },
  btnPrimary: {
    background: colors.bgBtnPrimary,
    border: "none",
    color: colors.textWhite,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnSecondary: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
};
