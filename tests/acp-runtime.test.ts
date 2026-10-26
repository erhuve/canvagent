import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AcpRuntime } from '../src/server/acp-runtime.js';
import type { AgentDefinition } from '../src/shared/agents.js';
import type { RuntimeEvent, RuntimeOptions } from '../src/server/runtime.js';

const fakeAgent = String.raw`
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');
const send = frame => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n');
const reply = (request,result) => send({id:request.id,result});
let initialize, opened, prompt;
const update = update => send({method:'session/update',params:{sessionId:'session-1',update}});
const text = text => update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);
 if(!request.method) {
   text(JSON.stringify(request));
   reply(prompt,{stopReason:'end_turn'});
   return;
 }
 switch(request.method) {
 case 'initialize': initialize=request.params; reply(request,{protocolVersion:fixture.version??1,agentInfo:{version:'test'},agentCapabilities:{loadSession:!!fixture.load,mcpCapabilities:{http:!!fixture.http},...(fixture.image!==undefined?{promptCapabilities:{image:fixture.image}}:{})},authMethods:[]}); break;
 case 'session/new': case 'session/load':
   if(fixture.authError) {send({id:request.id,error:{code:-32000,message:'Secret reflected: '+fixture.authError}});break;}
   opened=request.params;
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Replayed existing transcript'}});
   reply(request,request.method==='session/new'?{sessionId:'session-1'}:{});break;
 case 'session/prompt': {
   prompt=request;
   const input=request.params.prompt.at(-1).text;
   if(fixture.inspectPrompt) {text(JSON.stringify(request.params));reply(request,{stopReason:'end_turn'});break;}
   if(input==='inspect') {text(JSON.stringify({initialize,opened,environment:process.env.CANVAGENT_TEST_TARGET}));reply(request,{stopReason:'end_turn'});}
   if(input==='work') {
     update({sessionUpdate:'tool_call',toolCallId:'call-1',title:'Reading files',status:'pending'});
     update({sessionUpdate:'tool_call_update',toolCallId:'call-1',status:'completed',content:[{type:'content',content:{type:'text',text:'File contents'}}]});
     text('Hello ');text('world');
   }
   if(input==='permission') send({id:0,method:'session/request_permission',params:{sessionId:'session-1',toolCall:{toolCallId:'call-2',title:'Edit file'},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
   if(input==='unsupported') send({id:'terminal',method:'terminal/create',params:{sessionId:'session-1',command:'echo forbidden'}});
   if(input==='bridge') {
     const server=opened.mcpServers[0];
     const child=spawn(server.command,server.args,{env:{...process.env,...Object.fromEntries(server.env.map(entry=>[entry.name,entry.value]))},stdio:['pipe','pipe','ignore']});
     const lines=createInterface({input:child.stdout});
     lines.on('line',line=>{
       const response=JSON.parse(line);
       if(response.id===1) child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');
       if(response.id===2) child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_canvas',arguments:{}}})+'\n');
       if(response.id===3) {text(JSON.stringify(response));child.stdin.end();reply(request,{stopReason:'end_turn'});}
     });
     process.on('exit',()=>child.kill());
     child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fake',version:'1'}}})+'\n');
   }
   break;
 }
 case 'session/cancel': reply(prompt,{stopReason:'cancelled'});break;
 default: send({id:request.id,error:{code:-32601,message:'Unknown method'}});
 }
});
`;

function fixture(configuration: Record<string, unknown> = {}, overrides: Partial<RuntimeOptions> & { agent?: AgentDefinition } = {}) {
  const events: RuntimeEvent[] = [];
  const approvals: any[] = [];
  const runtime = new AcpRuntime({
    cwd: process.cwd(), requestTimeoutMs: 2_000,
    agent: { id: 'test', name: 'Test ACP', kind: 'acp', command: process.execPath, args: ['-e', `const fixture=${JSON.stringify(configuration)};\n${fakeAgent}`] },
    onEvent: event => events.push(event), onApproval: request => approvals.push(request),
    onTool: async () => ({ success: true, contentItems: [] }),
    ...overrides,
  });
  return { runtime, events, approvals };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for ACP fixture.');
}
const event = (events: RuntimeEvent[], type: string) => waitFor(() => events.find(event => event.type === type));

test('ACP negotiates v1 and HTTP canvas MCP without unsupported client capabilities', async t => {
  const { runtime, events } = fixture({ http: true }, { canvasMcp: { url: () => 'http://127.0.0.1:4317/mcp/session', token: 'scoped-token' } });
  t.after(() => runtime.close());
  const connection = await runtime.connect();
  assert.equal(connection.capabilities.canvasTools, true);
  assert.equal(connection.capabilities.steering, false);
  await runtime.open();
  assert.equal(events.some(event => event.type === 'item/agentMessage/delta'), false);
  await runtime.start('inspect');
  const inspection = JSON.parse((await event(events, 'item/agentMessage/delta')).payload.delta);
  assert.equal(inspection.initialize.protocolVersion, 1);
  assert.deepEqual(inspection.initialize.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(inspection.opened.mcpServers, [{ type: 'http', name: 'canvagent_canvas', url: 'http://127.0.0.1:4317/mcp/session', headers: [{ name: 'Authorization', value: 'Bearer scoped-token' }] }]);
  await event(events, 'turn/completed');
});

test('ACP forwards message chunks, tool activity and confirmed cancellation', async t => {
  const { runtime, events } = fixture();
  t.after(() => runtime.close());
  await runtime.connect(); await runtime.open();
  const id = await runtime.start('work');
  await waitFor(() => events.filter(event => event.type === 'item/agentMessage/delta').length === 2 ? true : undefined);
  assert.equal(events.filter(event => event.type === 'item/agentMessage/delta').map(event => event.payload.delta).join(''), 'Hello world');
  assert.equal((await event(events, 'item/completed')).payload.item.output, 'File contents');
  await assert.rejects(runtime.steer('update', id), /does not support steering/);
  await assert.rejects(runtime.start('duplicate'), /already active/);
  await runtime.interrupt(id);
  assert.equal(runtime.activeTurnId, id);
  assert.equal((await event(events, 'turn/completed')).payload.turn.status, 'interrupted');
  assert.equal(runtime.activeTurnId, null);
});

test('ACP sends image blocks only after negotiated support and supports image-only prompts', async t => {
  const images = [{ url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png', name: 'Screenshot.png' }];
  for (const text of ['Inspect this screenshot', '']) {
    const { runtime, events } = fixture({ image: true, inspectPrompt: true }, { developerInstructions: 'Use the current workspace.' });
    t.after(() => runtime.close());
    assert.equal((await runtime.connect()).capabilities.imageInput, true);
    await runtime.open(); await runtime.start(text, 'image-message', images);
    const submitted = JSON.parse((await event(events, 'item/agentMessage/delta')).payload.delta);
    assert.deepEqual(submitted, { sessionId: 'session-1', prompt: [
      { type: 'text', text: '[Canvagent instructions]\nUse the current workspace.' },
      ...(text ? [{ type: 'text', text }] : []),
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ] });
    await event(events, 'turn/completed');
  }
});

test('ACP missing or false image capability rejects attachments before a turn starts', async t => {
  for (const image of [undefined, false]) {
    const { runtime, events } = fixture(image === undefined ? {} : { image });
    t.after(() => runtime.close());
    assert.equal((await runtime.connect()).capabilities.imageInput, false);
    await runtime.open();
    await assert.rejects(runtime.start('Inspect', 'unsupported-image', [{ url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' }]), /does not support image attachments/);
    assert.equal(runtime.activeTurnId, null);
    assert.equal(events.some(event => event.type === 'turn/started'), false);
    assert.equal(JSON.stringify(events).includes('aGVsbG8='), false);
    await runtime.start('inspect');
    await event(events, 'turn/completed');
  }
});

test('ACP permissions preserve option IDs and reject unadvertised or duplicate answers', async t => {
  const { runtime, events, approvals } = fixture();
  t.after(() => runtime.close());
  await runtime.connect(); await runtime.open(); await runtime.start('permission');
  const approval = await waitFor(() => approvals[0]);
  assert.equal(approval.id, 0);
  assert.equal(approval.method, 'acp/request_permission');
  assert.deepEqual(approval.params.availableDecisions, ['allow-once', 'deny']);
  assert.throws(() => runtime.answer(0, { decision: 'accept' }), /advertised/);
  runtime.answer(0, { decision: 'deny' });
  assert.throws(() => runtime.answer(0, { decision: 'deny' }), /no longer pending/);
  const response = JSON.parse((await event(events, 'item/agentMessage/delta')).payload.delta);
  assert.deepEqual(response.result, { outcome: { outcome: 'selected', optionId: 'deny' } });
});

test('ACP cancellation answers pending permissions with the cancelled outcome', async t => {
  const { runtime, events, approvals } = fixture();
  t.after(() => runtime.close());
  await runtime.connect(); await runtime.open(); const id = await runtime.start('permission');
  await waitFor(() => approvals[0]);
  await runtime.interrupt(id);
  const response = JSON.parse((await event(events, 'item/agentMessage/delta')).payload.delta);
  assert.deepEqual(response.result, { outcome: { outcome: 'cancelled' } });
  assert.throws(() => runtime.answer(0, { decision: 'allow-once' }), /no longer pending/);
});

test('ACP fails closed on unsupported terminal requests', async t => {
  const { runtime, events } = fixture();
  t.after(() => runtime.close());
  await runtime.connect(); await runtime.open(); await runtime.start('unsupported');
  const response = JSON.parse((await event(events, 'item/agentMessage/delta')).payload.delta);
  assert.equal(response.id, 'terminal');
  assert.equal(response.error.code, -32601);
});

test('ACP resumes only when loadSession is advertised and suppresses replay duplicates', async t => {
  const unsupported = fixture(); const supported = fixture({ load: true });
  t.after(() => { unsupported.runtime.close(); supported.runtime.close(); });
  await unsupported.runtime.connect();
  await assert.rejects(unsupported.runtime.open('saved-session'), /cannot resume/);
  await supported.runtime.connect();
  assert.equal(await supported.runtime.open('session-1'), 'session-1');
  assert.equal(supported.events.some(event => event.type === 'item/agentMessage/delta'), false);
  await supported.runtime.start('inspect');
  const inspection = JSON.parse((await event(supported.events, 'item/agentMessage/delta')).payload.delta);
  assert.equal(inspection.opened.sessionId, 'session-1');
});

test('ACP rejects unsupported protocol versions and never reflects harness secrets from errors', async t => {
  const wrong = fixture({ version: 99 }); const rejected = fixture({ authError: 'private-credential' });
  t.after(() => { wrong.runtime.close(); rejected.runtime.close(); });
  await assert.rejects(wrong.runtime.connect(), /supported ACP protocol version/);
  await rejected.runtime.connect();
  await assert.rejects(rejected.runtime.open(), error => error instanceof Error && /login/.test(error.message) && !error.message.includes('private-credential'));
  assert.equal(rejected.events.find(event => event.type === 'runtime.error')?.payload.authenticationRequired, true);
  assert.equal(JSON.stringify(rejected.events).includes('private-credential'), false);
});

test('ACP stdio MCP fallback discovers and calls tools through the scoped HTTP endpoint', async t => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const frame = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ frame, authorization: req.headers.authorization, protocolVersion: req.headers['mcp-protocol-version'] });
    if (!frame.id) { res.writeHead(202); res.end(); return; }
    const result = frame.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'canvas', version: '1' } }
      : frame.method === 'tools/list' ? { tools: [{ name: 'read_canvas', description: 'Read', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'Board revision 8' }] };
    if (frame.method === 'tools/call') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n\n`); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { runtime, events } = fixture({}, { canvasMcp: { url: () => `http://127.0.0.1:${address.port}/mcp/session`, token: 'bridge-token' } });
  t.after(async () => { runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  assert.equal((await runtime.connect()).capabilities.canvasTools, true);
  await runtime.open(); await runtime.start('bridge');
  const response = JSON.parse((await event(events, 'item/agentMessage/delta')).payload.delta);
  assert.equal(response.result.content[0].text, 'Board revision 8');
  assert.ok(requests.every(request => request.authorization === 'Bearer bridge-token'));
  assert.equal(requests.find(request => request.frame.method === 'tools/call').protocolVersion, '2025-03-26');
});
