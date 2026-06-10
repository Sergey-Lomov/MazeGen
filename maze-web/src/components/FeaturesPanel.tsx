import React, { useState } from "react";
import { FeatureCard } from "./FeatureCard";
import type { FeatureStatus } from "./FeatureCard";
import { BasicConfigFeature } from "./features/BasicConfigFeature";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationKind } from "../store/mazeStore";

type FeatureId = "basic_config";

export function FeaturesPanel() {
  const [openCard, setOpenCard] = useState<FeatureId | null>(null);

  const tessellationConfirmed = useMazeStore((s) => s.tessellationConfirmed);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const setPreviewKind = useMazeStore((s) => s.setPreviewKind);
  const setPreviewHexOrientation = useMazeStore((s) => s.setPreviewHexOrientation);
  const setPreviewTriOrientation = useMazeStore((s) => s.setPreviewTriOrientation);

  function syncPreviewToConfirmed() {
    setPreviewKind(tessellationKind);
    if (tessellationKind === "hex") setPreviewHexOrientation(hexOrientation);
    if (tessellationKind === "triangle") setPreviewTriOrientation(triOrientation);
  }

  function handleToggle(id: FeatureId) {
    if (openCard === id) {
      setOpenCard(null);
    } else {
      if (id === "basic_config") syncPreviewToConfirmed();
      setOpenCard(id);
    }
  }

  function basicConfigStatus(): FeatureStatus {
    if (tessellationConfirmed) return "set";
    return "default";
  }

  function basicConfigComment(): string {
    if (tessellationConfirmed) return "Tessellation confirmed";
    return "Not confirmed yet";
  }

  function basicConfigSubtitle(): string | undefined {
    if (!tessellationConfirmed) return undefined;
    const kindLabel: Record<TessellationKind, string> = {
      square: "Square",
      hex: "Hex",
      triangle: "Triangle",
    };
    const label = kindLabel[tessellationKind];
    if (tessellationKind === "hex") {
      return `${label} · ${hexOrientation === "flat_top" ? "flat top" : "pointy top"}`;
    }
    if (tessellationKind === "triangle") {
      const oriLabel: Record<string, string> = { r0: "0°", r90: "90°", r180: "180°", r270: "270°" };
      return `${label} · ${oriLabel[triOrientation] ?? triOrientation}`;
    }
    return label;
  }

  return (
    <div style={styles.panel}>
      <FeatureCard
        title="Basic configuration"
        status={basicConfigStatus()}
        comment={basicConfigComment()}
        subtitle={basicConfigSubtitle()}
        expanded={openCard === "basic_config"}
        onToggle={() => handleToggle("basic_config")}
      >
        <BasicConfigFeature />
      </FeatureCard>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    background: "#1e1e1e",
    overflowY: "auto",
  },
};
