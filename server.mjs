import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST = 2 * 1024 * 1024;
const assets = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'], '/core.mjs': ['core.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const forbiddenHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'proxy-connection', 'te', 'trailer']);

function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function readJSON(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_REQUEST) throw Error('请求配置超过 2 MB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function proxy(req, res) {
  let config, target, headers;
  try {
    config = await readJSON(req); target = new URL(config.url);
    if (!['http:', 'https:'].includes(target.protocol)) throw Error('只支持 HTTP / HTTPS URL');
    if (target.username || target.password) throw Error('请在 Authorization Header 中设置认证，不在 URL 中设置账号密码');
    if (!/^[A-Z]+$/.test(config.method)) throw Error('无效的 HTTP 方法');
    if (typeof config.body !== 'string' || !Array.isArray(config.headers)) throw Error('无效的请求配置');
    if (['GET', 'HEAD'].includes(config.method) && config.body) throw Error('GET / HEAD 请求请清空 Body，或修改请求方法');
    headers = {};
    for (const h of config.headers) {
      if (!h.enabled || !h.name.trim()) continue;
      const name = h.name.trim().toLowerCase();
      if (forbiddenHeaders.has(name) || name.startsWith('proxy-')) continue;
      http.validateHeaderName(name); http.validateHeaderValue(name, h.value);
      // Preserve repeated headers through Node's array support.
      headers[name] = headers[name] === undefined ? h.value : [].concat(headers[name], h.value);
    }
    headers['accept-encoding'] ??= 'identity';
    if (config.body) headers['content-length'] = Buffer.byteLength(config.body);
  } catch (e) { json(res, 400, { error: e.message }); return; }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const start = performance.now();
  let closed = false, upstream, incoming, decoded;
  const at = () => Math.round(performance.now() - start);
  const emit = value => { if (!res.destroyed && !res.writableEnded) return res.write(JSON.stringify({ ...value, at: at() }) + '\n'); return false; };
  const finish = (type, message) => {
    if (closed) return; closed = true;
    emit({ type, ...(message ? { message } : {}) }); res.end();
    if (type === 'error') { upstream?.destroy(); incoming?.destroy(); decoded?.destroy(); }
  };
  res.setTimeout(0);
  res.on('close', () => { if (!closed) { closed = true; upstream?.destroy(); incoming?.destroy(); decoded?.destroy(); } });
  try {
    upstream = (target.protocol === 'https:' ? https : http).request(target, { method: config.method, headers, agent: false, timeout: 0 }, response => {
      incoming = response;
      emit({ type: 'response', status: response.statusCode, statusText: response.statusMessage, headers: response.headers });
      const encoding = (response.headers['content-encoding'] || '').toLowerCase();
      const decompress = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
      if (encoding && encoding !== 'identity' && !decompress) { finish('error', `不支持的响应压缩：${encoding}`); response.destroy(); return; }
      const stream = decoded = decompress ? response.pipe(decompress()) : response;
      response.on('error', e => finish('error', `上游连接中断：${e.message}`));
      const decoder = new TextDecoder();
      stream.on('data', chunk => {
        const text = decoder.decode(chunk, { stream: true });
        if (text && !emit({ type: 'chunk', text })) { stream.pause(); res.once('drain', () => stream.resume()); }
      });
      stream.on('end', () => { const text = decoder.decode(); if (text) emit({ type: 'chunk', text }); finish('done'); });
      stream.on('error', e => finish('error', `读取响应失败：${e.message}`));
    });
    upstream.on('error', e => finish('error', e.message));
    upstream.end(config.body || undefined);
  } catch (e) { finish('error', e.message); }
}

function demo(req, res) {
  req.resume();
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  const packets = [': connected\r\n\r\n'];
  for (const text of ['先检查请求参数。', '然后将思考与回答分开显示。', '中文与 emoji 🧪 也能正确流式解码。']) packets.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\r\n\r\n`);
  for (const text of ['你好！', '\n这是 SSE 流式调试示例。', '\n你可以粘贴 curl，或在左侧编辑 URL、Headers 和 Body。', '\n每个事件都可以在「原始事件」中核对。']) packets.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  const toolChunks = [
    { index: 0, id: 'demo_call_0', type: 'function', function: { name: 'run_code', arguments: '{"code":"print(\'' } },
    { index: 0, id: '', type: 'function', function: { arguments: "U')", valid: true }, valid: true },
    { index: 0, id: '', function: { arguments: '"}' } }
  ];
  for (const call of toolChunks) packets.push(`data:${JSON.stringify({ choices: [{ index: 0, delta: { content: '', tool_calls: [call] }, finish_reason: null }], usage: null, valid: true })}\n\n`);
  packets.push(`data:${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  packets.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 28, completion_tokens: 64, total_tokens: 92 } })}\n\n`, 'data: [DONE]\n\n');
  // Deliberately fragment events and UTF-8 bytes to exercise the real parser path.
  const bytes = Buffer.from(packets.join('')); let offset = 0;
  const timer = setInterval(() => { if (offset >= bytes.length) { clearInterval(timer); res.end(); } else { res.write(bytes.subarray(offset, offset + 29)); offset += 29; } }, 45);
  res.on('close', () => clearInterval(timer));
}

export function createApp() {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { json(res, 403, { error: '只允许本机访问' }); return; }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) { json(res, 403, { error: '不允许跨站请求' }); return; }
    const pathname = new URL(req.url, `http://${host}`).pathname;
    try {
      if (req.method === 'POST' && pathname === '/api/stream') return await proxy(req, res);
      if (req.method === 'POST' && pathname === '/api/demo') return demo(req, res);
      if (req.method === 'GET' && assets[pathname]) {
        const [file, type] = assets[pathname];
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(resolve(root, file))); return;
      }
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      json(res, 404, { error: 'Not found' });
    } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); else res.end(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8765);
  const app = createApp();
  app.on('error', e => { console.error(`启动失败：${e.message}\n可使用 PORT=8766 npm start 更换端口。`); process.exitCode = 1; });
  app.listen(port, '127.0.0.1', () => console.log(`SSE Chat 调试台已启动：http://127.0.0.1:${app.address().port}\n按 Ctrl+C 停止。`));
}
