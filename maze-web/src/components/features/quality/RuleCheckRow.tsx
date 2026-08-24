import { useMazeStore } from "../../../store/mazeStore";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import { Switch } from "../../Switch";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { X } from "lucide-react";
import { ui } from "../../../styles/theme";
import type { CheckVM } from "../useQualityViewModel";
import type { QualitySelection } from "./types";

// Stable reference for the lookup-miss fallback — a fresh `{}` literal on every selector call
// would make the Zustand selector return a new reference each render even when the underlying
// store data hasn't changed, causing unnecessary re-renders.
const EMPTY_PARAMS: Record<string, string> = {};

interface Props {
  check: CheckVM;
  selected: boolean;
  /** Current whole-canvas selection — used only to compute which of this check's own params (if
   * any) is currently selected (GitHub issue #375), same purpose `RuleStrategyPanel`'s `selection`
   * prop serves for its own params. */
  selection: QualitySelection;
  hovered: boolean;
  onSelect: () => void;
  /** Selects one of this check's params — forwarded to `ParamFields` as `onSelectParam`. */
  onSelectParam: (s: QualitySelection) => void;
  onRemove: () => void;
  onHoverChange: (hovered: boolean) => void;
}

// Row for one check inside a rule card's check list. Mirrors RuleStrategyPanel: the row header
// plus its params shown inline underneath, always expanded — same layout the strategy half uses,
// so checks and strategy read as the same kind of thing rather than checks needing an extra click.
export function RuleCheckRow({ check, selected, selection, hovered, onSelect, onSelectParam, onRemove, onHoverChange }: Props) {
  const setCheckParam = useMazeStore((s) => s.setCheckParam);
  const toggleCheckDisabled = useMazeStore((s) => s.toggleCheckDisabled);
  const storeValues = useMazeStore((s) => s.rules.find((r) => r.id === check.ruleId)?.checks.find((c) => c.localId === check.localId)?.params ?? EMPTY_PARAMS);

  const { values, onChange, flushRef } = useParamEditor({
    entityId: check.id,
    params: check.params,
    storeValues,
    onCommit: (paramId, value) => setCheckParam(check.ruleId, check.localId, paramId, value),
  });

  return (
    <div style={check.disabled ? styles.ruleCheckRowDisabled : undefined}>
      <div
        style={{
          ...styles.ruleCheckRow,
          ...(hovered ? styles.ruleCheckRowHover : {}),
          ...(selected ? styles.ruleCheckRowSelected : {}),
        }}
        onClick={() => {
          flushRef.current();
          onSelect();
        }}
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
      >
        <span style={styles.cardLabel}>{check.cardLabel}</span>
        <div
          style={styles.toggleWrap}
          title={check.disabled ? m["quality.enable_check"]() : m["quality.disable_check"]()}
          onClick={(e) => e.stopPropagation()}
        >
          <Switch checked={!check.disabled} onChange={() => { flushRef.current(); toggleCheckDisabled(check.ruleId, check.localId); }} />
        </div>
        <button
          className="hoverable"
          style={styles.removeBtn}
          title={m["quality.remove"]()}
          onClick={(e) => {
            e.stopPropagation();
            flushRef.current();
            onRemove();
          }}
        >
          <X size={18} color={ui.text.tertiary} />
        </button>
      </div>
      {check.params.length > 0 && (
        <div style={styles.ruleStrategyParams}>
          <ParamFields
            params={check.params}
            values={values}
            onChange={onChange}
            disabled={check.disabled}
            onSelectParam={(paramId) => { flushRef.current(); onSelectParam({ type: "param", owner: { kind: "check", checkId: check.id }, paramId }); }}
            selectedParamId={selection?.type === "param" && selection.owner.kind === "check" && selection.owner.checkId === check.id ? selection.paramId : null}
          />
        </div>
      )}
    </div>
  );
}
