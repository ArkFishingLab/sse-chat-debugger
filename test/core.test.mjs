import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurl, toCurl, SSEParser, extractText, ToolCallAccumulator, redactedConfig } from '../core.mjs';

test('curl import / export preserves JSON, quotes, multiline strings, headers and method', () => {
  const config = { url: 'https://example.com/chat?q=a&b=c', method: 'POST', headers: [{ name: 'Authorization', value: "Bearer don't-$HOME-`test`", enabled: true }, { name: 'Content-Type', value: 'application/json', enabled: true }], body: JSON.stringify({ prompt: "你好\nI'm here 🧪", stream: true }) };
  const parsed = parseCurl(toCurl(config));
  assert.equal(parsed.url, config.url); assert.equal(parsed.body, config.body); assert.deepEqual(parsed.headers, config.headers); assert.equal(parsed.method, 'POST');
});
test('curl supports Chrome ANSI quotes, attached flags, cookie and basic auth', () => {
  const parsed = parseCurl("curl --url=https://example.com -XPOST -H'Content-Type: application/json' --data-raw $'{\"x\":\"it\\\'s\"}' -b 'a=b' -u 'u:p'");
  assert.equal(parsed.body, '{"x":"it\'s"}'); assert.equal(parsed.method, 'POST');
  assert.equal(parsed.headers.at(-1).value, 'Basic dTpw'); assert.equal(parsed.headers.at(-2).value, 'a=b');
});
test('unsupported curl options, local file references and shell pipelines are explicit errors', () => {
  for (const source of ["curl https://example.com -F 'file=@a'", 'curl https://example.com --data @file', 'curl https://example.com | sh', 'curl https://example.com -k', "curl 'https://example.com"]) assert.throws(() => parseCurl(source));
  assert.equal(parseCurl('curl https://example.com --data-raw @literal').body, '@literal');
});
test('SSE parser handles every possible split in CRLF, unicode, multiline data and comments', () => {
  const stream = ': 心跳\r\n\r\nid: 7\r\nevent: delta\r\ndata: {"text":\r\ndata: "你🧪"}\r\n\r\ndata: [DONE]\n\n';
  for (let split = 0; split <= stream.length; split++) {
    const events = [], parser = new SSEParser(e => events.push(e)); parser.push(stream.slice(0, split)); parser.push(stream.slice(split));
    assert.equal(parser.finish(), ''); assert.equal(events.length, 3); assert.equal(events[0].hasData, false); assert.equal(events[1].event, 'delta'); assert.equal(events[1].data, '{"text":\n"你🧪"}'); assert.equal(events[2].id, '7'); assert.equal(events[2].data, '[DONE]');
  }
});
test('SSE incomplete final events are exposed rather than silently dispatched', () => {
  const events = [], parser = new SSEParser(e => events.push(e)); parser.push('data: unfinished'); assert.equal(parser.finish(), 'data: unfinished'); assert.equal(events.length, 0);
});
test('extract common chat protocols and custom paths without duplicating final snapshots', () => {
  assert.deepEqual(extractText({ choices: [{ delta: { reasoning_content: '想', content: '答' } }] }), { reasoning: '想', answer: '答' });
  assert.equal(extractText({ type: 'response.output_text.delta', delta: '答' }).answer, '答');
  assert.equal(extractText({ type: 'response.reasoning_summary_text.delta', delta: '想' }).reasoning, '想');
  assert.equal(extractText({ type: 'content_block_delta', delta: { thinking: '想' } }).reasoning, '想');
  assert.equal(extractText({ choices: [{ index: 1, delta: { content: 'other choice' } }] }).answer, '');
  assert.equal(extractText({ type: 'response.completed', response: { output: [{ content: [{ text: 'snapshot' }] }] } }).answer, '');
  assert.deepEqual(extractText({ data: { thinking: '想', text: '答' } }, '', { reasoning: 'data.thinking', answer: 'data.text' }), { reasoning: '想', answer: '答' });
});
test('saved configs redact common credentials without mutating the active request', () => {
  const config = { url: 'https://user:pw@example.com/?access_token=secret', headers: [{ name: 'Authorization', value: 'Bearer real', enabled: true }], body: '{"nested":{"api_key":"secret"},"messages":[{"content":"你好"}]}' };
  const saved = redactedConfig(config);
  assert.ok(!saved.url.includes('secret')); assert.equal(saved.headers[0].value, '[REDACTED]'); assert.equal(JSON.parse(saved.body).nested.api_key, '[REDACTED]'); assert.equal(config.headers[0].value, 'Bearer real');
  assert.equal(redactedConfig({ ...config, body: 'raw-secret' }).body, '');
});

test('GLM tool-call SSE without a space after data: preserves empty-ID argument fragments', () => {
  const payload = { id: 'chatcmpl-test', choices: [{ delta: { content: '', tool_calls: [{ index: 0, id: '', function: { arguments: "U')", valid: true }, type: 'function', valid: true }], valid: true }, finish_reason: null, index: 0, logprobs: null, valid: true }], created: 1792489017, model: 'glm-5.2', object: 'chat.completion.chunk', usage: null, valid: true };
  const wire = `data:${JSON.stringify(payload)}\n\n`;
  for (let split = 0; split <= wire.length; split++) {
    const calls = new ToolCallAccumulator();
    const parser = new SSEParser(event => calls.push(JSON.parse(event.data)));
    parser.push(wire.slice(0, split)); parser.push(wire.slice(split));
    assert.equal(parser.finish(), '');
    assert.deepEqual(calls.snapshot(), [{ key: 'tool-0', index: 0, id: '', type: 'function', name: '', arguments: "U')", finishReason: null }]);
  }
});
test('tool names and JSON arguments accumulate across empty-ID chunks without changing chat text', () => {
  const calls = new ToolCallAccumulator();
  const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  calls.push(chunk({ tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'run_', arguments: '{"code":"print(\'' } }] }));
  const obj = chunk({ content: '同时返回文本', reasoning_content: '思考', tool_calls: [{ index: 0, id: '', function: { name: 'code', arguments: "U')" } }] });
  assert.deepEqual(extractText(obj), { reasoning: '思考', answer: '同时返回文本' });
  const updates = calls.push(obj); assert.equal(updates[0].argumentsDelta, "U')");
  calls.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }));
  const finished = calls.push(chunk({}, 'tool_calls'));
  assert.equal(finished[0].argumentsDelta, '');
  assert.deepEqual(calls.snapshot()[0], { key: 'tool-0', index: 0, id: 'call_0', type: 'function', name: 'run_code', arguments: '{"code":"print(\'U\')"}', finishReason: 'tool_calls' });
  assert.deepEqual(JSON.parse(calls.snapshot()[0].arguments), { code: "print('U')" });
});
test('parallel tool calls stay separate, preserve a late ID, and ignore other choices', () => {
  const calls = new ToolCallAccumulator();
  calls.push({ choices: [{ index: 1, delta: { tool_calls: [{ index: 0, function: { arguments: 'ignored' } }] } }] });
  assert.equal(calls.snapshot().length, 0);
  calls.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { name: 'second', arguments: 'B' } }, { index: 0, id: 'first', function: { name: 'first', arguments: 'A' } }] } }] });
  calls.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { arguments: '1' } }, { index: 1, id: 'second', function: { arguments: '2' } }] } }] });
  assert.deepEqual(calls.snapshot().map(call => [call.index, call.id, call.arguments]), [[1, 'second', 'B2'], [0, 'first', 'A1']]);
  calls.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  assert.ok(calls.snapshot().every(call => call.finishReason === 'tool_calls'));
});
test('a new call ID at a reused index starts a separate call and snapshots are isolated', () => {
  const calls = new ToolCallAccumulator();
  for (const id of ['first', 'second']) calls.push({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'fn', arguments: id } }] } }] });
  const snapshot = calls.snapshot(); assert.equal(snapshot.length, 2); assert.equal(snapshot[0].arguments, 'first'); assert.equal(snapshot[1].arguments, 'second');
  snapshot[1].arguments = 'changed'; assert.equal(calls.snapshot()[1].arguments, 'second');
});
