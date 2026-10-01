import { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { presetEndpoint, presetEndpointsEqual, presetEndpointKey, type PresetEndpoint } from "../../pixi/presetEndpoint";
import { presetEdgeKey, resolvePresetActiveEndpoint, presetSplitNodeFaceKinds, rotatePresetSplitPointBreaksNeighborShape } from "../../pixi/fieldEditUtils";
import { activeFloorLevel } from "../../store/storeHelpers";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { splitNodeSemanticNames } from "../../pixi/splitNodeNames";
import { presetTargetLabel, type PresetSplitLabelContext } from "../../pixi/presetSplitLabels";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { SplitNodesDialogView, createRequiredLinksTracker, splitNodeLabel, type LinkInfo, type SplitEdgeKind, type ElementInfo } from "./SplitNodesDialogView";
import { buildPresetPointEntities } from "../../pixi/pointEntities";
import type { TileFace } from "./TileFaceEditor";
import { resolveActiveSplitEndpoint, splitPointKey, useSplitDialogFieldCells, useSplitNodesDialogOrchestration } from "./splitNodesOrchestration";
import * as m from "~/paraglide/messages";

interface Props {
  point: [number, number];
  onClose: () => void;
}

const AVAILABLE_KINDS: SplitEdgeKind[] = ["passage", "one_way", "undefined", "wall"];

/** Preset-stage adapter for `SplitNodesDialogView` (GitHub issue #231, tile+table layout added
 * for #234) — manages a split point's declared extra nodes and picks which one preset edge-tool
 * clicks on the point's faces currently target. Unlike post-edit's `ManageSplitNodesDialog`, there
 * is no `NodeId`/`nodes` snapshot to resolve against — presets run before generation, so every
 * endpoint's identity is just its raw `(point, slotId?)`; links are built directly from
 * `presetConnections`/`presetTeleports`/`presetStart`/`presetFinish`/`presetGenSource` via
 * structural comparison. Offers a third kind, `"undefined"` (the "preset optional connection" —
 * a preset that allows an edge without forcing it), which post-edit has no equivalent of. */
export function PresetSplitNodesDialog({ point, onClose }: Props) {
  const splitPoints = useMazeStore((s) => s.presetSplitPoints);
  const activeSplitNode = useMazeStore((s) => s.presetActiveSplitNode);
  const addPresetSplitNode = useMazeStore((s) => s.addPresetSplitNode);
  const removePresetSplitNode = useMazeStore((s) => s.removePresetSplitNode);
  const setPresetActiveSplitNode = useMazeStore((s) => s.setPresetActiveSplitNode);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetTeleports = useMazeStore((s) => s.presetTeleports);
  const presetVerticalPassages = useMazeStore((s) => s.presetVerticalPassages);
  const presetElevators = useMazeStore((s) => s.presetElevators);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const autoLockedNodes = useMazeStore((s) => s.autoLockedNodes);
  const cfg = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const floorFields = useMazeStore((s) => s.floorFields);
  const floors = useMazeStore((s) => s.floors);
  const applyPresetConnectionsToolAt = useMazeStore((s) => s.applyPresetConnectionsToolAt);
  const setPresetConnectionUndefined = useMazeStore((s) => s.setPresetConnectionUndefined);
  const rotatePresetSplitPoint = useMazeStore((s) => s.rotatePresetSplitPoint);
  const setPresetHoveredLink = useMazeStore((s) => s.setPresetHoveredLink);
  const setPresetHoveredEntity = useMazeStore((s) => s.setPresetHoveredEntity);
  const applyPresetSplitBlueprint = useMazeStore((s) => s.applyPresetSplitBlueprint);

  const [activeKind, setActiveKind] = useState<SplitEdgeKind>("passage");

  const level = useMazeStore((s) => activeFloorLevel(s));
  const key = splitPointKey(point, level);
  const slots = useMemo(() => [...(splitPoints[key] ?? [])].sort((a, b) => a - b), [splitPoints, key]);
  const inFieldCells = useSplitDialogFieldCells(fieldPoints, fieldEditMode, cfg);
  const presetSplitLabelContext: PresetSplitLabelContext = {
    splitPoints,
    presetConnections,
    activeSplitNode,
    cfgAt: (targetLevel) => floorFields[floors[targetLevel]?.id ?? ""]?.tessellationConfig ?? cfg,
    inFieldCellsAt: (targetLevel) => {
      const targetFloor = floorFields[floors[targetLevel]?.id ?? ""];
      return targetFloor
        ? buildCellSet(buildActiveCells(targetFloor.fieldPoints, targetFloor.fieldEditMode, targetFloor.tessellationConfig))
        : inFieldCells;
    },
  };

  const originalEndpoint = presetEndpoint(point, undefined, level);
  // Cross-floor bubble for a vertical-passage/elevator partner (GitHub issue #602) — always shows
  // the floor, via the shared `presetTargetLabel`.
  const floorNodeLabel = (ep: PresetEndpoint): string => presetTargetLabel(presetSplitLabelContext, ep, true);

  const pointElements = buildPresetPointEntities(point, level, level ?? 0, { kind: "point_all" }, {
    presetSplitPoints: splitPoints, presetStart, presetFinish, presetGenSource,
    presetTeleports, presetVerticalPassages, presetElevators, presetConnections,
    lockedNodes, autoLockedNodes, splitCtx: presetSplitLabelContext,
  });
  const elementsFor = (ep: PresetEndpoint): ElementInfo<PresetEndpoint>[] => pointElements
    .filter((e) => ["start", "finish", "teleport", "vertical_passage", "elevator", "lock"].includes(e.kind) && presetEndpointsEqual(e.endpoint, ep))
    .map((e) => {
      if (e.kind === "start" || e.kind === "finish") return { title: e.title, bubbles: [], showArrow: false, arrow: "->" as const };
      if (e.kind === "teleport") {
        const t = presetTeleports.find((entry) => String(entry.id) === e.id);
        if (!t) return { title: e.title, bubbles: [], showArrow: false, arrow: "->" as const };
        const currentFirst = presetEndpointsEqual(t.from, ep) ? t.from : t.to;
        const other = currentFirst === t.from ? t.to : t.from;
        const forward = currentFirst === t.from ? t.direction !== "backward" : t.direction === "backward";
        return { title: m["post_edit.entity_delete_label_teleport"](), bubbles: [describeEndpoint(other)], bubbleFloors: [other.level ?? 0], showArrow: true, arrow: t.direction === "two_way" ? "<->" as const : forward ? "->" as const : "<-" as const, hoverEndpoints: [currentFirst, other] };
      }
      if (e.kind === "vertical_passage") {
        const v = presetVerticalPassages.find((entry) => String(entry.id) === e.id);
        if (!v) return { title: e.title, bubbles: [], showArrow: false, arrow: "->" as const };
        const currentFirst = presetEndpointsEqual(v.from, ep) ? v.from : v.to;
        const other = currentFirst === v.from ? v.to : v.from;
        const forward = currentFirst === v.from ? v.direction !== "backward" : v.direction === "backward";
        return { title: m["post_edit.entity_delete_label_vertical_passage"](), bubbles: [floorNodeLabel(other)], bubbleFloors: [other.level ?? 0], showArrow: true, arrow: v.direction === "two_way" ? "<->" as const : forward ? "->" as const : "<-" as const, hoverEndpoints: [currentFirst, other] };
      }
      if (e.kind === "elevator") {
        const elevator = presetElevators.find((entry) => String(entry.id) === e.id);
        return { title: m["post_edit.entity_delete_label_elevator"](), bubbles: elevator ? elevator.floors.filter((floor) => !presetEndpointsEqual(floor, ep)).map(floorNodeLabel) : [], bubbleFloors: elevator ? elevator.floors.filter((floor) => !presetEndpointsEqual(floor, ep)).map((floor) => floor.level ?? 0) : [], showArrow: false, arrow: "->" as const };
      }
      return { title: e.title, bubbles: [], showArrow: false, arrow: "->" as const };
    });

  // Faces of one node (any row, not just the active one) — used both to build `tileNodes` (all of
  // the point's nodes drawn on the tile diagram at once, GitHub issue #234) and to recognize a
  // named special-split topology for `semanticNames` below. `presetSplitNodeFaceKinds` resolves the
  // neighbor's real connecting node per face (GitHub issue #243), shared with the split-target
  // dialog / status panel.
  const facesOf = (endpoint: PresetEndpoint): TileFace[] => {
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    const kinds = presetSplitNodeFaceKinds(
      endpoint, point, cfg, inFieldCells, presetConnections,
      useMazeStore.getState().presetSplitPoints, useMazeStore.getState().presetActiveSplitNode, level,
    );
    return offsets.map(([dx, dy], i): TileFace => {
      const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
      const boundary = !inFieldCells.has(`${neighbor[0]},${neighbor[1]}`);
      return { kind: kinds[i], boundary };
    });
  };

  // Node endpoints in row order (original node first, then each slot in slotId order) — the same
  // order `rows` and `tileNodes` use.
  const nodeEndpointsInOrder: PresetEndpoint[] = [
    originalEndpoint,
    ...slots.map((slotId) => presetEndpoint(point, slotId, level)),
  ];
  // Semantic per-node names when this point's current face configuration matches a recognized
  // special-split topology (GitHub issue #487) — `null` otherwise, falling back to "Node N".
  const semanticNames = useMemo(
    () => splitNodeSemanticNames(nodeEndpointsInOrder.map((ep) => ({ faces: facesOf(ep) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slots, cfg, point, inFieldCells, presetConnections],
  );
  // A preset endpoint's label is its coordinates, plus a compact "(N{N})" suffix for every node of
  // a *split* point — the point's original node included (slot 0 is not a special node any more,
  // GitHub issue #468) — or the semantic tag when this point is a recognized special split (GitHub
  // issue #487). A plain endpoint on a non-split point has no suffix. There's no "real NodeId" to
  // resolve (presets run before generation), so unlike post-edit's `describeEndpoint`, this never
  // needs a `nodes` snapshot lookup.
  // `ep` may be a cross-floor partner (teleport/vertical passage), so its own level (not the
  // dialog's active floor) decides whether the floor prefix shows.
  const describeEndpoint = (ep: PresetEndpoint): string => {
    const epLevel = ep.level ?? level ?? 0;
    return presetTargetLabel(presetSplitLabelContext, ep, epLevel !== (level ?? 0));
  };

  // Groups an endpoint's connections/teleports/markers by partner, same collapsing rule as
  // post-edit's `links` (a passage's two directed entries become one "<->" link).
  const links = (ep: PresetEndpoint): LinkInfo<PresetEndpoint>[] => {
    const { mark, finalize } = createRequiredLinksTracker(presetEndpointKey, describeEndpoint);
    const forbidden: LinkInfo<PresetEndpoint>[] = [];
    const undecided: LinkInfo<PresetEndpoint>[] = [];
    const decidedPartners = new Set<string>();
    for (const entry of presetConnections.values()) {
      const fromMatches = presetEndpointsEqual(entry.from, ep);
      const toMatches = presetEndpointsEqual(entry.to, ep);
      if (!fromMatches && !toMatches) continue;
      const partner = fromMatches ? entry.to : entry.from;
      if (entry.state === "wall") {
        forbidden.push({ otherLabel: describeEndpoint(partner), otherEndpoint: partner, arrow: fromMatches ? "->" : "<-", category: "forbidden" });
        decidedPartners.add(presetEndpointKey(partner));
        continue;
      }
      if (entry.state === "undefined") {
        undecided.push({ otherLabel: describeEndpoint(partner), otherEndpoint: partner, arrow: fromMatches ? "->" : "<-", category: "undefined" });
        decidedPartners.add(presetEndpointKey(partner));
        continue;
      }
      if (entry.state === "passage") {
        mark(partner, "out");
        mark(partner, "in");
      } else if (entry.state === "one_way_forward") {
        mark(partner, fromMatches ? "out" : "in");
      } else if (entry.state === "one_way_backward") {
        mark(partner, fromMatches ? "in" : "out");
      }
      decidedPartners.add(presetEndpointKey(partner));
    }
    // Every in-field geometric neighbor face with no connection entry at all defaults to
    // "undefined" (GitHub issue #234 follow-up) — a face isn't invisible just because the user
    // never clicked it; it starts out optional/undecided, same as `facesOf`'s tile-diagram model.
    const { offsets } = getNeighborData(cfg, ep.point[0], ep.point[1]);
    for (const [dx, dy] of offsets) {
      const neighbor: [number, number] = [ep.point[0] + dx, ep.point[1] + dy];
      if (!inFieldCells.has(`${neighbor[0]},${neighbor[1]}`)) continue;
      const neighborEndpoint = resolvePresetActiveEndpoint(neighbor, activeSplitNode, level);
      if (decidedPartners.has(presetEndpointKey(neighborEndpoint))) continue;
      undecided.push({ otherLabel: describeEndpoint(neighborEndpoint), otherEndpoint: neighborEndpoint, arrow: "->", category: "undefined" });
    }
    return [...finalize(), ...undecided, ...forbidden];
  };

  // Node color by row order (original node first, then each slot in slotId order) — same
  // fixed-then-generated palette the canvas uses for resolved split nodes (GitHub issue #223).
  const activeEndpoint = resolveActiveSplitEndpoint(activeSplitNode, key, originalEndpoint);
  const { rows, tileNodes, blueprints } = useSplitNodesDialogOrchestration({
    point, cfg, slots, originalEndpoint, endpointForSlot: (slotId) => presetEndpoint(point, slotId, level),
    endpointKey: presetEndpointKey, activeEndpoint, semanticNames,
    fallbackTitle: (rowIndex) => splitNodeLabel(rowIndex === 0 ? undefined : slots[rowIndex - 1]),
    lockKindFor: (endpoint) => lockedNodes.get(presetEndpointKey(endpoint))
      ?? (autoLockedNodes.has(presetEndpointKey(endpoint)) ? "both" : undefined),
    describeEndpoint, linksFor: links, elementsFor, facesOf,
  });

  const handleFaceClick = (offsetIndex: number) => {
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    const [dx, dy] = offsets[offsetIndex];
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];

    if (activeKind === "undefined") {
      const neighborActive = resolvePresetActiveEndpoint(neighbor, useMazeStore.getState().presetActiveSplitNode, level);
      const edgeKeyStr = presetEdgeKey(activeEndpoint, neighborActive);
      setPresetConnectionUndefined(edgeKeyStr, activeEndpoint, neighborActive);
      return;
    }
    const tool = activeKind === "passage" ? "passage" : activeKind === "wall" ? "wall" : "one_way";
    applyPresetConnectionsToolAt(tool, "", point, neighbor);
  };

  const handleFaceRightClick = (offsetIndex: number) => {
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    const [dx, dy] = offsets[offsetIndex];
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    applyPresetConnectionsToolAt("wall", "", point, neighbor);
  };

  return (
    <SplitNodesDialogView
      title={m["post_edit.manage_split_nodes"]({ coords: formatTargetLabel(point, level ?? 0, floors.length > 1, undefined) })}
      point={point}
      cfg={cfg}
      currentLevel={level ?? 0}
      rows={rows}
      tileNodes={tileNodes}
      availableKinds={AVAILABLE_KINDS}
      activeKind={activeKind}
      onKindChange={setActiveKind}
      onFaceClick={handleFaceClick}
      onFaceRightClick={handleFaceRightClick}
      onClose={() => { setPresetHoveredLink(null); setPresetHoveredEntity(null); onClose(); }}
      onSetActive={(ep) => setPresetActiveSplitNode(point, ep)}
      onAdd={() => addPresetSplitNode(point)}
      onRemove={(row) => { if (row.endpoint.slotId !== undefined) removePresetSplitNode(point, row.endpoint.slotId); }}
      onRotate={(direction) => rotatePresetSplitPoint(point, direction)}
      wouldBreakNeighborShape={(direction) => rotatePresetSplitPointBreaksNeighborShape(
        presetConnections, point, slots, direction, cfg, inFieldCells, splitPoints, activeSplitNode, level,
      )}
      onHoverLink={(row, link) => setPresetHoveredLink({ from: row.endpoint, to: link.otherEndpoint })}
      onUnhoverLink={() => setPresetHoveredLink(null)}
      onHoverElement={(_row, element) => {
        const endpoints = element.hoverEndpoints;
        if (endpoints && endpoints.length > 0) setPresetHoveredEntity(endpoints);
      }}
      onUnhoverElement={() => setPresetHoveredEntity(null)}
      blueprints={blueprints}
      onApplyBlueprint={(blueprint) => applyPresetSplitBlueprint(point, blueprint)}
    />
  );
}
