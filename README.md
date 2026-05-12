# Canvas Toolkit Peng

Canvas Toolkit Peng is an Obsidian Canvas utility plugin that automatically resizes cards so their content fits better inside the card bounds.

## What it does

- Auto-fits the selected cards in the active Canvas.
- Auto-fits all cards inside the selected group card.
- Auto-fits all supported cards in the current Canvas.
- Handles text cards and embed cards with different sizing logic.
- Preserves the current Canvas viewport after resizing.
- Optionally enables a single-card resize compatibility gesture for workflows that want an Enhanced Canvas-style interaction.

## How to use

1. Open a Canvas file in Obsidian.
2. Select one or more content cards, or select exactly one group card.
3. Open the Command Palette and run one of these commands:
   - `Auto-fit selected cards`
   - `Auto-fit cards in selected group`
   - `Auto-fit all cards in current canvas`
4. If you want the single-card compatibility gesture, open the plugin settings and enable it there.

### Notes

- Group cards themselves are not resized; the plugin targets the content cards inside them.
- Unsupported nodes are skipped automatically.
- If no Canvas is open, the plugin will show a notice and do nothing.
- Plugin settings are stored locally by Obsidian in `data.json`; that file is intentionally not tracked in Git.

## Install with BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from Obsidian Community Plugins.
2. Enable BRAT.
3. In BRAT, choose the option to add a beta plugin.
4. Paste this repository URL:

   `https://github.com/TheodorePeng/obsidian-canvas-toolkit-peng`

5. Confirm the install, then enable Canvas Toolkit Peng in Obsidian.

## Update with BRAT

1. Publish a new GitHub Release for each new version.
2. Keep the release tag in sync with the plugin version in `manifest.json`.
3. In BRAT, use its update flow to fetch the latest release from this repository.
4. After updating, reload Obsidian if needed.

## Requirements

- Obsidian 1.7.7 or later
- Obsidian Canvas workflow on desktop

## Repository layout

- `src/` contains the source code.
- `main.js` is the bundled plugin entry file.
- `manifest.json` and `versions.json` are used for Obsidian and BRAT releases.
- `data.json` is a local settings file and should not be committed.

---

# Canvas Toolkit Peng 中文说明

Canvas Toolkit Peng 是一个 Obsidian Canvas 工具插件，用于自动调整 Canvas 卡片尺寸，让卡片边界更好地适配实际内容。

## 主要功能

- 自动适配当前 Canvas 中选中的卡片。
- 自动适配所选分组卡片内部的全部卡片。
- 自动适配当前 Canvas 中所有支持的卡片。
- 针对文本卡片和嵌入卡片使用不同的尺寸计算逻辑。
- 调整尺寸后保留当前 Canvas 视口位置。
- 可选启用单卡片调整兼容手势，适合希望使用类似 Enhanced Canvas 交互方式的工作流。

## 使用方法

1. 在 Obsidian 中打开一个 Canvas 文件。
2. 选中一个或多个内容卡片，或者只选中一个分组卡片。
3. 打开命令面板，运行以下命令之一：
   - `Auto-fit selected cards`
   - `Auto-fit cards in selected group`
   - `Auto-fit all cards in current canvas`
4. 如果需要单卡片兼容手势，可以在插件设置中启用。

### 注意事项

- 分组卡片本身不会被调整尺寸；插件会处理分组内部的内容卡片。
- 不支持的节点会被自动跳过。
- 如果当前没有打开 Canvas，插件会显示提示并且不执行操作。
- 插件设置由 Obsidian 保存在本地 `data.json` 中；该文件是本地配置，不应提交到 Git。

## 通过 BRAT 安装

1. 在 Obsidian 社区插件中安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. 启用 BRAT。
3. 在 BRAT 中选择添加 beta 插件。
4. 粘贴本仓库地址：

   `https://github.com/TheodorePeng/obsidian-canvas-toolkit-peng`

5. 确认安装，然后在 Obsidian 中启用 Canvas Toolkit Peng。

## 通过 BRAT 更新

1. 每次发布新版本时，在 GitHub 创建新的 Release。
2. 保持 Release tag 与 `manifest.json` 中的插件版本一致。
3. 在 BRAT 中使用更新流程拉取本仓库的最新 release。
4. 更新后如有需要，重新加载 Obsidian。

## 环境要求

- Obsidian 1.7.7 或更高版本
- 使用 Obsidian Canvas 工作流

## 仓库结构

- `src/` 存放插件源代码。
- `main.js` 是打包后的插件入口文件。
- `manifest.json` 和 `versions.json` 用于 Obsidian 与 BRAT 发布。
- `data.json` 是本地设置文件，不应提交到 Git。
