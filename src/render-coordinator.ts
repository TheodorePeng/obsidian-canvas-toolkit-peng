import { BBoxData, CanvasLike, CanvasNodeLike, RectData } from "./types";

const DEFAULT_PAN_PADDING = 48;
const MAX_RENDER_ATTEMPTS = 8;
const STABILITY_ATTEMPTS = 3;
const SETTLE_DELAY_MS = 90;
const VIEWPORT_RESTORE_SETTLE_MS = 120;

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface RenderReadiness {
  ready: boolean;
  reason?: string;
}

interface MeasurementSignature {
  rectWidth: number;
  rectHeight: number;
  contentClientWidth: number;
  contentScrollWidth: number;
  contentClientHeight: number;
  contentScrollHeight: number;
  previewClientWidth: number;
  previewScrollWidth: number;
  previewClientHeight: number;
  previewScrollHeight: number;
}

export class CanvasRenderCoordinator {
  captureViewport(canvas: CanvasLike): ViewportState | null {
    if (!Number.isFinite(canvas.x) || !Number.isFinite(canvas.y) || !Number.isFinite(canvas.zoom)) {
      return null;
    }

    return {
      x: Number(canvas.x),
      y: Number(canvas.y),
      zoom: Number(canvas.zoom),
    };
  }

  async restoreViewport(canvas: CanvasLike, viewport: ViewportState | null): Promise<void> {
    if (!viewport || typeof canvas.setViewport !== "function") {
      return;
    }

    canvas.setViewport(viewport.x, viewport.y, viewport.zoom);
    canvas.requestFrame?.();
    await this.waitForFrames(2);
    await this.sleep(VIEWPORT_RESTORE_SETTLE_MS);
  }

  async ensureNodeReady(node: CanvasNodeLike): Promise<RenderReadiness> {
    const canvas = node.canvas;
    const bbox = this.getNodeBBox(node);
    if (!canvas) {
      return { ready: false, reason: "Canvas runtime is missing for this node." };
    }

    if (!bbox) {
      return { ready: false, reason: "Node bounding box is unavailable." };
    }

    for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
      if (this.hasUsableMeasurements(node)) {
        const stable = await this.waitForStableMeasurements(node);
        if (stable) {
          return { ready: true };
        }
      }

      canvas.panIntoView?.(bbox, DEFAULT_PAN_PADDING);
      canvas.requestFrame?.();
      await this.waitForFrames(2);
      await this.sleep(SETTLE_DELAY_MS);
    }

    return {
      ready: false,
      reason: "Node DOM did not stabilize after bringing it into view.",
    };
  }

  async waitForNodeStability(node: CanvasNodeLike): Promise<boolean> {
    return this.waitForStableMeasurements(node);
  }

  getNodeBBox(node: CanvasNodeLike): BBoxData | null {
    const bbox = node.getBBox?.();
    if (this.isBBoxData(bbox)) {
      return bbox;
    }

    const data = node.getData?.();
    if (!data) {
      return null;
    }

    return {
      minX: data.x,
      minY: data.y,
      maxX: data.x + data.width,
      maxY: data.y + data.height,
    };
  }

  getNodeRect(node: CanvasNodeLike): RectData | null {
    const data = node.getData?.();
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

  getContentElement(node: CanvasNodeLike): HTMLElement | null {
    const nodeEl = node.nodeEl;
    if (!(nodeEl instanceof HTMLElement)) {
      return null;
    }

    const content = node.contentEl ?? nodeEl.querySelector(".canvas-node-content");
    return content instanceof HTMLElement ? content : null;
  }

  getPreviewElement(node: CanvasNodeLike): HTMLElement | null {
    const nodeEl = node.nodeEl;
    if (!(nodeEl instanceof HTMLElement)) {
      return null;
    }

    const preview = nodeEl.querySelector(".nbe-embed, .markdown-preview-sizer, .markdown-preview-view");
    return preview instanceof HTMLElement ? preview : null;
  }

  private hasUsableMeasurements(node: CanvasNodeLike): boolean {
    const nodeEl = node.nodeEl;
    if (!(nodeEl instanceof HTMLElement) || !nodeEl.isConnected) {
      return false;
    }

    const rect = nodeEl.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return false;
    }

    const content = this.getContentElement(node);
    if (!(content instanceof HTMLElement)) {
      return false;
    }

    const preview = this.getPreviewElement(node);
    const maxMetric = Math.max(
      content.clientWidth,
      content.scrollWidth,
      content.clientHeight,
      content.scrollHeight,
      preview?.clientWidth ?? 0,
      preview?.scrollWidth ?? 0,
      preview?.clientHeight ?? 0,
      preview?.scrollHeight ?? 0,
    );

    return maxMetric > 0;
  }

  private async waitForStableMeasurements(node: CanvasNodeLike): Promise<boolean> {
    let previous = this.readMeasurementSignature(node);
    if (!previous) {
      return false;
    }

    for (let attempt = 0; attempt < STABILITY_ATTEMPTS; attempt += 1) {
      await this.waitForFrames(1);
      await this.sleep(SETTLE_DELAY_MS);

      const next = this.readMeasurementSignature(node);
      if (!next) {
        return false;
      }

      if (this.signatureEquals(previous, next)) {
        return true;
      }

      previous = next;
    }

    return false;
  }

  private readMeasurementSignature(node: CanvasNodeLike): MeasurementSignature | null {
    if (!this.hasUsableMeasurements(node)) {
      return null;
    }

    const nodeEl = node.nodeEl as HTMLElement;
    const content = this.getContentElement(node) as HTMLElement;
    const preview = this.getPreviewElement(node);
    const rect = nodeEl.getBoundingClientRect();

    return {
      rectWidth: Math.round(rect.width),
      rectHeight: Math.round(rect.height),
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      previewClientWidth: preview?.clientWidth ?? 0,
      previewScrollWidth: preview?.scrollWidth ?? 0,
      previewClientHeight: preview?.clientHeight ?? 0,
      previewScrollHeight: preview?.scrollHeight ?? 0,
    };
  }

  private signatureEquals(left: MeasurementSignature, right: MeasurementSignature): boolean {
    return (
      left.rectWidth === right.rectWidth &&
      left.rectHeight === right.rectHeight &&
      left.contentClientWidth === right.contentClientWidth &&
      left.contentScrollWidth === right.contentScrollWidth &&
      left.contentClientHeight === right.contentClientHeight &&
      left.contentScrollHeight === right.contentScrollHeight &&
      left.previewClientWidth === right.previewClientWidth &&
      left.previewScrollWidth === right.previewScrollWidth &&
      left.previewClientHeight === right.previewClientHeight &&
      left.previewScrollHeight === right.previewScrollHeight
    );
  }

  private isBBoxData(value: unknown): value is BBoxData {
    if (!value || typeof value !== "object") {
      return false;
    }

    const bbox = value as BBoxData;
    return (
      Number.isFinite(bbox.minX) &&
      Number.isFinite(bbox.minY) &&
      Number.isFinite(bbox.maxX) &&
      Number.isFinite(bbox.maxY)
    );
  }

  private waitForFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
      const tick = (remaining: number): void => {
        if (remaining <= 0) {
          resolve();
          return;
        }

        window.requestAnimationFrame(() => tick(remaining - 1));
      };

      tick(count);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}
