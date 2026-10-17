import { createServer as createHttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { courses, sections, lessons } from './catalog.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const BODY_LIMIT = 96 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORIZATION = /^Bearer ([A-Za-z0-9_-]{32,96})$/;
const FIELDS = ['id', 'courseId', 'sectionId', 'lessonIds', 'note', 'occurredAt'];
const IMPORT_FIELDS = [...FIELDS, 'createdAt', 'deletedAt'];
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.woff2', 'font/woff2'], ['.webmanifest', 'application/manifest+json'],
]);

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function namespace(request) {
  const match = AUTHORIZATION.exec(request.headers.authorization || '');
  if (!match) throw new RequestError(401, '请提供有效的同步码。');
  return createHash('sha256').update(match[1]).digest('hex');
}

function verifyOrigin(request) {
  if (!request.headers.origin) return;
  const peer = request.socket.remoteAddress;
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const forwarded = loopback ? request.headers['x-forwarded-proto'] : null;
  const protocol = forwarded === 'https' ? 'https:' : request.socket.encrypted ? 'https:' : 'http:';
  let origin;
  let expected;
  try {
    origin = new URL(request.headers.origin);
    expected = new URL(`${protocol}//${request.headers.host}`);
  } catch { throw new RequestError(403, '仅允许当前网站发起请求。'); }
  if (origin.origin !== expected.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new RequestError(403, '仅允许当前网站发起请求。');
  }
}

function readJson(request) {
  const length = request.headers['content-length'];
  if (length && Number(length) > BODY_LIMIT) {
    request.resume();
    throw new RequestError(413, '记录内容过大，请缩短后重试。');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    request.resume();
    throw new RequestError(415, '请使用 JSON 格式提交记录。');
  }
  return new Promise((accept, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const fail = error => { if (!finished) { finished = true; reject(error); } };
    request.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        chunks.length = 0;
        fail(new RequestError(413, '记录内容过大，请缩短后重试。'));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (finished) return;
      finished = true;
      try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new RequestError(400, '记录不是有效的 JSON。')); }
    });
    request.on('aborted', () => fail(new RequestError(400, '记录传输中断，请重试。')));
    request.on('error', () => fail(new RequestError(400, '记录传输失败，请重试。')));
  });
}

function timestamp(value) {
  if (typeof value !== 'string') throw new RequestError(400, '学习时间须为带时区的 ISO 日期。');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new RequestError(400, '学习时间须为带时区的 ISO 日期。');
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
    || !Number.isFinite(Date.parse(value))) {
    throw new RequestError(400, '学习时间无效。');
  }
  const canonical = new Date(value).toISOString();
  if (!/^\d{4}-/.test(canonical)) throw new RequestError(400, '学习时间无效。');
  return canonical;
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RequestError(400, '记录编号须为有效的 UUID。');
  return value.toLowerCase();
}

function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(payload, key))) {
    throw new RequestError(400, '请填写完整的学习记录。');
  }
  const id = uuid(payload.id);
  const { courseId, sectionId, note } = payload;
  if (typeof courseId !== 'string' || !courses.has(courseId)
    || typeof sectionId !== 'string' || sections.get(sectionId)?.courseId !== courseId) {
    throw new RequestError(400, '课程与章节不匹配。');
  }
  if (!Array.isArray(payload.lessonIds) || !payload.lessonIds.length
    || payload.lessonIds.some(lessonId => typeof lessonId !== 'string'
      || lessons.get(lessonId)?.courseId !== courseId || lessons.get(lessonId)?.sectionId !== sectionId)) {
    throw new RequestError(400, '请选择当前章节中的有效课程内容。');
  }
  if (typeof note !== 'string' || note.length > 2000 || note.includes('\u0000')) {
    throw new RequestError(400, '学习记录须为不超过 2000 字的文本。');
  }
  return { id, courseId, sectionId, lessonIds: [...new Set(payload.lessonIds)], note, occurredAt: timestamp(payload.occurredAt) };
}

function record(row) {
  return { id: row.id, courseId: row.course_id, sectionId: row.section_id,
    lessonIds: JSON.parse(row.lesson_ids_json), note: row.note, occurredAt: row.occurred_at,
    createdAt: row.created_at, deletedAt: row.deleted_at };
}

function equalPayload(existing, incoming) {
  return existing.courseId === incoming.courseId && existing.sectionId === incoming.sectionId
    && existing.note === incoming.note && existing.occurredAt === incoming.occurredAt
    && JSON.stringify([...existing.lessonIds].sort()) === JSON.stringify([...incoming.lessonIds].sort());
}

function validateImport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 1 || !Array.isArray(payload.records) || payload.records.length > 100) {
    throw new RequestError(400, '每次最多导入 100 条完整学习记录。');
  }
  const unique = new Map();
  for (const input of payload.records) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== IMPORT_FIELDS.length
      || IMPORT_FIELDS.some(field => !Object.hasOwn(input, field)) || input.deletedAt !== null) {
      throw new RequestError(400, '备份须包含完整、未删除的学习记录。');
    }
    const incoming = { ...validate(Object.fromEntries(FIELDS.map(field => [field, input[field]]))),
      createdAt: timestamp(input.createdAt), deletedAt: null };
    const previous = unique.get(incoming.id);
    if (previous && (!equalPayload(previous, incoming) || previous.createdAt !== incoming.createdAt)) {
      throw new RequestError(400, '备份中相同记录编号对应了不同内容，请检查后重试。');
    }
    if (!previous) unique.set(incoming.id, incoming);
  }
  return [...unique.values()];
}

export function createApp(options = {}) {
  const databaseFile = options.databaseFile ?? process.env.DATABASE_FILE ?? resolve(ROOT, 'data/rehab.db');
  const publicDir = resolve(options.publicDir ?? resolve(ROOT, 'public'));
  const clock = options.clock ?? (() => new Date());
  const now = () => clock().toISOString();
  if (databaseFile !== ':memory:') mkdirSync(dirname(resolve(databaseFile)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databaseFile);
  if (databaseFile !== ':memory:') chmodSync(databaseFile, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS checkins (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      lesson_ids_json TEXT NOT NULL,
      note TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (namespace, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS checkins_timeline ON checkins(namespace, occurred_at DESC, created_at DESC);
  `);
  const find = db.prepare('SELECT * FROM checkins WHERE namespace = ? AND id = ?');
  const list = db.prepare('SELECT * FROM checkins WHERE namespace = ? AND deleted_at IS NULL ORDER BY occurred_at DESC, created_at DESC, id');
  const insert = db.prepare('INSERT INTO checkins (namespace, id, course_id, section_id, lesson_ids_json, note, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const remove = db.prepare('UPDATE checkins SET deleted_at = ? WHERE namespace = ? AND id = ? AND deleted_at IS NULL');
  const restore = db.prepare('UPDATE checkins SET deleted_at = NULL WHERE namespace = ? AND id = ?');
  let dbClosed = false;
  const closeDb = () => { if (!dbClosed) { dbClosed = true; db.close(); } };

  async function serveStatic(request, response, rawPath) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new RequestError(405, '此资源不支持该操作。');
    let path;
    try { path = decodeURIComponent(rawPath); } catch { throw new RequestError(400, '资源路径无效。'); }
    if (path.includes('\\') || path.includes('\u0000') || path.split('/').some(part => part.startsWith('.'))) {
      throw new RequestError(404, '未找到该资源。');
    }
    const filename = resolve(publicDir, `.${path === '/' ? '/index.html' : path}`);
    if (!filename.startsWith(`${publicDir}${sep}`) || !MIME.has(extname(filename))) throw new RequestError(404, '未找到该资源。');
    let actual;
    try {
      actual = await realpath(filename);
      if (!actual.startsWith(`${await realpath(publicDir)}${sep}`) || !(await stat(actual)).isFile()) throw new Error('not public');
      const body = await readFile(actual);
      response.writeHead(200, { 'Content-Type': MIME.get(extname(filename)), 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (response.headersSent) throw error;
      throw new RequestError(404, '未找到该资源。');
    }
  }

  async function handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    const rawPath = (request.url || '/').split('?')[0];
    if (!rawPath.startsWith('/')) throw new RequestError(400, '请求路径无效。');
    if (!rawPath.startsWith('/api/')) return serveStatic(request, response, rawPath);
    response.setHeader('Cache-Control', 'no-store');
    verifyOrigin(request);
    if (rawPath === '/api/health' && request.method === 'GET') return json(response, 200, { ok: true });
    const key = namespace(request);
    if (rawPath === '/api/checkins' && request.method === 'GET') {
      return json(response, 200, { records: list.all(key).map(record), serverTime: now() });
    }
    if (rawPath === '/api/checkins' && request.method === 'POST') {
      const payload = validate(await readJson(request));
      const existingRow = find.get(key, payload.id);
      if (existingRow) {
        const existing = record(existingRow);
        if (!equalPayload(existing, payload)) throw new RequestError(409, '此记录编号已用于其他内容，请保留原记录并重新添加。');
        return json(response, 200, { record: existing });
      }
      insert.run(key, payload.id, payload.courseId, payload.sectionId, JSON.stringify(payload.lessonIds), payload.note, payload.occurredAt, now());
      return json(response, 201, { record: record(find.get(key, payload.id)) });
    }
    if (rawPath === '/api/checkins/import') {
      if (request.method !== 'POST') throw new RequestError(405, '该接口不支持此操作。');
      // Validate the entire batch before starting any writes, including duplicate IDs.
      const incoming = validateImport(await readJson(request));
      const result = { added: 0, existing: 0, restored: 0, conflicts: [], records: [] };
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const payload of incoming) {
          const existingRow = find.get(key, payload.id);
          if (!existingRow) {
            insert.run(key, payload.id, payload.courseId, payload.sectionId, JSON.stringify(payload.lessonIds),
              payload.note, payload.occurredAt, payload.createdAt);
            result.added++;
          } else {
            const existing = record(existingRow);
            if (!equalPayload(existing, payload)) {
              result.conflicts.push(payload.id);
            } else if (existing.deletedAt !== null) {
              restore.run(key, payload.id);
              result.restored++;
            } else {
              result.existing++;
            }
          }
          result.records.push(record(find.get(key, payload.id)));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(response, 200, result);
    }
    const target = /^\/api\/checkins\/([^/]+)(\/restore)?$/.exec(rawPath);
    if (target && (target[2] ? request.method === 'POST' : request.method === 'DELETE')) {
      const id = uuid(target[1]);
      if (!find.get(key, id)) throw new RequestError(404, '未找到该学习记录。');
      if (target[2]) {
        restore.run(key, id);
        return json(response, 200, { record: record(find.get(key, id)) });
      }
      remove.run(now(), key, id);
      return json(response, 200, { id, deletedAt: find.get(key, id).deleted_at });
    }
    if (rawPath === '/api/checkins' || target || rawPath === '/api/health') throw new RequestError(405, '该接口不支持此操作。');
    throw new RequestError(404, '未找到该接口。');
  }

  const server = createHttpServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent || response.destroyed) { response.end(); return; }
      json(response, error instanceof RequestError ? error.status : 500,
        { error: error instanceof RequestError ? error.message : '暂时无法处理记录，请稍后重试。' });
    });
  });
  server.on('close', closeDb);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server, db,
    close: () => new Promise((accept, reject) => {
      if (!server.listening) { closeDb(); accept(); return; }
      server.close(error => { if (error) reject(error); else accept(); });
    }),
  };
}

export function createStudyServer(options) { return createApp(options).server; }
export const createServer = createStudyServer;
