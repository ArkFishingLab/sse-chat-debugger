import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurl, toCurl, SSEParser, extractText, redactedConfig } from '../core.mjs';

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
