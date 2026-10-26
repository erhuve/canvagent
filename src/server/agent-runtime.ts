import type { AgentCapabilities } from '../shared/agents.js';
import type { RuntimeImage } from '../shared/context.js';
import type { RpcId, RuntimeConnection } from './runtime.js';

export type AgentRuntimeConnection = RuntimeConnection & { capabilities?: AgentCapabilities };

/** Shared conversation lifecycle; each adapter advertises only its own features. */
export interface AgentRuntime {
  threadId: string | null;
  activeTurnId: string | null;
  connect(): Promise<AgentRuntimeConnection>;
  open(threadId?: string): Promise<string>;
  start(text: string, requestId?: string, images?: RuntimeImage[]): Promise<string>;
  steer(text: string, turnId: string, images?: RuntimeImage[]): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  answer(id: RpcId, result: any): void;
  close(): void;
}
