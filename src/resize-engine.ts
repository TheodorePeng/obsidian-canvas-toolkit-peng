import { CanvasNodeLike, EventLike, FitResult, RectData } from "./types";
import { CanvasRenderCoordinator } from "./render-coordinator";

const DEFAULT_TIER_WIDTHS = [340, 420, 520, 640];
const DEFAULT_MIN_WIDTH = 200;
const DEFAULT_MAX_WIDTH = 640;
const DEFAULT_COARSE_WIDTH_STEP = 20;
const DEFAULT_REFINE_WIDTH_STEP = 4;
const MIN_INNER_WIDTH = 80;
const MIN_TEXT_HEIGHT = 52;
const MIN_EMBED_HEIGHT = 100;
const TEXT_SAFETY_MARGIN = 4;
const EMBED_SAFETY_MARGIN = 8;
const MAX_LIVE_WIDTH_CORRECTIONS = 6;
const MAX_LIVE_HEIGHT_CORRECTIONS = 6;
const MAX_OUTER_WIDTH = 1600;

type FitNodeStatus = "width-adjusted" | "height-only" | "unchanged" | "skipped" | "unresolved";
type RenderedNodeKind = "text" | "embed";

interface FitNodeOutcome {
  status: FitNodeStatus;
  widthChanged: boolean;
  heightChanged: boolean;
}

interface WidthCandidate {
  width: number;
  contentHeight: number;
  outerHeight: number;
  overflowX: boolean;
  blockCount: number | null;
  wrappedHeadingCount: number | null;
  wrappedBlockCount: number | null;
  extraWrappedLines: number | null;
  maxBlockLines: number | null;
}

interface WidthSelection {
  width: number;
  reason: string;
}

interface TextMetrics {
  lineCount: number;
  longestLine: number;
  charCount: number;
}

interface EmbedMetrics {
  naturalWidth: number | null;
}

interface WrapMetrics {
  blockCount: number;
  wrappedHeadingCount: number;
  wrappedBlockCount: number;
  extraWrappedLines: number;
  maxBlockLines: number;
}

interface TextBudgets {
  allowedWrappedBlocks: number;
  allowedExtraWrappedLines: number;
  targetMaxBlockLines: number;
  targetWrappedHeadings: number;
}

interface ComfortMeta {
  valid: WidthCandidate[];
  bestHeight: number;
  comfortCeiling: number;
  comfortSet: WidthCandidate[];
  threshold: number;
  elbow: WidthCandidate;
  byHeight: WidthCandidate[];
}

interface MeasurementContext {
  kind: RenderedNodeKind;
  node: CanvasNodeLike;
  nodeEl: HTMLElement;
  contentRoot: HTMLElement;
  sizer: HTMLElement | null;
  embed: HTMLElement | null;
  chromeHorizontal: number;
  chromeVertical: number;
  safety: number;
  minOuterHeight: number;
  textMetrics: TextMetrics | null;
  embedMetrics: EmbedMetrics | null;
  measureCache: Map<number, WidthCandidate>;
}

interface LiveMeasurement {
  kind: RenderedNodeKind;
  currentWidth: number;
  currentHeight: number;
  chromeHorizontal: number;
  chromeVertical: number;
  availableInnerWidth: number;
  neededInnerWidth: number;
  horizontalOverflow: number;
  availableBox: number;
  neededBox: number;
  overflow: number;
  slack: number;
  overflowSafety: number;
  slackTarget: number;
  minHeight: number;
}

export class ResizeEngine {
  constructor(private readonly renderCoordinator: CanvasRenderCoordinator = new CanvasRenderCoordinator()) {}

  async fitNodesToContent(nodes: CanvasNodeLike[]): Promise<FitResult> {
    let resized = 0;
    let skipped = 0;
    let unresolved = 0;
    let unchanged = 0;
    let widthAdjusted = 0;
    let heightOnly = 0;

    const canvas = nodes.find((node) => node.canvas)?.canvas ?? null;
    const viewport = canvas ? this.renderCoordinator.captureViewport(canvas) : null;

    try {
      for (const node of nodes) {
        const outcome = await this.fitNodeToContent(node);
        switch (outcome.status) {
          case "width-adjusted":
            resized += 1;
            widthAdjusted += 1;
            break;
          case "height-only":
            resized += 1;
            heightOnly += 1;
            break;
          case "unchanged":
            unchanged += 1;
            break;
          case "unresolved":
            unresolved += 1;
            break;
          case "skipped":
          default:
            skipped += 1;
            break;
        }
      }
    } finally {
      if (canvas) {
        await this.renderCoordinator.restoreViewport(canvas, viewport);
      }
    }

    return {
      attempted: nodes.length,
      resized,
      skipped,
      unresolved,
      unchanged,
      widthAdjusted,
      heightOnly,
    };
  }

  private async fitNodeToContent(node: CanvasNodeLike): Promise<FitNodeOutcome> {
    const originalRect = this.renderCoordinator.getNodeRect(node);
    if (!originalRect) {
      return { status: "skipped", widthChanged: false, heightChanged: false };
    }

    try {
      const readiness = await this.renderCoordinator.ensureNodeReady(node);
      if (!readiness.ready) {
        return { status: "unresolved", widthChanged: false, heightChanged: false };
      }

      const widthSelection = this.selectWidthSuggestion(node);
      let widthChanged = false;
      let heightChanged = false;

      if (widthSelection) {
        widthChanged = this.applyWidth(node, widthSelection.width);
        if (widthChanged) {
          await this.renderCoordinator.waitForNodeStability(node);
        }
      }

      const widthValidated = await this.correctLiveWidth(node);
      if (widthValidated === null) {
        this.applyRect(node, originalRect);
        return { status: "unresolved", widthChanged: false, heightChanged: false };
      }
      widthChanged = widthChanged || widthValidated;

      if (typeof node.onResizeDblclick !== "function") {
        return widthChanged
          ? { status: "width-adjusted", widthChanged: true, heightChanged: false }
          : { status: "skipped", widthChanged: false, heightChanged: false };
      }

      node.onResizeDblclick(this.createMockEvent(), "bottom");
      await this.renderCoordinator.waitForNodeStability(node);

      const heightValidated = await this.correctLiveHeight(node);
      if (heightValidated === null) {
        this.applyRect(node, originalRect);
        return { status: "unresolved", widthChanged: false, heightChanged: false };
      }
      heightChanged = heightValidated;

      const finalRect = this.renderCoordinator.getNodeRect(node);
      const finalWidthChanged = finalRect ? finalRect.width !== originalRect.width : widthChanged;
      const finalHeightChanged = finalRect ? finalRect.height !== originalRect.height : heightChanged;

      if (!finalWidthChanged && !finalHeightChanged) {
        return { status: "unchanged", widthChanged: false, heightChanged: false };
      }

      if (finalWidthChanged) {
        return { status: "width-adjusted", widthChanged: true, heightChanged: finalHeightChanged };
      }

      return { status: "height-only", widthChanged: false, heightChanged: true };
    } catch (error) {
      console.error("[Canvas Toolkit Peng] Failed to auto-fit a canvas card.", error);
      this.applyRect(node, originalRect);
      return { status: "skipped", widthChanged: false, heightChanged: false };
    }
  }

  private selectWidthSuggestion(node: CanvasNodeLike): WidthSelection | null {
    const context = this.buildMeasurementContext(node);
    if (!context) {
      return null;
    }

    return context.kind === "text" ? this.selectContinuousTextWidth(context) : this.selectTieredWidth(context);
  }

  private buildMeasurementContext(node: CanvasNodeLike): MeasurementContext | null {
    if (!(node.nodeEl instanceof HTMLElement)) {
      return null;
    }

    const contentRoot = this.renderCoordinator.getContentElement(node);
    if (!(contentRoot instanceof HTMLElement)) {
      return null;
    }

    const sizer = node.nodeEl.querySelector(".markdown-preview-sizer");
    const embed = node.nodeEl.querySelector(".nbe-embed");
    const kind: RenderedNodeKind | null =
      embed instanceof HTMLElement ? "embed" : sizer instanceof HTMLElement ? "text" : null;

    if (!kind) {
      return null;
    }

    const scale = Math.abs(Number(node.canvas?.scale ?? 1)) || 1;
    const outerRect = node.nodeEl.getBoundingClientRect();
    const innerRect = contentRoot.getBoundingClientRect();
    const chromeHorizontal = Math.max(0, Math.round((outerRect.width - innerRect.width) / scale));
    const chromeVertical = Math.max(0, Math.round((outerRect.height - innerRect.height) / scale));

    return {
      kind,
      node,
      nodeEl: node.nodeEl,
      contentRoot,
      sizer: sizer instanceof HTMLElement ? sizer : null,
      embed: embed instanceof HTMLElement ? embed : null,
      chromeHorizontal,
      chromeVertical,
      safety: kind === "embed" ? EMBED_SAFETY_MARGIN : TEXT_SAFETY_MARGIN,
      minOuterHeight: kind === "embed" ? MIN_EMBED_HEIGHT : MIN_TEXT_HEIGHT,
      textMetrics: kind === "text" && sizer instanceof HTMLElement ? this.readTextMetrics(sizer) : null,
      embedMetrics:
        kind === "embed" && embed instanceof HTMLElement
          ? this.readEmbedMetrics(embed, contentRoot, chromeHorizontal)
          : null,
      measureCache: new Map<number, WidthCandidate>(),
    };
  }

  private selectContinuousTextWidth(context: MeasurementContext): WidthSelection | null {
    const coarseWidths = this.buildRange(DEFAULT_MIN_WIDTH, DEFAULT_MAX_WIDTH, DEFAULT_COARSE_WIDTH_STEP);
    const coarseSelection = this.selectContinuousTextCandidate(this.measureWidthList(context, coarseWidths));
    if (!coarseSelection) {
      return null;
    }

    const refinedStart = Math.max(DEFAULT_MIN_WIDTH, coarseSelection.width - DEFAULT_COARSE_WIDTH_STEP);
    const refinedEnd = Math.min(DEFAULT_MAX_WIDTH, coarseSelection.width + DEFAULT_COARSE_WIDTH_STEP);
    const refinedWidths = this.buildRange(refinedStart, refinedEnd, DEFAULT_REFINE_WIDTH_STEP);
    const refinedSelection = this.selectContinuousTextCandidate(this.measureWidthList(context, refinedWidths));
    if (!refinedSelection) {
      return coarseSelection;
    }

    const finalStart = Math.max(DEFAULT_MIN_WIDTH, refinedSelection.width - DEFAULT_REFINE_WIDTH_STEP);
    const finalWidths = this.buildRange(finalStart, refinedSelection.width, 1);
    return this.selectContinuousTextCandidate(this.measureWidthList(context, finalWidths)) ?? refinedSelection;
  }

  private selectContinuousTextCandidate(items: WidthCandidate[]): WidthSelection | null {
    const valid = items
      .filter((item) => !item.overflowX && Number.isFinite(item.outerHeight))
      .sort((left, right) => left.width - right.width || left.outerHeight - right.outerHeight);

    if (valid.length === 0) {
      return null;
    }

    const measurable = valid.filter((item) => Number.isFinite(item.blockCount) && Number(item.blockCount) > 0);
    if (measurable.length === 0) {
      return this.chooseHeightElbowCandidate(valid, "Selected width via height fallback");
    }

    const budgets = this.buildTextBudgets(Number(measurable[0].blockCount));
    const satisfying = measurable.filter((item) => this.textCandidateMeetsBudgets(item, budgets));
    if (satisfying.length > 0) {
      const chosen = satisfying[0];
      return {
        width: chosen.width,
        reason: this.formatContinuousReason(chosen, budgets, "budget"),
      };
    }

    const scored = measurable
      .slice()
      .sort((left, right) => this.comparePenaltyTuple(this.buildTextPenaltyTuple(left, budgets), this.buildTextPenaltyTuple(right, budgets)));
    const chosen = scored[0];
    const penaltyTuple = this.buildTextPenaltyTuple(chosen, budgets);

    return {
      width: chosen.width,
      reason: this.formatContinuousReason(chosen, budgets, "penalty", penaltyTuple),
    };
  }

  private selectTieredWidth(context: MeasurementContext): WidthSelection | null {
    return this.chooseTieredCandidate(this.measureWidthList(context, DEFAULT_TIER_WIDTHS), context);
  }

  private chooseTieredCandidate(items: WidthCandidate[], context: MeasurementContext): WidthSelection | null {
    const meta = this.buildComfortMeta(items);
    if (!meta) {
      return null;
    }

    let floorWidth = meta.elbow.width;
    if (context.kind === "text") {
      const longestLine = context.textMetrics?.longestLine ?? 0;
      if (longestLine <= 24) {
        floorWidth = Math.max(floorWidth, 340);
      } else if (longestLine <= 44) {
        floorWidth = Math.max(floorWidth, 420);
      } else if (longestLine <= 68) {
        floorWidth = Math.max(floorWidth, 520);
      } else {
        floorWidth = Math.max(floorWidth, 640);
      }
    } else if (Number.isFinite(context.embedMetrics?.naturalWidth ?? NaN)) {
      floorWidth = Math.max(floorWidth, Number(context.embedMetrics?.naturalWidth));
    }

    const mappedFloorWidth = this.mapToCandidateWidth(floorWidth, DEFAULT_TIER_WIDTHS);
    const preferred = meta.comfortSet
      .filter((item) => item.width >= mappedFloorWidth)
      .sort((left, right) => left.width - right.width || left.outerHeight - right.outerHeight);
    const chosen = preferred[0] ?? meta.byHeight[0] ?? meta.valid[0];

    return {
      width: chosen.width,
      reason: `Selected width ${chosen.width}px from tiered comfort set (best=${meta.bestHeight}px elbow=${meta.elbow.width}px floor=${mappedFloorWidth}px)`,
    };
  }

  private chooseHeightElbowCandidate(items: WidthCandidate[], reasonPrefix: string): WidthSelection | null {
    const meta = this.buildComfortMeta(items);
    if (!meta) {
      return null;
    }

    const chosen = meta.comfortSet.find((item) => item.width >= meta.elbow.width) ?? meta.byHeight[0] ?? meta.valid[0];
    return {
      width: chosen.width,
      reason: `${reasonPrefix} ${chosen.width}px (best=${meta.bestHeight}px elbow=${meta.elbow.width}px height=${chosen.outerHeight}px)`,
    };
  }

  private buildComfortMeta(items: WidthCandidate[]): ComfortMeta | null {
    const valid = items
      .filter((item) => !item.overflowX && Number.isFinite(item.outerHeight))
      .slice()
      .sort((left, right) => left.width - right.width || left.outerHeight - right.outerHeight);

    if (valid.length === 0) {
      return null;
    }

    const bestHeight = Math.min(...valid.map((item) => item.outerHeight));
    const comfortCeiling = Math.min(bestHeight + 24, Math.ceil(bestHeight * 1.08));
    const comfortSet = valid.filter((item) => item.outerHeight <= comfortCeiling);
    const source = comfortSet.length > 0 ? comfortSet : valid;
    const threshold = Math.max(10, Math.ceil(bestHeight * 0.03));

    let elbow = source[source.length - 1];
    for (let index = 0; index < source.length - 1; index += 1) {
      const current = source[index];
      const next = source[index + 1];
      const nextDrop = Math.max(0, current.outerHeight - next.outerHeight);
      if (nextDrop < threshold) {
        elbow = current;
        break;
      }
    }

    const byHeight = source.slice().sort((left, right) => left.outerHeight - right.outerHeight || left.width - right.width);

    return {
      valid,
      bestHeight,
      comfortCeiling,
      comfortSet: source,
      threshold,
      elbow,
      byHeight,
    };
  }

  private measureWidthList(context: MeasurementContext, widths: number[]): WidthCandidate[] {
    return this.uniqueSortedNumbers(widths)
      .map((width) => this.measureAtWidth(context, width))
      .filter((item): item is WidthCandidate => item !== null);
  }

  private measureAtWidth(context: MeasurementContext, width: number): WidthCandidate | null {
    const cached = context.measureCache.get(width);
    if (cached) {
      return cached;
    }

    const innerWidth = Math.max(MIN_INNER_WIDTH, width - context.chromeHorizontal);
    const measured = context.kind === "embed" ? this.measureEmbed(context, innerWidth) : this.measureText(context, innerWidth);
    if (!measured) {
      return null;
    }

    const candidate: WidthCandidate = {
      width,
      contentHeight: measured.contentHeight,
      outerHeight: Math.max(context.minOuterHeight, measured.contentHeight + context.chromeVertical + context.safety),
      overflowX: measured.overflowX,
      blockCount: measured.wrapMetrics?.blockCount ?? null,
      wrappedHeadingCount: measured.wrapMetrics?.wrappedHeadingCount ?? null,
      wrappedBlockCount: measured.wrapMetrics?.wrappedBlockCount ?? null,
      extraWrappedLines: measured.wrapMetrics?.extraWrappedLines ?? null,
      maxBlockLines: measured.wrapMetrics?.maxBlockLines ?? null,
    };

    context.measureCache.set(width, candidate);
    return candidate;
  }

  private measureText(
    context: MeasurementContext,
    innerWidth: number,
  ): { contentHeight: number; overflowX: boolean; wrapMetrics: WrapMetrics | null } | null {
    if (!(context.sizer instanceof HTMLElement)) {
      return null;
    }

    const { wrap, cleanup } = this.createMeasurementHost(innerWidth);
    const cloneSizer = document.createElement("div");
    cloneSizer.className = "markdown-preview-sizer";
    cloneSizer.style.cssText = `min-height:0;padding:0;margin:0;width:${innerWidth}px;box-sizing:border-box;`;

    for (const child of Array.from(context.sizer.childNodes)) {
      if (child instanceof HTMLElement && child.classList.contains("markdown-preview-pusher")) {
        continue;
      }

      cloneSizer.appendChild(child.cloneNode(true));
    }

    wrap.appendChild(cloneSizer);

    const contentHeight = Math.ceil(
      Math.max(
        cloneSizer.scrollHeight || 0,
        wrap.scrollHeight || 0,
        cloneSizer.getBoundingClientRect().height || 0,
        wrap.getBoundingClientRect().height || 0,
      ),
    );
    const overflowX = (cloneSizer.scrollWidth || wrap.scrollWidth || 0) > innerWidth + 1;
    const wrapMetrics = this.collectTextWrapMetrics(cloneSizer);
    cleanup();

    return { contentHeight, overflowX, wrapMetrics };
  }

  private measureEmbed(
    context: MeasurementContext,
    innerWidth: number,
  ): { contentHeight: number; overflowX: boolean; wrapMetrics: null } | null {
    if (!(context.embed instanceof HTMLElement)) {
      return null;
    }

    const { wrap, cleanup } = this.createMeasurementHost(innerWidth);
    const shell = document.createElement("div");
    shell.className = "canvas-node-content markdown-embed";
    shell.style.cssText = `box-sizing:border-box;overflow:visible;padding:0;margin:0;width:${innerWidth}px;`;
    shell.appendChild(context.embed.cloneNode(true));
    wrap.appendChild(shell);

    const contentHeight = Math.ceil(
      Math.max(
        shell.scrollHeight || 0,
        wrap.scrollHeight || 0,
        shell.getBoundingClientRect().height || 0,
        wrap.getBoundingClientRect().height || 0,
      ),
    );
    const overflowX = (shell.scrollWidth || wrap.scrollWidth || 0) > innerWidth + 1;
    cleanup();

    return { contentHeight, overflowX, wrapMetrics: null };
  }

  private async correctLiveWidth(node: CanvasNodeLike): Promise<boolean | null> {
    let widthChanged = false;

    for (let attempt = 0; attempt < MAX_LIVE_WIDTH_CORRECTIONS; attempt += 1) {
      const measurement = this.readLiveMeasurement(node);
      if (!measurement) {
        return null;
      }

      if (measurement.horizontalOverflow <= 0) {
        return widthChanged;
      }

      const widthSafety = measurement.kind === "embed" ? 16 : 10;
      const desiredWidth = Math.min(
        MAX_OUTER_WIDTH,
        Math.ceil(measurement.currentWidth + measurement.horizontalOverflow + widthSafety),
      );

      if (desiredWidth <= measurement.currentWidth) {
        return widthChanged;
      }

      const applied = this.applyWidth(node, desiredWidth);
      if (!applied) {
        return null;
      }

      widthChanged = true;
      await this.renderCoordinator.waitForNodeStability(node);
    }

    return widthChanged;
  }

  private async correctLiveHeight(node: CanvasNodeLike): Promise<boolean | null> {
    let heightChanged = false;

    for (let attempt = 0; attempt < MAX_LIVE_HEIGHT_CORRECTIONS; attempt += 1) {
      const measurement = this.readLiveMeasurement(node);
      if (!measurement) {
        return null;
      }

      if (measurement.horizontalOverflow > 0) {
        return null;
      }

      if (measurement.overflow > 0) {
        const desiredHeight = measurement.currentHeight + measurement.overflow + measurement.overflowSafety;
        const applied = this.applyHeight(node, desiredHeight);
        if (!applied) {
          return null;
        }

        heightChanged = true;
        await this.renderCoordinator.waitForNodeStability(node);
        continue;
      }

      if (measurement.slack > measurement.slackTarget + 1) {
        const reclaim = measurement.slack - measurement.slackTarget;
        const desiredHeight = Math.max(measurement.minHeight, measurement.currentHeight - reclaim);
        if (desiredHeight === measurement.currentHeight) {
          return heightChanged;
        }

        const applied = this.applyHeight(node, desiredHeight);
        if (!applied) {
          return null;
        }

        heightChanged = true;
        await this.renderCoordinator.waitForNodeStability(node);
        continue;
      }

      return heightChanged;
    }

    return heightChanged;
  }

  private readLiveMeasurement(node: CanvasNodeLike): LiveMeasurement | null {
    if (!(node.nodeEl instanceof HTMLElement)) {
      return null;
    }

    const content = this.renderCoordinator.getContentElement(node);
    const preview = this.renderCoordinator.getPreviewElement(node);
    if (!(content instanceof HTMLElement) || !(preview instanceof HTMLElement)) {
      return null;
    }

    const kind = node.nodeEl.querySelector(".nbe-embed") ? "embed" : node.nodeEl.querySelector(".markdown-preview-sizer") ? "text" : null;
    if (!kind) {
      return null;
    }

    const current = node.getData?.();
    if (!current) {
      return null;
    }

    const scale = Math.abs(Number(node.canvas?.scale ?? 1)) || 1;
    const outerRect = node.nodeEl.getBoundingClientRect();
    const innerRect = content.getBoundingClientRect();
    const chromeHorizontal = Math.max(0, Math.round((outerRect.width - innerRect.width) / scale));
    const chromeVertical = Math.max(0, Math.round((outerRect.height - innerRect.height) / scale));

    const contentClientWidth = Math.ceil(content.clientWidth || 0);
    const previewClientWidth = Math.ceil(preview.clientWidth || 0);
    const availableInnerWidth = Math.max(0, current.width - chromeHorizontal, contentClientWidth, previewClientWidth);
    const neededInnerWidth =
      kind === "embed"
        ? Math.ceil(
            Math.max(
              preview.scrollWidth || 0,
              preview.getBoundingClientRect().width || 0,
              content.scrollWidth || 0,
              content.getBoundingClientRect().width || 0,
            ),
          )
        : Math.ceil(Math.max(content.scrollWidth || 0, preview.scrollWidth || 0, contentClientWidth, previewClientWidth));
    const horizontalOverflow = Math.max(0, neededInnerWidth - availableInnerWidth);

    const contentClientHeight = Math.ceil(content.clientHeight || 0);
    const previewClientHeight = Math.ceil(preview.clientHeight || 0);
    const availableBox = Math.max(0, current.height - chromeVertical);
    const neededBox =
      kind === "embed"
        ? Math.ceil(
            Math.max(
              preview.scrollHeight || 0,
              preview.getBoundingClientRect().height || 0,
              content.scrollHeight || 0,
              content.getBoundingClientRect().height || 0,
            ),
          )
        : Math.ceil(Math.max(content.scrollHeight || 0, preview.scrollHeight || 0, contentClientHeight, previewClientHeight));
    const overflow = Math.max(0, neededBox - availableBox);
    const slack = Math.max(0, availableBox - neededBox);
    const overflowSafetyBase = kind === "embed" ? 4 : 2;
    const overflowSafetyFallback = kind === "embed" ? 3 : 2;
    const overflowSafety = overflow > 0 && overflow <= 2 ? overflowSafetyFallback : overflowSafetyBase;

    return {
      kind,
      currentWidth: current.width,
      currentHeight: current.height,
      chromeHorizontal,
      chromeVertical,
      availableInnerWidth,
      neededInnerWidth,
      horizontalOverflow,
      availableBox,
      neededBox,
      overflow,
      slack,
      overflowSafety,
      slackTarget: kind === "embed" ? 2 : 1,
      minHeight: kind === "embed" ? MIN_EMBED_HEIGHT : MIN_TEXT_HEIGHT,
    };
  }

  private applyWidth(node: CanvasNodeLike, width: number): boolean {
    const current = this.renderCoordinator.getNodeRect(node);
    if (!current) {
      return false;
    }

    const nextWidth = Math.round(width);
    if (!Number.isFinite(nextWidth) || nextWidth <= 0 || current.width === nextWidth) {
      return false;
    }

    return this.applyRect(node, {
      ...current,
      width: nextWidth,
    });
  }

  private applyHeight(node: CanvasNodeLike, height: number): boolean {
    const current = this.renderCoordinator.getNodeRect(node);
    if (!current) {
      return false;
    }

    const nextHeight = Math.round(height);
    if (!Number.isFinite(nextHeight) || nextHeight <= 0 || current.height === nextHeight) {
      return false;
    }

    return this.applyRect(node, {
      ...current,
      height: nextHeight,
    });
  }

  private applyRect(node: CanvasNodeLike, rect: RectData): boolean {
    if (typeof node.moveAndResize === "function") {
      node.moveAndResize(rect);
      return true;
    }

    const data = node.getData?.();
    if (typeof node.setData === "function" && data) {
      node.setData({
        ...data,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });

      if (typeof node.render === "function") {
        node.render();
      }

      return true;
    }

    return false;
  }

  private createMeasurementHost(innerWidth: number): { wrap: HTMLDivElement; cleanup: () => void } {
    const host = document.createElement("div");
    host.style.cssText = [
      "position:fixed",
      "left:-100000px",
      "top:0",
      "visibility:hidden",
      "pointer-events:none",
      "z-index:-1",
      "overflow:visible",
      "contain:layout style",
      `width:${innerWidth}px`,
    ].join(";");

    const wrap = document.createElement("div");
    wrap.className = "markdown-preview-view markdown-rendered";
    wrap.style.cssText = `box-sizing:border-box;overflow:visible;min-height:0;padding:0;margin:0;width:${innerWidth}px;`;
    host.appendChild(wrap);
    document.body.appendChild(host);

    return {
      wrap,
      cleanup: () => host.remove(),
    };
  }

  private collectTextWrapMetrics(root: Element): WrapMetrics | null {
    const blocks = Array.from(root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote"))
      .map((element) => {
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text) {
          return null;
        }

        const tagName = (element.tagName || "").toUpperCase();
        const lines = Math.max(1, this.countRenderedLines(element));

        return {
          isHeading: /^H[1-6]$/.test(tagName),
          lines,
        };
      })
      .filter((item): item is { isHeading: boolean; lines: number } => item !== null);

    if (blocks.length === 0) {
      return null;
    }

    const wrappedBlocks = blocks.filter((item) => item.lines > 1);
    const wrappedHeadings = wrappedBlocks.filter((item) => item.isHeading);

    return {
      blockCount: blocks.length,
      wrappedHeadingCount: wrappedHeadings.length,
      wrappedBlockCount: wrappedBlocks.length,
      extraWrappedLines: wrappedBlocks.reduce((sum, item) => sum + Math.max(0, item.lines - 1), 0),
      maxBlockLines: Math.max(...blocks.map((item) => item.lines)),
    };
  }

  private countRenderedLines(element: Element): number {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent && node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });

    const tops: number[] = [];
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) {
          tops.push(Math.round(rect.top));
        }
      }
    }

    return this.dedupeLineTops(tops).length;
  }

  private dedupeLineTops(tops: number[]): number[] {
    const sorted = tops.slice().sort((left, right) => left - right);
    const result: number[] = [];

    for (const top of sorted) {
      if (result.length === 0 || Math.abs(top - result[result.length - 1]) > 1) {
        result.push(top);
      }
    }

    return result;
  }

  private readTextMetrics(sizer: HTMLElement): TextMetrics {
    const source = (sizer.innerText || "").replace(/\u00a0/g, " ");
    const lines = source
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    return {
      lineCount: lines.length,
      longestLine: lines.reduce((maxLength, line) => Math.max(maxLength, line.length), 0),
      charCount: source.trim().length,
    };
  }

  private readEmbedMetrics(embed: HTMLElement, contentRoot: HTMLElement, chromeHorizontal: number): EmbedMetrics {
    const naturalInner = Math.max(
      Math.ceil(embed.getBoundingClientRect().width || 0),
      Math.ceil(embed.scrollWidth || 0),
      Math.ceil(contentRoot.scrollWidth || 0),
      0,
    );

    return {
      naturalWidth: naturalInner > 0 ? naturalInner + Math.max(0, chromeHorizontal) : null,
    };
  }

  private buildTextBudgets(blockCount: number): TextBudgets {
    const allowance = this.clamp(Math.ceil(blockCount * 0.2), 1, 2);

    return {
      allowedWrappedBlocks: allowance,
      allowedExtraWrappedLines: allowance,
      targetMaxBlockLines: 2,
      targetWrappedHeadings: 0,
    };
  }

  private textCandidateMeetsBudgets(item: WidthCandidate, budgets: TextBudgets): boolean {
    return (
      Number.isFinite(item.blockCount) &&
      Number(item.blockCount) > 0 &&
      Number(item.wrappedHeadingCount || 0) <= budgets.targetWrappedHeadings &&
      Number(item.maxBlockLines || 0) <= budgets.targetMaxBlockLines &&
      Number(item.wrappedBlockCount || 0) <= budgets.allowedWrappedBlocks &&
      Number(item.extraWrappedLines || 0) <= budgets.allowedExtraWrappedLines
    );
  }

  private buildTextPenaltyTuple(item: WidthCandidate, budgets: TextBudgets): number[] {
    return [
      Number(item.wrappedHeadingCount || 0),
      Math.max(0, Number(item.maxBlockLines || 0) - budgets.targetMaxBlockLines),
      Math.max(0, Number(item.extraWrappedLines || 0) - budgets.allowedExtraWrappedLines),
      Math.max(0, Number(item.wrappedBlockCount || 0) - budgets.allowedWrappedBlocks),
      Number(item.width || 0),
      Number(item.outerHeight || 0),
    ];
  }

  private comparePenaltyTuple(left: number[], right: number[]): number {
    const maxLength = Math.max(left.length, right.length);
    for (let index = 0; index < maxLength; index += 1) {
      const leftValue = Number(left[index] ?? 0);
      const rightValue = Number(right[index] ?? 0);
      if (leftValue !== rightValue) {
        return leftValue - rightValue;
      }
    }

    return 0;
  }

  private formatContinuousReason(candidate: WidthCandidate, budgets: TextBudgets, mode: string, penaltyTuple: number[] | null = null): string {
    const parts = [
      `Selected width ${candidate.width}px via continuous ${mode}`,
      `wrapped blocks=${candidate.wrappedBlockCount}/${budgets.allowedWrappedBlocks}`,
      `extra wrapped lines=${candidate.extraWrappedLines}/${budgets.allowedExtraWrappedLines}`,
      `max block lines=${candidate.maxBlockLines}/${budgets.targetMaxBlockLines}`,
      `heading wraps=${candidate.wrappedHeadingCount}/${budgets.targetWrappedHeadings}`,
      `height=${candidate.outerHeight}px`,
    ];

    if (penaltyTuple) {
      parts.push(`penalty=${penaltyTuple.join("/")}`);
    }

    return parts.join(" ");
  }

  private mapToCandidateWidth(rawWidth: number, widths: number[]): number {
    if (!Number.isFinite(rawWidth) || rawWidth <= 0) {
      return widths[0];
    }

    for (const width of widths) {
      if (width >= rawWidth) {
        return width;
      }
    }

    return widths[widths.length - 1];
  }

  private buildRange(start: number, end: number, step: number): number[] {
    const values: number[] = [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0) {
      return values;
    }

    const safeStart = Math.round(start);
    const safeEnd = Math.round(end);
    for (let value = safeStart; value <= safeEnd; value += step) {
      values.push(value);
    }

    if (values.length === 0 || values[values.length - 1] !== safeEnd) {
      values.push(safeEnd);
    }

    return this.uniqueSortedNumbers(values);
  }

  private uniqueSortedNumbers(values: number[]): number[] {
    return [...new Set(values.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0))].sort(
      (left, right) => left - right,
    );
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private createMockEvent(): EventLike {
    return {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    };
  }
}
