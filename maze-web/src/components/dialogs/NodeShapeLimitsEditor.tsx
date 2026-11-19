import { Fragment, useEffect, useState } from "react";
import { Button } from "../Button";
import { Inline, Stack } from "../Layout";
import { NumberInput } from "../NumberInput";
import { sharedStyles } from "../../styles/shared";
import { spacing, ui } from "../../styles/theme";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { NodeShapeIcon } from "./NodeShapeIcon";
import {
  nodeShapeCellTypeLabel,
  nodeShapeLabel,
  parseNodeShapeLimits,
  serializeNodeShapeLimits,
  type NodeShapeLimit,
} from "../features/nodeShapeLimits";
import type { CellTypeShapes } from "../../wasm/mazeService";
import * as m from "~/paraglide/messages";

interface Props {
  /** The param's JSON value (cell type -> `NodeShape::key()` -> `{min, max}`). */
  value: string;
  /** Shapes the tessellation can produce per cell type (`getTessellationNodeShapes`). */
  cellTypes: readonly CellTypeShapes[];
  onChange: (value: string) => void;
  /** A limit to flag: its tab opens and its min field takes focus with `message` as an error. Each
   *  new object is a new request. */
  error?: { cellType: string; shape: string; message: () => string } | null;
}

const styles = {
  grid: {
    display: "grid",
    gridTemplateColumns: "auto auto auto auto",
    justifyContent: "start",
    alignItems: "center",
    gap: spacing.sectionGap,
  },
} satisfies Record<string, React.CSSProperties>;

const NO_LIMIT: NodeShapeLimit = { min: null, max: null };
/** Four digits are the most a shape count needs. */
const MAX_COUNT = 9999;

/** One optional bound: an empty field is no limit; `NumberInput` explains rejected input. */
function BoundInput({ label, bound, onBound, error }: {
  label: string;
  bound: number | null;
  onBound: (bound: number | null) => void;
  error?: { message: () => string } | null;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {label}
      <NumberInput
        name={`node-shape-limit-${label}`}
        ariaLabel={label}
        style={{ ...sharedStyles.inputSm, width: "4.5em" }}
        value={bound === null ? "" : String(bound)}
        min={0}
        max={MAX_COUNT}
        integer
        allowEmpty
        externalError={error}
        onChange={(v) => onBound(v === "" ? null : Number(v))}
      />
    </label>
  );
}

/** Limits editor of the `node_shape_limits` check (GitHub issue #1008): one row per shape of the
 *  tessellation, each with an icon and an optional min and max (equal bounds are an exact count;
 *  an empty bound is no limit on that side). A tessellation with several cell types gets a tab per
 *  type, so every shape of every type has its own limit. Pure over `value`/`onChange` apart from
 *  the icons' tile geometry — the shape vocabulary comes from the caller. */
export function NodeShapeLimitsEditor({ value, cellTypes, onChange, error }: Props) {
  const limits = parseNodeShapeLimits(value);
  const cfg = useMazeStore((s) => activeFloorTessellationOf(s));
  const [selected, setSelected] = useState(cellTypes[0]?.cellType ?? "");
  const current = cellTypes.find((t) => t.cellType === selected) ?? cellTypes[0];

  useEffect(() => {
    if (error) setSelected(error.cellType);
  }, [error]);

  function setBound(cellType: string, key: string, side: "min" | "max", bound: number | null) {
    const ofType = limits[cellType] ?? {};
    onChange(serializeNodeShapeLimits({
      ...limits,
      [cellType]: { ...ofType, [key]: { ...(ofType[key] ?? NO_LIMIT), [side]: bound } },
    }));
  }

  return (
    <Stack gap="sectionGap">
      {!current && <div style={{ color: ui.text.tertiary }}>{m["quality.node_shape_limits_empty"]()}</div>}
      {cellTypes.length > 1 && (
        <Inline gap="sectionGap">
          {cellTypes.map((t) => (
            <Button
              key={t.cellType}
              variant={t === current ? "toggle-selected" : "toggle"}
              onClick={() => setSelected(t.cellType)}
            >
              {nodeShapeCellTypeLabel(t.cellType)}
            </Button>
          ))}
        </Inline>
      )}
      {/* One grid for every row, so the Min and Max columns line up whatever the name lengths. */}
      {current && (
        <div style={styles.grid}>
          {current.shapes.map((key) => {
            const limit = limits[current.cellType]?.[key] ?? NO_LIMIT;
            return (
              <Fragment key={key}>
                <NodeShapeIcon shape={key} cfg={cfg} cell={current.exampleCell} faceRanks={current.faceRanks} />
                <span>{nodeShapeLabel(key, current.shapes)}</span>
                <BoundInput
                  label={m["quality.node_shape_limits_min"]()}
                  bound={limit.min}
                  onBound={(b) => setBound(current.cellType, key, "min", b)}
                  error={error && error.cellType === current.cellType && error.shape === key ? error : null}
                />
                <BoundInput label={m["quality.node_shape_limits_max"]()} bound={limit.max} onBound={(b) => setBound(current.cellType, key, "max", b)} />
              </Fragment>
            );
          })}
        </div>
      )}
    </Stack>
  );
}
