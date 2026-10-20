import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createApp } from '../server.mjs';
import { SSEParser } from '../core.mjs';

async function serve(server, t) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function request(base, config) {
  return fetch(base + '/api/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'POST', body: '', headers: [], ...config }) });
}
test('proxy streams compressed UTF-8 SSE, forwards edited body/headers and reports metadata', async t => {
  let actualBody, actualHeader;
  const upstream = await serve(http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); actualBody = Buffer.concat(chunks).toString(); actualHeader = req.headers['x-test'];
    const bytes = gzipSync('data: {"choices":[{"delta":{"content":"你好🧪"}}]}\r\n\r\ndata: [DONE]\n\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' }); res.write(bytes.subarray(0, 7)); setTimeout(() => res.end(bytes.subarray(7)), 15);
  }), t);
  const base = await serve(createApp(), t);
  const res = await request(base, { url: upstream, body: '{"stream":true}', headers: [{ name: 'X-Test', value: 'hello', enabled: true }, { name: 'Host', value: 'fake-host', enabled: true }] });
  const items = (await res.text()).trim().split('\n').map(JSON.parse);
  assert.equal(items[0].type, 'response'); assert.equal(items[0].status, 200); assert.equal(items.at(-1).type, 'done'); assert.equal(actualHeader, 'hello'); assert.equal(actualBody, '{"stream":true}');
  const events = [], parser = new SSEParser(e => events.push(e)); for (const item of items) if (item.type === 'chunk') parser.push(item.text);
  assert.equal(events.length, 2); assert.equal(JSON.parse(events[0].data).choices[0].delta.content, '你好🧪');
});
test('non-SSE errors and redirect responses remain visible, without following redirects', async t => {
  const upstream = await serve(http.createServer((req, res) => { res.writeHead(302, { Location: 'http://must-not-follow.invalid' }); res.end('redirect body'); }), t);
  const base = await serve(createApp(), t); const res = await request(base, { url: upstream });
  const items = (await res.text()).trim().split('\n').map(JSON.parse); assert.equal(items[0].status, 302); assert.equal(items[1].text, 'redirect body'); assert.equal(items.at(-1).type, 'done');
});
test('reject invalid URL, headers, cross-site origin and GET body', async t => {
  const base = await serve(createApp(), t);
  for (const config of [{ url: 'file:///etc/passwd' }, { url: 'http://example.com', method: 'GET', body: 'bad' }, { url: 'http://example.com', headers: [{ name: 'x-test', value: 'a\r\nb', enabled: true }] }]) assert.equal((await request(base, config)).status, 400);
  assert.equal((await fetch(base + '/api/stream', { method: 'POST', headers: { Origin: 'https://other.invalid' } })).status, 403);
});
test('legacy timeout settings do not terminate a slow upstream response', { timeout: 5000 }, async t => {
  const upstream = await serve(http.createServer((req, res) => {
    req.resume();
    const timer = setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); }, 1200);
    res.on('close', () => clearTimeout(timer));
  }), t), base = await serve(createApp(), t);
  const res = await request(base, { url: upstream, timeout: 1 }); const items = (await res.text()).trim().split('\n').map(JSON.parse);
  assert.equal(items[0].status, 200); assert.equal(items.at(-1).type, 'done');
  assert.ok(items.at(-1).at >= 1100); assert.ok(!items.some(item => item.type === 'error'));
});
test('browser cancellation disconnects the upstream', async t => {
  let disconnected;
  const closed = new Promise(resolve => disconnected = resolve);
  const upstream = await serve(http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': started\n\n'); res.on('close', disconnected); }), t);
  const base = await serve(createApp(), t), controller = new AbortController();
  const response = await fetch(base + '/api/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: upstream, method: 'POST', body: '', headers: [] }), signal: controller.signal });
  const reader = response.body.getReader(); while (true) { const { value } = await reader.read(); if (new TextDecoder().decode(value).includes('chunk')) break; }
  controller.abort();
  let timer; try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('upstream stayed open')), 1500); })]); } finally { clearTimeout(timer); }
});
test('static page is served with local CSP and the demo can run through the proxy', async t => {
  const base = await serve(createApp(), t); const page = await fetch(base); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /default-src 'self'/); assert.match(await page.text(), /流式调试台/);
  const response = await request(base, { url: base + '/api/demo' }); const items = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(items[0].status, 200); assert.match(items.filter(i => i.type === 'chunk').map(i => i.text).join(''), /\[DONE\]/); assert.equal(items.at(-1).type, 'done');
});
