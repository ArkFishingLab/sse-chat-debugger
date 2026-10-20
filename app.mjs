import { parseCurl, toCurl, SSEParser, extractText, ToolCallAccumulator, redactedConfig, isSensitive, redactURL } from './core.mjs';
const $ = id => document.getElementById(id);
const initial = { method: 'POST', url: '', headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }, { name: 'Authorization', value: '', enabled: true }], body: JSON.stringify({ model: 'your-model', messages: [{ role: 'user', content: '你好，请介绍一下自己。' }], stream: true }, null, 2), reasoningPath: '', answerPath: '' };
let headerRows = [], controller, record, running = false, playbackTimer, toastTimer, startTime, clockTimer;
let queue = [], queueIndex = 0, pendingChars = 0;
const output = { reasoning: '', answer: '' }, charCounts = { reasoning: 0, answer: 0 };
let toolCalls = new ToolCallAccumulator();
const MAX_RAW = 2 * 1024 * 1024, MAX_EVENTS = 1000;

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3800); }
function message(text, error = false) { $('message').textContent = text; $('message').hidden = !text; $('message').classList.toggle('error', error); }
function status(text, type = '') { $('status').textContent = text; $('status').className = `status ${type}`; }
function time(value) { return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`; }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请检查浏览器剪贴板权限'); } }
function renderHeaders() {
  $('headers').replaceChildren();
  headerRows.forEach((header, index) => {
    const row = document.createElement('div'); row.className = 'header-row';
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = header.enabled; enabled.setAttribute('aria-label', `启用 Header ${index + 1}`);
    const key = document.createElement('input'); key.value = header.name; key.placeholder = 'Header name'; key.spellcheck = false; key.setAttribute('aria-label', `Header ${index + 1} 名称`);
    const value = document.createElement('input'); value.value = header.value; value.placeholder = 'Value'; value.spellcheck = false; value.type = isSensitive(header.name) ? 'password' : 'text'; value.autocomplete = 'off'; value.setAttribute('aria-label', `Header ${index + 1} 值`);
    const actions = document.createElement('div'); actions.className = 'row-actions';
    const reveal = document.createElement('button'); reveal.textContent = '◉'; reveal.title = '显示 / 隐藏值'; reveal.onclick = () => value.type = value.type === 'password' ? 'text' : 'password';
    const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '删除 Header'; remove.onclick = () => { headerRows.splice(index, 1); renderHeaders(); };
    enabled.onchange = () => { header.enabled = enabled.checked; countHeaders(); };
    key.oninput = () => { header.name = key.value; value.type = isSensitive(key.value) ? 'password' : 'text'; countHeaders(); };
    value.oninput = () => header.value = value.value;
    actions.append(reveal, remove); row.append(enabled, key, value, actions); $('headers').append(row);
  }); countHeaders();
}
function countHeaders() { $('header-count').textContent = headerRows.filter(h => h.enabled && h.name.trim()).length; }
function getConfig() { return { method: $('method').value, url: $('url').value.trim(), headers: headerRows.map(h => ({ ...h })), body: $('body').value, reasoningPath: $('reasoning-path').value.trim(), answerPath: $('answer-path').value.trim() }; }
function applyConfig(config) {
  if (![...$('method').options].some(option => option.value === config.method)) $('method').append(new Option(config.method, config.method));
  $('method').value = config.method; $('url').value = config.url; $('body').value = config.body || '';
  $('reasoning-path').value = config.reasoningPath || ''; $('answer-path').value = config.answerPath || '';
  headerRows = config.headers.map(h => ({ ...h })); renderHeaders();
}
function tabGroup(selector, attr, prefix) {
  document.querySelectorAll(selector).forEach(button => button.onclick = () => {
    document.querySelectorAll(selector).forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-selected', active); $(prefix + item.dataset[attr]).hidden = !active; });
  });
}
tabGroup('[data-editor]', 'editor', 'editor-'); tabGroup('[data-inspect]', 'inspect', 'inspect-');
$('add-header').onclick = () => { headerRows.push({ name: '', value: '', enabled: true }); renderHeaders(); };
$('format-body').onclick = () => { try { $('body').value = JSON.stringify(JSON.parse($('body').value), null, 2); toast('JSON 已格式化'); } catch (e) { toast(`JSON 无效：${e.message}`); } };
$('import').onclick = () => { $('curl-error').textContent = ''; $('curl-dialog').showModal(); $('curl-input').focus(); };
$('confirm-import').onclick = () => {
  try { const config = parseCurl($('curl-input').value); applyConfig(config); $('curl-dialog').close(); $('curl-input').value = ''; message(config.warnings.join('\n')); toast('curl 已导入，可继续编辑后发送'); }
  catch (e) { $('curl-error').textContent = e.message; }
};
$('export-curl').onclick = () => copy(toCurl(getConfig()));

const PROFILE_KEY = 'sse-chat-debugger.profiles.v1';
function profiles() { try { const list = JSON.parse(localStorage.getItem(PROFILE_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } }
function refreshProfiles(selected = '') {
  $('profiles').replaceChildren(new Option('选择已保存的请求…', ''));
  for (const item of profiles()) $('profiles').append(new Option(item.name, item.id));
  $('profiles').value = selected;
}
$('save-profile').onclick = () => { $('profile-name').value = ''; $('save-dialog').showModal(); $('profile-name').focus(); };
$('close-save').onclick = () => $('save-dialog').close();
$('save-form').onsubmit = event => {
  event.preventDefault(); const name = $('profile-name').value.trim(); if (!name) return;
  try { const list = profiles(), id = crypto.randomUUID(); list.push({ id, name, config: redactedConfig(getConfig()) }); localStorage.setItem(PROFILE_KEY, JSON.stringify(list)); refreshProfiles(id); $('save-dialog').close(); toast('已保存脱敏配置；使用时请补全凭据'); } catch (e) { toast(`保存失败：${e.message}`); }
};
$('profiles').onchange = () => { const item = profiles().find(p => p.id === $('profiles').value); if (item) { applyConfig(item.config); toast('已加载配置，请补全已脱敏的凭据'); } };
$('delete-profile').onclick = () => { if (!$('profiles').value) return; try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles().filter(p => p.id !== $('profiles').value))); refreshProfiles(); toast('配置已删除'); } catch (e) { toast(e.message); } };

function scroll(element) { if ($('autoscroll').checked) element.scrollTop = element.scrollHeight; }
function appendOutput(kind, text) {
  const element = $(kind);
  if (element.lastChild?.nodeType === Node.TEXT_NODE) element.lastChild.appendData(text);
  else element.append(document.createTextNode(text));
  charCounts[kind] += Array.from(text).length; $(kind + '-count').textContent = `${charCounts[kind]} 字`; scroll(element);
}
function playback() {
  clearTimeout(playbackTimer);
  const speed = Number($('speed').value);
  if (!speed) { for (const kind of Object.keys(output)) { $(kind).textContent = output[kind]; charCounts[kind] = Array.from(output[kind]).length; $(kind + '-count').textContent = `${charCounts[kind]} 字`; scroll($(kind)); } queue = []; queueIndex = 0; pendingChars = 0; }
  else if (queueIndex < queue.length) {
    const chunk = queue[queueIndex]; const char = String.fromCodePoint(chunk.text.codePointAt(chunk.offset)); chunk.offset += char.length; pendingChars--; appendOutput(chunk.kind, char);
    if (chunk.offset >= chunk.text.length) queueIndex++;
    if (queueIndex >= queue.length) { queue = []; queueIndex = 0; }
  }
  $('pending').textContent = pendingChars ? `待展示 ${pendingChars} 字` : '';
  if (pendingChars) playbackTimer = setTimeout(playback, 1000 / Math.max(speed, 1));
}
function receiveText(kind, text, at, measureFirstText = true) {
  if (!text) return;
  if (measureFirstText && record.firstText === null) { record.firstText = at; $('metric-text').textContent = time(at); }
  output[kind] += text;
  if (Number($('speed').value) === 0) appendOutput(kind, text);
  else { const wasEmpty = pendingChars === 0; queue.push({ kind, text, offset: 0 }); pendingChars += Array.from(text).length; if (wasEmpty) playback(); }
}
$('speed').onchange = playback;
document.querySelectorAll('[data-copy]').forEach(button => button.onclick = () => copy(output[button.dataset.copy]));

function renderToolCall(call, argumentsDelta = '', at = 0) {
  $('tool-calls-section').hidden = false;
  $('tool-calls-count').textContent = toolCalls.calls.length;
  if (!$(call.key)) {
    const card = document.createElement('article'); card.className = 'tool-call';
    const heading = document.createElement('div'); heading.className = 'tool-heading';
    const title = document.createElement('h4'); title.id = call.key + '-name';
    const copyButton = document.createElement('button'); copyButton.className = 'text-button'; copyButton.textContent = '复制参数'; copyButton.onclick = () => copy(output[call.key]);
    heading.append(title, copyButton);
    const meta = document.createElement('div'); meta.className = 'tool-meta'; meta.id = call.key + '-meta';
    const args = document.createElement('div'); args.id = call.key; args.className = 'text-output tool-arguments'; args.dataset.placeholder = '等待参数片段…';
    const footer = document.createElement('div'); footer.className = 'card-footer';
    const count = document.createElement('span'); count.id = call.key + '-count'; count.textContent = '0 字';
    const state = document.createElement('span'); state.id = call.key + '-state';
    footer.append(count, state); card.append(heading, meta, args, footer); $('tool-calls').append(card);
    output[call.key] = ''; charCounts[call.key] = 0;
  }
  $(call.key + '-name').textContent = `#${call.index} · ${call.name || '未命名函数'}`;
  $(call.key + '-meta').textContent = `${call.type || 'function'} · ID: ${call.id || '尚未返回'}`;
  $(call.key + '-state').textContent = call.finishReason ? `参数结束 · ${call.finishReason}` : running ? '参数接收中' : record?.outcome === 'stopped' ? '已停止' : '流已结束';
  receiveText(call.key, argumentsDelta, at, false);
}
$('copy-tool-calls').onclick = () => copy(JSON.stringify(toolCalls.snapshot(), null, 2));

function reset() {
  clearTimeout(playbackTimer); clearInterval(clockTimer); queue = []; queueIndex = 0; pendingChars = 0;
  for (const kind of Object.keys(output)) if (kind !== 'reasoning' && kind !== 'answer') { delete output[kind]; delete charCounts[kind]; }
  toolCalls = new ToolCallAccumulator(); $('tool-calls').replaceChildren(); $('tool-calls-section').hidden = true; $('tool-calls-count').textContent = '0';
  for (const kind of ['reasoning', 'answer']) { output[kind] = ''; charCounts[kind] = 0; $(kind).textContent = ''; $(kind + '-count').textContent = '0 字'; }
  for (const metric of ['http', 'event', 'text', 'total']) $('metric-' + metric).textContent = '—';
  $('metric-events').textContent = '0'; $('raw-count').textContent = '0'; $('events').replaceChildren(); $('inspect-raw').textContent = ''; $('inspect-response-headers').textContent = '';
  $('connection-info').textContent = '连接尚未建立'; $('usage').textContent = '等待用量信息'; $('pending').textContent = ''; message(''); status('等待请求'); record = null;
}
$('clear').onclick = () => { if (running) return; reset(); };

function addEvent(event, at, note = '') {
  record.eventCount++; $('metric-events').textContent = record.eventCount; $('raw-count').textContent = record.eventCount;
  if (event.hasData && record.firstEvent === null) { record.firstEvent = at; $('metric-event').textContent = time(at); }
  const entry = { ...event, at, note }; record.events.push(entry); if (record.events.length > MAX_EVENTS) { record.events.shift(); record.eventsTruncated = true; }
  const details = document.createElement('details'), summary = document.createElement('summary');
  for (const [cls, text] of [['event-time', time(at)], ['event-tag', event.hasData ? event.event : 'heartbeat'], ['event-preview', note || event.data || event.raw]]) { const span = document.createElement('span'); span.className = cls; span.textContent = text; summary.append(span); }
  const pre = document.createElement('pre'); pre.textContent = event.raw + (note ? `\n\n[解析] ${note}` : ''); details.append(summary, pre); $('events').append(details);
  while ($('events').children.length > MAX_EVENTS) $('events').firstChild.remove();
  scroll($('events'));
}
function handleEvent(event, at, config) {
  let note = '';
  if (event.event === 'error' && event.hasData) { record.apiError = true; message(event.data, true); status('接口错误', 'error'); }
  if (event.hasData && event.data !== '[DONE]') {
    try {
      const obj = JSON.parse(event.data);
      if (event.event === 'error' || obj.error || obj.type === 'error' || obj.type === 'response.failed') {
        note = '接口返回错误事件'; record.apiError = true; message(JSON.stringify(obj.error || obj.response?.error || obj), true); status('接口错误', 'error');
      }
      if (record.response?.status >= 200 && record.response?.status < 300) {
        const { reasoning, answer } = extractText(obj, event.event, { reasoning: config.reasoningPath, answer: config.answerPath });
        receiveText('reasoning', reasoning, at); receiveText('answer', answer, at);
        const updates = toolCalls.push(obj);
        for (const update of updates) renderToolCall(update.call, update.argumentsDelta, at);
        if (updates.length) note = updates.map(({ call, argumentsDelta }) => `工具调用 #${call.index} · ${call.name || '未返回名称'} · +${Array.from(argumentsDelta).length} 字参数`).join('；');
      }
      const usage = obj.usage || obj.response?.usage || obj.message?.usage;
      if (usage) { record.usage = { ...record.usage, ...usage }; $('usage').textContent = Object.entries(record.usage).filter(([,v]) => typeof v === 'number').map(([k,v]) => `${k}: ${v}`).join(' · ') || '已收到用量信息'; }
      if (obj.choices?.some(c => c.index > 0)) note = '文本区域仅展示 choice 0，其他候选请查看原始事件';
    } catch { note = '非 JSON 数据，保留原始事件；自定义文本协议可继续适配'; }
  }
  if (event.data === '[DONE]') { record.sawDone = true; note = '流结束标记'; }
  addEvent(event, at, note);
}
function appendRaw(text) {
  const available = MAX_RAW - record.raw.length;
  if (available > 0) { const kept = text.slice(0, available); record.raw += kept; $('inspect-raw').append(document.createTextNode(kept)); scroll($('inspect-raw')); }
  if (text.length > available && !record.rawTruncated) { record.rawTruncated = true; $('inspect-raw').append(document.createTextNode('\n[原始响应超过 2 MB，仅保留前 2 MB；文本解析继续]')); }
}
function setRunning(value) { running = value; $('send').disabled = value; $('stop').disabled = !value; $('clear').disabled = value; $('demo').disabled = value; }
async function send(config) {
  if (running) return;
  try {
    const url = new URL(config.url); if (!['http:', 'https:'].includes(url.protocol)) throw Error('URL 必须以 http:// 或 https:// 开头');
    if (['GET', 'HEAD'].includes(config.method) && config.body) throw Error('GET / HEAD 请求请清空 Body');
    const contentType = config.headers.find(h => h.enabled && h.name.toLowerCase() === 'content-type')?.value || '';
    if (/json/i.test(contentType) && config.body) { try { JSON.parse(config.body); } catch (e) { throw Error(`Body JSON 无效：${e.message}`); } }
  } catch (e) { message(e.message, true); return; }
  reset(); setRunning(true); controller = new AbortController(); startTime = performance.now();
  record = { url: redactURL(config.url), method: config.method, startedAt: new Date().toISOString(), events: [], eventCount: 0, raw: '', firstEvent: null, firstText: null, duration: 0, response: null, outcome: 'running' };
  status('连接中', 'live'); clockTimer = setInterval(() => $('metric-total').textContent = time(performance.now() - startTime), 100);
  let isSSE = false, lastAt = 0, terminal = false;
  const parser = new SSEParser(event => handleEvent(event, lastAt, config));
  try {
    const response = await fetch('/api/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal: controller.signal });
    if (!response.ok) { const result = await response.json(); throw Error(result.error || `本地代理 HTTP ${response.status}`); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const envelope = item => {
      lastAt = item.at;
      if (item.type === 'response') {
        record.response = item; $('metric-http').textContent = item.status; $('connection-info').textContent = `响应头 ${time(item.at)}`;
        $('inspect-response-headers').textContent = Object.entries(item.headers).map(([k,v]) => `${k}: ${Array.isArray(v) ? v.join('\n') : v}`).join('\n');
        isSSE = /text\/event-stream/i.test(item.headers['content-type'] || ''); status('接收中', 'live');
        if (item.status < 200 || item.status >= 300) message(`接口返回 HTTP ${item.status} ${item.statusText}，请查看原始响应。`, true);
        else if (!isSSE) message('响应 Content-Type 不是 text/event-stream，原始响应已保留。请检查是否启用 stream。');
      } else if (item.type === 'chunk') { appendRaw(item.text); if (isSSE) parser.push(item.text); }
      else if (item.type === 'error') { terminal = true; throw Error(item.message); }
      else if (item.type === 'done') { terminal = true; record.duration = item.at; }
    };
    while (true) {
      const { value, done } = await reader.read(); buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let p; while ((p = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, p); buffer = buffer.slice(p + 1); if (line) envelope(JSON.parse(line)); }
      if (done) break;
    }
    if (buffer.trim()) envelope(JSON.parse(buffer));
    if (!terminal) throw Error('本地代理连接意外结束');
    const incomplete = isSSE ? parser.finish() : '';
    if (incomplete) { addEvent({ event: 'incomplete', data: '', raw: incomplete, hasData: false }, lastAt, '末尾事件缺少空行，未作为完整 SSE 事件解析'); message('流已关闭，但最后一个 SSE 事件不完整，请核对原始事件。', true); }
    const failed = record.apiError || incomplete || record.response?.status >= 300 || record.response?.status < 200;
    record.outcome = failed ? 'error' : 'complete'; status(failed ? '响应异常' : '接收完成', failed ? 'error' : '');
    if (isSSE && !output.reasoning && !output.answer && !toolCalls.calls.length && !failed) message('已收到流，但没有识别到文本。请在原始事件中确认字段，并在「解析 / 设置」配置增量字段路径。');
  } catch (e) {
    controller.abort(); record.duration = performance.now() - startTime;
    if (e.name === 'AbortError') { record.outcome = 'stopped'; status('已停止'); message('请求已停止；已接收的文本将继续逐字显示。'); }
    else { record.outcome = 'error'; record.error = e.message; status('请求失败', 'error'); message(e.message, true); }
  } finally { clearInterval(clockTimer); $('metric-total').textContent = time(record.duration); setRunning(false); for (const call of toolCalls.snapshot()) renderToolCall(call); controller = null; }
}
$('send').onclick = () => send(getConfig()); $('stop').onclick = () => controller?.abort();
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !document.querySelector('dialog[open]')) { event.preventDefault(); send(getConfig()); } });
$('demo').onclick = () => {
  const config = { ...initial, url: `${location.origin}/api/demo`, headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }], body: JSON.stringify({ demo: true, stream: true }, null, 2) };
  applyConfig(config); send(config);
};
$('export-record').onclick = () => {
  if (!record) { toast('请先发送请求'); return; }
  const headers = Object.fromEntries(Object.entries(record.response?.headers || {}).map(([k,v]) => [k, isSensitive(k) ? '[REDACTED]' : v]));
  const data = { ...record, response: record.response ? { ...record.response, headers } : null, output: { reasoning: output.reasoning, answer: output.answer }, toolCalls: toolCalls.snapshot(), note: '不包含请求 Headers / Body；原始响应及模型输出可能包含业务数据。事件最多保留末尾 1000 条，原始响应最多保留前 2 MB，截断见标记。' };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `sse-debug-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('记录已导出，原始响应可能包含业务数据');
};
applyConfig(initial); refreshProfiles();
