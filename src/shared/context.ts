export type ContextKind = 'file' | 'folder' | 'conversation' | 'canvas' | 'artifact' | 'image';

export type ContextReference =
  | { kind: 'file'; path: string; startLine?: number; endLine?: number }
  | { kind: 'folder'; path: string }
  | { kind: 'conversation'; sessionId: string }
  | { kind: 'canvas'; elementIds: string[] }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'image'; imageId: string };

/** Immutable, workspace-scoped context captured when the user attaches it. */
export type ContextAttachment = {
  id: string;
  kind: ContextKind;
  label: string;
  createdAt: string;
  text?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  revision?: string | number;
  truncated?: boolean;
  imageId?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  sessionId?: string;
  elementIds?: string[];
  artifactId?: string;
};

/** Binary data is hydrated only at the adapter boundary, never in saved chat JSON. */
export type RuntimeImage = { url: string; mimeType: string; name?: string };
export type ContextSuggestion = { label: string; description?: string; reference: ContextReference };

export type ReviewFile = { path: string; beforeRevision?: string; afterRevision?: string; status: 'added' | 'modified' | 'deleted'; additions?: number; deletions?: number };
export type TurnReview = {
  id: string;
  turnId?: string;
  messageId: string;
  createdAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed' | 'unknown';
  files: ReviewFile[];
  canvasElementIds: string[];
  truncated?: boolean;
};
