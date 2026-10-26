import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp } from '../server.mjs';
import { ProfileStore } from '../profiles.mjs';

const config = {
  url: 'https://example.com/chat?api_key=example-query-secret', method: 'POST',
  headers: [{ name: 'Authorization', value: 'Bearer example-secret', enabled: true }, { name: 'Cookie', value: 'session=example-cookie', enabled: false }],
  body: '{ "password": "example-password", "api_key": "example-key" }\n',
  reasoningPath: 'delta.reasoning', answerPath: 'delta.content'
};
async function storage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sse-profiles-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'data', 'requests.json');
}
async function server(t, file) {
  const app = createApp({ profilesFile: file }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  return `http://127.0.0.1:${app.address().port}`;
}
async function api(base, path = '', body, method = 'POST') {
  const response = await fetch(base + '/api/profiles' + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, result: await response.json() };
}
test('full credentials and exact Body persist on disk and load through a different port', async t => {
  const file = await storage(t), base = await server(t, file);
  assert.deepEqual((await api(base, '', undefined, 'GET')).result.profiles, []);
  const saved = await api(base, '', { name: '本地请求', config }); assert.equal(saved.status, 200);
  assert.deepEqual(saved.result.profile.config, config); assert.equal(saved.result.storagePath, file);
  const disk = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(disk[0].config, config);
  assert.deepEqual((await new ProfileStore(file).list())[0].config, config);
  const otherPort = await server(t, file);
  assert.deepEqual((await api(otherPort, '', undefined, 'GET')).result.profiles, disk);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await fetch(base + '/data/requests.json')).status, 404);
});
test('non-JSON bodies are preserved and deleting a profile updates the shared file', async t => {
  const file = await storage(t), base = await server(t, file);
  const raw = { ...config, body: 'token=raw-value&text=中文\n  unchanged  ' };
  const first = await api(base, '', { name: 'raw', config: raw });
  const second = await api(base, '', { name: 'json', config });
  assert.equal(first.result.profile.config.body, raw.body);
  const deleted = await api(base, '/' + first.result.profile.id, undefined, 'DELETE');
  assert.equal(deleted.status, 200); assert.deepEqual(deleted.result.profiles, [second.result.profile]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [second.result.profile]);
  assert.equal((await api(base, '/missing', undefined, 'DELETE')).status, 404);
});
test('simultaneous saves through two ports do not lose profiles', async t => {
  const file = await storage(t), a = await server(t, file), b = await server(t, file);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => api(i % 2 ? a : b, '', { name: `profile-${i}`, config })));
  assert.ok(responses.every(response => response.status === 200));
  const disk = JSON.parse(await readFile(file, 'utf8')); assert.equal(disk.length, 12); assert.equal(new Set(disk.map(item => item.id)).size, 12);
});
test('legacy import is idempotent and never replaces an already saved full profile', async t => {
  const file = await storage(t), base = await server(t, file);
  const saved = (await api(base, '', { name: 'full', config })).result.profile;
  const legacy = { id: 'legacy-id', name: '旧收藏', config: { ...config, headers: [{ name: 'Authorization', value: '[REDACTED]', enabled: true }] } };
  const first = await api(base, '/import', { profiles: [legacy, { ...saved, config: legacy.config }] });
  assert.equal(first.result.imported, 1); assert.deepEqual(first.result.profiles[0].config, config);
  const again = await api(base, '/import', { profiles: [legacy] }); assert.equal(again.result.imported, 0); assert.equal(again.result.profiles.length, 2);
});
test('a corrupt local file is reported without overwriting it', async t => {
  const file = await storage(t); await mkdir(dirname(file)); const original = '{ incomplete'; await writeFile(file, original);
  const base = await server(t, file);
  assert.equal((await api(base, '', undefined, 'GET')).status, 500);
  assert.equal((await api(base, '', { name: 'new', config })).status, 500);
  assert.equal(await readFile(file, 'utf8'), original);
});
test('invalid or cross-site saves cannot modify the local profiles', async t => {
  const file = await storage(t), base = await server(t, file);
  await api(base, '', { name: 'existing', config }); const original = await readFile(file, 'utf8');
  for (const body of [null, [], {}, { name: '', config }, { name: 'bad', config: { ...config, headers: 'wrong' } }]) assert.equal((await api(base, '', body)).status, 400);
  const denied = await fetch(base + '/api/profiles', { method: 'POST', headers: { Origin: 'https://other.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'bad', config }) });
  assert.equal(denied.status, 403); assert.equal(await readFile(file, 'utf8'), original);
});
