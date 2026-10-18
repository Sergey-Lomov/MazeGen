import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "./ItemSelectDialog";
import { WarningBubble } from "../WarningBubble";
import { Button } from "../Button";
import { radius, typography, inset } from "../../styles/theme";
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
    { id: "custom_vertex_based",   label: m["algorithm.custom_vertex_based"](),   description: m["algorithm.desc.custom_vertex_based"](),   canonical: false },
    { id: "recursive_backtracker", label: m["algorithm.recursive_backtracker"](), description: m["algorithm.desc.recursive_backtracker"](), canonical: true },
    { id: "wilson_algorithm",      label: m["algorithm.wilson_algorithm"](),      description: m["algorithm.desc.wilson_algorithm"](),      canonical: true },
    { id: "kruskal_algorithm",     label: m["algorithm.kruskal_algorithm"](),     description: m["algorithm.desc.kruskal_algorithm"](),     canonical: true },
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
    <>
      <div style={styles.description}>{selectedAlgorithm.description}</div>
      {selectedAlgorithm.canonical && (
        <WarningBubble
          message={m["generation.canonical_elements_warning"]({ qualityTitle: m["quality.title"]() })}
          severity="info"
        />
      )}
    </>
  ) : (
    <div style={styles.description}>No algorithm selected.</div>
  );

  const footer = (
    <>
      <Button variant="secondary" dialogAction layoutStyle={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</Button>
      <Button
        variant="primary"
        dialogAction
        layoutStyle={styles.btnPrimary}
        onClick={handleSelect}
      >
        {m["common.select"]()}
      </Button>
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
      onConfirm={handleSelect}
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
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
