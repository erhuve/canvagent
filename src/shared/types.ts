import type { AgentModel, AgentSettings, SettingsRequirements } from './settings.js';

export type JsonObject = Record<string, any>;
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  turnId?: string;
  canvasReference?: { boardId: string; revision: number; elementIds: string[] };
}
export interface Activity {
  id: string;
  kind: string;
  title: string;
  status: string;
  detail?: string;
  createdAt: string;
}
export interface Approval {
  id: string;
  nativeId: string | number;
  method: string;
  title: string;
  description: string;
  command?: string;
  cwd?: string;
  choices: string[];
  params: JsonObject;
}
export interface Session {
  settings?: AgentSettings;
  id: string;
  title: string;
  threadId: string | null;
  turnId: string | null;
  status: 'idle' | 'starting' | 'running' | 'awaiting_approval' | 'failed' | 'unknown';
  messages: Message[];
  activities: Activity[];
  pendingApprovals: Approval[];
  queued: { id: string; text: string; selection: { elementIds: string[] } }[];
  contextRevision: number;
  createdAt: string;
}
export interface Artifact {
  id: string;
  fileName: string;
  title: string;
  mimeType: string;
  size: number;
  sha256: string;
  sessionId?: string;
  createdAt: string;
}
export interface RuntimeState {
  connected: boolean;
  authenticated: boolean;
  version: string;
  models: AgentModel[];
  model: string;
  settings: AgentSettings;
  defaults?: Partial<AgentSettings>;
  requirements?: SettingsRequirements;
  error?: string;
  capabilities: { steering: boolean; canvasChangeNotices: boolean; canvasTools: boolean };
}
