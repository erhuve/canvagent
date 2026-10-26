import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentDefinitionSchema, builtinAgents, type AgentDefinition, type PublicAgentDefinition } from '../shared/agents.js';
import type { Store } from './store.js';

/** Agent configuration is project local. Supplied keys live only in this process. */
export class AgentRegistry {
  private custom: AgentDefinition[];
  private keys = new Map<string, string>();
  constructor(private store: Pick<Store, 'get' | 'set'>) {
    this.custom = z.array(agentDefinitionSchema).parse(store.get('agents') ?? []);
  }
  private definitions() { return [...builtinAgents.map(agent => this.custom.find(item => item.id === agent.id) ?? agent), ...this.custom.filter(agent => !builtinAgents.some(item => item.id === agent.id))]; }
  overridden(id: string) { return this.custom.some(agent => agent.id === id); }
  list(): PublicAgentDefinition[] {
    return this.definitions().map(agent => ({ ...agent, builtin: builtinAgents.some(item => item.id === agent.id),
      credentialConfigured: Boolean(this.key(agent.id)) }));
  }
  get(id: string): AgentDefinition {
    const agent = this.definitions().find(agent => agent.id === id);
    if (!agent) throw Object.assign(new Error('Agent configuration not found.'), { status: 404 });
    return agent;
  }
  key(id: string) {
    const agent = this.definitions().find(agent => agent.id === id);
    const official = agent && ['anthropic', 'openai-compatible'].includes(agent.kind) && (!agent.baseUrl || agent.baseUrl.replace(/\/$/, '') === (agent.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'));
    return this.keys.get(id) || (agent?.apiKeyEnv ? process.env[agent.apiKeyEnv] : official ? process.env[agent?.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] : undefined);
  }
  save(input: unknown) {
    const request = z.object({ id: z.string().optional(), apiKey: z.string().max(16000).optional() }).passthrough().parse(input);
    const { apiKey, ...configuration } = request;
    const agent = agentDefinitionSchema.parse({ ...configuration, id: request.id || `agent-${randomUUID()}` });
    if ((agent.kind === 'codex') !== (agent.id === 'codex')) throw Object.assign(new Error('The Codex runtime uses the reserved Codex configuration.'), { status: 400 });
    if (this.custom.length >= 50 && !this.custom.some(item => item.id === agent.id)) throw Object.assign(new Error('A project can configure up to 50 agents.'), { status: 400 });
    const previous = this.definitions().find(item => item.id === agent.id);
    if (previous && (previous.kind !== agent.kind || previous.baseUrl !== agent.baseUrl)) {
      if (previous.apiKeyEnv && previous.apiKeyEnv === agent.apiKeyEnv && apiKey === undefined)
        throw Object.assign(new Error('The API endpoint changed. Clear the old credential reference and explicitly configure credentials for the new endpoint.'), { status: 400 });
      this.keys.delete(agent.id);
    }
    this.custom = [...this.custom.filter(item => item.id !== agent.id), agent];
    this.store.set('agents', this.custom);
    if (apiKey !== undefined) { if (apiKey) this.keys.set(agent.id, apiKey); else this.keys.delete(agent.id); }
    return this.list().find(item => item.id === agent.id)!;
  }
  remove(id: string) {
    this.get(id);
    this.custom = this.custom.filter(agent => agent.id !== id);
    this.keys.delete(id);
    this.store.set('agents', this.custom);
  }
  clearKeys() { this.keys.clear(); }
}
