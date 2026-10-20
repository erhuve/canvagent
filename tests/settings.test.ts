import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentSettingsSchema, defaultAgentSettings, settingsCompatibilityError,
  serviceTierForModel,
  type AgentModel, type AgentSettings, type SettingsRequirements,
} from '../src/shared/settings.ts';

const models: AgentModel[] = [
  { id: 'large', name: 'Large', isDefault: true, defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'high', description: 'Thorough' }],
    serviceTiers: [{ id: 'fast', name: 'Fast' }, { id: 'flex', name: 'Flexible' }] },
  { id: 'small', name: 'Small', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }],
    serviceTiers: [{ id: 'flex', name: 'Flexible' }] },
];
function compatibility(settings: Partial<AgentSettings>, requirements?: SettingsRequirements) {
  return settingsCompatibilityError({ ...defaultAgentSettings(), ...settings }, models, requirements);
}

test('settings inherit optional Codex values while retaining the application safety defaults', () => {
  const defaults = defaultAgentSettings();
  assert.equal(defaults.model, '');
  assert.equal(defaults.reasoningEffort, '');
  assert.equal(defaults.serviceTier, '');
  assert.equal(defaults.approvalPolicy, 'on-request');
  assert.equal(defaults.sandboxMode, 'workspace-write');
  assert.equal(defaults.networkAccess, null);
  assert.equal(defaults.collaborationMode, 'default');
  assert.deepEqual(defaults.writableRoots, []);
  assert.deepEqual(defaults.configOverrides, {});
  const modifiedDefaults = defaultAgentSettings();
  modifiedDefaults.writableRoots.push('/one-workspace');
  modifiedDefaults.configOverrides.personality = 'friendly';
  assert.deepEqual(defaultAgentSettings().writableRoots, []);
  assert.deepEqual(defaultAgentSettings().configOverrides, {});
});

test('strict settings reject misspelled controls, malformed values and unbounded instructions', () => {
  for (const invalid of [
    { model: 12 }, { thinking: 'high' }, { fastMode: true }, { approvalPolicy: 'always' },
    { approvalsReviewer: 'automatic' }, { sandboxMode: 'full-access' }, { networkAccess: 'true' },
    { writableRoots: ['/tmp', ''] }, { webSearch: 'enabled' }, { collaborationMode: 'execute' },
    { reasoningSummary: 'verbose' }, { verbosity: 'max' }, { configOverrides: [] },
    { additionalInstructions: 'a'.repeat(20001) },
  ]) assert.equal(agentSettingsSchema.safeParse(invalid).success, false, JSON.stringify(invalid).slice(0, 100));
});

test('model capabilities validate reasoning and speed for the selected or inherited default model', () => {
  assert.equal(compatibility({ model: 'large', reasoningEffort: 'high', serviceTier: 'fast' }), undefined);
  assert.equal(compatibility({ model: 'small', serviceTier: 'default' }), undefined, 'Standard speed is available even when the catalog lists only optional speed tiers.');
  assert.equal(compatibility({ reasoningEffort: 'high', serviceTier: 'fast' }), undefined);
  assert.match(compatibility({ model: 'small', reasoningEffort: 'high' })!, /Small.*thinking level high/);
  assert.match(compatibility({ model: 'small', serviceTier: 'fast' })!, /Small.*speed fast/);
  assert.match(compatibility({ reasoningEffort: 'ultra' })!, /Large.*thinking level ultra/);
  assert.match(compatibility({ serviceTier: 'turbo' })!, /Large.*speed turbo/);
  assert.equal(compatibility({ model: 'small', reasoningEffort: '', serviceTier: '' }), undefined, 'Inheritance is always permitted.');
});

test('unknown capability metadata leaves custom model settings to Codex', () => {
  assert.equal(settingsCompatibilityError({ ...defaultAgentSettings(), model: 'custom', reasoningEffort: 'custom-effort', serviceTier: 'custom-tier' },
    [{ id: 'custom', name: 'Custom' }]), undefined);
  assert.equal(settingsCompatibilityError(defaultAgentSettings(), []), undefined);
});

test('Fast config and priority catalog tier names describe the same speed', () => {
  const model = { id: 'native', name: 'Native', serviceTiers: [{ id: 'priority', name: 'Fast' }] };
  assert.equal(serviceTierForModel(model, 'fast'), 'priority');
  assert.equal(serviceTierForModel(model, 'priority'), 'priority');
  assert.equal(serviceTierForModel(undefined, 'fast'), 'fast');
  assert.equal(settingsCompatibilityError({ ...defaultAgentSettings(), model: 'native', serviceTier: 'fast' }, [model]), undefined);
});

test('Codex requirements validate every restricted setting without coupling approvals to sandbox access', () => {
  const requirements: SettingsRequirements = {
    allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'],
    allowedSandboxModes: ['read-only', 'workspace-write'], allowedWebSearchModes: ['disabled', 'cached'],
  };
  assert.equal(compatibility({ approvalsReviewer: 'user', sandboxMode: 'read-only', webSearch: 'cached' }, requirements), undefined);
  for (const setting of [
    { approvalPolicy: 'never' as const }, { approvalsReviewer: 'auto_review' as const },
    { sandboxMode: 'danger-full-access' as const }, { webSearch: 'live' as const },
  ]) assert.match(compatibility(setting, requirements)!, /blocked by your Codex requirements/);
  assert.equal(compatibility({ approvalPolicy: '', approvalsReviewer: '', sandboxMode: '', webSearch: '' }, requirements), undefined);
});

test('explicitly empty requirement allowlists reject values rather than acting unrestricted', () => {
  assert.match(compatibility({ approvalsReviewer: 'user' }, { allowedApprovalsReviewers: [] })!, /Approval reviewer user.*blocked/);
  assert.match(compatibility({ webSearch: 'disabled' }, { allowedWebSearchModes: [] })!, /Web search disabled.*blocked/);
  assert.equal(compatibility({ webSearch: '' }, { allowedWebSearchModes: [] }), undefined);
});
