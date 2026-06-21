import React, { useMemo, useRef } from "react";
import { Save, FolderOpen, Maximize2 } from "lucide-react";
import { FeatureCard } from "./FeatureCard";
import type { FeatureStatus } from "./FeatureCard";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { HoverIconButton } from "./HoverIconButton";
import { BasicConfigFeature, getHexOrientationLabel, getTriOrientationLabel } from "./features/BasicConfigFeature";
import { FieldSetupFeature, fieldSetupSubtitle, configCellCount } from "./features/FieldSetupFeature";
import { PresetConnectionsFeature } from "./features/PresetConnectionsFeature";
import { QualityFeature } from "./features/QualityFeature";
import { GenerationFeature } from "./features/GenerationFeature";
import { PostEditFeature } from "./features/PostEditFeature";
import { AnalyticsFeature } from "./features/AnalyticsFeature";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationKind, FeatureId } from "../store/mazeStore";
import { downloadProjectFile, parseAndValidate } from "../store/projectExport";
import { computeInvalidKeys } from "../pixi/presetConnectionsUtils";
import { colors } from "../styles/theme";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import * as m from "~/paraglide/messages";

export function computeFieldStatus(
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

export function presetConnectionsSubtitle(
  presetConnections: Map<string, unknown>,
  invalidCount: number,
  markerCount: number,
): string {
  const n = presetConnections.size + markerCount;
  if (n === 0) return m["preset.subtitle_none"]();
  const base = n === 1
    ? m["preset.subtitle_count"]({ count: n })
    : m["preset.subtitle_count_plural"]({ count: n });
  if (invalidCount > 0) return `${base} · ${m["preset.subtitle_invalid"]({ count: invalidCount })}`;
  return base;
}

export function getTessellationKindLabel(kind: TessellationKind): string {
  const labels: Record<TessellationKind, () => string> = {
    square: m["tessellation.square"],
    hex: m["tessellation.hex"],
    triangle: m["tessellation.triangle"],
  };
  return labels[kind]();
}

export interface AnalyticsCardData {
  status: FeatureStatus;
  comment: string;
  subtitle?: string;
}

export function computeAnalyticsCard(hasNodes: boolean, warningsCount: number): AnalyticsCardData {
  if (!hasNodes) return { status: "unavailable", comment: m["status.no_maze"]() };
  if (warningsCount > 0) {
    return {
      status: "warning",
      comment: m["status.post_edit_has_issues"](),
      subtitle: warningsCount === 1
        ? m["status.analytics_issues"]({ count: warningsCount })
        : m["status.analytics_issues_plural"]({ count: warningsCount }),
    };
  }
  return { status: "set", comment: m["status.analytics_available"]() };
}

export function FeaturesPanel({ onRefit }: { onRefit: () => void }) {
  const openCard = useMazeStore((s) => s.openCard);
  const setOpenCard = useMazeStore((s) => s.setOpenCard);

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
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);

  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const nodes = useMazeStore((s) => s.nodes);
  const postEditAnalytics = useMazeStore((s) => s.postEditAnalytics);
  const generatedWarnings = useMazeStore((s) => s.warnings);
  const loadProject = useMazeStore((s) => s.loadProject);
  const setError = useMazeStore((s) => s.setError);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSave() {
    const state = useMazeStore.getState();
    if (!state.tessellationConfirmed) return;
    downloadProjectFile(state);
  }

  function handleLoadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onerror = () => setError(m["project.load_error_io"]());
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          setError(m["project.load_error_json"]());
          return;
        }
        const projectFile = parseAndValidate(json);
        loadProject(projectFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(m["project.load_error"]({ message }));
      }
    };
    reader.readAsText(file);
  }

  function handleToggle(id: FeatureId) {
    if (openCard === id) return;
    if (id === "basic_config") syncPreviewToConfirmed();
    setOpenCard(id);
  }

  const basicConfigStatus: FeatureStatus = tessellationConfirmed ? "set" : "critical";
  const basicConfigComment = tessellationConfirmed
    ? m["status.tessellation_confirmed"]()
    : m["status.not_confirmed"]();

  function basicConfigSubtitle(): string | undefined {
    if (!tessellationConfirmed) return undefined;
    const label = getTessellationKindLabel(tessellationKind);
    if (tessellationKind === "hex") return `${label} · ${getHexOrientationLabel(hexOrientation)}`;
    if (tessellationKind === "triangle") return `${label} · ${getTriOrientationLabel(triOrientation)}`;
    return label;
  }

  const fieldStatus = computeFieldStatus(tessellationConfirmed, fieldEditMode, fieldPoints, tessellationConfig);
  const fieldSetupComment = fieldStatus === "unavailable"
    ? m["status.confirm_tessellation_first"]()
    : fieldStatus === "critical"
    ? m["status.field_no_nodes"]()
    : m["status.field_configured"]();

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
    ? m["status.confirm_tessellation_first"]()
    : fieldBlocking
    ? m["status.configure_field_first"]()
    : presetInvalidKeys.size > 0
    ? (presetInvalidKeys.size === 1
        ? m["status.presets_outside_field"]({ count: presetInvalidKeys.size })
        : m["status.presets_outside_field_plural"]({ count: presetInvalidKeys.size }))
    : totalPresetCount > 0
    ? m["status.presets_configured"]()
    : m["status.no_presets"]();

  const analyticsCard = computeAnalyticsCard(nodes.length > 0, (postEditAnalytics?.warnings ?? generatedWarnings).length);

  return (
    <div style={styles.panel}>
      <FeatureCard
        title={m["tessellation.title"]()}
        status={basicConfigStatus}
        comment={basicConfigComment}
        subtitle={basicConfigSubtitle()}
        expanded={openCard === "basic_config"}
        onOpen={() => handleToggle("basic_config")}
      >
        <BasicConfigFeature />
      </FeatureCard>
      <FeatureCard
        title={m["field.title"]()}
        status={fieldStatus}
        comment={fieldSetupComment}
        subtitle={tessellationConfirmed
          ? fieldSetupSubtitle(tessellationKind, squareShape, hexShape, triangleShape, fieldEditMode, fieldPoints, tessellationConfig)
          : undefined}
        expanded={openCard === "field_setup"}
        onOpen={() => handleToggle("field_setup")}
      >
        <FieldSetupFeature />
      </FeatureCard>
      <FeatureCard
        title={m["preset.title"]()}
        status={presetStatus}
        comment={presetComment}
        subtitle={tessellationConfirmed
          ? presetConnectionsSubtitle(presetConnections, presetInvalidKeys.size, markerCount)
          : undefined}
        expanded={openCard === "preset_connections"}
        onOpen={() => handleToggle("preset_connections")}
      >
        <PresetConnectionsFeature />
      </FeatureCard>
      <FeatureCard
        title={m["quality.title"]()}
        status={selectedChecks.length === 0 ? "warning" : "set"}
        comment={selectedChecks.length === 0 ? m["status.no_checks"]() : m["status.quality_configured"]()}
        subtitle={selectedChecks.length === 1
          ? m["quality.checks_active"]({ count: selectedChecks.length })
          : m["quality.checks_active_plural"]({ count: selectedChecks.length })}
        expanded={openCard === "quality"}
        onOpen={() => handleToggle("quality")}
      >
        <QualityFeature />
      </FeatureCard>
      <FeatureCard
        title={m["generation.title"]()}
        status={tessellationConfirmed ? "set" : "unavailable"}
        comment={tessellationConfirmed ? m["status.ready_to_generate"]() : m["status.confirm_tessellation_first"]()}
        expanded={openCard === "generation"}
        onOpen={() => handleToggle("generation")}
      >
        <GenerationFeature canGenerate={tessellationConfirmed} />
      </FeatureCard>
      <FeatureCard
        title={m["post_edit.title"]()}
        status={nodes.length === 0 ? "unavailable" : "set"}
        comment={nodes.length === 0 ? m["status.post_edit_unavailable"]() : m["status.post_edit_ready"]()}
        expanded={openCard === "post_edit"}
        onOpen={() => handleToggle("post_edit")}
      >
        <PostEditFeature />
      </FeatureCard>
      <FeatureCard
        title={m["analytics.title"]()}
        status={analyticsCard.status}
        comment={analyticsCard.comment}
        subtitle={analyticsCard.subtitle}
        expanded={openCard === "analytics"}
        onOpen={() => handleToggle("analytics")}
      >
        <AnalyticsFeature />
      </FeatureCard>
      <div style={styles.footer}>
        <LanguageSwitcher />
        <div style={styles.footerRight}>
          <HoverIconButton onClick={handleSave} title={m["project.save"]()}><Save size={16} /></HoverIconButton>
          <HoverIconButton onClick={handleLoadClick} title={m["project.load"]()}><FolderOpen size={16} /></HoverIconButton>
          <HoverIconButton onClick={onRefit} title="Fit to screen"><Maximize2 size={16} /></HoverIconButton>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>
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
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 10px",
    borderTop: `1px solid ${colors.borderDim}`,
    marginTop: "auto",
  },
  footerRight: {
    display: "flex",
    gap: 4,
    alignItems: "center",
  },
};
