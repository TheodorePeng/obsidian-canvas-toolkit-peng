import type { EventRef } from "obsidian";
import { App } from "obsidian";
import { CanvasLike, CanvasNodeLike, EventLike, ResizeDirection } from "./types";

type MethodName = "onResizeDblclick" | "onResizePointerdown" | "blur";

interface PatchableNode extends CanvasNodeLike {
  __canvasToolkitPengAutoHeightEnabled?: boolean;
  __canvasToolkitPengAutoHeightTimer?: number | null;
}

type PatchFactory = (originalMethod: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;

export class SingleCardCompatibilityController {
  private unpatch: (() => void) | null = null;
  private retryRefs: EventRef[] = [];
  private enabled = false;

  constructor(private readonly app: App) {}

  enable(): boolean {
    this.enabled = true;
    return this.tryPatch();
  }

  disable(): void {
    this.enabled = false;
    this.clearRetryListeners();

    if (this.unpatch) {
      this.unpatch();
      this.unpatch = null;
    }
  }

  isActive(): boolean {
    return this.unpatch !== null;
  }

  private tryPatch(): boolean {
    if (!this.enabled) {
      return false;
    }

    if (this.unpatch) {
      return true;
    }

    const baseNodePrototype = this.findBaseNodePrototype();
    if (!baseNodePrototype) {
      this.ensureRetryListeners();
      return false;
    }

    const unpatch = this.patchPrototype(baseNodePrototype);
    if (!unpatch) {
      this.ensureRetryListeners();
      return false;
    }

    this.unpatch = unpatch;
    this.clearRetryListeners();
    return true;
  }

  private ensureRetryListeners(): void {
    if (this.retryRefs.length > 0) {
      return;
    }

    const retry = (): void => {
      if (!this.enabled || this.unpatch) {
        return;
      }

      this.tryPatch();
    };

    this.retryRefs = [
      this.app.workspace.on("active-leaf-change", retry),
      this.app.workspace.on("layout-change", retry),
    ];
  }

  private clearRetryListeners(): void {
    for (const ref of this.retryRefs) {
      this.app.workspace.offref(ref);
    }

    this.retryRefs = [];
  }

  private findBaseNodePrototype(): Record<MethodName, unknown> | null {
    const canvas = this.findAnyCanvas();
    const anyNode = canvas?.nodes?.values?.().next()?.value;
    if (!anyNode) {
      return null;
    }

    const nodeConstructor = (anyNode as CanvasNodeLike).constructor as { prototype?: unknown } | undefined;
    if (!nodeConstructor?.prototype) {
      return null;
    }

    return Object.getPrototypeOf(nodeConstructor.prototype) as Record<MethodName, unknown> | null;
  }

  private findAnyCanvas(): CanvasLike | null {
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const canvas = (leaf.view as { canvas?: CanvasLike }).canvas;
      if (canvas) {
        return canvas;
      }
    }

    return null;
  }

  private patchPrototype(baseNodePrototype: Record<MethodName, unknown>): (() => void) | null {
    const restorers: Array<() => void> = [];

    const dblClickUnpatch = this.patchMethod(baseNodePrototype, "onResizeDblclick", (originalMethod) => {
      return function (this: PatchableNode, ...args: unknown[]): unknown {
        const [, direction] = args as [EventLike, ResizeDirection];
        if (direction === "bottom") {
          if (typeof this.__canvasToolkitPengAutoHeightTimer === "number") {
            window.clearTimeout(this.__canvasToolkitPengAutoHeightTimer);
          }

          this.__canvasToolkitPengAutoHeightTimer = null;
          this.__canvasToolkitPengAutoHeightEnabled = true;
        }

        return originalMethod.apply(this, args);
      };
    });

    if (dblClickUnpatch) {
      restorers.push(dblClickUnpatch);
    }

    const pointerDownUnpatch = this.patchMethod(baseNodePrototype, "onResizePointerdown", (originalMethod) => {
      return function (this: PatchableNode, ...args: unknown[]): unknown {
        const [event, direction] = args as [EventLike, ResizeDirection];
        const result = originalMethod.apply(this, args);

        if (direction === "bottom") {
          if (typeof this.__canvasToolkitPengAutoHeightTimer === "number") {
            window.clearTimeout(this.__canvasToolkitPengAutoHeightTimer);
            this.__canvasToolkitPengAutoHeightTimer = null;
          } else {
            this.__canvasToolkitPengAutoHeightTimer = window.setTimeout(() => {
              this.__canvasToolkitPengAutoHeightEnabled = false;
              this.__canvasToolkitPengAutoHeightTimer = null;
            }, 250);
          }
        }

        if ((direction === "left" || direction === "right") && this.__canvasToolkitPengAutoHeightEnabled === true) {
          const handlePointerUp = (): void => {
            window.setTimeout(() => {
              const canvas = this.canvas;
              const nodeId = typeof this.id === "string" ? this.id : undefined;
              const stillExists = nodeId ? canvas?.nodes?.has?.(nodeId) : true;

              if (!stillExists) {
                return;
              }

              if (this.nodeEl instanceof HTMLElement && this.nodeEl.classList.contains("is-resizing")) {
                return;
              }

              if (typeof this.onResizeDblclick === "function") {
                this.onResizeDblclick(event, "bottom");
              }
            }, 0);
          };

          window.addEventListener("pointerup", handlePointerUp, { once: true });
        }

        return result;
      };
    });

    if (pointerDownUnpatch) {
      restorers.push(pointerDownUnpatch);
    }

    const blurUnpatch = this.patchMethod(baseNodePrototype, "blur", (originalMethod) => {
      return function (this: PatchableNode, ...args: unknown[]): unknown {
        const result = originalMethod.apply(this, args);

        if (this.__canvasToolkitPengAutoHeightEnabled === true) {
          window.setTimeout(() => {
            if (typeof this.onResizeDblclick === "function") {
              this.onResizeDblclick(createMockEvent(), "bottom");
            }
          }, 300);
        }

        return result;
      };
    });

    if (blurUnpatch) {
      restorers.push(blurUnpatch);
    }

    if (restorers.length === 0) {
      return null;
    }

    return () => {
      for (const restore of restorers.reverse()) {
        restore();
      }
    };
  }

  private patchMethod(
    target: Record<MethodName, unknown>,
    methodName: MethodName,
    createPatchedMethod: PatchFactory,
  ): (() => void) | null {
    const originalMethod = target[methodName];
    if (typeof originalMethod !== "function") {
      return null;
    }

    const patchedMethod = createPatchedMethod(originalMethod as (...args: unknown[]) => unknown);
    target[methodName] = patchedMethod;

    return () => {
      if (target[methodName] === patchedMethod) {
        target[methodName] = originalMethod;
      }
    };
  }
}

function createMockEvent(): EventLike {
  return {
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}
