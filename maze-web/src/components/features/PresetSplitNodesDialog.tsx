import { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { presetEndpoint, presetEndpointsEqual, presetEndpointKey, type PresetEndpoint } from "../../pixi/presetEndpoint";
import { presetEdgeKey, resolvePresetActiveEndpoint, resolvePresetPartnerAt } from "../../pixi/fieldEditUtils";
import { activeFloorLevel } from "../../store/storeHelpers";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { blueprintsForDegree } from "../../pixi/splitBlueprints";
import { SplitNodesDialogView, createRequiredLinksTracker, type SplitNodesRow, type LinkInfo, type SplitEdgeKind } from "./SplitNodesDialogView";
import type { TileFace, TileFaceKind, TileFaceNode } from "./TileFaceEditor";
import * as m from "~/paraglide/messages";

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

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
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const cfg = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const applyPresetConnectionsToolAt = useMazeStore((s) => s.applyPresetConnectionsToolAt);
  const setPresetConnectionUndefined = useMazeStore((s) => s.setPresetConnectionUndefined);
  const setPresetStartEndpoint = useMazeStore((s) => s.setPresetStartEndpoint);
  const setPresetFinishEndpoint = useMazeStore((s) => s.setPresetFinishEndpoint);
  const rotatePresetSplitPoint = useMazeStore((s) => s.rotatePresetSplitPoint);
  const setPresetHoveredLink = useMazeStore((s) => s.setPresetHoveredLink);
  const applyPresetSplitBlueprint = useMazeStore((s) => s.applyPresetSplitBlueprint);

  const [activeKind, setActiveKind] = useState<SplitEdgeKind>("passage");

  const level = useMazeStore((s) => activeFloorLevel(s));
  const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const slots = useMemo(() => [...(splitPoints[key] ?? [])].sort((a, b) => a - b), [splitPoints, key]);
  const isActive = (ep: PresetEndpoint) => presetEndpointsEqual(activeSplitNode[key] ?? presetEndpoint(point, undefined, level), ep);

  const inFieldCells = useMemo(
    () => buildCellSet(buildActiveCells(fieldPoints, fieldEditMode, cfg)),
    [fieldPoints, fieldEditMode, cfg],
  );

  // A preset endpoint's label is trivial — just its coordinates, plus a slot suffix for a
  // non-original node. There's no "real NodeId" to resolve (presets run before generation), so
  // unlike post-edit's `describeEndpoint`, this never needs a `nodes` snapshot lookup.
  const describeEndpoint = (ep: PresetEndpoint): string =>
    ep.slotId === undefined
      ? `${ep.point[0]},${ep.point[1]}`
      : `${ep.point[0]},${ep.point[1]} (${m["post_edit.split_node_label"]({ slotId: ep.slotId })})`;

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
    for (const t of presetTeleports) {
      if (t.direction === "two_way") {
        if (presetEndpointsEqual(t.from, ep)) { mark(t.to, "out"); mark(t.to, "in"); }
        else if (presetEndpointsEqual(t.to, ep)) { mark(t.from, "out"); mark(t.from, "in"); }
      } else if (presetEndpointsEqual(t.from, ep)) {
        mark(t.to, t.direction === "backward" ? "in" : "out");
      } else if (presetEndpointsEqual(t.to, ep)) {
        mark(t.from, t.direction === "backward" ? "out" : "in");
      }
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

  const isStart = (ep: PresetEndpoint) => presetStart != null && presetEndpointsEqual(presetStart, ep);
  const isFinish = (ep: PresetEndpoint) => presetFinish != null && presetEndpointsEqual(presetFinish, ep);

  // Node color by row order (original node first, then each slot in slotId order) — same
  // fixed-then-generated palette the canvas uses for resolved split nodes (GitHub issue #223).
  const colorAt = (rowIndex: number) => colorToCss(splitSlotColor(rowIndex, canvas.node.splitSlots));

  const originalEndpoint = presetEndpoint(point, undefined, level);
  const rows: SplitNodesRow<PresetEndpoint>[] = [
    {
      key: presetEndpointKey(originalEndpoint), endpoint: originalEndpoint, title: m["post_edit.split_original_node"](),
      color: colorAt(0), removable: false, active: isActive(originalEndpoint), ownLabel: describeEndpoint(originalEndpoint), links: links(originalEndpoint),
      isStart: isStart(originalEndpoint), isFinish: isFinish(originalEndpoint),
    },
    ...slots.map((slotId, i) => {
      const ep = presetEndpoint(point, slotId, level);
      return {
        key: presetEndpointKey(ep), endpoint: ep, title: m["post_edit.split_node_label"]({ slotId }),
        color: colorAt(1 + i), removable: true, active: isActive(ep), ownLabel: describeEndpoint(ep), links: links(ep),
        isStart: isStart(ep), isFinish: isFinish(ep),
      };
    }),
  ];

  const activeEndpoint = activeSplitNode[key] ?? originalEndpoint;

  const blueprints = useMemo(
    () => blueprintsForDegree(getNeighborData(cfg, point[0], point[1]).offsets.length),
    [cfg, point],
  );

  // Faces of one node (any row, not just the active one) — used to build `tileNodes` below, all
  // of the point's nodes drawn on the tile diagram at once (GitHub issue #234).
  const facesOf = (endpoint: PresetEndpoint): TileFace[] => {
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    return offsets.map(([dx, dy]) => {
      const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
      const boundary = !inFieldCells.has(`${neighbor[0]},${neighbor[1]}`);
      if (boundary) return { kind: "wall" as TileFaceKind, boundary };

      // The neighbor's real connecting node for this face — not just its active UI slot (GitHub
      // issue #243 follow-up): a split neighbor may have its real decided connection on a node
      // other than whichever one currently happens to be active in its own panel.
      const neighborPartner = resolvePresetPartnerAt(
        [endpoint], neighbor, presetConnections, useMazeStore.getState().presetSplitPoints, useMazeStore.getState().presetActiveSplitNode,
      );
      const entry = presetConnections.get(presetEdgeKey(endpoint, neighborPartner));
      let kind: TileFaceKind = "undefined";
      if (entry) {
        if (entry.state === "wall") kind = "wall";
        else if (entry.state === "passage") kind = "passage";
        else if (entry.state === "undefined") kind = "undefined";
        else if (entry.state === "one_way_forward" || entry.state === "one_way_backward") {
          // entry.from/.to are the canonical-order endpoints (see presetEdgeKey) — the actual
          // passage direction is entry.from -> entry.to for "one_way_forward", reversed for
          // "one_way_backward" (Specs/preset-connections.md's "One-way direction").
          const endpointIsFrom = presetEndpointsEqual(entry.from, endpoint);
          const forward = entry.state === "one_way_forward";
          kind = (endpointIsFrom === forward) ? "one_way_out" : "one_way_in";
        }
      }
      return { kind, boundary: false };
    });
  };

  const tileNodes: TileFaceNode[] = useMemo(
    () => rows.map((row) => ({ color: row.color, faces: facesOf(row.endpoint) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, cfg, point, inFieldCells, presetConnections],
  );

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
      title={m["post_edit.manage_split_nodes"]({ x: point[0], y: point[1] })}
      point={point}
      cfg={cfg}
      rows={rows}
      tileNodes={tileNodes}
      availableKinds={AVAILABLE_KINDS}
      activeKind={activeKind}
      onKindChange={setActiveKind}
      onFaceClick={handleFaceClick}
      onFaceRightClick={handleFaceRightClick}
      onClose={() => { setPresetHoveredLink(null); onClose(); }}
      onSetActive={(ep) => setPresetActiveSplitNode(point, ep)}
      onAdd={() => addPresetSplitNode(point)}
      onRemove={(row) => { if (row.endpoint.slotId !== undefined) removePresetSplitNode(point, row.endpoint.slotId); }}
      onToggleStart={() => setPresetStartEndpoint(isStart(activeEndpoint) ? null : activeEndpoint)}
      onToggleFinish={() => setPresetFinishEndpoint(isFinish(activeEndpoint) ? null : activeEndpoint)}
      onRotate={(direction) => rotatePresetSplitPoint(point, direction)}
      onHoverLink={(row, link) => setPresetHoveredLink({ from: row.endpoint, to: link.otherEndpoint })}
      onUnhoverLink={() => setPresetHoveredLink(null)}
      blueprints={blueprints}
      onApplyBlueprint={(blueprint) => applyPresetSplitBlueprint(point, blueprint)}
    />
  );
}
