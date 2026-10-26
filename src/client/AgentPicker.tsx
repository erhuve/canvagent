import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AgentDefinition, PublicAgentDefinition } from '../shared/agents';
import { errorMessage } from './api';
import { Icon } from './icons';
import './AgentPicker.css';

export type SaveAgentInput = Partial<AgentDefinition> & { apiKey?: string };

type AgentPickerProps = {
  agents: PublicAgentDefinition[];
  activeAgentId: string;
  disabled?: boolean;
  hasMessages: boolean;
  onSelect: (id: string) => Promise<void>;
  onSave: (agent: SaveAgentInput) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onError: (message: string) => void;
};

const kindLabel = (kind: AgentDefinition['kind']) => ({ codex: 'Built in', acp: 'ACP', 'openai-compatible': 'API', anthropic: 'API' })[kind];
const newAgent = (): SaveAgentInput => ({ name: '', kind: 'acp', command: '', args: [], env: {} });
function apiOrigin(baseUrl: string | undefined, kind: SaveAgentInput['kind']) {
  try { return new URL(baseUrl || (kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')).origin; }
  catch { return undefined; }
}

function AgentManager({ agents, activeAgentId, onSave, onRemove, onClose }: Pick<AgentPickerProps, 'agents' | 'activeAgentId' | 'onSave' | 'onRemove'> & { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SaveAgentInput>(newAgent);
  const [args, setArgs] = useState('[]');
  const [environment, setEnvironment] = useState('{}');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [credentialHostChanged, setCredentialHostChanged] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const adding = useRef<Set<string>>();
  const existing = agents.find(agent => agent.id === editingId);
  const apiProvider = draft.kind === 'openai-compatible' || draft.kind === 'anthropic';

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!adding.current) return;
    const created = agents.find(agent => !adding.current?.has(agent.id));
    if (!created) return;
    adding.current = undefined;
    setEditingId(created.id);
    setDraft({ id: created.id, name: created.name, kind: created.kind, description: created.description, command: created.command, args: created.args, env: created.env, baseUrl: created.baseUrl, model: created.model, apiKeyEnv: created.apiKeyEnv });
  }, [agents]);

  const edit = (agent?: PublicAgentDefinition) => {
    setEditingId(agent?.id ?? null);
    setDraft(agent ? { id: agent.id, name: agent.name, kind: agent.kind, description: agent.description, command: agent.command, args: agent.args, env: agent.env, baseUrl: agent.baseUrl, model: agent.model, apiKeyEnv: agent.apiKeyEnv } : newAgent());
    setArgs(JSON.stringify(agent?.args ?? []));
    setEnvironment(JSON.stringify(agent?.env ?? {}, null, 2));
    setApiKey('');
    setClearApiKey(false);
    setCredentialHostChanged(false);
    setError('');
    setStatus('');
  };
  const update = (change: SaveAgentInput) => { setDraft(current => ({ ...current, ...change })); setError(''); setStatus(''); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    let parsedArgs: string[] = [];
    let parsedEnv: Record<string, string> = {};
    if (draft.kind === 'acp' || draft.kind === 'codex') {
      try { parsedArgs = JSON.parse(args); }
      catch { setError('Arguments must be a JSON array of strings, such as ["acp"].'); return; }
      if (!Array.isArray(parsedArgs) || parsedArgs.some(argument => typeof argument !== 'string')) { setError('Arguments must be a JSON array of strings.'); return; }
      try { parsedEnv = JSON.parse(environment); }
      catch { setError('Environment mapping must be a JSON object, such as {"TOKEN": "MY_TOKEN"}.'); return; }
      if (!parsedEnv || Array.isArray(parsedEnv) || typeof parsedEnv !== 'object' || Object.entries(parsedEnv).some(([name, source]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof source !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source))) {
        setError('Environment mapping must use variable names for both keys and values. Store secret values in your host environment.'); return;
      }
    }
    const payload: SaveAgentInput = {
      ...(editingId ? { id: editingId } : {}), name: draft.name?.trim(), kind: draft.kind,
      ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
      ...(apiProvider ? {
        model: draft.model?.trim(),
        ...(draft.baseUrl?.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
        ...(draft.apiKeyEnv?.trim() ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {}),
        ...(clearApiKey ? { apiKey: '' } : apiKey ? { apiKey } : {}),
      } : {
        ...(draft.command?.trim() ? { command: draft.command.trim() } : {}), args: parsedArgs, env: parsedEnv,
      }),
    };
    submitting.current = true;
    setSaving(true);
    if (!editingId) adding.current = new Set(agents.map(agent => agent.id));
    try {
      await onSave(payload);
      setApiKey('');
      setClearApiKey(false);
      setCredentialHostChanged(false);
      setStatus(`${draft.name?.trim() || 'Agent'} saved. Choose it from the agent picker when you are ready.`);
    } catch (cause) { adding.current = undefined; setError(errorMessage(cause)); }
    finally { submitting.current = false; setSaving(false); }
  };
  const remove = async () => {
    if (!existing || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      await onRemove(existing.id);
      edit();
      setStatus(existing.builtin ? 'Built-in configuration restored.' : `${existing.name} removed.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { submitting.current = false; setSaving(false); }
  };

  return <dialog ref={dialogRef} className="agent-manager-dialog" aria-labelledby="agent-manager-title" aria-describedby="agent-manager-description" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="agent-manager-heading"><div><h2 id="agent-manager-title">Your agents</h2><p id="agent-manager-description">Bring your own harness or connect a model provider.</p></div><button type="button" className="icon-button" aria-label="Close agent manager" disabled={saving} onClick={onClose}><Icon name="close" size={18} /></button></div>
    <div className="agent-manager-content">
      <div className="agent-manager-sidebar"><div className="agent-manager-list" aria-label="Configured agents">{agents.map(agent => <button key={agent.id} type="button" className={`agent-manager-item ${editingId === agent.id ? 'selected' : ''}`} aria-label={`Configure ${agent.name}`} aria-pressed={editingId === agent.id} disabled={saving} onClick={() => edit(agent)}><span className="agent-provider-icon"><Icon name={agent.kind === 'acp' || agent.kind === 'codex' ? 'terminal' : 'spark'} size={16} /></span><span><strong>{agent.name}</strong><small>{kindLabel(agent.kind)}{agent.id === activeAgentId ? ' · Current' : ''}</small></span></button>)}</div><button className="agent-manager-add" type="button" disabled={saving} onClick={() => edit()}><Icon name="plus" size={15} />Add agent</button></div>
      <form className="agent-manager-form" onSubmit={event => void save(event)}>
        <div className="agent-manager-form-heading"><h3>{existing ? `Configure ${existing.name}` : 'Add an agent'}</h3><p>{existing?.builtin ? 'Built-in agents use an installed harness and its existing authentication.' : 'Agent configurations are saved for this workspace.'}</p></div>
        <fieldset disabled={saving} className="agent-manager-fields">
          <label><span>Name</span><input autoFocus required maxLength={100} value={draft.name ?? ''} placeholder="My agent" onChange={event => update({ name: event.target.value })} /></label>
          <label><span>Connection</span><select value={draft.kind} disabled={existing?.builtin} onChange={event => { update({ kind: event.target.value as AgentDefinition['kind'], apiKeyEnv: '' }); setApiKey(''); setClearApiKey(!!existing?.credentialConfigured); setCredentialHostChanged(!!existing); }}><option value="acp">Agent Client Protocol (ACP)</option><option value="openai-compatible">OpenAI compatible API</option><option value="anthropic">Anthropic API</option>{draft.kind === 'codex' && <option value="codex">Codex app server</option>}</select></label>
          <label className="agent-field-wide"><span>Description <small>Optional</small></span><input maxLength={1000} value={draft.description ?? ''} placeholder="What you use this agent for" onChange={event => update({ description: event.target.value })} /></label>
          {!apiProvider ? <>
            <label className="agent-field-wide"><span>Executable{draft.kind === 'codex' && <small>Optional · defaults to codex</small>}</span><input required={draft.kind === 'acp'} value={draft.command ?? ''} placeholder={draft.kind === 'codex' ? 'codex' : 'my-agent'} onChange={event => update({ command: event.target.value })} /><small>Use an installed executable or an absolute path. Authenticate with the harness before selecting it.</small></label>
            <label className="agent-field-wide"><span>Arguments (JSON)</span><input className="agent-config-code" value={args} placeholder='["acp"]' spellCheck={false} onChange={event => { setArgs(event.target.value); setError(''); setStatus(''); }} /><small>Separate arguments in an array. The executable runs directly without a shell.</small></label>
            <label className="agent-field-wide"><span>Environment mapping (JSON) <small>Optional</small></span><textarea className="agent-config-code" rows={3} value={environment} spellCheck={false} onChange={event => { setEnvironment(event.target.value); setError(''); setStatus(''); }} /><small>Map harness variable names to existing environment variable names, for example {'{"ANTHROPIC_API_KEY": "MY_ANTHROPIC_KEY"}'}. Values are variable names, never secret values.</small></label>
          </> : <>
            <label className="agent-field-wide"><span>Model ID</span><input required maxLength={160} value={draft.model ?? ''} placeholder={draft.kind === 'anthropic' ? 'Your Claude model ID' : 'Your provider’s model ID'} onChange={event => update({ model: event.target.value })} /></label>
            <label className="agent-field-wide"><span>Base URL <small>Optional</small></span><input type="url" value={draft.baseUrl ?? ''} placeholder={draft.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'} onChange={event => {
              const baseUrl = event.target.value;
              const changed = apiOrigin(baseUrl, draft.kind) !== apiOrigin(draft.baseUrl, draft.kind);
              update({ baseUrl, ...(changed ? { apiKeyEnv: '' } : {}) });
              if (changed) { setApiKey(''); setClearApiKey(!!existing?.credentialConfigured); setCredentialHostChanged(true); }
            }} /><small>Use your provider’s API base URL, or leave blank for the provider default. Local endpoints support HTTP.</small></label>
            {credentialHostChanged && <p className="agent-field-wide agent-credential-host-note">The API endpoint changed. Enter credentials for this endpoint; the previous session key and environment mapping will not be reused.</p>}
            <label className="agent-field-wide"><span>API key environment variable <small>Recommended for reuse</small></span><input value={draft.apiKeyEnv ?? ''} placeholder={draft.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} pattern="[A-Za-z_][A-Za-z0-9_]*" autoComplete="off" spellCheck={false} onChange={event => update({ apiKeyEnv: event.target.value })} /><small>Name an environment variable available to the Canvagent server.</small></label>
            <label className="agent-field-wide"><span>{existing?.credentialConfigured ? 'Replace API key' : 'API key'} <small>Optional</small></span><input type="password" value={apiKey} autoComplete="new-password" spellCheck={false} placeholder={clearApiKey ? 'Session key will be cleared when you save' : existing?.credentialConfigured ? 'A key is configured · leave blank to keep it' : 'Paste a key for this server session'} onChange={event => { setApiKey(event.target.value); setClearApiKey(false); setError(''); setStatus(''); }} /><small>Pasted keys stay in server memory until it restarts. They are never saved to workspace files or browser storage. Use an environment variable for reuse.</small></label>
            {existing?.credentialConfigured && <div className="agent-field-wide agent-credential-clear"><button type="button" onClick={() => { setClearApiKey(value => !value); setApiKey(''); }}>{clearApiKey ? 'Keep session key' : 'Clear session key'}</button>{clearApiKey && <small>The session key will be cleared when you save. An environment variable, if configured, remains available.</small>}</div>}
          </>}
        </fieldset>
        {error && <p className="agent-manager-error" role="alert">{error}</p>}
        {status && <p className="agent-manager-status" role="status">{status}</p>}
        <div className="agent-manager-form-footer">{existing && <button type="button" className="agent-manager-remove" disabled={saving} onClick={() => void remove()}>{existing.builtin ? 'Reset configuration' : 'Remove agent'}</button>}<button className="button-dark" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save agent'}</button></div>
      </form>
    </div>
  </dialog>;
}

export function AgentPicker(props: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = props.agents.find(agent => agent.id === props.activeAgentId) ?? props.agents[0];
  const disabled = props.disabled || selecting;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const select = async (id: string) => {
    if (disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (id === props.activeAgentId) return;
    setSelecting(true);
    try { await props.onSelect(id); }
    catch (cause) { props.onError(errorMessage(cause)); }
    finally { setSelecting(false); }
  };
  return <div className="agent-picker" ref={rootRef} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menu"] button:not(:disabled)') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length]?.focus();
    }
  }}>
    <button ref={triggerRef} type="button" className="agent-picker-trigger" aria-label={`Choose agent: ${selected?.name ?? 'Loading agents'}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled || !selected} title={props.disabled ? 'Choose an agent when the current turn has finished' : 'Choose the agent for this conversation'} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus()); } }}><Icon name={selected?.kind === 'openai-compatible' || selected?.kind === 'anthropic' ? 'spark' : 'terminal'} size={14} /><strong>{selected?.name ?? 'Loading agents'}</strong><Icon name="chevron" size={12} /></button>
    {open && <div className="agent-picker-menu" role="menu" aria-label="Choose an agent"><div className="agent-picker-heading">Use your preferred agent</div>{props.agents.map(agent => <button type="button" key={agent.id} role="menuitemradio" aria-checked={agent.id === props.activeAgentId} className="agent-picker-option" onClick={() => void select(agent.id)}><span className="agent-provider-icon"><Icon name={agent.kind === 'acp' || agent.kind === 'codex' ? 'terminal' : 'spark'} size={16} /></span><span className="agent-option-text"><strong>{agent.name}<small>{kindLabel(agent.kind)}</small></strong><span>{agent.description ?? (agent.kind === 'acp' ? 'Your installed ACP harness' : 'Your configured model provider')}</span></span>{agent.id === props.activeAgentId && <Icon name="check" size={15} />}</button>)}<p className="agent-picker-note">{props.hasMessages ? 'Choosing another agent starts a new conversation. This conversation stays in your history.' : 'Your agent connects automatically when selected.'}</p><button type="button" role="menuitem" className="agent-picker-manage" onClick={() => { setOpen(false); setManaging(true); }}><Icon name="settings" size={15} />Manage agents<Icon name="arrow-right" size={14} /></button></div>}
    {managing && createPortal(<AgentManager agents={props.agents} activeAgentId={props.activeAgentId} onSave={props.onSave} onRemove={props.onRemove} onClose={() => { setManaging(false); requestAnimationFrame(() => triggerRef.current?.focus()); }} />, document.body)}
  </div>;
}
