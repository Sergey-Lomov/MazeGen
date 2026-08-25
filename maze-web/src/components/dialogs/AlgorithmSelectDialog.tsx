import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "./ItemSelectDialog";
import { ui, radius, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Every algorithm here (`custom_vertex_based`, `recursive_backtracker`, `wilson_algorithm`,
 * `kruskal_algorithm`) is vertex-based and handles multi-floor fields without erroring, though
 * only `custom_vertex_based` can actually connect floors (via vertical passages/elevators) — the
 * rest treat each floor as its own disconnected component (one spanning tree per floor for
 * RB/Wilson via the #417 restart, one MST per floor for Kruskal). */
function getAlgorithms() {
  return [
    { id: "custom_vertex_based",   label: m["algorithm.custom_vertex_based"](),   description: m["algorithm.desc.custom_vertex_based"]() },
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

  const [selectedId, setSelectedId] = useState<string>(initialConfig.method);

  const algorithms = getAlgorithms();
  const selectedAlgorithm = algorithms.find((a) => a.id === selectedId);

  function handleSelectId(id: string) {
    setSelectedId(id);
  }

  function handleSelect() {
    if (selectedId !== initialConfig.method) setGenerationMethod(selectedId);
    onClose();
  }

  const items = algorithms.map((a) => ({ id: a.id, label: a.label }));

  const rightPanel = selectedAlgorithm ? (
    <div style={styles.description}>{selectedAlgorithm.description}</div>
  ) : (
    <div style={styles.description}>No algorithm selected.</div>
  );

  const footer = (
    <>
      <button className="hoverable" style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        className="hoverable-accent"
        style={styles.btnPrimary}
        onClick={handleSelect}
      >
        {m["common.select"]()}
      </button>
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
    ...typography.body,
    lineHeight: 1.6,
  },
  btnPrimary: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
