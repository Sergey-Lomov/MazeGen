import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "./ItemSelectDialog";
import { ui, radius, typography, inset } from "../../styles/theme";
import { WarningBubble } from "../WarningBubble";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** GitHub issue #337 / #417: `custom_edge_based` is edge-based and has no notion of floors, so it
 * cannot connect them — disabled once more than one floor exists. The other algorithms
 * (`custom_vertex_based`, `recursive_backtracker`, `wilson_algorithm`, `kruskal_algorithm`) are
 * vertex-based and handle multi-floor fields without erroring, though only `custom_vertex_based`
 * can actually connect floors (via vertical passages/elevators) — the rest treat each floor as
 * its own disconnected component (one spanning tree per floor for RB/Wilson via the #417 restart,
 * one MST per floor for Kruskal). */
function getAlgorithms(multiFloor: boolean) {
  return [
    { id: "custom_vertex_based",   label: m["algorithm.custom_vertex_based"](),   description: m["algorithm.desc.custom_vertex_based"]() },
    { id: "custom_edge_based",     label: m["algorithm.custom_edge_based"](),     description: m["algorithm.desc.custom_edge_based"]() },
    { id: "recursive_backtracker", label: m["algorithm.recursive_backtracker"](), description: m["algorithm.desc.recursive_backtracker"]() },
    { id: "wilson_algorithm",      label: m["algorithm.wilson_algorithm"](),      description: m["algorithm.desc.wilson_algorithm"]() },
    { id: "kruskal_algorithm",     label: m["algorithm.kruskal_algorithm"](),     description: m["algorithm.desc.kruskal_algorithm"]() },
  ].map((a) => ({ ...a, disabled: a.id === "custom_edge_based" && multiFloor }));
}

export function getAlgorithmLabel(id: string): string {
  return getAlgorithms(false).find((a) => a.id === id)?.label ?? id;
}

export function AlgorithmSelectDialog({ onClose }: Props) {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const setGenerationMethod = useMazeStore((s) => s.setGenerationMethod);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);

  const [selectedId, setSelectedId] = useState<string>(initialConfig.method);

  const algorithms = getAlgorithms(multiFloor);
  const selectedAlgorithm = algorithms.find((a) => a.id === selectedId);

  function handleSelectId(id: string) {
    setSelectedId(id);
  }

  function handleSelect() {
    if (selectedAlgorithm?.disabled) return;
    if (selectedId !== initialConfig.method) setGenerationMethod(selectedId);
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
      {selectedAlgorithm?.disabled && (
        <WarningBubble message={m["algorithm.multi_floor_unavailable"]()} severity="critical" />
      )}
    </>
  );

  const selectDisabled = selectedAlgorithm?.disabled ?? false;

  const footer = (
    <>
      <button className="hoverable" style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        className={selectDisabled ? undefined : "hoverable-accent"}
        style={{ ...styles.btnPrimary, ...(selectDisabled ? styles.btnDisabled : {}) }}
        disabled={selectDisabled}
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
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
