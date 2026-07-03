import { useState, useRef } from "react";
import { useQualityViewModel } from "./useQualityViewModel";
import { RulesColumn } from "./quality/RulesColumn";
import { QualityDetailPanel } from "./quality/QualityDetailPanel";
import { qualityCanvasStyles as styles } from "./quality/qualityCanvasStyles";
import type { QualitySelection } from "./quality/types";

export function QualityCanvas() {
  const [selection, setSelection] = useState<QualitySelection>(null);
  const vm = useQualityViewModel();
  const flushRef = useRef<() => void>(() => {});

  function handleSelect(next: QualitySelection) {
    flushRef.current();
    setSelection(next);
  }

  return (
    <div style={styles.root}>
      <RulesColumn
        stages={vm.stages}
        selection={selection}
        onSelect={handleSelect}
      />
      <div style={styles.divider} />
      <QualityDetailPanel
        selection={selection}
        vm={vm}
        flushRef={flushRef}
        onSelect={handleSelect}
      />
    </div>
  );
}
