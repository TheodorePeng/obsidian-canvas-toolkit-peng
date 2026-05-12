import { App, PluginSettingTab, Setting } from "obsidian";
import type CanvasToolkitPengPlugin from "./main";

export interface CanvasToolkitPengSettings {
  enableSingleCardResizeCompatibility: boolean;
}

export const DEFAULT_SETTINGS: CanvasToolkitPengSettings = {
  enableSingleCardResizeCompatibility: false,
};

export class CanvasToolkitPengSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CanvasToolkitPengPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Canvas Toolkit Peng" });

    const enhancedCanvasEnabled = this.plugin.isEnhancedCanvasEnabled();
    const compatibilityDescription = enhancedCanvasEnabled
      ? "Enable the reference-plugin-style single-card resize gesture when no conflict exists. Enhanced Canvas is currently enabled, so this option will stay inactive until that plugin is turned off."
      : "Enable the reference-plugin-style single-card resize gesture in this plugin. This is optional and is mainly for transition away from Enhanced Canvas.";

    new Setting(containerEl)
      .setName("Enable single-card resize compatibility")
      .setDesc(compatibilityDescription)
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableSingleCardResizeCompatibility)
          .onChange(async (value) => {
            await this.plugin.updateSingleCardCompatibilitySetting(value, true);
            this.display();
          });
      });

    if (enhancedCanvasEnabled) {
      new Setting(containerEl)
        .setName("Compatibility status")
        .setDesc(
          "Enhanced Canvas is active. Canvas Toolkit Peng range commands still work, but its single-card compatibility gesture is suspended to avoid conflicts.",
        );
    }
  }
}
