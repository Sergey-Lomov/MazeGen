import type * as React from "react";
import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { DirectionIndicatorGeometry, WaypointOpeningMode, WaypointOpeningPatch, WaypointOpeningSettings } from "../../store/imageExportTypes";
import type { OneWayPattern } from "../../pixi/renderers/types";
import type { ColorField, ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { selectFloorScopedMaze } from "../../pixi/selectors/mazeSelectors";
import { endpointOuterFaces, floorCellSet, resolveOpeningFace, type OuterFace } from "../../pixi/selectors/mazeSelectors/waypointOpening";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/exportStyleBuilders";
import { indent, spacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { SectionHeader } from "../SectionHeader";
import { LinkedColorRow, LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import { useGate } from "./LinkContext";
import { IndicatorGeometryRows } from "./IndicatorGeometryRows";
import * as m from "~/paraglide/messages";

type Kind = "start" | "finish";

/** The outer sides of the active floor's start/finish cell, in face order — empty when the endpoint is not on the floor. */
function useOuterFaces(kind: Kind): OuterFace[] {
  const nodes = useMazeStore((s) => s.nodes);
  const edges = useMazeStore((s) => s.edges);
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const start = useMazeStore((s) => s.start);
  const finish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  return useMemo(() => {
    const raw = resolveEffectiveEndpoints({ nodes, start, finish, postEditMeta, postEditDraftSplitPoints });
    const scoped = selectFloorScopedMaze(nodes, edges, floors, activeFloorId, raw.start, raw.finish);
    const id = kind === "start" ? scoped.start : scoped.finish;
    const node = id === null ? undefined : scoped.nodes.find((n) => n.id === id);
    return endpointOuterFaces(node, floorCellSet(scoped.nodes), cfg);
  }, [kind, nodes, edges, floors, activeFloorId, cfg, start, finish, postEditMeta, postEditDraftSplitPoints]);
}

const SIDE_LABELS = {
  top: () => m["image_export.vector_by_walls.opening_side_top"](),
  top_right: () => m["image_export.vector_by_walls.opening_side_top_right"](),
  right: () => m["image_export.vector_by_walls.opening_side_right"](),
  bottom_right: () => m["image_export.vector_by_walls.opening_side_bottom_right"](),
  bottom: () => m["image_export.vector_by_walls.opening_side_bottom"](),
  bottom_left: () => m["image_export.vector_by_walls.opening_side_bottom_left"](),
  left: () => m["image_export.vector_by_walls.opening_side_left"](),
  top_left: () => m["image_export.vector_by_walls.opening_side_top_left"](),
} satisfies Record<OuterFace["compass"], () => string>;

/** Options of the side select: compass names, or the face number where two sides share a name (a dense tessellation). */
export function sideOptions(faces: readonly OuterFace[]): { value: string; label: string }[] {
  const counts = new Map<string, number>();
  for (const f of faces) counts.set(f.compass, (counts.get(f.compass) ?? 0) + 1);
  return faces.map((f) => ({
    value: String(f.face),
    label: (counts.get(f.compass) ?? 0) > 1 ? m["image_export.vector_by_walls.opening_side_numbered"]({ n: f.face + 1 }) : SIDE_LABELS[f.compass](),
  }));
}

/** The "External passage" subsection of a start/finish group (GitHub issue #330, "Vector by walls" only): the mode,
 *  the outer wall to work on (when the cell touches several) and, in the modes that draw one, the "Pointer" group
 *  (always expanded) with the pointer's pattern, color, size, thickness, gap width and corner style. */
export function WaypointOpeningSubsection({ kind, sectionId, settings, onChange, isExpanded, onToggle, linkTargets, field, defaultColor, priorityColors }: {
  kind: Kind;
  /** The owning group's id (e.g. `"markers_start"`); the subsection's own expand id is `${sectionId}_opening`. */
  sectionId: string;
  settings: WaypointOpeningSettings;
  onChange: (patch: WaypointOpeningPatch) => void;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  linkTargets: { mode: "startOpening.mode" | "finishOpening.mode"; pattern: "startOpening.pattern" | "finishOpening.pattern"; color: "startOpening.color" | "finishOpening.color"; gapWidth: "startOpening.gapWidth" | "finishOpening.gapWidth"; join: "startOpening.join" | "finishOpening.join" };
  field: ColorField;
  defaultColor: number;
  priorityColors: ProjectColorEntry[];
}) {
  const passageOn = useGate(kind === "start" ? "startOpeningOn" : "finishOpeningOn");
  const pointerOn = useGate(kind === "start" ? "startOpeningPointerOn" : "finishOpeningPointerOn");
  const faces = useOuterFaces(kind);
  const id = `${sectionId}_opening`;
  const expanded = isExpanded(id);
  const resolved = resolveOpeningFace(faces, settings.face);
  const sides = sideOptions(faces);
  return (
    <>
      <SectionHeader label={m["image_export.vector_by_walls.markers_opening_subsection"]()} expanded={expanded} onToggle={() => onToggle(id)} />
      {expanded && (
        <div style={styles.group}>
          <LinkedSelectRow
            label={m["image_export.vector_by_walls.opening_mode"]()}
            value={settings.mode}
            options={[
              { value: "none" as WaypointOpeningMode, label: m["image_export.vector_by_walls.opening_mode_none"]() },
              { value: "opening" as WaypointOpeningMode, label: m["image_export.vector_by_walls.opening_mode_opening"]() },
              { value: "pointer" as WaypointOpeningMode, label: m["image_export.vector_by_walls.opening_mode_pointer"]() },
              { value: "both" as WaypointOpeningMode, label: m["image_export.vector_by_walls.opening_mode_both"]() },
            ]}
            onChange={(mode) => onChange({ mode })}
            linkTarget={linkTargets.mode}
          />
          {passageOn && faces.length > 1 && (
            <LinkedSelectRow
              label={m["image_export.vector_by_walls.opening_side"]()}
              value={String(resolved?.face ?? "")}
              options={sides}
              onChange={(face) => onChange({ face: Number(face) })}
              linkTarget={null}
            />
          )}
          {pointerOn && (
            <>
              <div style={styles.pointerLabel}>{m["image_export.vector_by_walls.markers_opening_pointer_subsection"]()}</div>
              <div style={styles.group}>
                <LinkedSelectRow
                  label={m["image_export.vector_by_walls.one_way_pattern"]()}
                  value={settings.pattern}
                  options={[
                    { value: "triangle" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                    { value: "chevron" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                    { value: "arrow" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                  ]}
                  onChange={(pattern) => onChange({ pattern })}
                  linkTarget={linkTargets.pattern}
                />
                <LinkedColorRow
                  label={m["image_export.vector_by_walls.one_way_color"]()}
                  color={settings.color}
                  onChange={(color) => onChange({ color })}
                  defaultColor={defaultColor}
                  field={field}
                  priorityColors={priorityColors}
                  linkTarget={linkTargets.color}
                />
                <IndicatorGeometryRows
                  geometry={settings.geometry}
                  onChange={(leaf, value) => {
                    const [pattern, param] = leaf.split(".") as [keyof DirectionIndicatorGeometry, string];
                    onChange({ geometry: { [pattern]: { [param]: value } } });
                  }}
                  prefix={`${kind}Opening.geometry`}
                />
                <LinkedSliderRow
                  label={m["image_export.vector_by_walls.one_way_gap_width"]()}
                  value={settings.gapWidth}
                  onChange={(gapWidth) => onChange({ gapWidth })}
                  min={0}
                  max={10}
                  step={1}
                  format={(v) => String(v)}
                  linkTarget={linkTargets.gapWidth}
                />
                <LinkedSelectRow
                  label={m["image_export.vector_by_walls.one_way_join"]()}
                  value={settings.join}
                  options={[
                    { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                    { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                  ]}
                  onChange={(join) => onChange({ join })}
                  linkTarget={linkTargets.join}
                />
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  pointerLabel: sharedStyles.sectionHeader,
  group: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
