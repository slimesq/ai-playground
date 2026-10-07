import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateConfig } from './public/plan.js';
import { normalizeHistory, normalizeJournalTimestamp, SYNC_BODY_LIMIT, MAX_NOTE_LENGTH } from './public/journal.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = SYNC_BODY_LIMIT;
const EMPTY_DATE = '1970-01-01T00:00:00.000Z';
const STUDY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COURSE_ID = /^(?:s1-(?:0[1-9]|1[0-4])|s[234]-(?:0[1-9]|1[0-9]|20))$/;
const VERSION = /^[a-f0-9]{64}$/;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/plan.js', ['plan.js', 'text/javascript; charset=utf-8']],
  ['/journal.js', ['journal.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
  ['/favicon.png', ['favicon.png', 'image/png']],
  // A new URL lets browsers recover from a cached failed favicon request.
  ['/favicon-20261005-r3.ico', ['favicon.ico', 'image/x-icon']],
  ['/favicon-20261005-r3.png', ['favicon.png', 'image/png']],
  ['/icons.svg', ['icons.svg', 'image/svg+xml']],
]);

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function timestamp(value) {
  try { const iso = normalizeJournalTimestamp(value); return { iso, milliseconds: Date.parse(iso) }; }
  catch (error) { throw new RequestError(400, error.message); }
}

function validatePayload(payload) {
  if (!object(payload) || !onlyKeys(payload, ['config', 'configUpdatedAt', 'entries', 'expected']) || !object(payload.entries)) {
    throw new RequestError(400, '请求须包含 entries 对象。');
  }
  const hasConfig = Object.hasOwn(payload, 'config');
  let config;
  let configTime;
  if (Object.hasOwn(payload, 'configUpdatedAt')) configTime = timestamp(payload.configUpdatedAt);
  if (hasConfig) {
    if (!object(payload.config) || !onlyKeys(payload.config, ['startDate', 'program', 'days', 'sessionMinutes'])
        || Object.values(payload.config).some(value => value === null) || !configTime) {
      throw new RequestError(400, '学习计划设置无效，请同时提供设置和更新时间。');
    }
    try { config = validateConfig(payload.config); }
    catch { throw new RequestError(400, '学习计划设置无效，请检查日期、课程类型、学习日和时长。'); }
  }
  const entries = Object.entries(payload.entries).map(([id, record]) => {
    if (!COURSE_ID.test(id) || !object(record)
        || !onlyKeys(record, ['status', 'minutes', 'note', 'title', 'updatedAt', 'history'])
        || !['pending', 'learning', 'done'].includes(record.status)
        || !Number.isInteger(record.minutes) || record.minutes < 0 || record.minutes > 100000
        || typeof record.note !== 'string' || record.note.length > MAX_NOTE_LENGTH
        || Object.hasOwn(record, 'title') && (typeof record.title !== 'string' || record.title.length > 160)) {
      throw new RequestError(400, '课程记录无效，请检查课程编号、状态、分钟数和笔记。');
    }
    const updated = timestamp(record.updatedAt);
    let history;
    if (Object.hasOwn(record, 'history')) {
      try { history = normalizeHistory(id, record); } catch (error) { throw new RequestError(400, error.message); }
    }
    return { id, status: record.status, minutes: record.minutes, note: record.note,
      title: record.title ?? null, updatedAt: updated.iso, updatedMilliseconds: updated.milliseconds, history };
  });
  let expected;
  if (Object.hasOwn(payload, 'expected')) {
    expected = payload.expected;
    const validVersion = value => value === null || typeof value === 'string' && VERSION.test(value);
    if (!object(expected) || !onlyKeys(expected, ['config', 'entries']) || !object(expected.entries)
      || Object.keys(expected.entries).length !== entries.length
      || entries.some(({ id }) => !Object.hasOwn(expected.entries, id) || !validVersion(expected.entries[id]))
      || hasConfig !== Object.hasOwn(expected, 'config') || hasConfig && !validVersion(expected.config)) {
      throw new RequestError(400, '同步版本无效，请重新读取学习记录后重试。');
    }
  }
  return { config, configTime, entries, expected };
}

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    let finished = false;
    let size = 0;
    let chunks = [];
    const reject = error => {
      if (finished) return;
      finished = true;
      chunks = [];
      rejectBody(error);
      request.resume();
    };
    request.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > BODY_LIMIT) reject(new RequestError(413, '同步内容过大，请分批提交课程记录。'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (finished) return;
      finished = true;
      try { resolveBody(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { rejectBody(new RequestError(400, '请求内容须为有效 JSON。')); }
    });
    request.on('aborted', () => reject(new RequestError(400, '请求未完整发送，请重试。')));
    request.on('error', () => reject(new RequestError(400, '读取请求失败，请重试。')));
    if (Number(request.headers['content-length']) > BODY_LIMIT) {
      reject(new RequestError(413, '同步内容过大，请分批提交课程记录。'));
    }
  });
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(value));
}

function requestPath(request) {
  let path;
  try { path = decodeURIComponent((request.url || '/').split('?')[0]); }
  catch { throw new RequestError(400, '请求路径无效。'); }
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) {
    throw new RequestError(400, '请求路径无效。');
  }
  return path;
}

export function createStudyServer({ databasePath = process.env.DB_PATH || resolve(ROOT, 'data/vocal.db'),
  staticDirectory = resolve(ROOT, 'public') } = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS study_config (
      study_key TEXT PRIMARY KEY, config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS course_entries (
      study_key TEXT NOT NULL, course_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','learning','done')),
      minutes INTEGER NOT NULL CHECK(minutes BETWEEN 0 AND 100000),
      note TEXT NOT NULL, title TEXT,
      updated_at TEXT NOT NULL, updated_ms INTEGER NOT NULL,
      history_json TEXT,
      PRIMARY KEY(study_key, course_id)
    );
  `);
  if (!database.prepare('PRAGMA table_info(course_entries)').all().some(column => column.name === 'history_json')) database.exec('ALTER TABLE course_entries ADD COLUMN history_json TEXT');
  const readConfig = database.prepare('SELECT config_json, updated_at FROM study_config WHERE study_key = ?');
  const readEntries = database.prepare('SELECT course_id, status, minutes, note, title, updated_at, history_json FROM course_entries WHERE study_key = ? ORDER BY course_id');
  const writeConfig = database.prepare(`INSERT INTO study_config VALUES (?, ?, ?, ?)
    ON CONFLICT(study_key) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at, updated_ms=excluded.updated_ms
    WHERE excluded.updated_ms >= study_config.updated_ms`);
  const writeEntry = database.prepare(`INSERT INTO course_entries (study_key, course_id, status, minutes, note, title, updated_at, updated_ms, history_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(study_key, course_id) DO UPDATE SET status=excluded.status, minutes=excluded.minutes,
      note=excluded.note, title=excluded.title, updated_at=excluded.updated_at, updated_ms=excluded.updated_ms, history_json=excluded.history_json
    WHERE excluded.updated_ms >= course_entries.updated_ms`);
  const checkedConfig = database.prepare(`INSERT INTO study_config VALUES (?, ?, ?, ?)
    ON CONFLICT(study_key) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at, updated_ms=excluded.updated_ms`);
  const checkedEntry = database.prepare(`INSERT INTO course_entries (study_key, course_id, status, minutes, note, title, updated_at, updated_ms, history_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(study_key, course_id) DO UPDATE SET status=excluded.status, minutes=excluded.minutes,
      note=excluded.note, title=excluded.title, updated_at=excluded.updated_at, updated_ms=excluded.updated_ms, history_json=excluded.history_json`);
  const version = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  const getState = key => {
    const config = readConfig.get(key);
    const entries = Object.fromEntries(readEntries.all(key).map(row => {
      const record = { status: row.status, minutes: row.minutes, note: row.note,
        ...(row.title === null ? {} : { title: row.title }), updatedAt: row.updated_at,
        ...(row.history_json !== null ? { history: JSON.parse(row.history_json) } : {}) };
      return [row.course_id, { ...record, history: normalizeHistory(row.course_id, record) }];
    }));
    const value = config ? JSON.parse(config.config_json) : null;
    return { config: value, configUpdatedAt: config?.updated_at ?? EMPTY_DATE, entries,
      versions: { config: config ? version([value, config.updated_at]) : null,
        entries: Object.fromEntries(Object.entries(entries).map(([id, record]) => [id,
          version([record.status, record.minutes, record.note, record.title || '', record.updatedAt, record.history])])) },
      serverTime: new Date().toISOString() };
  };

  const handle = async (request, response) => {
    const path = requestPath(request);
    if (path === '/api/health') {
      if (request.method !== 'GET') return json(response, 405, { message: '该接口仅接受 GET。' }, { Allow: 'GET' });
      return json(response, 200, { ok: true });
    }
    if (path === '/api/state' || path === '/api/sync') {
      const method = path === '/api/state' ? 'GET' : 'POST';
      if (request.method !== method) return json(response, 405, { message: `该接口仅接受 ${method}。` }, { Allow: method });
      const rawKey = request.headers['x-study-key'];
      if (typeof rawKey !== 'string' || !STUDY_KEY.test(rawKey)) {
        return json(response, 401, { message: '同步码无效，请使用浏览器生成的同步码。' });
      }
      const key = rawKey.toLowerCase();
      if (method === 'POST') {
        const payload = validatePayload(await readJson(request));
        database.exec('BEGIN IMMEDIATE');
        try {
          const current = getState(key);
          if (payload.expected) {
            const conflicts = { config: payload.config !== undefined && payload.expected.config !== current.versions.config,
              entries: payload.entries.filter(({ id }) => payload.expected.entries[id] !== (current.versions.entries[id] ?? null)).map(({ id }) => id) };
            if (conflicts.config || conflicts.entries.length) {
              database.exec('ROLLBACK');
              return json(response, 409, { message: '另一设备已更新记录，本次未覆盖。请核对记录后选择要保留的内容。', state: current, conflicts });
            }
          }
          if (payload.config) (payload.expected ? checkedConfig : writeConfig).run(key, JSON.stringify(payload.config), payload.configTime.iso, payload.configTime.milliseconds);
          for (const record of payload.entries) {
            const existing = current.entries[record.id];
            // Stale legacy requests are harmless no-ops, even if their note would exceed the history limit.
            if (!payload.expected && existing && record.updatedMilliseconds < Date.parse(existing.updatedAt)) continue;
            let history = record.history;
            if (history !== undefined && existing) {
              const originalTimes = new Map(existing.history.map(item => [item.id, item.createdAt]));
              if (history.some(item => originalTimes.has(item.id) && originalTimes.get(item.id) !== item.createdAt)) throw new RequestError(400, '已有学习记录的时间不能修改，请保留原时间。');
            }
            if (history === undefined) {
              history = existing ? [...existing.history] : [];
              if (record.note && (!existing || record.note !== existing.note)) {
                const addition = normalizeHistory(record.id, { note: record.note, updatedAt: record.updatedAt })[0];
                if (!history.some(item => item.id === addition.id)) history.push(addition);
              }
              try { history = normalizeHistory(record.id, { history }); } catch (error) { throw new RequestError(400, error.message); }
            }
            (payload.expected ? checkedEntry : writeEntry).run(key, record.id, record.status, record.minutes, record.note, record.title,
              record.updatedAt, record.updatedMilliseconds, JSON.stringify(history));
          }
          database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      }
      return json(response, 200, getState(key));
    }
    if (path.startsWith('/api/')) return json(response, 404, { message: '接口不存在。' });
    const file = STATIC_FILES.get(path);
    if (!file) return json(response, 404, { message: '页面不存在。' });
    if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { message: '该页面仅接受 GET 或 HEAD。' }, { Allow: 'GET, HEAD' });
    let content;
    try { content = await readFile(resolve(staticDirectory, file[0])); }
    catch (error) {
      if (error.code === 'ENOENT') return json(response, 404, { message: '页面不存在。' });
      throw error;
    }
    response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': content.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      json(response, error instanceof RequestError ? error.status : 500,
        { message: error instanceof RequestError ? error.message : '服务暂时不可用，请稍后重试。' });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.once('close', () => database.close());
  return server;
}
