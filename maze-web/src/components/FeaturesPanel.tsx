import React, { useState } from "react";
import { FeatureCard } from "./FeatureCard";
import type { FeatureStatus } from "./FeatureCard";
import { BasicConfigFeature, HEX_ORIENTATION_LABELS, TRI_ORIENTATION_LABELS } from "./features/BasicConfigFeature";
import { FieldSetupFeature, fieldSetupSubtitle } from "./features/FieldSetupFeature";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationKind } from "../store/mazeStore";

const KIND_LABELS: Record<TessellationKind, string> = {
  square: "Square",
  hex: "Hex",
  triangle: "Triangle",
};

type FeatureId = "basic_config" | "field_setup";

export function FeaturesPanel() {
  const [openCard, setOpenCard] = useState<FeatureId | null>(null);

  const tessellationConfirmed = useMazeStore((s) => s.tessellationConfirmed);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const squareShape = useMazeStore((s) => s.squareShape);
  const hexShape = useMazeStore((s) => s.hexShape);
  const triangleShape = useMazeStore((s) => s.triangleShape);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const fieldPoints = useMazeStore((s) => s.fieldPoints);
  const fieldEditMode = useMazeStore((s) => s.fieldEditMode);
  const syncPreviewToConfirmed = useMazeStore((s) => s.syncPreviewToConfirmed);
  const setFieldSetupOpen = useMazeStore((s) => s.setFieldSetupOpen);

  function handleToggle(id: FeatureId) {
    if (openCard === id) {
      if (id === "field_setup") setFieldSetupOpen(false);
      setOpenCard(null);
    } else {
      if (openCard === "field_setup") setFieldSetupOpen(false);
      if (id === "basic_config") syncPreviewToConfirmed();
      if (id === "field_setup") setFieldSetupOpen(true);
      setOpenCard(id);
    }
  }

  const basicConfigStatus: FeatureStatus = tessellationConfirmed ? "set" : "default";
  const basicConfigComment = tessellationConfirmed ? "Tessellation confirmed" : "Not confirmed yet";

  function basicConfigSubtitle(): string | undefined {
    if (!tessellationConfirmed) return undefined;
    const label = KIND_LABELS[tessellationKind];
    if (tessellationKind === "hex") return `${label} · ${HEX_ORIENTATION_LABELS[hexOrientation]}`;
    if (tessellationKind === "triangle") return `${label} · ${TRI_ORIENTATION_LABELS[triOrientation]}`;
    return label;
  }

  const fieldSetupStatus: FeatureStatus = tessellationConfirmed ? "default" : "unavailable";
  const fieldSetupComment = tessellationConfirmed ? "Configure field shape" : "Confirm tessellation first";

  return (
    <div style={styles.panel}>
      <FeatureCard
        title="Basic configuration"
        status={basicConfigStatus}
        comment={basicConfigComment}
        subtitle={basicConfigSubtitle()}
        expanded={openCard === "basic_config"}
        onToggle={() => handleToggle("basic_config")}
      >
        <BasicConfigFeature />
      </FeatureCard>
      <FeatureCard
        title="Field setup"
        status={fieldSetupStatus}
        comment={fieldSetupComment}
        subtitle={tessellationConfirmed
          ? fieldSetupSubtitle(tessellationKind, squareShape, hexShape, triangleShape, fieldEditMode, fieldPoints, tessellationConfig)
          : undefined}
        expanded={openCard === "field_setup"}
        onToggle={() => handleToggle("field_setup")}
      >
        <FieldSetupFeature />
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
