import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "./ItemSelectDialog";
import { sharedStyles } from "../../styles/shared";
import { colors, font, radius } from "../../styles/theme";
import type { GenerationParams, EdgeBasedParams } from "../../wasm/types";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

function getAlgorithms() {
  return [
    { id: "custom_vertex_based",   label: m["algorithm.custom_vertex_based"](),   description: m["algorithm.desc.custom_vertex_based"]() },
    { id: "custom_edge_based",     label: m["algorithm.custom_edge_based"](),     description: m["algorithm.desc.custom_edge_based"]() },
    { id: "recursive_backtracker", label: m["algorithm.recursive_backtracker"](), description: m["algorithm.desc.recursive_backtracker"]() },
    { id: "wilson_algorithm",      label: m["algorithm.wilson_algorithm"](),      description: m["algorithm.desc.wilson_algorithm"]() },
    { id: "kruskal_algorithm",     label: m["algorithm.kruskal_algorithm"](),     description: m["algorithm.desc.kruskal_algorithm"]() },
  ];
}

export function getAlgorithmLabel(id: string): string {
  return getAlgorithms().find((a) => a.id === id)?.label ?? id;
}

export function AlgorithmSelectDialog({ onClose }: Props) {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const setGenerationMethod = useMazeStore((s) => s.setGenerationMethod);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setEdgeBasedParam = useMazeStore((s) => s.setEdgeBasedParam);

  const [selectedId, setSelectedId] = useState<string>(initialConfig.method);

  const algorithms = getAlgorithms();
  const selectedAlgorithm = algorithms.find((a) => a.id === selectedId);

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

  const items = algorithms.map((a) => ({ id: a.id, label: a.label }));

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
          <SliderRow label={m["generation.depth_first"]()} value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
          <SliderRow label={m["generation.corridor_chance"]()} value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} />
          <SliderRow label={m["generation.branching"]()} value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} />
          <SliderRow label={m["generation.directionality"]()} value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} />
        </div>
      )}
      {isEdgeBased && edgeParams && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <SliderRow label={m["generation.corridor_length"]()} value={edgeParams.corridor_length ?? 0.5} onChange={(v) => setEdgeBasedParam("corridor_length", v)} />
          <SliderRow label={m["generation.branching"]()} value={edgeParams.branching ?? 0.5} onChange={(v) => setEdgeBasedParam("branching", v)} />
          <SliderRow label={m["generation.depth_first"]()} value={edgeParams.depth_first ?? 0.5} onChange={(v) => setEdgeBasedParam("depth_first", v)} />
          <SliderRow label={m["generation.directionality"]()} value={edgeParams.directionality ?? 0.0} onChange={(v) => setEdgeBasedParam("directionality", v)} />
        </div>
      )}
    </>
  );

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button style={styles.btnPrimary} onClick={handleSelect}>{m["common.select"]()}</button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["generation.select_algorithm"]()}
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
