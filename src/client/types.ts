import type { AgentModel, AgentSettings, SettingsRequirements } from '../shared/settings';

export type SceneElement = Record<string, any> & { id: string; isDeleted?: boolean };
export type Board = {
  id: string;
  revision: number;
  elements: SceneElement[];
  files: Record<string, any>;
  metadata: Record<string, { revision: number; actor: string }>;
  lastAgentMutation?: string | null;
};
export type Message = {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  turnId?: string;
};
export type Activity = {
  id: string;
  kind?: string;
  title: string;
  status?: string;
  detail?: string;
  createdAt?: string;
};
export type Approval = {
  id: string;
  title?: string;
  method?: string;
  description?: string;
  command?: string | string[];
  cwd?: string;
  [key: string]: any;
};
export type Session = {
  settings?: AgentSettings;
  id: string;
  title: string;
  threadId?: string;
  status: "idle" | "starting" | "running" | "awaiting_approval" | "failed" | "unknown";
  messages: Message[];
  turnId?: string;
  pendingApprovals: Approval[];
  activities?: Activity[];
  error?: string;
};
export type Runtime = {
  connected: boolean;
  authenticated: boolean;
  version?: string;
  models: AgentModel[];
  model?: string;
  settings: AgentSettings;
  defaults?: Partial<AgentSettings>;
  requirements?: SettingsRequirements;
  error?: string;
  capabilities?: Record<string, boolean>;
};
export type AppState = {
  board: Board;
  project: { workspace: string; name: string; desktop?: boolean };
  sessions: Session[];
  activeSessionId?: string;
  runtime: Runtime;
  artifacts: any[];
};
export type ProjectSummary = {
  id: string;
  name: string;
  workspace: string;
  sessions: Pick<Session, "id" | "title" | "status">[];
  activeSessionId?: string;
  available?: boolean;
};
export type Region = { x: number; y: number; width: number; height: number };
export type PendingEdit = { element: SceneElement; expectedRevision?: number };
export type MutationResult = {
  ok: boolean;
  boardRevision?: number;
  mutationId?: string;
  changedElements?: SceneElement[];
  metadata?: Board["metadata"];
  board?: Board;
  conflicts?: { elementId: string; [key: string]: any }[];
  message?: string;
};
