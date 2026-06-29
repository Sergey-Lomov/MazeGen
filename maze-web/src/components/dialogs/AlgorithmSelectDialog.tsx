import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "./ItemSelectDialog";
import { ui, font, radius } from "../../styles/theme";
import type { GenerationParams, EdgeBasedParams } from "../../wasm/types";
import { SliderRow } from "../SliderRow";
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
          <SliderRow label={m["generation.depth_first"]()} description={m["generation.desc.depth_first"]()} value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
          <SliderRow label={m["generation.corridor_chance"]()} description={m["generation.desc.corridor_chance"]()} value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} />
          <SliderRow label={m["generation.branching"]()} description={m["generation.desc.branching"]()} value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} />
          <SliderRow label={m["generation.directionality"]()} description={m["generation.desc.directionality"]()} value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} />
          <SliderRow label={m["generation.cyclicity"]()} description={m["generation.desc.cyclicity"]()} value={vertexParams.cyclicity ?? 0.0} onChange={(v) => setGenerationParam("cyclicity", v)} />
        </div>
      )}
      {isEdgeBased && edgeParams && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <SliderRow label={m["generation.corridor_length"]()} description={m["generation.desc.corridor_length"]()} value={edgeParams.corridor_length ?? 0.5} onChange={(v) => setEdgeBasedParam("corridor_length", v)} />
          <SliderRow label={m["generation.branching"]()} description={m["generation.desc.branching"]()} value={edgeParams.branching ?? 0.5} onChange={(v) => setEdgeBasedParam("branching", v)} />
          <SliderRow label={m["generation.depth_first"]()} description={m["generation.desc.depth_first"]()} value={edgeParams.depth_first ?? 0.5} onChange={(v) => setEdgeBasedParam("depth_first", v)} />
          <SliderRow label={m["generation.directionality"]()} description={m["generation.desc.directionality"]()} value={edgeParams.directionality ?? 0.0} onChange={(v) => setEdgeBasedParam("directionality", v)} />
          <SliderRow label={m["generation.cyclicity"]()} description={m["generation.desc.cyclicity"]()} value={edgeParams.cyclicity ?? 0.0} onChange={(v) => setEdgeBasedParam("cyclicity", v)} />
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


const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: ui.text.tertiary,
    lineHeight: 1.6,
  },
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  paramsSeparator: {
    borderTop: `1px solid ${ui.border.default}`,
    marginBottom: 4,
  },
  btnPrimary: {
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnSecondary: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
};
