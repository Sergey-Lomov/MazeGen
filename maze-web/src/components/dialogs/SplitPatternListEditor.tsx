import React, { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { useMazeStore } from "../../store/mazeStore";
import { TileFaceEditor } from "../features/TileFaceEditor";
import { sharedStyles } from "../../styles/shared";
import { ui, typography, muted, spacing, indent } from "../../styles/theme";
import { AbstractPatternEditorDialog } from "./AbstractPatternEditorDialog";
import { degreeFor, patternAnchorPoint, tileNodesForPattern } from "../../pixi/splitPatternTile";
import { blueprintsForDegree, blueprintToSplitPattern, tileNodesForBlueprint } from "../../pixi/splitBlueprints";
import type { SplitPattern } from "../../wasm/types";
import * as m from "~/paraglide/messages";

interface Props {
  patterns: SplitPattern[];
  onChange: (patterns: SplitPattern[]) => void;
  /** Whether each pattern card shows a weight input/share (a strategy's own weighted selection
   *  pool) or just the tile preview and node count (a check's own plain membership filter — GitHub
   *  issue #247). */
  withWeights: boolean;
  /** Locks topology to whatever `patterns` already holds (GitHub issue #389) — hides add/remove/
   *  blueprints/edit-topology controls, leaving only each card's weight input (when `withWeights`
   *  is also set). Used by `AddSplitStrategy`'s own `pattern_weights` param, whose topology is
   *  owned by the rule-level `split_patterns` param, not by this strategy. */
  locked?: boolean;
}

const NOOP = () => {};

/** Compact, non-interactive tile preview for one pattern's card in the list — reuses
 *  `TileFaceEditor` itself (no separate rendering path to keep in sync with the abstract editor)
 *  with a fixed small size and no-op click handlers; `TileFaceEditor`'s own cursor is already
 *  `default` (not a pointer), so it doesn't visually suggest interactivity. */
function PatternPreviewTile({ pattern, degree, cfg }: { pattern: SplitPattern; degree: number; cfg: ReturnType<typeof activeFloorTessellationOf> }) {
  const anchorPoint = patternAnchorPoint(cfg);
  return (
    <div style={styles.previewTile}>
      <TileFaceEditor
        point={anchorPoint} cfg={cfg} nodes={tileNodesForPattern(pattern, degree)} activeIndex={null}
        onFaceClick={NOOP} onFaceRightClick={NOOP} onRotate={NOOP} showRotateControls={false}
      />
    </div>
  );
}

/** Reusable pattern-list editor (GitHub issue #247) — one card per pattern with a tile preview,
 *  edit/remove actions, and a strip of built-in blueprints to add from. Extracted from
 *  `SplitSettingsDialog` (generation's own pattern config) so it can also back a check's
 *  "patterns" filter param (no weights, `SplitCountCheck`/`SplitDensityCheck`'s own `patterns`
 *  param) or a repair strategy's own weighted pattern-selection pool (`AddSplitStrategy`'s
 *  `split_config` param, via `SplitGenerationSettingsBody`). Pure over `patterns`/`onChange` — no
 *  store coupling beyond the active tessellation (needed for tile geometry), so any caller can
 *  back it with whatever storage its own value lives in (generation's own store slice, or a
 *  JSON-string param round-tripped by the caller). */
export function SplitPatternListEditor({ patterns, onChange, withWeights, locked = false }: Props) {
  const fieldConfig = useMazeStore((s) => activeFloorTessellationOf(s));
  const degree = degreeFor(fieldConfig);
  const anchorPoint = patternAnchorPoint(fieldConfig);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  function addPattern(pattern: SplitPattern) {
    onChange([...patterns, pattern]);
  }

  function updatePattern(index: number, next: SplitPattern) {
    onChange(patterns.map((p, i) => (i === index ? next : p)));
  }

  function removePattern(index: number) {
    onChange(patterns.filter((_, i) => i !== index));
  }

  function handleAddPattern() {
    const fresh: SplitPattern = { node_count: 2, faces: [[], []], weight: 1.0 };
    addPattern(fresh);
    setEditingIndex(patterns.length);
  }

  const blueprints = useMemo(() => blueprintsForDegree(degree), [degree]);

  function handleAddBlueprint(blueprint: (typeof blueprints)[number]) {
    addPattern(blueprintToSplitPattern(blueprint, fieldConfig, anchorPoint));
  }

  // Removing a pattern shifts every later index down by one — an open editor for the removed
  // pattern itself, or for any pattern after it, must close/re-target accordingly, or it would
  // silently keep editing whatever pattern ended up at that index afterward.
  function handleRemovePattern(index: number) {
    removePattern(index);
    setEditingIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      if (current > index) return current - 1;
      return current;
    });
  }

  // Closing the editor on a pattern left with no faces defined on any node (GitHub issue #237) —
  // silently drops it from the list instead of keeping a dead entry the generator would treat as
  // an all-wall split (every face defaults to `Wall` when absent, see `tileFaceKindOf`).
  function handleCloseEditor() {
    if (editingIndex === null) return;
    const edited = patterns[editingIndex];
    const isEmpty = edited && edited.faces.every((nodeFaces) => nodeFaces.length === 0);
    if (isEmpty) removePattern(editingIndex);
    setEditingIndex(null);
  }

  const totalWeight = patterns.reduce((sum, p) => sum + Math.max(0, p.weight ?? 1.0), 0);
  const percentOf = (weight: number) => {
    const w = Math.max(0, weight);
    return totalWeight > 0 ? (w / totalWeight) * 100 : 0;
  };

  return (
    <>
      <div style={styles.patternsSection}>
        <div style={styles.sectionHeader}>
          <span style={styles.label}>{m["generation.split_patterns"]()}</span>
          {!locked && (
            <button className="hoverable" style={styles.iconBtn} onClick={handleAddPattern} title={m["generation.split_pattern_add"]()}>
              <Plus size={14} />
            </button>
          )}
        </div>
        {patterns.length === 0 ? (
          <div style={styles.empty}>{m["generation.split_patterns_none"]()}</div>
        ) : (
          patterns.map((pattern, i) => (
            <div key={i} style={styles.patternCard}>
              <PatternPreviewTile pattern={pattern} degree={degree} cfg={fieldConfig} />
              <div style={styles.patternInfo}>
                {withWeights && (
                  <div style={styles.weightRow}>
                    <span style={styles.label}>{m["generation.split_pattern_weight"]()}</span>
                    <input
                      type="number"
                      name={`split-pattern-${i}-weight`}
                      style={sharedStyles.inputSm}
                      value={pattern.weight ?? 1.0}
                      min={0}
                      step={0.1}
                      onChange={(e) => {
                        const w = Math.max(0, Number(e.target.value));
                        if (Number.isFinite(w)) updatePattern(i, { ...pattern, weight: w });
                      }}
                    />
                    <span style={styles.percent}>{percentOf(pattern.weight ?? 1.0).toFixed(1)}%</span>
                  </div>
                )}
                <span style={muted(typography.caption)}>
                  {m["generation.split_pattern_nodes"]()}: {pattern.node_count}
                </span>
              </div>
              {!locked && (
                <div style={styles.patternActions}>
                  <button className="hoverable" style={styles.editBtn} onClick={() => setEditingIndex(i)} title={m["generation.split_pattern_edit"]()}>✎</button>
                  <button className="hoverable" style={styles.editBtn} onClick={() => handleRemovePattern(i)} title={m["generation.split_pattern_remove"]()}>✕</button>
                </div>
              )}
            </div>
          ))
        )}
        {!locked && blueprints.length > 0 && (
          <div style={styles.blueprintsBlock}>
            <span style={styles.label}>{m["generation.split_pattern_blueprints_label"]()}</span>
            <div style={styles.blueprintStrip}>
              {blueprints.map((blueprint) => (
                <button
                  key={blueprint.id}
                  className="hoverable"
                  style={styles.blueprintThumb}
                  onClick={() => handleAddBlueprint(blueprint)}
                >
                  <TileFaceEditor
                    point={anchorPoint} cfg={fieldConfig} nodes={tileNodesForBlueprint(blueprint, fieldConfig, anchorPoint)}
                    activeIndex={null} onFaceClick={NOOP} onFaceRightClick={NOOP} onRotate={NOOP} showRotateControls={false}
                  />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {editingIndex !== null && patterns[editingIndex] && (
        <AbstractPatternEditorDialog
          pattern={patterns[editingIndex]}
          onChange={(next) => updatePattern(editingIndex, next)}
          onClose={handleCloseEditor}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: {
    ...typography.control,
    color: ui.text.secondary,
  },
  patternsSection: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
  },
  patternCard: {
    display: "flex",
    alignItems: "center",
    gap: spacing.groupGap,
    padding: spacing.itemGap,
    border: `1px solid ${ui.border.default}`,
    borderRadius: 6,
  },
  previewTile: {
    width: 56,
    height: 56,
    flexShrink: 0,
  },
  patternInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  weightRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  percent: {
    ...muted(typography.caption),
    minWidth: 40,
  },
  patternActions: {
    display: "flex",
    flexDirection: "row",
    gap: 2,
    flexShrink: 0,
  },
  editBtn: {
    background: "none",
    border: "none",
    cursor: "default",
    color: ui.text.secondary,
    padding: "2px 6px",
  },
  // Horizontally scrolling strip of built-in blueprint thumbnails (GitHub issue #235 follow-up)
  // — same visual pattern as `SplitNodesDialogView`'s own blueprint strip, one-click "add a
  // standard pattern" shortcut sitting right below the pattern list.
  blueprintsBlock: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
  },
  blueprintStrip: {
    display: "flex",
    flexDirection: "row",
    gap: spacing.itemGap,
    overflowX: "auto",
    paddingBottom: 2,
  },
  blueprintThumb: {
    flex: "0 0 auto",
    width: 56,
    height: 56,
    padding: 4,
    border: `1px solid ${ui.border.default}`,
    borderRadius: 6,
    background: "none",
    cursor: "default",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: `1px solid ${ui.border.strong}`,
    borderRadius: 4,
    cursor: "default",
    padding: 4,
    color: ui.text.secondary,
  },
  empty: {
    ...muted(typography.body),
    padding: `4px 0`,
    paddingLeft: indent.tree,
  },
};
