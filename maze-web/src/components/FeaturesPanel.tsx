import React, { useState, useMemo } from "react";
import { FeatureCard } from "./FeatureCard";
import type { FeatureStatus } from "./FeatureCard";
import { BasicConfigFeature, getHexOrientationLabel, getTriOrientationLabel } from "./features/BasicConfigFeature";
import { FieldSetupFeature, fieldSetupSubtitle, configCellCount } from "./features/FieldSetupFeature";
import { PresetConnectionsFeature } from "./features/PresetConnectionsFeature";
import { QualityFeature } from "./features/QualityFeature";
import { GenerationFeature } from "./features/GenerationFeature";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationKind } from "../store/mazeStore";
import { computeInvalidKeys } from "../pixi/presetConnectionsUtils";
import { colors, font } from "../styles/theme";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { useLocale } from "../i18n/useLocale";
import type { Locale } from "../i18n/useLocale";
import * as m from "~/paraglide/messages";

function LanguageSwitcher() {
  const { locale, setLocale, availableLocales } = useLocale();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      style={langSwitcherStyles.select}
    >
      {availableLocales.map((lang) => (
        <option key={lang} value={lang}>{lang.toUpperCase()}</option>
      ))}
    </select>
  );
}

const langSwitcherStyles: Record<string, React.CSSProperties> = {
  select: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    fontSize: font.sm,
    padding: "2px 4px",
    borderRadius: 3,
    cursor: "pointer",
  },
};

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

function presetConnectionsSubtitle(
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

function getTessellationKindLabel(kind: TessellationKind): string {
  const labels: Record<TessellationKind, () => string> = {
    square: m["tessellation.square"],
    hex: m["tessellation.hex"],
    triangle: m["tessellation.triangle"],
  };
  return labels[kind]();
}

type FeatureId = "basic_config" | "field_setup" | "preset_connections" | "quality" | "generation";

export function FeaturesPanel() {
  const [openCard, setOpenCard] = useState<FeatureId>("basic_config");

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
  const setGenerationOpen = useMazeStore((s) => s.setGenerationOpen);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);

  function handleToggle(id: FeatureId) {
    if (openCard === id) return;
    if (openCard === "field_setup") setFieldSetupOpen(false);
    if (openCard === "preset_connections") setPresetConnectionsOpen(false);
    if (openCard === "generation") setGenerationOpen(false);
    if (id === "basic_config") syncPreviewToConfirmed();
    if (id === "field_setup") setFieldSetupOpen(true);
    if (id === "preset_connections") setPresetConnectionsOpen(true);
    if (id === "generation") setGenerationOpen(true);
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

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <LanguageSwitcher />
      </div>
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
  header: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    padding: "6px 10px",
    borderBottom: `1px solid ${colors.borderDim}`,
  },
};
