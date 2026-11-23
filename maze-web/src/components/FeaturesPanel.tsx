import { TESSELLATION_UI } from "../domain/geometry/tessellationUi";
import { zoneOverrideWarningCount } from "../domain/zoneOverrides";
import React, { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Maximize2, Bug } from "lucide-react";
import { FeatureCard } from "./FeatureCard";
import type { FeatureStatus } from "./FeatureCard";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { FlatIconButton } from "./FlatIconButton";
import { SaveIconButton } from "./SaveIconButton";
import { FileNameModal, timestampedBaseName } from "./FileNameModal";
import { LoadIconButton } from "./LoadIconButton";
import { BasicConfigFeature, getHexOrientationLabel, getTriOrientationLabel } from "./features/BasicConfigFeature";
import { FieldSetupFeature, fieldSetupSubtitle, configCellCount } from "./features/FieldSetupFeature";
import { ZonesFeature } from "./features/ZonesFeature";
import { PresetConnectionsFeature } from "./features/PresetConnectionsFeature";
import { QualityFeature } from "./features/QualityFeature";
import { GenerationFeature } from "./features/GenerationFeature";
import { PostEditFeature } from "./features/PostEditFeature";
import { AnalyticsFeature } from "./features/AnalyticsFeature";
import { ImageExportFeature } from "./features/ImageExportFeature";
import { resolveRenderMode } from "./features/imageExportRegistry";
import { resolveIssue, isIssueEntirelyHidden } from "./issueRegistry";
import { readJsonFile } from "./jsonFile";
import { notify } from "../notifications/notificationStore";
import { PROJECT_LOAD_SOURCE, PROJECT_LOAD_CODES } from "../store/projectLoadNotifications";
import { useMazeStore } from "../store/mazeStore";
import { problematicRuleCount } from "../store/qcDerivedProblems";
import type { TessellationKind, FeatureId, PngExportSettings } from "../store/mazeStore";
import { downloadProjectFile, parseAndValidate, projectFileAccept, FileKindMismatchError, PROJECT_FILE_EXTENSION } from "../store/projectExport";
import { buildExactGenerateCallPayload } from "../store/slices/generationSlice";
import { computeInvalidKeys, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, computeInvalidEndpoint, computeInvalidLockedNodeKeys, computeInvalidSplitPoints, listedInvalidConnections, listedInvalidSplitKeys } from "../domain/fieldValidity";
import { resolveFieldAtOf } from "../store/storeHelpers";
import { selectAnalyticsIssues } from "../domain/selectors/mazeSelectors";
import { countManualZones } from "../domain/selectors/zoneSelectors";
import { ui, spacing, inset } from "../styles/theme";
import type { FieldConfig } from "../fieldConfig";
import * as m from "~/paraglide/messages";

export function computeFieldStatus(
  tessellationConfirmed: boolean,
  floorFields: { fieldEditMode: "default" | "custom"; fieldPoints: Set<number>; fieldConfig: FieldConfig }[],
): FeatureStatus {
  if (!tessellationConfirmed) return "unavailable";
  const totalCount = floorFields.reduce(
    (sum, f) => sum + (f.fieldEditMode === "custom" ? f.fieldPoints.size : configCellCount(f.fieldConfig)),
    0,
  );
  if (totalCount === 0) return "critical";
  return "set";
}

export function presetConnectionsSubtitle(
  presetConnections: Map<string, unknown>,
  markerCount: number,
  teleportCount: number = 0,
  verticalPassageCount: number = 0,
  elevatorCount: number = 0,
): string {
  const n = presetConnections.size + markerCount + teleportCount + verticalPassageCount + elevatorCount;
  if (n === 0) return m["preset.subtitle_none"]();
  const base = n === 1
    ? m["preset.subtitle_count"]({ count: n })
    : m["preset.subtitle_count_plural"]({ count: n });
  return base;
}

export function zonesSubtitle(manualZoneCount: number): string {
  if (manualZoneCount === 0) return m["zones.subtitle_none"]();
  return manualZoneCount === 1
    ? m["zones.subtitle_count"]({ count: manualZoneCount })
    : m["zones.subtitle_count_plural"]({ count: manualZoneCount });
}

export function getTessellationKindLabel(kind: TessellationKind): string {
  const labels: Record<TessellationKind, () => string> = {
    square: m["tessellation.square"],
    hex: m["tessellation.hex"],
    tri: m["tessellation.triangle"],
    cairo: m["tessellation.cairo"],
    square_octagon: m["tessellation.square_octagon"],
    brick: m["tessellation.brick"],
    trihexagonal: m["tessellation.trihexagonal"],
    snub_hexagonal: m["tessellation.snub_hexagonal"],
    rhombitrihexagonal: m["tessellation.rhombitrihexagonal"],
    truncated_hexagonal: m["tessellation.truncated_hexagonal"],
    truncated_trihexagonal: m["tessellation.truncated_trihexagonal"],
    elongated_triangular: m["tessellation.elongated_triangular"],
    snub_square: m["tessellation.snub_square"],
    curved_quadrilateral: m["tessellation.curved_quadrilateral"],
    radial: m["tessellation.radial"],
    voronoi: m["tessellation.voronoi"],
  };
  return labels[kind]();
}

export interface AnalyticsCardData {
  status: FeatureStatus;
  comment: string;
}

/// Universal rule: card status mirrors the worst issue severity present — critical beats
/// warning — and the comment always reports the issue count, not any single issue's title.
export function computeAnalyticsCard(hasNodes: boolean, issueKinds: string[]): AnalyticsCardData {
  if (!hasNodes) return { status: "unavailable", comment: m["status.no_maze"]() };

  const issues = issueKinds.map(resolveIssue);
  const comment = issues.length === 0
    ? m["status.analytics_no_issues"]()
    : issues.length === 1
      ? m["status.analytics_issues"]({ count: issues.length })
      : m["status.analytics_issues_plural"]({ count: issues.length });

  const critical = issues.find((issue) => issue.severity === "critical");
  if (critical != null) return { status: "critical", comment };
  const warning = issues.find((issue) => issue.severity === "warning");
  if (warning != null) return { status: "warning", comment };
  return { status: "set", comment };
}

export interface GenerationCardData {
  status: FeatureStatus;
  comment: string;
}

/// Pattern mode on + a positive split chance + no patterns defined is a dead-weight config —
/// splitting is enabled but has nothing to draw from, so it silently never fires. Only
/// `custom_vertex_based` even has pattern mode (see `GenerationFeature.tsx`'s `isVertexBased`).
export function computeGenerationCard(
  tessellationConfirmed: boolean,
  method: string,
  splitPatternMode: boolean,
  splitChance: number,
  patternCount: number,
  zoneOverrideWarnings = 0,
): GenerationCardData {
  if (!tessellationConfirmed) return { status: "unavailable", comment: m["status.confirm_tessellation_first"]() };

  const splitPatternsMissing = method === "custom_vertex_based" && splitPatternMode && splitChance > 0 && patternCount === 0;
  if (splitPatternsMissing) return { status: "warning", comment: m["status.split_patterns_missing"]() };

  // Zone overrides (GitHub issue #1038) only exist for the custom generator; one with no zones left, or one that
  // sets a parameter another sets on the same cell, is worth a look before generating.
  if (method === "custom_vertex_based" && zoneOverrideWarnings > 0) return { status: "warning", comment: m["status.zone_overrides_warning"]() };

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

export function FeaturesPanel({ onRefit, onExportPng, onFocusTeleportConnector }: {
  onRefit: () => void;
  onExportPng: (settings: PngExportSettings) => Promise<Blob | null>;
  onFocusTeleportConnector?: (points: readonly [number, number][]) => void;
}) {
  const openCard = useMazeStore((s) => s.openCard);
  const setOpenCard = useMazeStore((s) => s.setOpenCard);

  const floors = useMazeStore((s) => s.floors);
  const tessellationConfirmed = useMazeStore((s) => s.tessellationConfirmed);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const tessellationParams = useMazeStore((s) => s.tessellationParams);
  const smoothPrimitives = useMazeStore((s) => s.smoothPrimitives);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const floorFields = useMazeStore((s) => s.floorFields);
  const syncPreviewToConfirmed = useMazeStore((s) => s.syncPreviewToConfirmed);
  const zones = useMazeStore((s) => s.zones);
  const zoneGroups = useMazeStore((s) => s.zoneGroups);
  const zoneOverrides = useMazeStore((s) => s.zoneOverrides);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const presetTeleports = useMazeStore((s) => s.presetTeleports);
  const presetVerticalPassages = useMazeStore((s) => s.presetVerticalPassages);
  const presetElevators = useMazeStore((s) => s.presetElevators);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const presetSplitPoints = useMazeStore((s) => s.presetSplitPoints);

  const initialConfig = useMazeStore((s) => s.initialConfig);
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const splitPatternMode = useMazeStore((s) => s.splitPatternMode);
  const splitPatterns = useMazeStore((s) => s.splitPatterns);

  const activeCheckCount = useMazeStore((s) => s.rules.reduce((n, r) => n + r.checks.length, 0));
  const problemRuleCount = useMazeStore((s) => problematicRuleCount(s.rules, s.stages, s.availableChecks));
  const repairMaxIterations = useMazeStore((s) => s.repairMaxIterations);
  const repairTimeBudgetSecs = useMazeStore((s) => s.repairTimeBudgetSecs);
  const nodes = useMazeStore((s) => s.nodes);
  const activeRenderMode = useMazeStore((s) => s.activeRenderMode);
  const analyticsIssues = useMazeStore(useShallow(selectAnalyticsIssues));
  const showFullyPresetLockedIssues = useMazeStore((s) => s.showFullyPresetLockedIssues);
  const loadProject = useMazeStore((s) => s.loadProject);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [projectSaveDialogOpen, setProjectSaveDialogOpen] = useState(false);
  const [debugDownload, setDebugDownload] = useState<{ baseName: string; payload: NonNullable<ReturnType<typeof buildExactGenerateCallPayload>> } | null>(null);

  function handleSave() {
    setProjectSaveDialogOpen(true);
  }

  function handleSaveDebugConfig() {
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    if (!payload) return;
    setDebugDownload({ baseName: timestampedBaseName(`maze-debug-call-${payload.seed}`), payload });
  }

  function confirmSaveDebugConfig(fileName: string) {
    if (!debugDownload) return;
    setDebugDownload(null);
    const blob = new Blob([JSON.stringify(debugDownload.payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
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
    readJsonFile(file, PROJECT_LOAD_SOURCE, (json) => {
      // Validation runs before `loadProject`, so a rejected file leaves the store untouched.
      let project: ReturnType<typeof parseAndValidate>;
      try {
        project = parseAndValidate(json);
      } catch (err) {
        if (err instanceof FileKindMismatchError) {
          notify({ source: PROJECT_LOAD_SOURCE, code: err.found === "quality_preset" ? PROJECT_LOAD_CODES.qualityPreset : PROJECT_LOAD_CODES.visualPreset });
          return;
        }
        notify({ source: PROJECT_LOAD_SOURCE, code: PROJECT_LOAD_CODES.invalid, details: err instanceof Error ? err.message : String(err) });
        return;
      }
      loadProject(project);
    });
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
    const slot = TESSELLATION_UI[tessellationKind].orientationSlot;
    if (slot === "hex") return `${label} · ${getHexOrientationLabel(hexOrientation)}`;
    if (slot === "tri") return `${label} · ${getTriOrientationLabel(triOrientation)}`;
    return label;
  }

  const orderedFloorFields = useMemo(() => floors.map((f) => floorFields[f.id]), [floors, floorFields]);

  const fieldStatus = computeFieldStatus(tessellationConfirmed, orderedFloorFields);
  const fieldSetupComment = fieldStatus === "unavailable"
    ? m["status.confirm_tessellation_first"]()
    : fieldStatus === "critical"
    ? m["status.field_no_nodes"]()
    : m["status.field_configured"]();

  const resolveFieldAt = useMemo(
    () => resolveFieldAtOf({ floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives }),
    [floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives],
  );
  const presetInvalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, resolveFieldAt),
    [presetConnections, resolveFieldAt],
  );
  const presetInvalidTeleportIds = useMemo(
    () => computeInvalidTeleportIds(presetTeleports, resolveFieldAt),
    [presetTeleports, resolveFieldAt],
  );
  const presetInvalidVerticalPassageIds = useMemo(
    () => computeInvalidVerticalPassageIds(presetVerticalPassages, resolveFieldAt),
    [presetVerticalPassages, resolveFieldAt],
  );
  const presetInvalidElevatorIds = useMemo(
    () => computeInvalidElevatorIds(presetElevators, resolveFieldAt),
    [presetElevators, resolveFieldAt],
  );
  const presetInvalidMarkers = useMemo(
    () => computeInvalidMarkers(presetStart, presetFinish, resolveFieldAt),
    [presetStart, presetFinish, resolveFieldAt],
  );
  const presetInvalidGenSource = useMemo(
    () => computeInvalidEndpoint(presetGenSource, resolveFieldAt),
    [presetGenSource, resolveFieldAt],
  );
  const presetInvalidLockedKeys = useMemo(
    () => computeInvalidLockedNodeKeys(lockedNodes, resolveFieldAt),
    [lockedNodes, resolveFieldAt],
  );
  const presetInvalidSplitKeys = useMemo(
    () => computeInvalidSplitPoints(presetSplitPoints, resolveFieldAt),
    [presetSplitPoints, resolveFieldAt],
  );
  const presetInvalidMarkerCount = (presetInvalidMarkers.start ? 1 : 0) + (presetInvalidMarkers.finish ? 1 : 0) + (presetInvalidGenSource ? 1 : 0);
  const presetInvalidCount = listedInvalidConnections(presetConnections, presetSplitPoints, presetInvalidKeys).length + presetInvalidTeleportIds.size + presetInvalidVerticalPassageIds.size + presetInvalidElevatorIds.size + presetInvalidMarkerCount + presetInvalidLockedKeys.size + listedInvalidSplitKeys(presetSplitPoints, presetInvalidSplitKeys).length;
  const fieldBlocking = fieldStatus === "unavailable" || fieldStatus === "critical";
  const markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0);
  // Always green once available: zones have no invalid state, even with none defined.
  const zonesStatus: FeatureStatus = fieldBlocking ? "unavailable" : "set";
  const zonesComment = !tessellationConfirmed
    ? m["status.confirm_tessellation_first"]()
    : fieldBlocking
    ? m["status.configure_field_first"]()
    : undefined;
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
    ? m["status.problematic_preset_elements"]({ count: presetInvalidCount })
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
  // Problematic rules are left out of generation, so they rank right after having no checks at all.
  const qualityStatus: FeatureStatus = activeCheckCount === 0 || problemRuleCount > 0 || repairUnbounded ? "warning" : "set";
  const qualityComment = activeCheckCount === 0
    ? m["status.no_checks"]()
    : problemRuleCount > 0
    ? m["status.quality_problems"]({ count: problemRuleCount })
    : repairUnbounded
    ? m["status.repair_loop_unbounded"]()
    : m["status.quality_configured"]();

  const { status: generationStatus, comment: generationComment } = computeGenerationCard(
    tessellationConfirmed, initialConfig.method, splitPatternMode, elementsConfig.split_chance ?? 0, splitPatterns.length,
    zoneOverrideWarningCount(zoneOverrides, zones, zoneGroups),
  );

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
        title={m["field.title"]()}
        status={fieldStatus}
        comment={fieldSetupComment}
        subtitle={tessellationConfirmed
          ? fieldSetupSubtitle(tessellationKind, orderedFloorFields)
          : undefined}
        expanded={openCard === "field_setup"}
        onOpen={() => handleToggle("field_setup")}
      >
        <FieldSetupFeature />
      </FeatureCard>
      <FeatureCard
        title={m["zones.title"]()}
        status={zonesStatus}
        comment={zonesComment}
        subtitle={fieldBlocking ? undefined : zonesSubtitle(countManualZones(zones))}
        expanded={openCard === "zones"}
        onOpen={() => handleToggle("zones")}
      >
        <ZonesFeature />
      </FeatureCard>
      <FeatureCard
        title={m["preset.title"]()}
        status={presetStatus}
        comment={presetComment}
        subtitle={tessellationConfirmed
          ? presetConnectionsSubtitle(presetConnections, markerCount, presetTeleports.length, presetVerticalPassages.length, presetElevators.length)
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
        <ImageExportFeature onExportPng={onExportPng} onFocusTeleportConnector={onFocusTeleportConnector ?? (() => {})} />
      </FeatureCard>
      </div>
      <div style={styles.footer}>
        <LanguageSwitcher />
        <div style={styles.footerRight}>
          <SaveIconButton onClick={handleSave} title={m["project.save"]()} />
          <LoadIconButton onClick={handleLoadClick} title={m["project.load"]()} />
          <FlatIconButton onClick={handleSaveDebugConfig} title={m["generation.save_debug_config_tooltip"]()}><Bug size={16} /></FlatIconButton>
          <FlatIconButton onClick={onRefit} title={m["app.fit_to_screen"]()}><Maximize2 size={16} /></FlatIconButton>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          name="project-file"
          accept={projectFileAccept(navigator)}
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        {projectSaveDialogOpen && (
          <FileNameModal
            defaultBaseName={timestampedBaseName("maze-project")}
            extension={PROJECT_FILE_EXTENSION}
            onConfirm={(fileName) => { setProjectSaveDialogOpen(false); downloadProjectFile(useMazeStore.getState(), fileName); }}
            onCancel={() => setProjectSaveDialogOpen(false)}
          />
        )}
        {debugDownload !== null && (
          <FileNameModal
            defaultBaseName={debugDownload.baseName}
            extension=".json"
            onConfirm={confirmSaveDebugConfig}
            onCancel={() => setDebugDownload(null)}
          />
        )}
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
    alignItems: "center",
  },
};
