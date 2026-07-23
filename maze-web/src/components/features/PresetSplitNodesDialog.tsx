import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { presetEndpoint, presetEndpointsEqual, presetEndpointKey, type PresetEndpoint } from "../../pixi/presetEndpoint";
import { SplitNodesDialogView, type SplitNodesRow, type LinkInfo } from "./SplitNodesDialogView";
import * as m from "~/paraglide/messages";

interface Props {
  point: [number, number];
  onClose: () => void;
}

/** Preset-stage adapter for `SplitNodesDialogView` (GitHub issue #231) — manages a split point's
 * declared extra nodes and picks which one preset edge-tool clicks on the point's faces currently
 * target. Unlike post-edit's `ManageSplitNodesDialog`, there is no `NodeId`/`nodes` snapshot to
 * resolve against — presets run before generation, so every endpoint's identity is just its raw
 * `(point, slotId?)`; links are built directly from `presetConnections`/`presetTeleports`/
 * `presetStart`/`presetFinish`/`presetGenSource` via structural comparison. */
export function PresetSplitNodesDialog({ point, onClose }: Props) {
  const splitPoints = useMazeStore((s) => s.presetSplitPoints);
  const activeSplitNode = useMazeStore((s) => s.presetActiveSplitNode);
  const addPresetSplitNode = useMazeStore((s) => s.addPresetSplitNode);
  const removePresetSplitNode = useMazeStore((s) => s.removePresetSplitNode);
  const setPresetActiveSplitNode = useMazeStore((s) => s.setPresetActiveSplitNode);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetTeleports = useMazeStore((s) => s.presetTeleports);

  const key = `${point[0]},${point[1]}`;
  const slots = useMemo(() => [...(splitPoints[key] ?? [])].sort((a, b) => a - b), [splitPoints, key]);
  const isActive = (ep: PresetEndpoint) => presetEndpointsEqual(activeSplitNode[key] ?? presetEndpoint(point), ep);

  // A preset endpoint's label is trivial — just its coordinates, plus a slot suffix for a
  // non-original node. There's no "real NodeId" to resolve (presets run before generation), so
  // unlike post-edit's `describeEndpoint`, this never needs a `nodes` snapshot lookup.
  const describeEndpoint = (ep: PresetEndpoint): string =>
    ep.slotId === undefined
      ? `${ep.point[0]},${ep.point[1]}`
      : `${ep.point[0]},${ep.point[1]} (${m["post_edit.split_node_label"]({ slotId: ep.slotId })})`;

  // Groups an endpoint's connections/teleports/markers by partner, same collapsing rule as
  // post-edit's `links` (a passage's two directed entries become one "<->" link).
  const links = (ep: PresetEndpoint): LinkInfo[] => {
    const byPartner = new Map<string, { otherLabel: string; out: boolean; in: boolean }>();
    const mark = (partnerEp: PresetEndpoint, direction: "out" | "in") => {
      const partnerKey = presetEndpointKey(partnerEp);
      const entry = byPartner.get(partnerKey) ?? { otherLabel: describeEndpoint(partnerEp), out: false, in: false };
      entry[direction] = true;
      byPartner.set(partnerKey, entry);
    };
    for (const entry of presetConnections.values()) {
      // wall/undefined aren't passages — nothing to show as a link.
      if (entry.state === "wall" || entry.state === "undefined") continue;
      const fromMatches = presetEndpointsEqual(entry.from, ep);
      const toMatches = presetEndpointsEqual(entry.to, ep);
      if (!fromMatches && !toMatches) continue;
      const partner = fromMatches ? entry.to : entry.from;
      if (entry.state === "passage") {
        mark(partner, "out");
        mark(partner, "in");
      } else if (entry.state === "one_way_forward") {
        mark(partner, fromMatches ? "out" : "in");
      } else if (entry.state === "one_way_backward") {
        mark(partner, fromMatches ? "in" : "out");
      }
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
    return [...byPartner.values()].map(({ otherLabel, out, in: isIn }) => ({
      otherLabel,
      arrow: out && isIn ? "<->" : isIn ? "<-" : "->",
    }));
  };

  const originalEndpoint = presetEndpoint(point);
  const rows: SplitNodesRow<PresetEndpoint>[] = [
    {
      key: presetEndpointKey(originalEndpoint), endpoint: originalEndpoint, title: m["post_edit.split_original_node"](),
      removable: false, active: isActive(originalEndpoint), ownLabel: describeEndpoint(originalEndpoint), links: links(originalEndpoint),
    },
    ...slots.map((slotId) => {
      const ep = presetEndpoint(point, slotId);
      return {
        key: presetEndpointKey(ep), endpoint: ep, title: m["post_edit.split_node_label"]({ slotId }),
        removable: true, active: isActive(ep), ownLabel: describeEndpoint(ep), links: links(ep),
      };
    }),
  ];

  return (
    <SplitNodesDialogView
      title={m["post_edit.manage_split_nodes"]({ x: point[0], y: point[1] })}
      rows={rows}
      onClose={onClose}
      onSetActive={(ep) => setPresetActiveSplitNode(point, ep)}
      onAdd={() => addPresetSplitNode(point)}
      onRemove={(row) => { if (row.endpoint.slotId !== undefined) removePresetSplitNode(point, row.endpoint.slotId); }}
    />
  );
}
