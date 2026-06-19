import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { colors, font } from "../../styles/theme";
import * as m from "~/paraglide/messages";

export function QualityFeature() {
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const openCard = useMazeStore((s) => s.openCard);

  if (openCard === "quality") return null;

  return (
    <div style={styles.root}>
      {selectedChecks.length === 0 ? (
        <span style={styles.empty}>{m["status.no_checks"]()}</span>
      ) : (
        <span style={styles.hint}>{m["quality.open_to_configure"]()}</span>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    paddingBottom: 4,
  },
  empty: {
    fontSize: font.sm,
    color: colors.textVeryDim,
  },
  hint: {
    fontSize: font.sm,
    color: colors.textVeryDim,
  },
};
