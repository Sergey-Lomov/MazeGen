import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { activeTessellationOf } from "../../store/storeHelpers";
import { Modal } from "../Modal";
import { Switch } from "../Switch";
import { TileFaceEditor } from "../features/TileFaceEditor";
import { sharedStyles } from "../../styles/shared";
import { ui, typography, muted, spacing, dialogSpacing } from "../../styles/theme";
import { AbstractPatternEditorDialog } from "./AbstractPatternEditorDialog";
import { degreeFor, tileNodesForPattern } from "../../pixi/splitPatternTile";
import type { SplitPattern } from "../../wasm/types";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

const ANCHOR_POINT: [number, number] = [0, 0];
const NOOP = () => {};

/** Compact, non-interactive tile preview for one pattern's card in the list — reuses
 *  `TileFaceEditor` itself (no separate rendering path to keep in sync with the abstract editor)
 *  with a fixed small size and no-op click handlers; `TileFaceEditor`'s own cursor is already
 *  `default` (not a pointer), so it doesn't visually suggest interactivity. */
function PatternPreviewTile({ pattern, degree, cfg }: { pattern: SplitPattern; degree: number; cfg: ReturnType<typeof activeTessellationOf> }) {
  return (
    <div style={styles.previewTile}>
      <TileFaceEditor
        point={ANCHOR_POINT} cfg={cfg} nodes={tileNodesForPattern(pattern, degree)} activeIndex={null}
        onFaceClick={NOOP} onFaceRightClick={NOOP} onRotate={NOOP} showRotateControls={false}
      />
    </div>
  );
}

export function SplitSettingsDialog({ onClose }: Props) {
  const splitPatternMode = useMazeStore((s) => s.splitPatternMode);
  const splitMaxNodes = useMazeStore((s) => s.splitMaxNodes);
  const splitPatterns = useMazeStore((s) => s.splitPatterns);
  const tessellationConfig = useMazeStore((s) => activeTessellationOf(s));
  const setSplitPatternMode = useMazeStore((s) => s.setSplitPatternMode);
  const setSplitMaxNodes = useMazeStore((s) => s.setSplitMaxNodes);
  const addSplitPattern = useMazeStore((s) => s.addSplitPattern);
  const removeSplitPattern = useMazeStore((s) => s.removeSplitPattern);
  const updateSplitPattern = useMazeStore((s) => s.updateSplitPattern);

  const degree = degreeFor(tessellationConfig);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  function handleAddPattern() {
    const fresh: SplitPattern = { node_count: 2, faces: [[], []], weight: 1.0 };
    addSplitPattern(fresh);
    setEditingIndex(splitPatterns.length);
  }

  // Removing a pattern shifts every later index down by one — an open editor for the removed
  // pattern itself, or for any pattern after it, must close/re-target accordingly, or it would
  // silently keep editing whatever pattern ended up at that index afterward.
  function handleRemovePattern(index: number) {
    removeSplitPattern(index);
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
    const edited = splitPatterns[editingIndex];
    const isEmpty = edited && edited.faces.every((nodeFaces) => nodeFaces.length === 0);
    if (isEmpty) removeSplitPattern(editingIndex);
    setEditingIndex(null);
  }

  const totalWeight = splitPatterns.reduce((sum, p) => sum + Math.max(0, p.weight ?? 1.0), 0);
  const percentOf = (weight: number) => {
    const w = Math.max(0, weight);
    return totalWeight > 0 ? (w / totalWeight) * 100 : 0;
  };

  return (
    <>
      <Modal title={m["generation.split_settings_title"]()} onClose={onClose}>
        <div style={styles.row}>
          <span style={styles.label}>{m["generation.split_pattern_mode"]()}</span>
          <Switch checked={splitPatternMode} onChange={setSplitPatternMode} />
        </div>

        {!splitPatternMode && (
          <div style={styles.row}>
            <span style={styles.label}>{m["generation.split_max_nodes"]()}</span>
            <input
              type="number"
              style={sharedStyles.inputSm}
              value={splitMaxNodes}
              min={1}
              step={1}
              onChange={(e) => {
                const v = Math.max(1, Math.trunc(Number(e.target.value)));
                if (Number.isFinite(v)) setSplitMaxNodes(v);
              }}
            />
          </div>
        )}

        {splitPatternMode && (
          <div style={styles.patternsSection}>
            <span style={styles.label}>{m["generation.split_patterns"]()}</span>
            {splitPatterns.length === 0 ? (
              <div style={styles.empty}>{m["generation.split_patterns_none"]()}</div>
            ) : (
              splitPatterns.map((pattern, i) => (
                <div key={i} style={styles.patternCard}>
                  <PatternPreviewTile pattern={pattern} degree={degree} cfg={tessellationConfig} />
                  <div style={styles.patternInfo}>
                    <div style={styles.weightRow}>
                      <span style={styles.label}>{m["generation.split_pattern_weight"]()}</span>
                      <input
                        type="number"
                        style={sharedStyles.inputSm}
                        value={pattern.weight ?? 1.0}
                        min={0}
                        step={0.1}
                        onChange={(e) => {
                          const w = Math.max(0, Number(e.target.value));
                          if (Number.isFinite(w)) updateSplitPattern(i, { ...pattern, weight: w });
                        }}
                      />
                      <span style={styles.percent}>{percentOf(pattern.weight ?? 1.0).toFixed(1)}%</span>
                    </div>
                    <span style={muted(typography.caption)}>
                      {m["generation.split_pattern_nodes"]()}: {pattern.node_count}
                    </span>
                  </div>
                  <div style={styles.patternActions}>
                    <button className="hoverable" style={styles.editBtn} onClick={() => setEditingIndex(i)} title={m["generation.split_pattern_edit"]()}>✎</button>
                    <button className="hoverable" style={styles.editBtn} onClick={() => handleRemovePattern(i)} title={m["generation.split_pattern_remove"]()}>✕</button>
                  </div>
                </div>
              ))
            )}
            <button className="hoverable" style={styles.addBtn} onClick={handleAddPattern}>
              {m["generation.split_pattern_add"]()}
            </button>
          </div>
        )}
      </Modal>
      {editingIndex !== null && splitPatterns[editingIndex] && (
        <AbstractPatternEditorDialog
          pattern={splitPatterns[editingIndex]}
          onChange={(next) => updateSplitPattern(editingIndex, next)}
          onClose={handleCloseEditor}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.groupGap,
    padding: `6px ${dialogSpacing.paddingX}px`,
  },
  label: {
    ...typography.control,
    color: ui.text.secondary,
  },
  patternsSection: {
    marginTop: spacing.groupGap,
    borderTop: `1px solid ${ui.border.strong}`,
    padding: `${spacing.groupGap}px ${dialogSpacing.paddingX}px`,
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
  addBtn: {
    ...typography.control,
    background: "none",
    border: `1px solid ${ui.border.strong}`,
    borderRadius: 4,
    cursor: "default",
    padding: "4px 8px",
    color: ui.text.secondary,
    alignSelf: "flex-start",
  },
  empty: {
    ...muted(typography.body),
    padding: `4px 0`,
  },
};
