import React, { useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Save, FolderOpen, Maximize2, Bug } from "lucide-react";
import { FeatureCard } from "./FeatureCard";
import type { FeatureStatus } from "./FeatureCard";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { HoverIconButton } from "./HoverIconButton";
import { BasicConfigFeature, getHexOrientationLabel, getTriOrientationLabel } from "./features/BasicConfigFeature";
import { FloorsFeature } from "./features/FloorsFeature";
import { FieldSetupFeature, fieldSetupSubtitle, configCellCount } from "./features/FieldSetupFeature";
import { PresetConnectionsFeature } from "./features/PresetConnectionsFeature";
import { QualityFeature } from "./features/QualityFeature";
import { GenerationFeature } from "./features/GenerationFeature";
import { PostEditFeature } from "./features/PostEditFeature";
import { AnalyticsFeature } from "./features/AnalyticsFeature";
import { ImageExportFeature } from "./features/ImageExportFeature";
import { resolveRenderMode } from "./features/imageExportRegistry";
import { resolveIssue, isIssueEntirelyHidden } from "./issueRegistry";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationKind, FeatureId, FloorState, PngExportSettings } from "../store/mazeStore";
import { downloadProjectFile, parseAndValidate } from "../store/projectExport";
import { buildExactGenerateCallPayload } from "../store/slices/generationSlice";
import { computeInvalidKeys, computeInvalidTeleportIds, computeInvalidMarkers } from "../pixi/fieldEditUtils";
import { selectAnalyticsIssues } from "../pixi/selectors/mazeSelectors";
import { ui, spacing, inset } from "../styles/theme";
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

export interface FloorsCardData {
  status: FeatureStatus;
  comment: string;
  subtitle: string;
}

// floors.length === 0 is unreachable through the UI (removeFloor refuses to drop the last floor,
// default state always starts with one) — kept anyway per the issue's own status mapping, and as
// a defensive fallback if a future path (e.g. a malformed loaded project) ever produces an empty
// list.
export function computeFloorsCard(floors: FloorState[]): FloorsCardData {
  const subtitle = floors.length === 1
    ? m["floors.count_active"]({ count: floors.length })
    : m["floors.count_active_plural"]({ count: floors.length });
  if (floors.length === 0) return { status: "critical", comment: m["status.floors_none"](), subtitle };
  const titles = floors.map((f) => f.title);
  const hasDuplicate = new Set(titles).size !== titles.length;
  if (hasDuplicate) return { status: "warning", comment: m["status.floors_duplicate_title"](), subtitle };
  return { status: "set", comment: m["status.floors_ready"](), subtitle };
}

export function presetConnectionsSubtitle(
  presetConnections: Map<string, unknown>,
  invalidCount: number,
  markerCount: number,
  teleportCount: number = 0,
): string {
  const n = presetConnections.size + markerCount + teleportCount;
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

/// Universal rule: card status mirrors the worst issue severity present, and the comment is
/// that issue's title (not a generic "has issues" message) — critical beats warning, and
/// within a severity the first matching issue (in `issueKinds` order) wins. No issues -> "set".
export function computeAnalyticsCard(hasNodes: boolean, issueKinds: string[]): AnalyticsCardData {
  if (!hasNodes) return { status: "unavailable", comment: m["status.no_maze"]() };

  const issues = issueKinds.map(resolveIssue);
  const subtitleFor = (count: number) => count === 1
    ? m["status.analytics_issues"]({ count })
    : m["status.analytics_issues_plural"]({ count });

  const critical = issues.find((issue) => issue.severity === "critical");
  if (critical != null) {
    return { status: "critical", comment: critical.label, subtitle: subtitleFor(issues.length) };
  }
  const warning = issues.find((issue) => issue.severity === "warning");
  if (warning != null) {
    return { status: "warning", comment: warning.label, subtitle: subtitleFor(issues.length) };
  }
  return { status: "set", comment: m["status.analytics_available"]() };
}

export interface GenerationCardData {
  status: FeatureStatus;
  comment: string;
}

/// Pattern mode on + a positive split chance + no patterns defined is a dead-weight config —
/// splitting is enabled but has nothing to draw from, so it silently never fires. Only
/// `custom_vertex_based` even has pattern mode (see `GenerationFeature.tsx`'s `isVertexBased`).
/// `floorCount > 1` with a non-`custom_vertex_based` method (GitHub issue #337) is a harder
/// block than the split-patterns warning — only `custom_vertex_based` can connect floors at all,
/// so it takes priority and is reported as `critical`, not just `warning`.
export function computeGenerationCard(
  tessellationConfirmed: boolean,
  method: string,
  splitPatternMode: boolean,
  splitChance: number,
  patternCount: number,
  floorCount: number,
): GenerationCardData {
  if (!tessellationConfirmed) return { status: "unavailable", comment: m["status.confirm_tessellation_first"]() };

  const algorithmFloorIncompatible = floorCount > 1 && method !== "custom_vertex_based";
  if (algorithmFloorIncompatible) return { status: "critical", comment: m["status.algorithm_floor_incompatible"]() };

  const splitPatternsMissing = method === "custom_vertex_based" && splitPatternMode && splitChance > 0 && patternCount === 0;
  if (splitPatternsMissing) return { status: "warning", comment: m["status.split_patterns_missing"]() };

  return { status: "set", comment: m["status.ready_to_generate"]() };
}

export interface ImageExportCardData {
  status: FeatureStatus;
  comment: string;
}

/// A stale/unknown activeRenderMode (e.g. a project file naming a since-removed mode — see
/// `imageExportRegistry.ts`'s `resolveRenderMode`) falls back to the same "not selected" reading
/// as `null` — never crashes, never silently pretends a mode is active.
export function computeImageExportCard(hasNodes: boolean, resolvedRenderMode: { label: () => string } | null): ImageExportCardData {
  if (!hasNodes) return { status: "unavailable", comment: m["status.post_edit_unavailable"]() };
  if (resolvedRenderMode === null) return { status: "warning", comment: m["status.render_mode_not_selected"]() };
  return { status: "set", comment: m["status.render_mode_active"]({ mode: resolvedRenderMode.label() }) };
}

export function FeaturesPanel({ onRefit, onExportPng }: {
  onRefit: () => void;
  onExportPng: (settings: PngExportSettings) => Promise<Blob | null>;
}) {
  const openCard = useMazeStore((s) => s.openCard);
  const setOpenCard = useMazeStore((s) => s.setOpenCard);

  const floors = useMazeStore((s) => s.floors);

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
  const presetTeleports = useMazeStore((s) => s.presetTeleports);

  const initialConfig = useMazeStore((s) => s.initialConfig);
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const splitPatternMode = useMazeStore((s) => s.splitPatternMode);
  const splitPatterns = useMazeStore((s) => s.splitPatterns);

  const activeCheckCount = useMazeStore((s) => s.rules.reduce((n, r) => n + r.checks.length, 0));
  const repairMaxIterations = useMazeStore((s) => s.repairMaxIterations);
  const repairTimeBudgetSecs = useMazeStore((s) => s.repairTimeBudgetSecs);
  const nodes = useMazeStore((s) => s.nodes);
  const activeRenderMode = useMazeStore((s) => s.activeRenderMode);
  const analyticsIssues = useMazeStore(useShallow(selectAnalyticsIssues));
  const showFullyPresetLockedIssues = useMazeStore((s) => s.showFullyPresetLockedIssues);
  const loadProject = useMazeStore((s) => s.loadProject);
  const setError = useMazeStore((s) => s.setError);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSave() {
    downloadProjectFile(useMazeStore.getState());
  }

  function handleSaveDebugConfig() {
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `maze-debug-call-${payload.seed}.json`;
    a.click();
    URL.revokeObjectURL(url);
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

  const floorsCard = computeFloorsCard(floors);

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
  const presetInvalidTeleportIds = useMemo(
    () => computeInvalidTeleportIds(presetTeleports, tessellationConfig, customPts),
    [presetTeleports, tessellationConfig, customPts],
  );
  const presetInvalidMarkers = useMemo(
    () => computeInvalidMarkers(presetStart, presetFinish, tessellationConfig, customPts),
    [presetStart, presetFinish, tessellationConfig, customPts],
  );
  const presetInvalidMarkerCount = (presetInvalidMarkers.start ? 1 : 0) + (presetInvalidMarkers.finish ? 1 : 0);
  const presetInvalidCount = presetInvalidKeys.size + presetInvalidTeleportIds.size + presetInvalidMarkerCount;
  const fieldBlocking = fieldStatus === "unavailable" || fieldStatus === "critical";
  const markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0);
  const presetStatus: FeatureStatus = fieldBlocking
    ? "unavailable"
    : presetInvalidCount > 0
    ? "warning"
    : "set";
  const presetComment = !tessellationConfirmed
    ? m["status.confirm_tessellation_first"]()
    : fieldBlocking
    ? m["status.configure_field_first"]()
    : presetInvalidCount > 0
    ? (presetInvalidCount === 1
        ? m["status.presets_outside_field"]({ count: presetInvalidCount })
        : m["status.presets_outside_field_plural"]({ count: presetInvalidCount }))
    : undefined;

  const analyticsCard = computeAnalyticsCard(
    nodes.length > 0,
    analyticsIssues
      .filter((issue) => !isIssueEntirelyHidden(issue, showFullyPresetLockedIssues))
      .map((issue) => issue.kind),
  );

  const resolvedRenderMode = activeRenderMode !== null ? resolveRenderMode(activeRenderMode) : null;
  const imageExportCard = computeImageExportCard(nodes.length > 0, resolvedRenderMode);

  // No checks beats an unbounded repair loop — both are "warning", but having nothing to check
  // at all is the more fundamental gap, so its message takes priority when both are true.
  const repairUnbounded = repairMaxIterations == null && repairTimeBudgetSecs == null;
  const qualityStatus: FeatureStatus = activeCheckCount === 0 || repairUnbounded ? "warning" : "set";
  const qualityComment = activeCheckCount === 0
    ? m["status.no_checks"]()
    : repairUnbounded
    ? m["status.repair_loop_unbounded"]()
    : m["status.quality_configured"]();

  const { status: generationStatus, comment: generationComment } = computeGenerationCard(
    tessellationConfirmed, initialConfig.method, splitPatternMode, elementsConfig.split_chance ?? 0, splitPatterns.length, floors.length,
  );
  const algorithmFloorIncompatible = floors.length > 1 && initialConfig.method !== "custom_vertex_based";

  return (
    <div style={styles.panel}>
      <div style={styles.scrollArea}>
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
        title={m["floors.title"]()}
        status={floorsCard.status}
        comment={floorsCard.comment}
        subtitle={floorsCard.subtitle}
        expanded={openCard === "floors"}
        onOpen={() => handleToggle("floors")}
      >
        <FloorsFeature />
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
          ? presetConnectionsSubtitle(presetConnections, presetInvalidCount, markerCount, presetTeleports.length)
          : undefined}
        expanded={openCard === "preset_connections"}
        onOpen={() => handleToggle("preset_connections")}
      >
        <PresetConnectionsFeature />
      </FeatureCard>
      <FeatureCard
        title={m["quality.title"]()}
        status={qualityStatus}
        comment={qualityComment}
        subtitle={activeCheckCount === 1
          ? m["quality.checks_active"]({ count: activeCheckCount })
          : m["quality.checks_active_plural"]({ count: activeCheckCount })}
        expanded={openCard === "quality"}
        onOpen={() => handleToggle("quality")}
      >
        <QualityFeature />
      </FeatureCard>
      <FeatureCard
        title={m["generation.title"]()}
        status={generationStatus}
        comment={generationComment}
        expanded={openCard === "generation"}
        onOpen={() => handleToggle("generation")}
      >
        <GenerationFeature canGenerate={tessellationConfirmed && !algorithmFloorIncompatible} />
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
      <FeatureCard
        title={m["image_export.title"]()}
        status={imageExportCard.status}
        comment={imageExportCard.comment}
        expanded={openCard === "image_export"}
        onOpen={() => handleToggle("image_export")}
      >
        <ImageExportFeature onExportPng={onExportPng} />
      </FeatureCard>
      </div>
      <div style={styles.footer}>
        <LanguageSwitcher />
        <div style={styles.footerRight}>
          <HoverIconButton onClick={handleSave} title={m["project.save"]()}><Save size={16} /></HoverIconButton>
          <HoverIconButton onClick={handleLoadClick} title={m["project.load"]()}><FolderOpen size={16} /></HoverIconButton>
          <HoverIconButton onClick={handleSaveDebugConfig} title={m["generation.save_debug_config_tooltip"]()}><Bug size={16} /></HoverIconButton>
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
    background: ui.bg.panel,
  },
  scrollArea: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    overflowY: "auto",
    minHeight: 0,
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  footerRight: {
    display: "flex",
    gap: spacing.itemGap,
    alignItems: "stretch",
    alignSelf: "stretch",
  },
};
