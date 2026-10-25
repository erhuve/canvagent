import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  agentSettingsSchema,
  settingsCompatibilityError,
  serviceTierForModel,
  type AgentModel,
  type AgentSettings,
  type SettingsRequirements,
} from "../shared/settings";
import { errorMessage } from "./api";
import { Icon } from "./icons";

type SettingsProps = {
  settings: AgentSettings;
  defaults?: Partial<AgentSettings>;
  models: AgentModel[];
  requirements?: SettingsRequirements;
  running: boolean;
  disabled?: boolean;
  saving?: boolean;
  onChange: (settings: Partial<AgentSettings>, remember?: boolean) => Promise<void>;
  onSaveDefaults: (settings: AgentSettings) => Promise<void>;
  onError: (message: string) => void;
};

const displayValue = (value: string) => ({
  "on-request": "On request", never: "Never", untrusted: "Untrusted commands",
  user: "You", auto_review: "Automatic review", guardian_subagent: "Guardian subagent",
  "read-only": "Read only", "workspace-write": "Workspace write", "danger-full-access": "Full access",
  default: "Default", plan: "Plan", auto: "Auto", concise: "Concise", detailed: "Detailed", none: "None",
  disabled: "Disabled", cached: "Cached", indexed: "Indexed", live: "Live", low: "Low", medium: "Medium", high: "High",
  minimal: "Minimal", xhigh: "Extra high", max: "Max", ultra: "Ultra", fast: "Fast", priority: "Fast", flex: "Flex",
} as Record<string, string>)[value] ?? value;

function selectedModel(settings: AgentSettings, models: AgentModel[], defaults?: Partial<AgentSettings>) {
  const configured = settings.configOverrides.model;
  const id = settings.model || (typeof configured === "string" ? configured : "") || defaults?.model;
  return id ? models.find(model => model.id === id) : models.find(model => model.isDefault);
}

// Only carry explicit choices across a model switch when the new catalog says
// they are supported. Empty values ask Codex to resolve its own defaults.
function changeModel(settings: AgentSettings, id: string, models: AgentModel[], defaults?: Partial<AgentSettings>): AgentSettings {
  const next = { ...settings, model: id };
  const model = selectedModel(next, models, defaults);
  next.serviceTier = serviceTierForModel(model, next.serviceTier);
  if (model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.some(item => item.reasoningEffort === next.reasoningEffort)) next.reasoningEffort = "";
  if (model?.serviceTiers && !model.serviceTiers.some(item => item.id === next.serviceTier)) next.serviceTier = "";
  return next;
}

function ModelOptions({ settings, models, defaults }: Pick<SettingsProps, "settings" | "models" | "defaults">) {
  const inherited = models.find(model => model.id === defaults?.model)?.name ?? defaults?.model;
  return <>
    <option value="">Codex default{inherited ? ` (${inherited})` : ""}</option>
    {!!settings.model && !models.some(model => model.id === settings.model) && <option value={settings.model}>{settings.model}</option>}
    {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
  </>;
}

function EffortOptions({ settings, models, defaults }: Pick<SettingsProps, "settings" | "models" | "defaults">) {
  const model = selectedModel(settings, models, defaults);
  const efforts = model?.supportedReasoningEfforts ?? [];
  const configured = defaults?.reasoningEffort;
  const inherited = configured && (!model?.supportedReasoningEfforts || efforts.some(item => item.reasoningEffort === configured)) ? configured : model?.defaultReasoningEffort;
  return <>
    <option value="">Default{inherited ? ` (${displayValue(inherited)})` : ""}</option>
    {!!settings.reasoningEffort && !efforts.some(item => item.reasoningEffort === settings.reasoningEffort) && <option value={settings.reasoningEffort}>{displayValue(settings.reasoningEffort)}</option>}
    {efforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort} title={item.description}>{displayValue(item.reasoningEffort)}</option>)}
  </>;
}

function TierOptions({ settings, models, defaults }: Pick<SettingsProps, "settings" | "models" | "defaults">) {
  const model = selectedModel(settings, models, defaults);
  const tiers = model?.serviceTiers ?? [];
  const configured = serviceTierForModel(model, defaults?.serviceTier ?? '');
  const inherited = configured && (!model?.serviceTiers || tiers.some(item => item.id === configured)) ? configured : model?.defaultServiceTier || (model?.serviceTiers ? 'default' : undefined);
  return <>
    <option value="">Default{inherited ? ` (${inherited === 'default' ? 'Standard' : displayValue(inherited)})` : ""}</option>
    {!!settings.serviceTier && !tiers.some(item => item.id === settings.serviceTier) && <option value={settings.serviceTier}>{displayValue(settings.serviceTier)}</option>}
    {tiers.map(item => <option key={item.id} value={item.id} title={item.description}>{item.name}</option>)}
  </>;
}

function Field({ label, description, wide, children }: { label: string; description?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`agent-settings-field${wide ? " field-wide" : ""}`}><span>{label}</span>{children}{description && <small>{description}</small>}</label>;
}

function InheritedOptions({ values, current, allowed, inherited }: { values: string[]; current: string; allowed?: string[]; inherited?: string }) {
  const allValues = current && !values.includes(current) ? [...values, current] : values;
  return <>
    <option value="">Codex default{inherited ? ` (${displayValue(inherited)})` : ""}</option>
    {allValues.map(value => <option key={value} value={value} disabled={!!allowed && !allowed.includes(value)}>{displayValue(value)}{allowed && !allowed.includes(value) ? " (managed)" : ""}</option>)}
  </>;
}

function SettingsDialog(props: SettingsProps & { onClose: () => void }) {
  const [draft, setDraft] = useState<AgentSettings>(() => structuredClone(props.settings));
  const [configJson, setConfigJson] = useState(() => JSON.stringify(props.settings.configOverrides, null, 2));
  const [writableRoots, setWritableRoots] = useState(() => props.settings.writableRoots.join("\n"));
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const { models, defaults, requirements } = props;
  const blocked = saving || props.saving;
  const set = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    setDraft(previous => ({ ...previous, [key]: value }));
    setError("");
    setStatus("");
  };
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const save = async (asDefaults: boolean) => {
    if (blocked) return;
    let configOverrides: AgentSettings["configOverrides"];
    try {
      const parsed: unknown = JSON.parse(configJson.trim() || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Enter a JSON object, for example {\"model_context_window\": 200000}.");
      configOverrides = parsed as AgentSettings["configOverrides"];
    } catch (cause) {
      setError(`Advanced configuration is invalid: ${errorMessage(cause)}`);
      dialog.current?.querySelector<HTMLTextAreaElement>("[name=configOverrides]")?.focus();
      return;
    }
    const result = agentSettingsSchema.safeParse({ ...draft, configOverrides, writableRoots: writableRoots.split("\n").map(root => root.trim()).filter(Boolean) });
    if (!result.success) { setError(result.error.issues[0]?.message ?? "Check your settings."); return; }
    const compatibilityError = settingsCompatibilityError(result.data, models, requirements);
    if (compatibilityError) { setError(compatibilityError); return; }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      if (asDefaults) {
        await props.onSaveDefaults(result.data);
        setStatus("Defaults saved for new conversations.");
      } else {
        await props.onChange(result.data);
        props.onClose();
      }
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      props.onError(message);
    } finally { setSaving(false); }
  };

  return <dialog ref={dialog} className="agent-settings-dialog" aria-labelledby="agent-settings-title" aria-describedby="agent-settings-description" onCancel={event => { event.preventDefault(); props.onClose(); }} onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); void save(false); }}>
      <div className="agent-settings-heading"><div><h2 id="agent-settings-title">Codex settings</h2><p id="agent-settings-description">Changes apply to the next turn in this conversation.{props.running ? " The current turn keeps its settings." : ""}</p></div><button className="icon-button" type="button" aria-label="Close settings" onClick={props.onClose}><Icon name="close" size={18} /></button></div>
      <div className="agent-settings-body">
        <p className="agent-settings-hint">Default values inherit your Codex configuration. Managed options are set by your Codex requirements.</p>
        <fieldset disabled={blocked} className="agent-settings-grid">
          <legend>Model and behavior</legend>
          <Field label="Model"><select value={draft.model} onChange={event => { setDraft(current => changeModel(current, event.target.value, models, defaults)); setError(""); setStatus(""); }}><ModelOptions settings={draft} models={models} defaults={defaults} /></select></Field>
          <Field label="Thinking"><select value={draft.reasoningEffort} onChange={event => set("reasoningEffort", event.target.value)}><EffortOptions settings={draft} models={models} defaults={defaults} /></select></Field>
          <Field label="Speed"><select value={draft.serviceTier} onChange={event => set("serviceTier", event.target.value)}><TierOptions settings={draft} models={models} defaults={defaults} /></select></Field>
          <Field label="Collaboration mode"><select value={draft.collaborationMode} onChange={event => set("collaborationMode", event.target.value as AgentSettings["collaborationMode"])}><option value="default">Default</option><option value="plan">Plan</option></select></Field>
          <Field label="Reasoning summaries"><select value={draft.reasoningSummary} onChange={event => set("reasoningSummary", event.target.value as AgentSettings["reasoningSummary"])}><InheritedOptions values={["auto", "concise", "detailed", "none"]} current={draft.reasoningSummary} inherited={defaults?.reasoningSummary} /></select></Field>
          <Field label="Response verbosity"><select value={draft.verbosity} onChange={event => set("verbosity", event.target.value as AgentSettings["verbosity"])}><InheritedOptions values={["low", "medium", "high"]} current={draft.verbosity} inherited={defaults?.verbosity} /></select></Field>
        </fieldset>
        <fieldset disabled={blocked} className="agent-settings-grid">
          <legend>Permissions and access</legend>
          <Field label="Approval policy"><select value={draft.approvalPolicy} onChange={event => set("approvalPolicy", event.target.value as AgentSettings["approvalPolicy"])}><InheritedOptions values={["on-request", "never"]} current={draft.approvalPolicy} allowed={requirements?.allowedApprovalPolicies} inherited={defaults?.approvalPolicy} /></select></Field>
          <Field label="Approval reviewer"><select value={draft.approvalsReviewer} onChange={event => set("approvalsReviewer", event.target.value as AgentSettings["approvalsReviewer"])}><InheritedOptions values={["user", "auto_review"]} current={draft.approvalsReviewer} allowed={requirements?.allowedApprovalsReviewers} inherited={defaults?.approvalsReviewer} /></select></Field>
          <Field label="Sandbox access"><select value={draft.sandboxMode} onChange={event => set("sandboxMode", event.target.value as AgentSettings["sandboxMode"])}><InheritedOptions values={["read-only", "workspace-write", "danger-full-access"]} current={draft.sandboxMode} allowed={requirements?.allowedSandboxModes} inherited={defaults?.sandboxMode} /></select></Field>
          <Field label="Network access"><select value={draft.networkAccess === null ? "" : String(draft.networkAccess)} onChange={event => set("networkAccess", event.target.value === "" ? null : event.target.value === "true")}><option value="">Codex default{defaults?.networkAccess != null ? ` (${defaults.networkAccess ? "On" : "Off"})` : ""}</option><option value="true">On</option><option value="false">Off</option></select></Field>
          <Field label="Web search"><select value={draft.webSearch} onChange={event => set("webSearch", event.target.value as AgentSettings["webSearch"])}><InheritedOptions values={["disabled", "cached", "indexed", "live"]} current={draft.webSearch} allowed={requirements?.allowedWebSearchModes} inherited={defaults?.webSearch} /></select></Field>
          <Field label="Additional writable roots" wide description="One absolute folder path per line. Applies to workspace write access."><textarea rows={3} value={writableRoots} placeholder="/path/to/another/project" onChange={event => { setWritableRoots(event.target.value); setError(""); setStatus(""); }} /></Field>
        </fieldset>
        <fieldset disabled={blocked} className="agent-settings-grid">
          <legend>Instructions and advanced configuration</legend>
          <Field label="Additional instructions" wide description="Added to each new turn alongside this conversation’s context."><textarea rows={4} maxLength={20000} value={draft.additionalInstructions} placeholder="Preferences for how Codex should work in this conversation…" onChange={event => set("additionalInstructions", event.target.value)} /></Field>
          <Field label="Advanced Codex configuration (JSON)" wide description="Use Codex config keys for other settings. Explicit controls above override matching JSON keys."><textarea name="configOverrides" className="agent-settings-json" rows={6} spellCheck={false} value={configJson} onChange={event => { setConfigJson(event.target.value); setError(""); setStatus(""); }} /></Field>
        </fieldset>
        {error && <p className="agent-settings-error" role="alert">{error}</p>}
        {status && <p className="agent-settings-status" role="status">{status}</p>}
      </div>
      <div className="agent-settings-footer"><p>Save settings for this conversation, or save defaults for new conversations.</p><div><button type="button" className="settings-secondary" disabled={blocked} onClick={() => void save(true)}>Save as defaults</button><button type="submit" className="button-dark" disabled={blocked}>{blocked ? "Saving…" : "Save settings"}</button></div></div>
    </form>
  </dialog>;
}

export function AgentSettingsControls(props: SettingsProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const changing = useRef(false);
  const options = { settings: props.settings, models: props.models, defaults: props.defaults };
  const model = selectedModel(props.settings, props.models, props.defaults);
  const blocked = props.disabled || props.saving || saving;
  const inheritedValue = (key: keyof AgentSettings, configKey: string, fallback: string) => {
    const configured = props.settings.configOverrides[configKey];
    return String(props.settings[key] || (typeof configured === "string" ? configured : "") || props.defaults?.[key] || fallback);
  };
  const permissions = {
    approvalPolicy: inheritedValue("approvalPolicy", "approval_policy", "on-request"),
    approvalsReviewer: inheritedValue("approvalsReviewer", "approvals_reviewer", "user"),
    sandboxMode: inheritedValue("sandboxMode", "sandbox_mode", "workspace-write"),
  };
  const approvalPresets = [
    { id: "ask", label: "Ask to approve", approvalPolicy: "on-request", approvalsReviewer: "user", sandboxMode: "workspace-write" },
    { id: "auto-review", label: "Auto review", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxMode: "workspace-write" },
    { id: "read-only", label: "Read only", approvalPolicy: "on-request", approvalsReviewer: "user", sandboxMode: "read-only" },
    { id: "full-access", label: "Full access", approvalPolicy: "never", approvalsReviewer: "user", sandboxMode: "danger-full-access" },
  ] as const;
  const approvalPreset = approvalPresets.find(preset => preset.approvalPolicy === permissions.approvalPolicy && preset.approvalsReviewer === permissions.approvalsReviewer && preset.sandboxMode === permissions.sandboxMode);
  const presetAllowed = (preset: typeof approvalPresets[number]) => (
    (!props.requirements?.allowedApprovalPolicies || props.requirements.allowedApprovalPolicies.includes(preset.approvalPolicy)) &&
    (!props.requirements?.allowedApprovalsReviewers || props.requirements.allowedApprovalsReviewers.includes(preset.approvalsReviewer)) &&
    (!props.requirements?.allowedSandboxModes || props.requirements.allowedSandboxModes.includes(preset.sandboxMode))
  );
  const configuredEffort = inheritedValue("reasoningEffort", "model_reasoning_effort", "");
  const effectiveEffort = props.settings.reasoningEffort || (configuredEffort && (!model?.supportedReasoningEfforts || model.supportedReasoningEfforts.some(item => item.reasoningEffort === configuredEffort)) ? configuredEffort : model?.defaultReasoningEffort);
  const configuredTier = serviceTierForModel(model, inheritedValue("serviceTier", "service_tier", ""));
  const effectiveTier = props.settings.serviceTier || (configuredTier && (!model?.serviceTiers || model.serviceTiers.some(item => item.id === configuredTier)) ? configuredTier : model?.defaultServiceTier || "default");
  const fast = effectiveTier === "fast" || effectiveTier === "priority";
  const fastSupported = !model?.serviceTiers || model.serviceTiers.some(item => item.id === "fast" || item.id === "priority");
  const modelLabel = model?.name || inheritedValue("model", "model", "Codex default");
  // Send only the selected controls so remembering a choice never promotes
  // conversation-specific instructions or advanced config into defaults.
  const modelSettings = (settings: AgentSettings) => {
    const configured = (value: string, key: string) => value || (typeof settings.configOverrides[key] === "string" ? settings.configOverrides[key] as string : "");
    return {
      model: configured(settings.model, "model"),
      reasoningEffort: configured(settings.reasoningEffort, "model_reasoning_effort"),
      serviceTier: configured(settings.serviceTier, "service_tier"),
    };
  };
  const change = async (settings: Partial<AgentSettings>) => {
    if (blocked || changing.current) return;
    changing.current = true;
    setSaving(true);
    try { await props.onChange(settings, true); }
    catch (cause) { props.onError(errorMessage(cause)); }
    finally { changing.current = false; setSaving(false); }
  };
  return <>
    <div className="composer-settings-controls" aria-label="Conversation settings" aria-busy={saving || props.saving}>
      <label className="composer-setting composer-approval-setting" title="Approval mode · applies next turn and is remembered for new conversations">
        <span className="composer-setting-label">{approvalPreset?.label ?? "Custom permissions"}</span><Icon name="chevron" size={12} />
        <select aria-label="Approval mode" value={approvalPreset?.id ?? "custom"} disabled={blocked} onChange={event => {
          const preset = approvalPresets.find(item => item.id === event.target.value);
          if (preset && presetAllowed(preset)) void change({ approvalPolicy: preset.approvalPolicy, approvalsReviewer: preset.approvalsReviewer, sandboxMode: preset.sandboxMode });
        }}>
          {!approvalPreset && <option value="custom" disabled>Custom permissions</option>}
          {approvalPresets.map(preset => <option key={preset.id} value={preset.id} disabled={!presetAllowed(preset)}>{preset.label}{!presetAllowed(preset) ? " (managed)" : ""}</option>)}
        </select>
      </label>
      <label className="composer-setting composer-mode-setting" title="Collaboration mode · applies next turn and is remembered for new conversations">
        <span className="composer-setting-label">{displayValue(props.settings.collaborationMode)}</span><Icon name="chevron" size={12} />
        <select aria-label="Collaboration mode" value={props.settings.collaborationMode} disabled={blocked} onChange={event => void change({ collaborationMode: event.target.value as AgentSettings["collaborationMode"] })}><option value="default">Default</option><option value="plan">Plan</option></select>
      </label>
      <label className="composer-setting composer-model-setting" title={`${modelLabel} · applies next turn and is remembered for new conversations`}>
        <span className="composer-setting-label">{modelLabel}</span><Icon name="chevron" size={12} />
        <select aria-label="Agent model" value={props.settings.model} disabled={blocked} onChange={event => void change(modelSettings(changeModel(props.settings, event.target.value, props.models, props.defaults)))}><ModelOptions {...options} /></select>
      </label>
      <label className="composer-setting composer-effort-setting" title="Thinking level · applies next turn and is remembered for new conversations">
        <span className="composer-setting-label">{effectiveEffort ? displayValue(effectiveEffort) : "Default"}</span><Icon name="chevron" size={12} />
        <select aria-label="Thinking level" value={props.settings.reasoningEffort} disabled={blocked} onChange={event => void change({ ...modelSettings(props.settings), reasoningEffort: event.target.value })}><EffortOptions {...options} /></select>
      </label>
      <button type="button" role="switch" className="composer-fast-mode" aria-label="Fast mode" aria-checked={fast} title={fastSupported ? "Fast mode · applies next turn and is remembered for new conversations" : `Fast mode is unavailable for ${model?.name ?? "this model"}.`} disabled={blocked || !fastSupported} onClick={() => void change({ ...modelSettings(props.settings), serviceTier: fast ? "default" : serviceTierForModel(model, "fast") })}>
        <span>Fast mode</span><span className="composer-fast-switch" aria-hidden="true" />
      </button>
      <button type="button" className="icon-button composer-more-settings" aria-label="More Codex settings" title="More Codex settings" disabled={blocked} onClick={() => setOpen(true)}><Icon name="settings" size={17} /></button>
    </div>
    {open && createPortal(<SettingsDialog {...props} onClose={() => setOpen(false)} />, document.body)}
  </>;
}
