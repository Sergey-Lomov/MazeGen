import { useMazeStore } from "../../../store/mazeStore";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { X } from "lucide-react";
import { colors } from "../../../styles/theme";
import type { CheckVM } from "../useQualityViewModel";

interface Props {
  check: CheckVM;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onHoverChange: (hovered: boolean) => void;
}

// Row for one check inside a rule card's check list. Mirrors RuleStrategyPanel: the row header
// plus its params shown inline underneath, always expanded — same layout the strategy half uses,
// so checks and strategy read as the same kind of thing rather than checks needing an extra click.
export function RuleCheckRow({ check, selected, hovered, onSelect, onRemove, onHoverChange }: Props) {
  const checkParams = useMazeStore((s) => s.checkParams);
  const setCheckParam = useMazeStore((s) => s.setCheckParam);

  const { values, onChange, flushRef } = useParamEditor({
    entityId: check.id,
    params: check.params,
    storeValues: checkParams[check.id] ?? {},
    onCommit: (paramId, value) => setCheckParam(check.id, paramId, value),
  });

  return (
    <div>
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
        <span style={styles.cardLabel}>{check.label}</span>
        <button
          style={styles.removeBtn}
          title={m["quality.remove"]()}
          onClick={(e) => {
            e.stopPropagation();
            flushRef.current();
            onRemove();
          }}
        >
          <X size={18} color={colors.textDim} />
        </button>
      </div>
      {check.params.length > 0 && (
        <div style={styles.ruleStrategyParams}>
          <ParamFields params={check.params} values={values} onChange={onChange} labelSize="sm" />
        </div>
      )}
    </div>
  );
}
