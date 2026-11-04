/** A tiny MCP stdio proxy used by OpenCode's ACP session configuration. */
export const SPARKY_MCP_STDIO_BRIDGE = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const endpoint = process.env.SPARKY_MCP_ENDPOINT;
const token = process.env.SPARKY_MCP_TOKEN;
let sessionId;
let serial = 0;
let requestQueue = Promise.resolve();
function rpc(method, params, notify = false) {
  const task = requestQueue.then(() => rpcOnce(method, params, notify));
  requestQueue = task.then(() => undefined, () => undefined);
  return task;
}
async function rpcOnce(method, params, notify = false) {
  const id = ++serial;
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (token) headers.authorization = 'Bearer ' + token;
  const response = await fetch(endpoint, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(20000), body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) });
  sessionId = response.headers.get('mcp-session-id') || sessionId;
  if (notify || response.status === 202 || response.status === 204) return undefined;
  if (!response.ok) throw new Error('Sparky MCP returned HTTP ' + response.status);
  let text;
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) { const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const boundary = buffer.search(/\r?\n\r?\n/); if (boundary >= 0) { text = buffer.slice(0, boundary).split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'); break; } if (done) break; }
    await reader.cancel().catch(() => {});
  } else text = await response.text();
  if (!text) throw new Error('Sparky MCP returned an empty response');
  const result = JSON.parse(text);
  if (result.error) throw new Error(result.error.message || 'Sparky MCP request failed');
  return result.result;
}
async function handle(message) {
  try {
    let result;
    if (message.method === 'initialize') {
      const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'OpenCode via Sparky', version: '1.0.0' } });
      await rpc('notifications/initialized', undefined, true);
      result = initialized;
    } else if (message.method === 'notifications/initialized' || message.method?.startsWith('notifications/')) return;
    else if (message.method === 'tools/list' || message.method === 'prompts/list' || message.method === 'resources/list' || message.method === 'resources/templates/list') result = await rpc(message.method, message.params || {});
    else if (message.method === 'tools/call' || message.method === 'prompts/get' || message.method === 'resources/read') result = await rpc(message.method, message.params || {});
    else throw new Error('Unsupported MCP method: ' + message.method);
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result ?? {} }) + '\n');
  } catch (error) {
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }) + '\n');
  }
}
rl.on('line', (line) => { try { void handle(JSON.parse(line)); } catch {} });
`;
