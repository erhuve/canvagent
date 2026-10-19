import assert from "node:assert/strict";
import test from "node:test";
import { CodexRuntime, RuntimeRequestError, type RuntimeEvent, type RuntimeOptions } from "../src/server/runtime.js";

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
  case 'model/list':
   reply(request,request.params.cursor
    ? {data:[{id:'second',model:'model-second',displayName:'Second model'}],nextCursor:null}
    : {data:[{id:'first',model:'model-first',displayName:'First model'}],nextCursor:'page2'}); break;
  case 'thread/start':
   send({method:'test/thread-params',params:request.params});
   reply(request,{thread:{id:'thread-1',turns:[]}}); break;
  case 'thread/resume':
   send({method:'test/resume-params',params:request.params});
   reply(request,{thread:{id:request.params.threadId,turns:active?[turn()]:[]}}); break;
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
