export type ResizeDirection = "top" | "right" | "bottom" | "left";

export interface RectData {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BBoxData {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CanvasNodeData extends RectData {
  id: string;
  type?: string;
  [key: string]: unknown;
}

export interface CanvasSelectionData {
  nodes: CanvasNodeData[];
  edges: unknown[];
  center?: {
    x: number;
    y: number;
  };
}

export interface CanvasNodeLike {
  id?: string;
  canvas?: CanvasLike;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  nodeEl?: HTMLElement;
  contentEl?: HTMLElement;
  onResizeDblclick?: (event: EventLike, direction: ResizeDirection) => unknown;
  onResizePointerdown?: (event: EventLike, direction: ResizeDirection) => unknown;
  blur?: (...args: unknown[]) => unknown;
  getData?: () => CanvasNodeData;
  setData?: (...args: unknown[]) => unknown;
  moveAndResize?: (rect: RectData) => unknown;
  resize?: (size: { width: number; height: number }) => unknown;
  render?: () => unknown;
  getBBox?: () => unknown;
  [key: string]: unknown;
}

export interface CanvasLike {
  nodes: Map<string, CanvasNodeLike>;
  selection: Set<unknown>;
  scale?: number;
  x?: number;
  y?: number;
  zoom?: number;
  tx?: number;
  ty?: number;
  tZoom?: number;
  gridSpacing?: number;
  getSelectionData?: () => CanvasSelectionData;
  getViewportBBox?: () => BBoxData;
  panIntoView?: (bbox: BBoxData, padding?: number) => void;
  setViewport?: (x: number, y: number, zoom: number) => void;
  requestFrame?: () => void;
  readonly?: boolean;
  [key: string]: unknown;
}

export interface CanvasViewLike {
  canvas?: CanvasLike;
  getViewType?: () => string;
  [key: string]: unknown;
}

export interface EventLike {
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface FitResult {
  attempted: number;
  resized: number;
  skipped: number;
  unresolved: number;
  unchanged: number;
  widthAdjusted: number;
  heightOnly: number;
}
