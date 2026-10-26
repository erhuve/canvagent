/** Self-contained Node source so the desktop's bundled server can offer a stdio
 * MCP server without shipping a second entrypoint or resolving an external CLI. */
export const canvasMcpBridgeSource = String.raw`
const { createInterface } = require('node:readline');
const endpoint = process.env.CANVAGENT_CANVAS_MCP_URL;
const token = process.env.CANVAGENT_CANVAS_MCP_TOKEN;
let protocolVersion;
const write = message => process.stdout.write(JSON.stringify(message) + '\n');
const validId = value => typeof value === 'string' || typeof value === 'number';
const fail = id => { if (validId(id)) write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Canvas MCP connection failed.' } }); };
let valid = false;
try {
  const url = new URL(endpoint);
  valid = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !!token;
} catch {}
async function readBody(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 32 * 1024 * 1024) throw new Error();
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks).toString('utf8');
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let frame;
  try { frame = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid MCP JSON.' } }); return; }
  if (!valid || !frame || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') { fail(frame && frame.id); return; }
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token, ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) },
      body: JSON.stringify(frame),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    if (response.status === 202 || response.status === 204) return;
    const body = await readBody(response);
    if (!validId(frame.id)) return;
    const messages = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(row => row.startsWith('data:')).map(row => row.slice(5).trimStart()).join('\n')).filter(Boolean).map(data => JSON.parse(data))
      : [JSON.parse(body)];
    let answered = false;
    for (const message of messages) {
      if (message?.jsonrpc !== '2.0') continue;
      if (message.id === frame.id) { answered = true; if (frame.method === 'initialize' && typeof message.result?.protocolVersion === 'string') protocolVersion = message.result.protocolVersion; write(message); }
      else if (typeof message.method === 'string' && message.id === undefined) write(message);
    }
    if (!answered) throw new Error();
  } catch { fail(frame.id); }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
`;
