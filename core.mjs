// Shared by the browser and Node tests. No shell commands are ever executed.
export function tokenizeCurl(source) {
  source = source.replace(/\\\r?\n/g, '');
  const tokens = []; let token = '', active = false, quote = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote === "'") { if (c === "'") quote = ''; else token += c; }
    else if (quote === 'ansi') {
      if (c === "'") quote = '';
      else if (c === '\\') {
        const next = source[++i];
        if (next === undefined) throw Error('curl 转义不完整');
        const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
        if (!(next in escapes)) throw Error(`暂不支持 ANSI 转义 \\${next}，请改用普通引号`);
        token += escapes[next];
      } else token += c;
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && /["\\$`]/.test(source[i + 1] || ' ')) token += source[++i];
      else token += c;
    } else if (/\s/.test(c)) {
      if (active) { tokens.push(token); token = ''; active = false; }
    } else {
      active = true;
      if (c === '$' && source[i + 1] === "'") { quote = 'ansi'; i++; }
      else if (c === "'" || c === '"') quote = c;
      else if (c === '\\') { if (++i >= source.length) throw Error('curl 转义不完整'); token += source[i]; }
      else token += c;
    }
  }
  if (quote) throw Error('curl 引号未闭合');
  if (active) tokens.push(token);
  return tokens;
}

export function parseCurl(source) {
  const tokens = tokenizeCurl(source.trim());
  if (!/^curl(?:\.exe)?$/i.test(tokens.shift() || '')) throw Error('请粘贴以 curl 开头的 Bash / macOS 请求');
  let url = '', method = '', body; const headers = [], warnings = [];
  const addHeader = value => {
    const colon = value.indexOf(':');
    if (colon < 1) throw Error(`Header 格式应为 Name: Value：${value}`);
    headers.push({ name: value.slice(0, colon).trim(), value: value.slice(colon + 1).trim(), enabled: true });
  };
  for (let i = 0; i < tokens.length; i++) {
    let flag = tokens[i], inline;
    if (flag.startsWith('--') && flag.includes('=')) { const p = flag.indexOf('='); inline = flag.slice(p + 1); flag = flag.slice(0, p); }
    else if (/^-[XHdub].+/.test(flag)) { inline = flag.slice(2); flag = flag.slice(0, 2); }
    const value = () => { const v = inline !== undefined ? inline : tokens[++i]; if (v === undefined) throw Error(`${flag} 缺少参数`); return v; };
    if (flag === '-X' || flag === '--request') method = value().toUpperCase();
    else if (flag === '-H' || flag === '--header') addHeader(value());
    else if (['-d', '--data', '--data-raw', '--data-binary', '--json'].includes(flag)) {
      const v = value();
      if (v.startsWith('@') && flag !== '--data-raw') throw Error('不读取 curl 引用的本地文件；请将文件内容粘贴到 Body');
      if (body !== undefined) throw Error('暂不支持多段 --data，请合并后导入');
      body = v;
      if (flag === '--json') { addHeader('Content-Type: application/json'); addHeader('Accept: application/json'); }
    } else if (flag === '--url') url = value();
    else if (flag === '-b' || flag === '--cookie') { const v = value(); if (!v.includes('=')) throw Error('不支持 Cookie 文件，请粘贴 Cookie 内容'); addHeader(`Cookie: ${v}`); }
    else if (flag === '-u' || flag === '--user') {
      const v = value(); if (!v.includes(':')) throw Error('Basic Auth 需完整的 username:password');
      const bytes = new TextEncoder().encode(v); addHeader(`Authorization: Basic ${btoa(String.fromCharCode(...bytes))}`);
    } else if (['-N', '--no-buffer', '-s', '-S', '-sS', '--silent', '--show-error', '--compressed', '--globoff', '--http1.1', '--http2', '-i', '--include'].includes(flag)) {
      if (['--http1.1', '--http2'].includes(flag)) warnings.push('本地代理使用 HTTP/1.1，不复现 HTTP/2 协商');
    } else if (flag === '-L' || flag === '--location') warnings.push('不自动跟随重定向；请检查响应 Location 后修改 URL');
    else if (flag.startsWith('-')) throw Error(`暂不支持参数 ${flag}；请在网页中手动配置对应请求`);
    else if (/^https?:\/\//i.test(flag) && !url) url = flag;
    else throw Error(`无法识别参数：${flag}。仅解析单个 curl 请求，不执行 Shell、变量或管道。`);
  }
  if (!url) throw Error('curl 中没有 HTTP / HTTPS URL');
  if (body !== undefined && !headers.some(h => h.name.toLowerCase() === 'content-type')) addHeader('Content-Type: application/x-www-form-urlencoded');
  return { url, method: method || (body === undefined ? 'GET' : 'POST'), headers, body: body ?? '', warnings };
}

const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
export function toCurl(config) {
  const lines = [`curl -N -X ${config.method} ${shellQuote(config.url)}`];
  for (const h of config.headers.filter(h => h.enabled && h.name.trim())) lines.push(`  -H ${shellQuote(`${h.name}: ${h.value}`)}`);
  if (config.body) lines.push(`  --data-raw ${shellQuote(config.body)}`);
  return lines.join(' \\\n');
}

// SSE is line framed, independent of network chunks. CR, LF and CRLF are supported.
export class SSEParser {
  constructor(onEvent) { this.onEvent = onEvent; this.buffer = ''; this.data = []; this.event = ''; this.id = ''; this.raw = []; this.skipLF = false; }
  push(text) {
    for (const c of text) {
      if (this.skipLF) { this.skipLF = false; if (c === '\n') continue; }
      if (c === '\r' || c === '\n') { this.line(this.buffer); this.buffer = ''; this.skipLF = c === '\r'; }
      else this.buffer += c;
    }
  }
  line(line) {
    if (line === '') {
      if (this.raw.length) this.onEvent({ event: this.event || 'message', id: this.id, data: this.data.join('\n'), raw: this.raw.join('\n'), hasData: this.data.length > 0 });
      this.raw = []; this.data = []; this.event = ''; return;
    }
    this.raw.push(line);
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
  }
  finish() {
    if (this.buffer) { this.line(this.buffer); this.buffer = ''; }
    // A final event without an empty line is incomplete under the SSE protocol.
    return this.raw.length ? this.raw.join('\n') : '';
  }
}

export function getPath(object, path) {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((v, key) => v?.[key], object);
}
function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : (v?.text || '')).join('');
  return '';
}
export function extractText(obj, event = '', mapping = {}) {
  if (mapping.reasoning || mapping.answer) return { reasoning: textValue(getPath(obj, mapping.reasoning || '__none__')), answer: textValue(getPath(obj, mapping.answer || '__none__')) };
  const delta = obj.choices?.find(choice => choice.index === undefined || choice.index === 0)?.delta;
  if (delta) return { reasoning: textValue(delta.reasoning_content ?? delta.reasoning), answer: textValue(delta.content) };
  const type = obj.type || event;
  if (/^response\.reasoning(?:_summary)?_text\.delta$/.test(type)) return { reasoning: textValue(obj.delta), answer: '' };
  if (type === 'response.output_text.delta') return { reasoning: '', answer: textValue(obj.delta) };
  if (type === 'content_block_delta') return { reasoning: textValue(obj.delta?.thinking), answer: textValue(obj.delta?.text) };
  return { reasoning: textValue(obj.reasoning_content), answer: textValue(obj.content) };
}

export const isSensitive = name => /authorization|cookie|token|secret|password|passwd|api[-_]?key|credential/i.test(name);
export function redactURL(value) {
  try { const url = new URL(value); url.username = ''; url.password = ''; for (const key of url.searchParams.keys()) if (isSensitive(key)) url.searchParams.set(key, '[REDACTED]'); return url.href; } catch { return value; }
}
export function redactedConfig(config) {
  const walk = object => {
    if (Array.isArray(object)) return object.map(walk);
    if (object && typeof object === 'object') return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, isSensitive(k) ? '[REDACTED]' : walk(v)]));
    return object;
  };
  let body = config.body;
  try { body = JSON.stringify(walk(JSON.parse(body)), null, 2); } catch { body = ''; }
  return { ...config, url: redactURL(config.url), body, headers: config.headers.map(h => ({ ...h, value: isSensitive(h.name) ? '[REDACTED]' : h.value })) };
}
