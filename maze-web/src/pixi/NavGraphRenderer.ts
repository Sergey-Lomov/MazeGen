import type { NodeDto, NavNodeDto, NavEdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { canvas } from "./colorUtils";
import { cellCenter } from "./hexGeometry";
import { BaseGraphRenderer, buildPathRenderEdges } from "./BaseGraphRenderer";
import type { Pos, RenderNode } from "./BaseGraphRenderer";

export interface NavGraphData {
  nodes: NodeDto[];
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  start: number | null;
  finish: number | null;
  cfg: TessellationConfig;
  vpScale?: number;
}

export class NavGraphRenderer extends BaseGraphRenderer {
  render(data: NavGraphData): void {
    this.resetContainers();
    if (data.nodes.length === 0) return;

    const { nodes, navNodes, navEdges, start, finish, cfg, vpScale = 1 } = data;
    this.vpScale = vpScale;
    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, cellCenter(node, cfg));

    const renderEdges = buildPathRenderEdges(navEdges, nodePos);
    this.drawEdges(renderEdges, canvas.edge.default);

    const navNodeIds = new Set(navNodes.map(n => n.node_id));
    const renderNodes: RenderNode[] = [];
    for (const nid of navNodeIds) {
      const pos = nodePos.get(nid);
      if (pos) renderNodes.push({ id: nid, pos });
    }

    this.drawNodes(renderNodes, null, start, finish, false);
  }

  clear(): void {
    this.resetContainers();
  }
}
