import { useState } from "react";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { NodeShapeLimitsEditor } from "./NodeShapeLimitsEditor";
import { firstInvertedLimit, parseNodeShapeLimits } from "../features/nodeShapeLimits";
import type { CellTypeShapes } from "../../wasm/mazeService";
import * as m from "~/paraglide/messages";

interface Props {
  title: string;
  /** The param's committed JSON value. */
  value: string;
  cellTypes: readonly CellTypeShapes[];
  /** Commits the edited value. Closing the dialog any other way discards the edits. */
  onConfirm: (value: string) => void;
  onClose: () => void;
}

type LimitError = { cellType: string; shape: string; message: () => string };

/** Dialog around `NodeShapeLimitsEditor` (GitHub issue #1008): edits a local draft, so only the
 *  confirm button applies it - closing (Escape, backdrop, the close control) cancels. A limit whose
 *  min is above its max is not applied: the dialog stays open and the first such min field (its tab
 *  opened first when needed) takes focus with an error hint. */
export function NodeShapeLimitsDialog({ title, value, cellTypes, onConfirm, onClose }: Props) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<LimitError | null>(null);

  function confirm() {
    const inverted = firstInvertedLimit(parseNodeShapeLimits(draft), cellTypes);
    if (!inverted) {
      onConfirm(draft);
      return;
    }
    setError({ ...inverted, message: () => m["quality.node_shape_limits_min_above_max"]() });
  }

  return (
    <Modal title={title} onClose={onClose}>
      <NodeShapeLimitsEditor
        value={draft}
        cellTypes={cellTypes}
        error={error}
        onChange={(next) => { setError(null); setDraft(next); }}
      />
      <Button variant="primary" dialogAction onClick={confirm}>
        {m["common.confirm"]()}
      </Button>
    </Modal>
  );
}
