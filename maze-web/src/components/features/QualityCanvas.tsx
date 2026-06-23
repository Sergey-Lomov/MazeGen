import { useState, useRef } from "react";
import { useQualityViewModel } from "./useQualityViewModel";
import { ChecksColumn } from "./quality/ChecksColumn";
import { StrategiesColumn } from "./quality/StrategiesColumn";
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
      <ChecksColumn
        checks={vm.checks}
        selection={selection}
        onSelect={handleSelect}
      />
      <div style={styles.divider} />
      <StrategiesColumn
        slots={vm.strategySlots}
        selection={selection}
        onSelect={handleSelect}
      />
      <div style={styles.divider} />
      <QualityDetailPanel
        selection={selection}
        vm={vm}
        flushRef={flushRef}
      />
    </div>
  );
}
