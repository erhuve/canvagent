import assert from "node:assert/strict";
import test from "node:test";
import { CodexRuntime, RuntimeRequestError, type RuntimeEvent, type RuntimeOptions } from "../src/server/runtime.js";
import { defaultAgentSettings, type AgentSettings } from '../src/shared/settings.js';

// A real subprocess exercises framing, request correlation, and disconnects without
// depending on authentication or making paid model requests in the test suite.
const fakeServer = String.raw`
const { createInterface } = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (request, result) => send({id:request.id,result});
let active = null;
const turn = (status='inProgress') => ({id:'turn-1',status,items:[],error:null});
const finish = status => { active = null; send({method:'turn/completed',params:{threadId:'thread-1',turn:turn(status)}}); };
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (!request.method) {
   send({method:'test/client-response',params:request});
   return;
 }
 switch(request.method) {
  case 'initialize':
   send({method:'test/initialize',params:request.params});
   reply(request,{userAgent:'fake-codex/0.159.2'}); break;
  case 'initialized': break;
  case 'account/read': reply(request,{account:{type:'chatgpt'},requiresOpenaiAuth:true}); break;
  case 'config/read':
  case 'configRequirements/read': {
   if(typeof settingsFixture==='undefined') { send({id:request.id,error:{code:-32601,message:'Unknown fake method'}}); break; }
   const key=request.method==='config/read'?'config':'requirements';
   send({method:'test/'+request.method,params:request.params});
   if(settingsFixture[key+'Error']) send({id:request.id,error:settingsFixture[key+'Error']});
   else reply(request,key==='config'?{config:settingsFixture.config??{}}:{requirements:settingsFixture.requirements??null});
   break;
  }
  case 'model/list':
   reply(request,typeof settingsFixture!=='undefined'&&settingsFixture.models?{data:settingsFixture.models,nextCursor:null}:request.params.cursor
    ? {data:[{id:'second',model:'model-second',displayName:'Second model'}],nextCursor:null}
    : {data:[{id:'first',model:'model-first',displayName:'First model'}],nextCursor:'page2'}); break;
  case 'thread/start':
   send({method:'test/thread-params',params:request.params});
   reply(request,{...(typeof settingsFixture!=='undefined'?settingsFixture.threadResult??{}:{}),thread:{id:'thread-1',turns:[]}}); break;
  case 'thread/resume':
   send({method:'test/resume-params',params:request.params});
   reply(request,{...(typeof settingsFixture!=='undefined'?settingsFixture.threadResult??{}:{}),thread:{id:request.params.threadId,turns:active?[turn()]:[]}}); break;
  case 'mcpServerStatus/list':
   send({method:'test/mcp-status-params',params:request.params});
   reply(request,{data:[{name:'canvagent_canvas',tools:{read_canvas:{name:'read_canvas'}},toolsError:null}],nextCursor:null}); break;
  case 'turn/start': {
   const text=request.params.input[0].text;
   send({method:'test/start-params',params:request.params});
   if(text==='timeout') break;
   if(text==='crash') { process.exit(3); break; }
   if(text==='rejected') { send({id:request.id,error:{code:-32000,message:'Known rejection'}}); break; }
   active='turn-1';
   send({method:'turn/started',params:{threadId:'thread-1',turn:turn()}});
   if(text==='fast') finish('completed');
   reply(request,{turn:turn()});
   if(text==='tool') send({id:'tool-request',method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'call-1',namespace:null,tool:'read_canvas',arguments:{boardId:'board-1'}}});
   if(text==='approval') send({id:0,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'command-1',command:'pwd'}});
   break;
  }
  case 'turn/steer':
   send({method:'test/steer-params',params:request.params});
   reply(request,{turnId:active}); break;
  case 'turn/interrupt':
   reply(request,{});
   setTimeout(()=>finish('interrupted'),30); break;
  default: send({id:request.id,error:{code:-32601,message:'Unknown fake method'}});
 }
});
`;

function fixture(overrides: Partial<RuntimeOptions> = {}) {
  const events: RuntimeEvent[] = [];
  const runtime = new CodexRuntime({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", fakeServer],
    tools: [{ name: "read_canvas", description: "Read board", inputSchema: { type: "object", properties: {} } }],
    requestTimeoutMs: 1_000,
    onEvent: (event) => events.push(event),
    onApproval: () => {},
    onTool: async () => ({ success: true, contentItems: [] }),
    ...overrides,
  });
  return { runtime, events };
}

function settingsFixture(metadata: Record<string, unknown>, overrides: Partial<RuntimeOptions> = {}) {
  return fixture({ args: ['-e', `const settingsFixture=${JSON.stringify(metadata)};\n${fakeServer}`], ...overrides });
}

async function waitFor(events: RuntimeEvent[], type: string): Promise<RuntimeEvent> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = events.find((event) => event.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Did not receive ${type}`);
}

test("initializes experimental protocol, paginates models, and binds native canvas tools", async (t) => {
  const { runtime, events } = fixture();
  t.after(() => runtime.close());
  const connection = await runtime.connect();
  assert.equal(connection.authenticated, true);
  assert.deepEqual(connection.models, [
    { id: "model-first", name: "First model" },
    { id: "model-second", name: "Second model" },
  ]);
  assert.equal((await waitFor(events, "test/initialize")).payload.capabilities.experimentalApi, true);
  assert.equal(await runtime.open(), "thread-1");
  const parameters = (await waitFor(events, "test/thread-params")).payload;
  assert.equal(parameters.dynamicTools[0].type, "function");
  assert.equal(parameters.dynamicTools[0].name, "read_canvas");
  assert.equal(parameters.sandbox, "workspace-write");
  assert.equal(parameters.approvalPolicy, "on-request");
});

test("steering targets the existing turn and interruption waits for its terminal event", async (t) => {
  const { runtime, events } = fixture();
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  const id = await runtime.start("work", "message-1");
  assert.equal(runtime.activeTurnId, id);
  assert.equal((await waitFor(events, "test/start-params")).payload.clientUserMessageId, "message-1");
  await assert.rejects(runtime.start("duplicate"), /already active/);
  await assert.rejects(runtime.steer("update", "wrong-id"), /no longer active/);
  await runtime.steer("Canvas changed; read its current state", id);
  const steer = (await waitFor(events, "test/steer-params")).payload;
  assert.equal(steer.expectedTurnId, id);
  assert.equal(steer.input[0].type, "text");
  await runtime.interrupt(id);
  assert.equal(runtime.activeTurnId, id);
  await waitFor(events, "turn/completed");
  assert.equal(runtime.activeTurnId, null);
});

test('resuming an existing thread installs current canvas MCP tools without replacing native history', async t => {
  const { runtime, events } = fixture({ canvasMcp: { url: () => 'http://127.0.0.1:4317/mcp/saved-conversation', token: 'local-test-token' } });
  t.after(() => runtime.close());
  await runtime.connect();
  const savedThread = 'existing-native-thread';
  assert.equal(await runtime.open(savedThread), savedThread);
  const params = (await waitFor(events, 'test/resume-params')).payload;
  assert.equal(params.threadId, savedThread);
  assert.equal(params.history, undefined);
  assert.equal(params.dynamicTools, undefined);
  assert.deepEqual(params.config['mcp_servers.canvagent_canvas'], {
    url: 'http://127.0.0.1:4317/mcp/saved-conversation', bearer_token_env_var: 'CANVAGENT_CANVAS_MCP_TOKEN', required: true, startup_timeout_sec: 10, tool_timeout_sec: 30,
  });
  assert.equal(JSON.stringify(params).includes('local-test-token'), false);
  assert.equal(events.some(event => event.type === 'test/thread-params'), false);
  assert.equal((await waitFor(events, 'test/mcp-status-params')).payload.threadId, savedThread);
  assert.deepEqual((await waitFor(events, 'canvas_tools.ready')).payload, { threadId: savedThread, resumed: true });
  await runtime.start('Continue our existing work');
  assert.equal((await waitFor(events, 'test/start-params')).payload.threadId, savedThread);
});

test('new threads use the refreshable canvas connection and verify its tools before starting work', async t => {
  const { runtime, events } = fixture({ canvasMcp: { url: () => 'http://127.0.0.1:4317/mcp/new-conversation', token: 'token' } });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  const params = (await waitFor(events, 'test/thread-params')).payload;
  assert.equal(params.dynamicTools, undefined);
  assert.equal(params.config['mcp_servers.canvagent_canvas'].url, 'http://127.0.0.1:4317/mcp/new-conversation');
  assert.deepEqual((await waitFor(events, 'canvas_tools.ready')).payload, { threadId: 'thread-1', resumed: false });
});

test('missing upgraded tools retain the old thread binding and do not silently start a replacement', async t => {
  const { runtime, events } = fixture({ canvasMcp: { url: () => 'http://127.0.0.1:4317/mcp/existing', token: 'token' },
    tools: [{ name: 'apply_canvas_ops', description: 'Current drawing tools', inputSchema: { type: 'object' } }],
  });
  t.after(() => runtime.close());
  await runtime.connect();
  await assert.rejects(runtime.open('original-thread'), /current canvas tools could not be loaded/);
  assert.equal(runtime.threadId, 'original-thread');
  await assert.rejects(runtime.start('Do not continue without tools'), /current canvas tools/);
  assert.equal(events.some(event => event.type === 'test/thread-params' || event.type === 'test/start-params'), false);
});

test("canvas tool responses preserve native text and image output", async (t) => {
  let toolArguments: unknown;
  const output = {
    success: true,
    contentItems: [
      { type: "inputText", text: "Board at revision 3" },
      { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
    ],
  };
  const { runtime, events } = fixture({ onTool: async (name, args) => {
    assert.equal(name, "read_canvas");
    toolArguments = args;
    return output;
  } });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  await runtime.start("tool");
  const response = (await waitFor(events, "test/client-response")).payload;
  assert.equal(response.id, "tool-request");
  assert.deepEqual(response.result, output);
  assert.deepEqual(toolArguments, { boardId: "board-1" });
});

test("failed canvas tools return a structured failure without interrupting ordinary work", async (t) => {
  const { runtime, events } = fixture({ onTool: async () => { throw new Error("Board unavailable"); } });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  await runtime.start("tool");
  const response = (await waitFor(events, "test/client-response")).payload;
  assert.equal(response.result.success, false);
  assert.match(response.result.contentItems[0].text, /Board unavailable/);
  assert.equal(runtime.activeTurnId, "turn-1");
});

test("approval responses keep exact RPC identity and cannot be answered twice", async (t) => {
  const approvals: any[] = [];
  const { runtime, events } = fixture({ onApproval: (request) => approvals.push(request) });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  await runtime.start("approval");
  // The request is sent after the start response in the same stdout chunk.
  while (!approvals.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(approvals[0].id, 0);
  assert.equal(approvals[0].method, "item/commandExecution/requestApproval");
  runtime.answer(0, { decision: "decline" });
  const response = (await waitFor(events, "test/client-response")).payload;
  assert.deepEqual(response, { id: 0, result: { decision: "decline" } });
  assert.throws(() => runtime.answer(0, { decision: "accept" }), /no longer pending/);
});

test("completion preceding turn/start response does not resurrect a finished turn", async (t) => {
  const { runtime } = fixture();
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  assert.equal(await runtime.start("fast"), "turn-1");
  assert.equal(runtime.activeTurnId, null);
});

test("a timed-out submission is not resent and blocks another submission until resume", async (t) => {
  const { runtime, events } = fixture({ requestTimeoutMs: 100 });
  t.after(() => runtime.close());
  await runtime.connect();
  const thread = await runtime.open();
  await assert.rejects(runtime.start("timeout"), (error) => error instanceof RuntimeRequestError && error.uncertain);
  await assert.rejects(runtime.start("retry"), /outcome is unknown/);
  assert.equal(events.filter((event) => event.type === "test/start-params").length, 1);
  await runtime.open(thread);
  assert.equal((await waitFor(events, "test/resume-params")).payload.threadId, thread);
  await runtime.start("work");
});

test("subprocess loss rejects in-flight requests and preserves an explicit uncertain outcome", async (t) => {
  const { runtime, events } = fixture();
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  await assert.rejects(runtime.start("crash"), (error) => error instanceof RuntimeRequestError && error.uncertain);
  const disconnected = events.find((event) => event.type === "connection.changed" && event.payload.state === "disconnected");
  assert.equal(disconnected?.payload.intentional, false);
  await assert.rejects(runtime.start("retry"), /Connect to Codex first/);
});

test('connection metadata preserves catalog capabilities and exposes only safe configuration defaults', async t => {
  const model = {
    id: 'catalog-entry', model: 'codex-model', displayName: 'Codex Model', description: 'Model description', isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Proactive work' }, { reasoningEffort: 'high', description: 'Deep thinking' }],
    defaultReasoningEffort: 'high', serviceTiers: [{ id: 'default', name: 'Standard', description: 'Regular speed' }, { id: 'priority', name: 'Fast', description: 'Lower latency' }], defaultServiceTier: 'priority',
    providerApiKey: 'private-model-value',
  };
  const { runtime, events } = settingsFixture({
    models: [model], config: {
      model: 'codex-model', model_reasoning_effort: 'high', service_tier: 'priority', model_reasoning_summary: 'concise', model_verbosity: 'low',
      approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write', web_search: 'indexed',
      sandbox_workspace_write: { network_access: true, writable_roots: ['/private/tmp/shared'] },
      model_providers: { private: { api_key: 'private-config-value' } }, mcp_servers: { private: { bearer_token: 'private-token' } },
      developer_instructions: 'private-instruction',
    },
    requirements: {
      allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user', 'auto_review'], allowedSandboxModes: ['read-only', 'workspace-write'], allowedWebSearchModes: ['disabled', 'indexed'],
      modelProviders: { private: { api_key: 'private-requirements-value' } },
    },
  });
  t.after(() => runtime.close());
  const connection = await runtime.connect();
  assert.deepEqual(connection.models, [{
    id: 'codex-model', name: model.displayName, description: model.description, isDefault: true,
    supportedReasoningEfforts: model.supportedReasoningEfforts, defaultReasoningEffort: 'high', serviceTiers: model.serviceTiers, defaultServiceTier: 'priority',
  }]);
  assert.deepEqual(connection.defaults, {
    model: 'codex-model', reasoningEffort: 'high', serviceTier: 'priority', reasoningSummary: 'concise', verbosity: 'low',
    approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxMode: 'workspace-write', webSearch: 'indexed',
    networkAccess: true, writableRoots: ['/private/tmp/shared'],
  });
  assert.deepEqual(connection.requirements, {
    allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user', 'auto_review'], allowedSandboxModes: ['read-only', 'workspace-write'], allowedWebSearchModes: ['disabled', 'indexed'],
  });
  assert.deepEqual((await waitFor(events, 'test/config/read')).payload, { cwd: process.cwd(), includeLayers: false });
  assert.equal(JSON.stringify({ connection, events }).includes('private-'), false);
});

test('native settings reach new and resumed threads and remain fixed for the opened turn', async t => {
  let settings: AgentSettings = {
    ...defaultAgentSettings(), model: 'chosen-model', reasoningEffort: 'ultra', serviceTier: 'priority', approvalPolicy: 'never', approvalsReviewer: 'auto_review',
    sandboxMode: 'workspace-write', networkAccess: true, writableRoots: ['/private/tmp/extra'], webSearch: 'live', reasoningSummary: 'detailed', verbosity: 'high', collaborationMode: 'plan',
    additionalInstructions: 'Follow the project conventions.', configOverrides: {
      model: 'wrong-model', service_tier: 'wrong-tier', approval_policy: 'untrusted', sandbox_mode: 'read-only', model_reasoning_effort: 'low',
      sandbox_workspace_write: { network_access: false, writable_roots: ['/wrong'], exclude_slash_tmp: true },
      mcp_servers: { canvagent_canvas: { url: 'http://wrong', required: false }, useful: { command: 'useful-server' } },
      'mcp_servers.canvagent_canvas.url': 'http://also-wrong',
      'mcp_servers.canvagent_canvas.bearer_token_env_var': 'WRONG_TOKEN',
      developer_instructions: 'Remove canvas instructions', 'developer_instructions.invalid': 'Remove canvas instructions', custom_setting: { enabled: true },
    },
  };
  const { runtime, events } = settingsFixture({ threadResult: { model: 'chosen-model', reasoningEffort: 'ultra' } }, {
    settings: () => settings, developerInstructions: 'Use the canvas tools.',
    canvasMcp: { url: () => 'http://127.0.0.1:4317/mcp/real', token: 'secret-local-token' },
  });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  const opened = (await waitFor(events, 'test/thread-params')).payload;
  assert.equal(opened.model, 'chosen-model');
  assert.equal(opened.serviceTier, 'priority');
  assert.equal(opened.approvalPolicy, 'never');
  assert.equal(opened.approvalsReviewer, 'auto_review');
  assert.equal(opened.sandbox, 'workspace-write');
  assert.equal(opened.developerInstructions, 'Use the canvas tools.\n\nFollow the project conventions.');
  assert.equal(opened.config.model_reasoning_effort, 'ultra');
  assert.equal(opened.config.model_reasoning_summary, 'detailed');
  assert.equal(opened.config.model_verbosity, 'high');
  assert.equal(opened.config.web_search, 'live');
  assert.equal(opened.config['sandbox_workspace_write.network_access'], true);
  assert.deepEqual(opened.config['sandbox_workspace_write.writable_roots'], ['/private/tmp/extra']);
  assert.equal(opened.config['sandbox_workspace_write.exclude_slash_tmp'], true);
  assert.deepEqual(opened.config.custom_setting, { enabled: true });
  assert.deepEqual(opened.config['mcp_servers.useful'], { command: 'useful-server' });
  assert.deepEqual(opened.config['mcp_servers.canvagent_canvas'], {
    url: 'http://127.0.0.1:4317/mcp/real', bearer_token_env_var: 'CANVAGENT_CANVAS_MCP_TOKEN', required: true, startup_timeout_sec: 10, tool_timeout_sec: 30,
  });
  assert.equal(JSON.stringify(opened).includes('wrong'), false);
  assert.equal(JSON.stringify(opened).includes('Remove canvas instructions'), false);
  assert.equal(JSON.stringify(opened).includes('secret-local-token'), false);
  // Mutating the saved object itself cannot change the in-flight settings snapshot.
  settings.model = 'next-model';
  settings.reasoningEffort = 'high';
  settings.writableRoots.push('/private/tmp/next');
  settings.collaborationMode = 'default';
  await runtime.start('fast');
  const started = (await waitFor(events, 'test/start-params')).payload;
  assert.equal(started.model, 'chosen-model');
  assert.equal(started.effort, 'ultra');
  assert.equal(started.summary, 'detailed');
  assert.equal(started.serviceTier, 'priority');
  assert.deepEqual(started.collaborationMode, { mode: 'plan', settings: { model: 'chosen-model', reasoning_effort: 'ultra', developer_instructions: null } });
  assert.deepEqual(started.sandboxPolicy, { type: 'workspaceWrite', networkAccess: true, writableRoots: ['/private/tmp/extra'], excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  settings = { ...defaultAgentSettings(), model: 'next-model', serviceTier: 'default', collaborationMode: 'default' };
  await runtime.open('thread-1');
  const resumed = (await waitFor(events, 'test/resume-params')).payload;
  assert.equal(resumed.model, 'next-model');
  assert.equal(resumed.serviceTier, 'default');
  assert.equal(resumed.approvalPolicy, 'on-request');
  assert.equal(resumed.config['mcp_servers.canvagent_canvas'].required, true);
});

test('empty model, effort, and speed explicitly restore native defaults when resuming saved settings', async t => {
  const settings: AgentSettings = { ...defaultAgentSettings(), approvalPolicy: '', sandboxMode: '', collaborationMode: 'plan' };
  const { runtime, events } = settingsFixture({
    config: { model: 'native-model', model_reasoning_effort: 'high', service_tier: 'priority' },
    threadResult: { model: 'historical-model', reasoningEffort: 'low', serviceTier: 'default', sandbox: { type: 'readOnly', networkAccess: false } },
  }, { settings: () => settings });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open('saved-thread');
  const opened = (await waitFor(events, 'test/resume-params')).payload;
  assert.equal(opened.model, 'native-model');
  assert.equal(opened.serviceTier, 'priority');
  assert.equal(opened.config.model_reasoning_effort, 'high');
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox']) assert.equal(opened[key], undefined);
  await runtime.start('fast');
  const started = (await waitFor(events, 'test/start-params')).payload;
  assert.equal(started.model, 'native-model');
  assert.equal(started.serviceTier, 'priority');
  assert.equal(started.effort, 'high');
  for (const key of ['summary', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']) assert.equal(started[key], undefined);
  assert.deepEqual(started.collaborationMode, { mode: 'plan', settings: { model: 'native-model', reasoning_effort: 'high', developer_instructions: null } });
  assert.equal(settings.model, '');
  assert.equal(settings.reasoningEffort, '');
  assert.equal(settings.serviceTier, '');
});

test('managed settings violations stop before creating a native thread', async t => {
  const { runtime, events } = settingsFixture({ requirements: { allowedApprovalPolicies: ['on-request'], allowedSandboxModes: ['workspace-write'] } }, {
    settings: () => ({ ...defaultAgentSettings(), approvalPolicy: 'never' }),
  });
  t.after(() => runtime.close());
  await runtime.connect();
  await assert.rejects(runtime.open(), /Approval policy never is blocked/);
  assert.equal(events.some(event => event.type === 'test/thread-params'), false);
});

test('metadata configuration failures remain visible while older missing methods remain compatible', async t => {
  const { runtime } = settingsFixture({ configError: { code: -32000, message: 'Managed configuration is invalid' } });
  t.after(() => runtime.close());
  await assert.rejects(runtime.connect(), /Managed configuration is invalid/);
  const older = fixture();
  t.after(() => older.runtime.close());
  const connection = await older.runtime.connect();
  assert.equal(connection.defaults, undefined);
  assert.equal(connection.requirements, undefined);
});

test('standard speed is available when native catalogs list only optional accelerated tiers', async t => {
  const { runtime, events } = settingsFixture({ models: [
    { model: 'speedy-model', displayName: 'Speedy model', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { model: 'standard-model', displayName: 'Standard model', additionalSpeedTiers: [] },
  ] }, { settings: () => ({ ...defaultAgentSettings(), model: 'speedy-model', serviceTier: 'default' }) });
  t.after(() => runtime.close());
  const connection = await runtime.connect();
  assert.deepEqual(connection.models[0].serviceTiers, [{ id: 'default', name: 'Standard' }, { id: 'priority', name: 'Fast' }]);
  assert.deepEqual(connection.models[1].serviceTiers, [{ id: 'default', name: 'Standard' }]);
  await runtime.open();
  assert.equal((await waitFor(events, 'test/thread-params')).payload.serviceTier, 'default');
});

test('selecting a model replaces incompatible inherited effort and speed with its catalog defaults', async t => {
  const { runtime, events } = settingsFixture({
    models: [{ model: 'narrow-model', displayName: 'Narrow model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Standard' }], defaultReasoningEffort: 'medium', serviceTiers: [], defaultServiceTier: null }],
    config: { model_reasoning_effort: 'ultra', service_tier: 'priority' },
  }, { settings: () => ({ ...defaultAgentSettings(), model: 'narrow-model' }) });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open();
  const opened = (await waitFor(events, 'test/thread-params')).payload;
  assert.equal(opened.config.model_reasoning_effort, 'medium');
  assert.equal(opened.serviceTier, 'default');
});

test('advanced model, effort, and speed overrides take priority over inherited native defaults', async t => {
  const { runtime, events } = settingsFixture({ config: { model: 'global-model', model_reasoning_effort: 'high', service_tier: 'priority' } }, {
    settings: () => ({ ...defaultAgentSettings(), configOverrides: { model: 'advanced-model', model_reasoning_effort: 'medium', service_tier: 'default' } }),
  });
  t.after(() => runtime.close());
  await runtime.connect();
  await runtime.open('saved-thread');
  const opened = (await waitFor(events, 'test/resume-params')).payload;
  assert.equal(opened.model, 'advanced-model');
  assert.equal(opened.serviceTier, 'default');
  assert.equal(opened.config.model_reasoning_effort, 'medium');
});

test('native Fast aliases resolve to the catalog tier for inherited, explicit, and advanced settings', async t => {
  for (const selection of [{}, { serviceTier: 'fast' }, { configOverrides: { service_tier: 'fast' } }]) {
    const { runtime, events } = settingsFixture({
      models: [{ model: 'fast-model', displayName: 'Fast model', serviceTiers: [{ id: 'priority', name: 'Fast' }] }],
      config: { model: 'fast-model', service_tier: 'fast' },
      threadResult: { model: 'fast-model', serviceTier: 'default' },
    }, { settings: () => ({ ...defaultAgentSettings(), ...selection }) });
    t.after(() => runtime.close());
    await runtime.connect();
    await runtime.open('saved-thread');
    assert.equal((await waitFor(events, 'test/resume-params')).payload.serviceTier, 'priority');
    await runtime.start('fast');
    assert.equal((await waitFor(events, 'test/start-params')).payload.serviceTier, 'priority');
    runtime.close();
  }
});
