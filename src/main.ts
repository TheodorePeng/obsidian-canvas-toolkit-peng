import { Notice, Plugin } from "obsidian";
import { CanvasContextService } from "./canvas-context";
import { ResizeEngine } from "./resize-engine";
import { CanvasRenderCoordinator } from "./render-coordinator";
import { CanvasToolkitPengSettingTab, CanvasToolkitPengSettings, DEFAULT_SETTINGS } from "./settings";
import { SingleCardCompatibilityController } from "./single-card-compat";
import { CanvasLike, CanvasNodeLike } from "./types";

interface CommandTargetResult {
  nodes: CanvasNodeLike[];
  reason?: string;
}

export default class CanvasToolkitPengPlugin extends Plugin {
  settings: CanvasToolkitPengSettings = DEFAULT_SETTINGS;

  private canvasContext!: CanvasContextService;
  private resizeEngine!: ResizeEngine;
  private singleCardCompatibility!: SingleCardCompatibilityController;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.canvasContext = new CanvasContextService(this.app);
    this.resizeEngine = new ResizeEngine(new CanvasRenderCoordinator());
    this.singleCardCompatibility = new SingleCardCompatibilityController(this.app);

    this.addCommands();
    this.addSettingTab(new CanvasToolkitPengSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.syncSingleCardCompatibility(false);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        void this.syncSingleCardCompatibility(false);
      }),
    );

    await this.syncSingleCardCompatibility(false);
  }

  onunload(): void {
    this.singleCardCompatibility.disable();
  }

  isEnhancedCanvasEnabled(): boolean {
    const pluginManager = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> } })
      .plugins;

    if (pluginManager?.enabledPlugins instanceof Set) {
      return pluginManager.enabledPlugins.has("enhanced-canvas");
    }

    return Boolean(pluginManager?.plugins?.["enhanced-canvas"]);
  }

  async updateSingleCardCompatibilitySetting(value: boolean, showNotice: boolean): Promise<void> {
    this.settings.enableSingleCardResizeCompatibility = value;
    await this.saveSettings();
    await this.syncSingleCardCompatibility(showNotice);
  }

  private addCommands(): void {
    this.addCommand({
      id: "auto-fit-selected-cards",
      name: "Auto-fit selected cards",
      callback: () => {
        void this.runResizeCommand("selected cards", (canvas) => {
          const selectedNodes = this.canvasContext.getSelectedNodes(canvas);
          return {
            nodes: selectedNodes,
            reason: selectedNodes.length === 0 ? "Select one or more cards first." : undefined,
          };
        });
      },
    });

    this.addCommand({
      id: "auto-fit-selected-group-cards",
      name: "Auto-fit cards in selected group",
      callback: () => {
        void this.runResizeCommand("cards in the selected group", (canvas) => this.canvasContext.resolveSelectedGroup(canvas));
      },
    });

    this.addCommand({
      id: "auto-fit-all-cards",
      name: "Auto-fit all cards in current canvas",
      callback: () => {
        void this.runResizeCommand("all cards in the current canvas", (canvas) => {
          const allNodes = this.canvasContext.getAllContentNodes(canvas);
          return {
            nodes: allNodes,
            reason: allNodes.length === 0 ? "This canvas does not contain any content cards yet." : undefined,
          };
        });
      },
    });
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async syncSingleCardCompatibility(showNotice: boolean): Promise<void> {
    if (!this.settings.enableSingleCardResizeCompatibility) {
      this.singleCardCompatibility.disable();
      return;
    }

    if (this.isEnhancedCanvasEnabled()) {
      this.singleCardCompatibility.disable();
      if (showNotice) {
        new Notice(
          "Canvas Toolkit Peng: single-card resize compatibility is unavailable while Enhanced Canvas is enabled. The selected/group/all commands still work.",
        );
      }
      return;
    }

    const activated = this.singleCardCompatibility.enable();
    if (showNotice && !activated) {
      new Notice(
        "Canvas Toolkit Peng: single-card compatibility is enabled and will activate once a Canvas with at least one node is available.",
      );
    }
  }

  private async runResizeCommand(scopeLabel: string, resolver: (canvas: CanvasLike) => CommandTargetResult): Promise<void> {
    const canvas = this.canvasContext.getActiveCanvas();
    if (!canvas) {
      new Notice("Canvas Toolkit Peng: open a Canvas file first.");
      return;
    }

    const targetResult = resolver(canvas);
    if (targetResult.reason) {
      new Notice(`Canvas Toolkit Peng: ${targetResult.reason}`);
      return;
    }

    const supportedNodes = targetResult.nodes.filter((node) => this.canvasContext.isSupportedResizeNode(node));
    if (supportedNodes.length === 0) {
      new Notice("Canvas Toolkit Peng: no supported content cards were found for this command.");
      return;
    }

    const fitResult = await this.resizeEngine.fitNodesToContent(supportedNodes);
    const skippedNodes = targetResult.nodes.length - supportedNodes.length + fitResult.skipped;
    const summaryParts = [`resized ${fitResult.resized}`];

    if (fitResult.widthAdjusted > 0) {
      summaryParts.push(`width-adjusted ${fitResult.widthAdjusted}`);
    }

    if (fitResult.heightOnly > 0) {
      summaryParts.push(`height-only ${fitResult.heightOnly}`);
    }

    if (fitResult.unchanged > 0) {
      summaryParts.push(`unchanged ${fitResult.unchanged}`);
    }

    if (fitResult.unresolved > 0) {
      summaryParts.push(`unresolved ${fitResult.unresolved}`);
    }

    if (skippedNodes > 0) {
      summaryParts.push(`skipped ${skippedNodes}`);
    }

    new Notice(`Canvas Toolkit Peng: auto-fit ${scopeLabel} complete, ${summaryParts.join(", ")}.`);
  }
}
