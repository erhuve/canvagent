import { z } from 'zod';

export const agentDefinitionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['codex', 'acp', 'openai-compatible', 'anthropic']),
  description: z.string().max(1000).optional(),
  command: z.string().trim().min(1).max(4096).optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  // Values name existing host environment variables; secrets never enter saved config.
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
  baseUrl: z.string().url().max(4096).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
}).strict().superRefine((agent, ctx) => {
  if (agent.kind === 'acp' && !agent.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'An ACP executable is required.' });
  if (['openai-compatible', 'anthropic'].includes(agent.kind) && !agent.model) ctx.addIssue({ code: 'custom', path: ['model'], message: 'An API model ID is required.' });
  if (agent.baseUrl) {
    const url = new URL(agent.baseUrl);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Use an HTTP or HTTPS base URL without credentials, query, or fragment.' });
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Remote API endpoints require HTTPS. HTTP is supported for localhost.' });
  }
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type PublicAgentDefinition = AgentDefinition & { credentialConfigured?: boolean; builtin?: boolean };
export type AgentCapabilities = {
  imageInput?: boolean;
  steering: boolean;
  canvasChangeNotices: boolean;
  canvasTools: boolean;
  models?: boolean;
  approvalPolicy?: boolean;
  reasoningEffort?: boolean;
  serviceTier?: boolean;
};

export const builtinAgents: AgentDefinition[] = [
  { id: 'codex', name: 'Codex', kind: 'codex', command: 'codex', args: ['app-server'], description: 'Uses your installed Codex CLI and its existing login.' },
  { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'claude-agent-acp', args: [], description: 'Uses the Claude Code ACP adapter and your Claude authentication. Install claude-agent-acp and sign in first.' },
  { id: 'opencode', name: 'OpenCode', kind: 'acp', command: 'opencode', args: ['acp'], description: 'Uses your installed OpenCode harness, models, and authentication.' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'acp', command: 'gemini', args: ['--experimental-acp'], description: 'Uses your installed Gemini CLI and its existing authentication.' },
];

export function capabilitiesForAgent(agent: AgentDefinition): AgentCapabilities {
  const codex = agent.kind === 'codex';
  return { imageInput: agent.kind !== 'acp', steering: codex, canvasChangeNotices: false, canvasTools: agent.kind !== 'acp', models: codex || agent.kind !== 'acp', approvalPolicy: codex, reasoningEffort: codex, serviceTier: codex };
}
