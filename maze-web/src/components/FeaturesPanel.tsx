import React, { useState, useMemo } from "react";
import { FeatureCard } from "./FeatureCard";
import type { FeatureStatus } from "./FeatureCard";
import { BasicConfigFeature, HEX_ORIENTATION_LABELS, TRI_ORIENTATION_LABELS } from "./features/BasicConfigFeature";
import { FieldSetupFeature, fieldSetupSubtitle, configCellCount } from "./features/FieldSetupFeature";
import { PresetConnectionsFeature, presetConnectionsSubtitle } from "./features/PresetConnectionsFeature";
import { QualityFeature } from "./features/QualityFeature";
import { GenerationFeature } from "./features/GenerationFeature";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationKind } from "../store/mazeStore";
import { computeInvalidKeys } from "../pixi/presetConnectionsUtils";
import { colors } from "../styles/theme";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

function computeFieldStatus(
  tessellationConfirmed: boolean,
  fieldEditMode: "default" | "custom",
  fieldPoints: Set<number>,
  tessellationConfig: TessellationConfig,
): FeatureStatus {
  if (!tessellationConfirmed) return "unavailable";
  const count = fieldEditMode === "custom" ? fieldPoints.size : configCellCount(tessellationConfig);
  if (count === 0) return "critical";
  return "set";
}

const KIND_LABELS: Record<TessellationKind, string> = {
  square: "Square",
  hex: "Hex",
  triangle: "Triangle",
};

type FeatureId = "basic_config" | "field_setup" | "preset_connections" | "quality" | "generation";

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
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const setPresetConnectionsOpen = useMazeStore((s) => s.setPresetConnectionsOpen);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);

  function handleToggle(id: FeatureId) {
    if (openCard === id) {
      if (id === "field_setup") setFieldSetupOpen(false);
      if (id === "preset_connections") setPresetConnectionsOpen(false);
      setOpenCard(null);
    } else {
      if (openCard === "field_setup") setFieldSetupOpen(false);
      if (openCard === "preset_connections") setPresetConnectionsOpen(false);
      if (id === "basic_config") syncPreviewToConfirmed();
      if (id === "field_setup") setFieldSetupOpen(true);
      if (id === "preset_connections") setPresetConnectionsOpen(true);
      setOpenCard(id);
    }
  }

  const basicConfigStatus: FeatureStatus = tessellationConfirmed ? "set" : "critical";
  const basicConfigComment = tessellationConfirmed ? "Tessellation confirmed" : "Not confirmed yet";

  function basicConfigSubtitle(): string | undefined {
    if (!tessellationConfirmed) return undefined;
    const label = KIND_LABELS[tessellationKind];
    if (tessellationKind === "hex") return `${label} · ${HEX_ORIENTATION_LABELS[hexOrientation]}`;
    if (tessellationKind === "triangle") return `${label} · ${TRI_ORIENTATION_LABELS[triOrientation]}`;
    return label;
  }

  const fieldStatus = computeFieldStatus(tessellationConfirmed, fieldEditMode, fieldPoints, tessellationConfig);
  const fieldSetupComment = fieldStatus === "unavailable" ? "Confirm tessellation first"
    : fieldStatus === "critical" ? "Field has no nodes"
    : "Field configured";

  const customPts = fieldEditMode === "custom" && fieldPoints.size > 0 ? fieldPoints : undefined;
  const presetInvalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, tessellationConfig, customPts),
    [presetConnections, tessellationConfig, customPts],
  );
  const fieldBlocking = fieldStatus === "unavailable" || fieldStatus === "critical";
  const markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0);
  const totalPresetCount = presetConnections.size + markerCount;
  const presetStatus: FeatureStatus = fieldBlocking
    ? "unavailable"
    : presetInvalidKeys.size > 0
    ? "warning"
    : "set";
  const presetComment = !tessellationConfirmed
    ? "Confirm tessellation first"
    : fieldBlocking
    ? "Configure field first"
    : presetInvalidKeys.size > 0
    ? `${presetInvalidKeys.size} preset${presetInvalidKeys.size !== 1 ? "s" : ""} outside field`
    : totalPresetCount > 0
    ? "Presets configured"
    : "No presets set";

  return (
    <div style={styles.panel}>
      <FeatureCard
        title="Tessellation"
        status={basicConfigStatus}
        comment={basicConfigComment}
        subtitle={basicConfigSubtitle()}
        expanded={openCard === "basic_config"}
        onToggle={() => handleToggle("basic_config")}
      >
        <BasicConfigFeature />
      </FeatureCard>
      <FeatureCard
        title="Field"
        status={fieldStatus}
        comment={fieldSetupComment}
        subtitle={tessellationConfirmed
          ? fieldSetupSubtitle(tessellationKind, squareShape, hexShape, triangleShape, fieldEditMode, fieldPoints, tessellationConfig)
          : undefined}
        expanded={openCard === "field_setup"}
        onToggle={() => handleToggle("field_setup")}
      >
        <FieldSetupFeature />
      </FeatureCard>
      <FeatureCard
        title="Preset connections"
        status={presetStatus}
        comment={presetComment}
        subtitle={tessellationConfirmed
          ? presetConnectionsSubtitle(presetConnections, presetInvalidKeys.size, markerCount)
          : undefined}
        expanded={openCard === "preset_connections"}
        onToggle={() => handleToggle("preset_connections")}
      >
        <PresetConnectionsFeature />
      </FeatureCard>
      <FeatureCard
        title="Quality"
        status={selectedChecks.length === 0 ? "warning" : "set"}
        comment={selectedChecks.length === 0 ? "No checks active" : "Quality checks configured"}
        subtitle={`${selectedChecks.length} check${selectedChecks.length !== 1 ? "s" : ""} active`}
        expanded={openCard === "quality"}
        onToggle={() => handleToggle("quality")}
      >
        <QualityFeature />
      </FeatureCard>
      <FeatureCard
        title="Generation"
        status={tessellationConfirmed ? "set" : "unavailable"}
        comment={tessellationConfirmed ? "Ready to generate" : "Confirm tessellation first"}
        expanded={openCard === "generation"}
        onToggle={() => handleToggle("generation")}
      >
        <GenerationFeature canGenerate={tessellationConfirmed} />
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
    background: colors.bgPanel,
    overflowY: "auto",
  },
};
