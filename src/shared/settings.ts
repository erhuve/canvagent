import { z } from 'zod';

// Empty values inherit Codex's configuration. Keep Canvagent's original safety
// defaults for approvals and filesystem access until the user changes them.
export const agentSettingsSchema = z.object({
  model: z.string().trim().max(160).default(''),
  reasoningEffort: z.string().trim().max(80).default(''),
  serviceTier: z.string().trim().max(80).default(''),
  approvalPolicy: z.enum(['', 'on-request', 'never', 'untrusted']).default('on-request'),
  approvalsReviewer: z.enum(['', 'user', 'auto_review', 'guardian_subagent']).default(''),
  sandboxMode: z.enum(['', 'read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  networkAccess: z.boolean().nullable().default(null),
  writableRoots: z.array(z.string().trim().min(1).max(4096)).max(50).default([]),
  webSearch: z.enum(['', 'disabled', 'cached', 'indexed', 'live']).default(''),
  reasoningSummary: z.enum(['', 'auto', 'concise', 'detailed', 'none']).default(''),
  verbosity: z.enum(['', 'low', 'medium', 'high']).default(''),
  collaborationMode: z.enum(['default', 'plan']).default('default'),
  additionalInstructions: z.string().max(20000).default(''),
  configOverrides: z.record(z.string().min(1).max(240), z.json()).default({}),
}).strict();

export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const defaultAgentSettings = (): AgentSettings => agentSettingsSchema.parse({});
export type AgentModel = {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
  defaultServiceTier?: string | null;
  serviceTiers?: { id: string; name: string; description?: string }[];
};

export type SettingsRequirements = {
  allowedApprovalPolicies?: string[];
  allowedApprovalsReviewers?: string[];
  allowedSandboxModes?: string[];
  allowedWebSearchModes?: string[];
};

// Codex config calls this tier "fast"; newer model catalogs can advertise
// its wire name "priority" instead. They represent the same selection.
export function serviceTierForModel(model: AgentModel | undefined, tier: string): string {
  if (!model?.serviceTiers || model.serviceTiers.some(item => item.id === tier)) return tier;
  const alias = tier === 'fast' ? 'priority' : tier === 'priority' ? 'fast' : '';
  return alias && model.serviceTiers.some(item => item.id === alias) ? alias : tier;
}

export function settingsCompatibilityError(settings: AgentSettings, models: AgentModel[], requirements?: SettingsRequirements): string | undefined {
  const model = models.find(item => item.id === settings.model) ?? (!settings.model ? models.find(item => item.isDefault) : undefined);
  if (settings.reasoningEffort && model?.supportedReasoningEfforts?.length && !model.supportedReasoningEfforts.some(item => item.reasoningEffort === settings.reasoningEffort)) return `${model.name} does not support thinking level ${settings.reasoningEffort}.`;
  if (settings.serviceTier && settings.serviceTier !== 'default' && model?.serviceTiers?.length && !model.serviceTiers.some(item => item.id === serviceTierForModel(model, settings.serviceTier))) return `${model.name} does not support speed ${settings.serviceTier}.`;
  for (const [value, allowed, label] of [
    [settings.approvalPolicy, requirements?.allowedApprovalPolicies, 'Approval policy'],
    [settings.approvalsReviewer, requirements?.allowedApprovalsReviewers, 'Approval reviewer'],
    [settings.sandboxMode, requirements?.allowedSandboxModes, 'Sandbox access'],
    [settings.webSearch, requirements?.allowedWebSearchModes, 'Web search'],
  ] as const) {
    if (value && allowed && !allowed.includes(value)) return `${label} ${value} is blocked by your Codex requirements.`;
  }
  return undefined;
}
