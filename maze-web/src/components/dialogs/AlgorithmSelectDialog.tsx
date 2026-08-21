import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "./ItemSelectDialog";
import { ui, radius, typography, spacing, inset } from "../../styles/theme";
import type { GenerationParams, EdgeBasedParams } from "../../wasm/types";
import { SliderRow } from "../SliderRow";
import { ToggleRow } from "../ToggleRow";
import { ElevatorSpanRow } from "../ElevatorSpanRow";
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

const VERTEX_BASED_DEFAULTS: GenerationParams = { depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0, cyclicity: 0.0 };
const EDGE_BASED_DEFAULTS: EdgeBasedParams = { corridor_length: 0.5, branching: 0.5, depth_first: 0.5, directionality: 0.0, cyclicity: 0.0 };

export function AlgorithmSelectDialog({ onClose }: Props) {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const setGenerationMethod = useMazeStore((s) => s.setGenerationMethod);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setElementsParam = useMazeStore((s) => s.setElementsParam);
  const setElementsBoolParam = useMazeStore((s) => s.setElementsBoolParam);
  const setEdgeBasedParam = useMazeStore((s) => s.setEdgeBasedParam);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);

  const [selectedId, setSelectedId] = useState<string>(initialConfig.method);

  const algorithms = getAlgorithms(multiFloor);
  const selectedAlgorithm = algorithms.find((a) => a.id === selectedId);

  const isVertexBased = selectedId === "custom_vertex_based";
  const isEdgeBased = selectedId === "custom_edge_based";
  // The row under the cursor may not be the applied algorithm yet (switching only happens on
  // "Select" — see handleSelect) — while previewing a not-yet-applied algorithm, show its
  // defaults read-only instead of the live (and differently-shaped) initialConfig.
  const isApplied = selectedId === initialConfig.method;

  const vertexParams = isVertexBased
    ? (isApplied ? (initialConfig as { method: string } & GenerationParams) : VERTEX_BASED_DEFAULTS)
    : null;
  const edgeParams = isEdgeBased
    ? (isApplied ? (initialConfig as { method: string } & EdgeBasedParams) : EDGE_BASED_DEFAULTS)
    : null;
  // Unlike vertexParams/edgeParams (reset to fresh defaults by setGenerationMethod on apply),
  // elementsConfig is algorithm-independent — switching the previewed row never resets it — so it
  // always shows/edits the real live config, never a frozen draft default, regardless of isApplied.
  const verticalParams = elementsConfig;

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
      {isVertexBased && vertexParams && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <SliderRow disabled={!isApplied} label={m["generation.depth_first"]()} description={m["generation.desc.depth_first"]()} value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.corridor_chance"]()} description={m["generation.desc.corridor_chance"]()} value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.branching"]()} description={m["generation.desc.branching"]()} value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.directionality"]()} description={m["generation.desc.directionality"]()} value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.cyclicity"]()} description={m["generation.desc.cyclicity"]()} value={vertexParams.cyclicity ?? 0.0} onChange={(v) => setGenerationParam("cyclicity", v)} />
          {multiFloor && (
            <>
              <div style={styles.paramsSeparator} />
              <SliderRow label={m["generation.vertical_chance"]()} description={m["generation.desc.vertical_chance"]()} value={verticalParams.vertical_chance ?? 0.0} onChange={(v) => setElementsParam("vertical_chance", v)} />
              <SliderRow label={m["generation.vertical_passage_elevator_balance"]()} description={m["generation.desc.vertical_passage_elevator_balance"]()} value={verticalParams.vertical_passage_elevator_balance ?? 0.5} onChange={(v) => setElementsParam("vertical_passage_elevator_balance", v)} />
              <SliderRow label={m["generation.one_way_vertical_passage_chance"]()} description={m["generation.desc.one_way_vertical_passage_chance"]()} value={verticalParams.one_way_vertical_passage_chance ?? 0.0} onChange={(v) => setElementsParam("one_way_vertical_passage_chance", v)} />
              <SliderRow label={m["generation.vertical_up_down_balance"]()} description={m["generation.desc.vertical_up_down_balance"]()} value={verticalParams.vertical_up_down_balance ?? 0.5} onChange={(v) => setElementsParam("vertical_up_down_balance", v)} />
              <ElevatorSpanRow min={verticalParams.elevator_span_min ?? 2} max={verticalParams.elevator_span_max ?? 2} onMinChange={(v) => setElementsParam("elevator_span_min", v)} onMaxChange={(v) => setElementsParam("elevator_span_max", v)} />
              <SliderRow label={m["generation.elevator_branching"]()} description={m["generation.desc.elevator_branching"]()} value={verticalParams.elevator_branching ?? 0.5} onChange={(v) => setElementsParam("elevator_branching", v)} />
              <ToggleRow label={m["generation.allow_non_consecutive_elevator_floors"]()} checked={verticalParams.allow_non_consecutive_elevator_floors ?? false} onChange={(v) => setElementsBoolParam("allow_non_consecutive_elevator_floors", v)} />
            </>
          )}
        </div>
      )}
      {isEdgeBased && edgeParams && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <SliderRow disabled={!isApplied} label={m["generation.corridor_length"]()} description={m["generation.desc.corridor_length"]()} value={edgeParams.corridor_length ?? 0.5} onChange={(v) => setEdgeBasedParam("corridor_length", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.branching"]()} description={m["generation.desc.branching"]()} value={edgeParams.branching ?? 0.5} onChange={(v) => setEdgeBasedParam("branching", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.depth_first"]()} description={m["generation.desc.depth_first"]()} value={edgeParams.depth_first ?? 0.5} onChange={(v) => setEdgeBasedParam("depth_first", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.directionality"]()} description={m["generation.desc.directionality"]()} value={edgeParams.directionality ?? 0.0} onChange={(v) => setEdgeBasedParam("directionality", v)} />
          <SliderRow disabled={!isApplied} label={m["generation.cyclicity"]()} description={m["generation.desc.cyclicity"]()} value={edgeParams.cyclicity ?? 0.0} onChange={(v) => setEdgeBasedParam("cyclicity", v)} />
        </div>
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
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.sectionGap,
  },
  paramsSeparator: {
    borderTop: `1px solid ${ui.border.default}`,
    marginBottom: spacing.itemGap,
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
