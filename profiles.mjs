import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ProfileError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.url !== 'string' || typeof config.method !== 'string'
    || typeof config.body !== 'string' || !Array.isArray(config.headers)
    || !config.headers.every(h => h && typeof h.name === 'string' && typeof h.value === 'string' && typeof h.enabled === 'boolean')) {
    throw new ProfileError('请求配置格式不正确');
  }
}
function validateProfile(profile) {
  if (!profile || typeof profile.id !== 'string' || !/^[\w-]{1,100}$/.test(profile.id)
    || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.trim().length > 80) {
    throw new ProfileError('配置名称须为 1–80 字，且 ID 格式须有效');
  }
  validateConfig(profile.config);
}

export class ProfileStore {
  constructor(file) { this.file = resolve(file); this.pending = Promise.resolve(); }
  async read() {
    let text;
    try { text = await readFile(this.file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    try {
      const profiles = JSON.parse(text);
      if (!Array.isArray(profiles)) throw Error('expected array');
      for (const profile of profiles) validateProfile(profile);
      return profiles;
    } catch { throw new ProfileError('本地请求文件格式损坏，请检查 data/requests.json；原文件未被修改', 500); }
  }
  async list() { await this.pending; return this.read(); }
  mutate(change) {
    const operation = this.pending.then(async () => {
      const profiles = await this.read();
      const result = change(profiles);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, this.file);
      } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  save(name, config) {
    const profile = { id: randomUUID(), name: typeof name === 'string' ? name.trim() : name, config };
    validateProfile(profile);
    return this.mutate(profiles => { profiles.push(profile); return { profile, profiles }; });
  }
  remove(id) {
    return this.mutate(profiles => {
      const index = profiles.findIndex(profile => profile.id === id);
      if (index < 0) throw new ProfileError('未找到该配置', 404);
      profiles.splice(index, 1); return { profiles };
    });
  }
  import(profiles) {
    if (!Array.isArray(profiles)) throw new ProfileError('旧收藏格式不正确');
    for (const profile of profiles) validateProfile(profile);
    return this.mutate(existing => {
      let imported = 0;
      for (const profile of profiles) {
        if (existing.some(item => item.id === profile.id)) continue;
        existing.push(profile); imported++;
      }
      return { profiles: existing, imported };
    });
  }
}

const stores = new Map();
export function getProfileStore(file) {
  const path = resolve(file);
  if (!stores.has(path)) stores.set(path, new ProfileStore(path));
  return stores.get(path);
}
