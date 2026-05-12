import { App, ItemView } from "obsidian";
import { CanvasLike, CanvasNodeData, CanvasNodeLike, CanvasSelectionData, CanvasViewLike, RectData } from "./types";

const GROUP_NODE_TYPE = "group";

export interface GroupResolution {
  group: CanvasNodeLike | null;
  nodes: CanvasNodeLike[];
  reason?: string;
}

export class CanvasContextService {
  constructor(private readonly app: App) {}

  getActiveCanvasView(): CanvasViewLike | null {
    const candidateViews: CanvasViewLike[] = [];
    const activeItemView = this.app.workspace.getActiveViewOfType(ItemView);
    const activeLeafView = this.app.workspace.activeLeaf?.view;
    const mostRecentLeafView = this.app.workspace.getMostRecentLeaf()?.view;

    if (activeItemView) {
      candidateViews.push(activeItemView as unknown as CanvasViewLike);
    }

    if (activeLeafView && activeLeafView !== activeItemView) {
      candidateViews.push(activeLeafView as unknown as CanvasViewLike);
    }

    if (mostRecentLeafView && mostRecentLeafView !== activeItemView && mostRecentLeafView !== activeLeafView) {
      candidateViews.push(mostRecentLeafView as unknown as CanvasViewLike);
    }

    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const candidate = leaf.view as unknown as CanvasViewLike;
      if (!candidateViews.includes(candidate)) {
        candidateViews.push(candidate);
      }
    }

    return candidateViews.find((view) => view?.getViewType?.() === "canvas" && view.canvas) ?? null;
  }

  getActiveCanvas(): CanvasLike | null {
    return this.getActiveCanvasView()?.canvas ?? null;
  }

  getSelectedNodes(canvas: CanvasLike): CanvasNodeLike[] {
    const selectionDataNodes = this.getSelectionNodeData(canvas);
    if (selectionDataNodes.length > 0) {
      return selectionDataNodes
        .map((nodeData) => canvas.nodes.get(nodeData.id))
        .filter((node): node is CanvasNodeLike => node !== undefined);
    }

    const rawSelection = Array.from(canvas.selection ?? []);
    return rawSelection.filter((item): item is CanvasNodeLike => this.looksLikeNode(item));
  }

  getAllContentNodes(canvas: CanvasLike): CanvasNodeLike[] {
    return Array.from(canvas.nodes.values()).filter((node) => !this.isGroupNode(node));
  }

  resolveSelectedGroup(canvas: CanvasLike): GroupResolution {
    const selectedNodes = this.getSelectedNodes(canvas);
    if (selectedNodes.length !== 1) {
      return {
        group: null,
        nodes: [],
        reason: "Select exactly one group card before running this command.",
      };
    }

    const [groupNode] = selectedNodes;
    if (!this.isGroupNode(groupNode)) {
      return {
        group: null,
        nodes: [],
        reason: "The selected item is not a group card.",
      };
    }

    const childNodes = this.getDirectChildContentNodes(canvas, groupNode);
    return {
      group: groupNode,
      nodes: childNodes,
    };
  }

  getNodeData(node: CanvasNodeLike): CanvasNodeData | null {
    if (typeof node.getData === "function") {
      return node.getData();
    }

    const maybeData = node as unknown as Partial<CanvasNodeData>;
    if (
      typeof maybeData.id === "string" &&
      typeof maybeData.x === "number" &&
      typeof maybeData.y === "number" &&
      typeof maybeData.width === "number" &&
      typeof maybeData.height === "number"
    ) {
      return maybeData as CanvasNodeData;
    }

    return null;
  }

  getNodeRect(node: CanvasNodeLike): RectData | null {
    const data = this.getNodeData(node);
    if (!data) {
      return null;
    }

    return {
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
    };
  }

  getNodeType(node: CanvasNodeLike): string | undefined {
    return this.getNodeData(node)?.type;
  }

  isGroupNode(node: CanvasNodeLike): boolean {
    return this.getNodeType(node) === GROUP_NODE_TYPE;
  }

  isSupportedResizeNode(node: CanvasNodeLike): boolean {
    return !this.isGroupNode(node) && typeof node.onResizeDblclick === "function";
  }

  private getSelectionNodeData(canvas: CanvasLike): CanvasNodeData[] {
    const selectionData = canvas.getSelectionData?.();
    if (selectionData && this.isSelectionData(selectionData)) {
      return selectionData.nodes ?? [];
    }

    return [];
  }

  private getDirectChildContentNodes(canvas: CanvasLike, groupNode: CanvasNodeLike): CanvasNodeLike[] {
    const groupRect = this.getNodeRect(groupNode);
    const groupData = this.getNodeData(groupNode);
    if (!groupRect || !groupData) {
      return [];
    }

    const allNodes = Array.from(canvas.nodes.values());
    const nestedGroups = allNodes.filter((node) => {
      if (node === groupNode || !this.isGroupNode(node)) {
        return false;
      }

      const nodeRect = this.getNodeRect(node);
      return nodeRect ? this.isFullyInside(nodeRect, groupRect) : false;
    });

    return allNodes.filter((node) => {
      if (node === groupNode || this.isGroupNode(node)) {
        return false;
      }

      const nodeRect = this.getNodeRect(node);
      if (!nodeRect || !this.isFullyInside(nodeRect, groupRect)) {
        return false;
      }

      return !nestedGroups.some((nestedGroup) => {
        const nestedRect = this.getNodeRect(nestedGroup);
        return nestedRect ? this.isFullyInside(nodeRect, nestedRect) : false;
      });
    });
  }

  private isFullyInside(inner: RectData, outer: RectData): boolean {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height
    );
  }

  private isSelectionData(value: unknown): value is CanvasSelectionData {
    return typeof value === "object" && value !== null && Array.isArray((value as CanvasSelectionData).nodes);
  }

  private looksLikeNode(value: unknown): value is CanvasNodeLike {
    if (!value || typeof value !== "object") {
      return false;
    }

    const maybeNode = value as CanvasNodeLike;
    return typeof maybeNode.getData === "function" || typeof maybeNode.onResizeDblclick === "function";
  }
}
