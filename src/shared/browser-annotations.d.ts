export type AnnotationTool = 'pen' | 'highlight' | 'rectangle';
export type AnnotationState = {
  active: boolean;
  tool: AnnotationTool;
  color: string;
  count: number;
  canUndo: boolean;
  documentId: string;
};
export type AnnotationCommand = {
  command: 'start' | 'stop' | 'settings' | 'undo' | 'clear' | 'state';
  tool?: AnnotationTool;
  color?: string;
};
export type BrowserAnnotator = { command(input: AnnotationCommand): AnnotationState; dispose(): void };
declare global {
  interface Window {
    __CANVAGENT_CREATE_BROWSER_ANNOTATIONS__?: (container?: HTMLElement) => BrowserAnnotator;
  }
}
