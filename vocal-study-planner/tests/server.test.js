import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createStudyServer } from '../server.js';
import { normalizeHistory, normalizeJournalTimestamp, MAX_HISTORY_BYTES, SYNC_BODY_LIMIT } from '../public/journal.js';

const FIRST = '2026-10-05T08:00:00.000Z';
const SECOND = '2026-10-05T09:00:00.000Z';
const THIRD = '2026-10-05T10:00:00.000Z';
const config = { startDate: '2026-10-05', program: 'full', days: [1, 3, 6], sessionMinutes: 30 };
const entry = (updatedAt = FIRST, extra = {}) => ({ status: 'learning', minutes: 15,
  note: '已练习一次', title: '开班典礼', updatedAt, ...extra });
const storedEntry = (id, value, history = normalizeHistory(id, value)) => ({ ...value, history });

async function fixture(t, { legacyRows = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vocal-server-'));
  const databasePath = join(directory, 'data', 'study.db');
  const staticDirectory = join(directory, 'public');
  await mkdir(staticDirectory);
  await Promise.all(['index.html', 'app.js', 'app.css', 'plan.js', 'journal.js', 'favicon.svg', 'icons.svg'].map(file => writeFile(join(staticDirectory, file), `fixture ${file}`)));
  await Promise.all(['favicon.ico', 'favicon.png'].map(async file => writeFile(join(staticDirectory, file), await readFile(new URL(`../public/${file}`, import.meta.url)))));
  if (legacyRows.length) {
    await mkdir(join(directory, 'data'));
    const old = new DatabaseSync(databasePath);
    old.exec(`CREATE TABLE course_entries (study_key TEXT NOT NULL, course_id TEXT NOT NULL, status TEXT NOT NULL,
      minutes INTEGER NOT NULL, note TEXT NOT NULL, title TEXT, updated_at TEXT NOT NULL, updated_ms INTEGER NOT NULL,
      PRIMARY KEY(study_key, course_id));`);
    const insert = old.prepare('INSERT INTO course_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const { key, id, record } of legacyRows) insert.run(key, id, record.status, record.minutes, record.note, record.title ?? null, record.updatedAt, Date.parse(record.updatedAt));
    old.close();
  }
  let server;
  let base;
  const start = async () => {
    server = createStudyServer({ databasePath, staticDirectory });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return {
    databasePath, restart: async () => { await stop(); await start(); },
    async static(path, method = 'GET') {
      const response = await fetch(`${base}${path}`, { method });
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, body, text: body.toString('utf8') };
    },
    async call(path, { key, payload, method = payload === undefined ? 'GET' : 'POST', raw, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, { method,
        headers: { ...(key ? { 'X-Study-Key': key } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: raw ?? (payload === undefined ? undefined : JSON.stringify(payload)) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
    async raw(path, { method = 'GET', key, body = '', chunked = false } = {}) {
      return new Promise((resolve, reject) => {
        const request = httpRequest(base, { path, method,
          headers: { ...(key ? { 'X-Study-Key': key } : {}),
            ...(body ? { 'Content-Type': 'application/json', ...(chunked ? {} : { 'Content-Length': Buffer.byteLength(body) }) } : {}) } }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        request.on('error', reject);
        if (chunked) { request.write(body.slice(0, 50000)); request.write(body.slice(50000)); request.end(); }
        else request.end(body);
      });
    },
  };
}

test('health, authentication, methods and whitelisted static routes', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/health')).body, { ok: true });
  for (const key of [undefined, 'bad-key', `${randomUUID()}x`]) {
    const response = await f.call('/api/state', { key });
    assert.equal(response.status, 401);
    assert.ok(response.body.message);
    assert.equal(JSON.stringify(response.body).includes(key || 'undefined'), false);
  }
  assert.equal((await f.call('/api/state', { method: 'POST', key: randomUUID(), payload: { entries: {} } })).status, 405);
  assert.equal((await f.call('/api/sync', { key: randomUUID() })).status, 405);
  assert.equal((await f.call('/api/users')).status, 404);
  for (const path of ['/../server.js', '/%2e%2e/server.js', '/%2e%2e/app.js', '/%2e%2e/journal.js', '/%2e%2e/favicon.svg', '/%2e%2e/favicon.ico', '/%2e%2e/favicon.png', '/%2e%2e/icons.svg', '/%2f..%2fserver.js', '/app.js%00', '/%5cserver.js', '/%ZZ']) {
    assert.equal((await f.raw(path)).status, 400, path);
  }
  assert.equal((await f.raw('/server.js')).status, 404);
  assert.equal((await f.raw('/icons.svg.bak')).status, 404);
  assert.equal((await f.raw('/favicon.ico.bak')).status, 404);
  for (const [path, mime] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/app.js', 'text/javascript'],
    ['/app.css', 'text/css'], ['/plan.js', 'text/javascript'], ['/journal.js', 'text/javascript'], ['/favicon.svg', 'image/svg+xml'], ['/icons.svg', 'image/svg+xml'],
    ['/favicon.ico?v=20261005-2', 'image/x-icon'], ['/favicon.png?v=20261005-2', 'image/png'],
    ['/favicon-20261005-r3.ico', 'image/x-icon'], ['/favicon-20261005-r3.png', 'image/png']]) {
    const response = await f.static(path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    if (mime === 'image/x-icon') {
      assert.equal(response.body.readUInt16LE(0), 0);
      assert.equal(response.body.readUInt16LE(2), 1);
      assert.equal(response.body.readUInt16LE(4), 3);
      assert.deepEqual([0, 1, 2].map(index => [response.body[6 + index * 16], response.body[7 + index * 16]]), [[16, 16], [32, 32], [48, 48]]);
    } else if (mime === 'image/png') {
      assert.equal(response.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(response.body.readUInt32BE(16), 32);
      assert.equal(response.body.readUInt32BE(20), 32);
    } else assert.ok(response.text.startsWith('fixture '));
    const head = await f.static(path, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), response.headers.get('content-type'));
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
    assert.equal(head.headers.get('cache-control'), response.headers.get('cache-control'));
    assert.equal(head.text, '');
  }
});

test('fresh profiles are isolated, reads do not create rows, and data persists after restart', async t => {
  const f = await fixture(t);
  const firstKey = randomUUID();
  const secondKey = randomUUID();
  const empty = await f.call('/api/state', { key: firstKey });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.config, null);
  assert.equal(empty.body.configUpdatedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(empty.body.entries, {});
  assert.ok(Number.isFinite(Date.parse(empty.body.serverTime)));
  const inspection = new DatabaseSync(f.databasePath, { readOnly: true });
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM study_config').get().count, 0);
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM course_entries').get().count, 0);
  inspection.close();
  const written = await f.call('/api/sync', { key: firstKey, payload: {
    config, configUpdatedAt: FIRST, entries: { 's1-01': entry() },
  } });
  assert.equal(written.status, 200);
  assert.deepEqual(written.body.config, config);
  assert.deepEqual(written.body.entries['s1-01'], storedEntry('s1-01', entry()));
  assert.deepEqual((await f.call('/api/state', { key: secondKey })).body.entries, {});
  assert.equal((await f.call('/api/state', { key: secondKey })).body.config, null);
  await f.call('/api/sync', { key: secondKey, payload: { entries: { 's1-01': entry(SECOND, { note: '另一个独立计划' }) } } });
  await f.restart();
  const restored = await f.call('/api/state', { key: firstKey });
  assert.deepEqual(restored.body.entries['s1-01'], storedEntry('s1-01', entry()));
  assert.deepEqual(restored.body.config, config);
  assert.equal(restored.body.configUpdatedAt, FIRST);
  assert.equal((await f.call('/api/state', { key: secondKey })).body.entries['s1-01'].note, '另一个独立计划');
});

test('per-course last-write wins retains omitted courses and permits explicit correction', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  await f.call('/api/sync', { key, payload: { entries: { 's1-01': entry(SECOND), 's2-20': entry(FIRST, { title: '期末考试' }) } } });
  const stale = await f.call('/api/sync', { key, payload: { entries: { 's1-01': entry(FIRST, { minutes: 1 }) } } });
  assert.equal(stale.body.entries['s1-01'].minutes, 15);
  assert.ok(stale.body.entries['s2-20']);
  const corrected = entry(THIRD, { status: 'pending', minutes: 0, note: '' });
  const latest = await f.call('/api/sync', { key, payload: { entries: { 's1-01': corrected } } });
  assert.deepEqual(latest.body.entries['s1-01'], storedEntry('s1-01', corrected, normalizeHistory('s1-01', entry(SECOND))));
  assert.ok(latest.body.entries['s2-20']);
  const tie = await f.call('/api/sync', { key, payload: { entries: { 's1-01': entry(THIRD, { status: 'done', minutes: 25 }) } } });
  assert.equal(tie.body.entries['s1-01'].status, 'done');
  const offset = await f.call('/api/sync', { key, payload: { entries: { 's3-01': entry('2026-10-05T18:00:00+08:00', { title: '发声练习' }) } } });
  assert.equal(offset.body.entries['s3-01'].updatedAt, THIRD);
  const optionalTitle = entry(THIRD);
  delete optionalTitle.title;
  const without = await f.call('/api/sync', { key, payload: { entries: { 's4-20': optionalTitle } } });
  assert.equal(without.status, 200);
  assert.equal(Object.hasOwn(without.body.entries['s4-20'], 'title'), false);
});

test('config updates are timestamped independently and omitted config stays unchanged', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  await f.call('/api/sync', { key, payload: { config, configUpdatedAt: SECOND, entries: {} } });
  const stale = await f.call('/api/sync', { key, payload: { config: { ...config, program: 'basic' }, configUpdatedAt: FIRST, entries: {} } });
  assert.equal(stale.body.config.program, 'full');
  assert.equal(stale.body.configUpdatedAt, SECOND);
  const omitted = await f.call('/api/sync', { key, payload: { configUpdatedAt: THIRD, entries: { 's1-02': entry() } } });
  assert.equal(omitted.body.configUpdatedAt, SECOND);
  assert.deepEqual(omitted.body.config, config);
  const partialConfig = await f.call('/api/sync', { key, payload: { config: { program: 'basic' }, configUpdatedAt: THIRD, entries: {} } });
  assert.equal(partialConfig.status, 200);
  assert.equal(partialConfig.body.config.program, 'basic');
});

test('conditional writes reject stale versions atomically and an explicit choice needs the latest version', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const original = await f.call('/api/sync', { key, payload: { config, configUpdatedAt: FIRST,
    entries: { 's1-01': entry(), 's1-02': entry() }, expected: { config: null, entries: { 's1-01': null, 's1-02': null } } } });
  assert.equal(original.status, 200);
  assert.match(original.body.versions.entries['s1-01'], /^[a-f0-9]{64}$/);
  const remote = await f.call('/api/sync', { key, payload: { entries: { 's1-01': entry(SECOND, { note: '另一设备的新笔记' }) } } });
  const stale = await f.call('/api/sync', { key, payload: { config: { ...config, startDate: '2026-11-02' }, configUpdatedAt: THIRD,
    entries: { 's1-01': entry(THIRD, { note: '尚未拉取新笔记的草稿' }), 's1-02': entry(THIRD, { status: 'done' }) },
    expected: { config: original.body.versions.config, entries: { 's1-01': original.body.versions.entries['s1-01'], 's1-02': original.body.versions.entries['s1-02'] } } } });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.conflicts, { config: false, entries: ['s1-01'] });
  assert.deepEqual(stale.body.state.entries, remote.body.entries);
  assert.deepEqual(stale.body.state.config, config);
  const after = await f.call('/api/state', { key });
  assert.deepEqual(after.body.entries['s1-02'], storedEntry('s1-02', entry()), 'a conflict prevents unrelated parts of the same request from being stored');
  assert.deepEqual(after.body.config, config);
  const resolved = await f.call('/api/sync', { key, payload: { entries: { 's1-01': entry(THIRD, { note: '明确选择保留本地草稿' }) },
    expected: { entries: { 's1-01': after.body.versions.entries['s1-01'] } } } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.entries['s1-01'].note, '明确选择保留本地草稿');
  assert.deepEqual(resolved.body.entries['s1-02'], storedEntry('s1-02', entry()));
});

test('versions protect equal-timestamp edits, absence, schedule changes and concurrent writers', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const initial = await f.call('/api/sync', { key, payload: { config, configUpdatedAt: FIRST, entries: { 's1-01': entry() } } });
  const sameTime = await f.call('/api/sync', { key, payload: { config: { ...config, days: [2, 6] }, configUpdatedAt: FIRST,
    entries: { 's1-01': entry(FIRST, { note: '相同时间戳的新内容' }), 's1-03': entry() } } });
  assert.notEqual(sameTime.body.versions.entries['s1-01'], initial.body.versions.entries['s1-01']);
  const rejected = await f.call('/api/sync', { key, payload: { config, configUpdatedAt: SECOND, entries: { 's1-01': entry(SECOND), 's1-03': entry(SECOND) },
    expected: { config: initial.body.versions.config, entries: { 's1-01': initial.body.versions.entries['s1-01'], 's1-03': null } } } });
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.body.conflicts, { config: true, entries: ['s1-01', 's1-03'] });
  const competitors = await Promise.all(['A', 'B'].map(note => f.call('/api/sync', { key, payload: { entries: { 's1-01': entry(THIRD, { note }) },
    expected: { entries: { 's1-01': sameTime.body.versions.entries['s1-01'] } } } })));
  assert.deepEqual(competitors.map(value => value.status).sort(), [200, 409]);
  const winner = competitors.find(value => value.status === 200).body.entries['s1-01'];
  assert.deepEqual((await f.call('/api/state', { key })).body.entries['s1-01'], winner);
  await f.restart();
  assert.equal((await f.call('/api/state', { key })).body.versions.entries['s1-01'], competitors.find(value => value.status === 200).body.versions.entries['s1-01']);
});

test('old databases expose stable legacy history without inventing an original creation time', async t => {
  const key = randomUUID();
  const otherKey = randomUUID();
  const original = entry();
  const f = await fixture(t, { legacyRows: [
    { key, id: 's1-01', record: original },
    { key, id: 's1-02', record: entry(FIRST, { note: '' }) },
    { key: otherKey, id: 's1-01', record: entry(SECOND, { note: '另一个同步码的旧记录' }) },
  ] });
  const first = (await f.call('/api/state', { key })).body;
  const history = first.entries['s1-01'].history;
  assert.equal(history.length, 1);
  assert.equal(history[0].legacy, true);
  assert.equal(history[0].createdAt, FIRST, 'the only known old time is updatedAt');
  assert.equal(history[0].note, original.note);
  assert.match(history[0].id, /^legacy-s1-01-[a-f0-9]{16}$/);
  assert.deepEqual(first.entries['s1-02'].history, []);
  assert.deepEqual(normalizeHistory('s1-01', original), history, 'old browser and old backup normalization match the server');
  const inspection = new DatabaseSync(f.databasePath, { readOnly: true });
  assert.ok(inspection.prepare('PRAGMA table_info(course_entries)').all().some(column => column.name === 'history_json'));
  assert.equal(inspection.prepare('SELECT history_json FROM course_entries WHERE study_key = ? AND course_id = ?').get(key, 's1-01').history_json, null, 'GET does not write converted history');
  inspection.close();
  const corrected = entry(SECOND, { status: 'done', title: '核对后的课名' });
  const changed = await f.call('/api/sync', { key, payload: { entries: { 's1-01': corrected } } });
  assert.deepEqual(changed.body.entries['s1-01'].history, history, 'a title or completion edit does not redate the old note');
  await f.restart();
  assert.deepEqual((await f.call('/api/state', { key })).body.entries['s1-01'].history, history);
  assert.equal((await f.call('/api/state', { key: otherKey })).body.entries['s1-01'].history[0].note, '另一个同步码的旧记录');
});

test('journal entries retain their creation times, survive retries and legacy writes, and can be restored with CAS', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const first = { id: randomUUID(), createdAt: FIRST, note: '第一次练习记录' };
  const second = { id: randomUUID(), createdAt: SECOND, note: '第二次练习记录' };
  const record = entry(FIRST, { note: first.note, history: [first] });
  const created = await f.call('/api/sync', { key, payload: { entries: { 's1-01': record }, expected: { entries: { 's1-01': null } } } });
  assert.equal(created.status, 200);
  const next = entry(SECOND, { note: second.note, history: [first, second] });
  const payload = { entries: { 's1-01': next }, expected: { entries: { 's1-01': created.body.versions.entries['s1-01'] } } };
  const saved = await f.call('/api/sync', { key, payload });
  assert.deepEqual(saved.body.entries['s1-01'].history, [first, second]);
  const redated = await f.call('/api/sync', { key, payload: { entries: { 's1-01': { ...next, history: [{ ...first, createdAt: THIRD }, second] } }, expected: { entries: { 's1-01': saved.body.versions.entries['s1-01'] } } } });
  assert.equal(redated.status, 400);
  assert.match(redated.body.message, /时间不能修改/);
  const retry = await f.call('/api/sync', { key, payload });
  assert.equal(retry.status, 409);
  assert.deepEqual(retry.body.state.entries['s1-01'], next, 'the rejected retry exposes the exact already-stored journal for client acknowledgement');
  const legacy = entry(THIRD, { status: 'done', note: second.note });
  const marked = await f.call('/api/sync', { key, payload: { entries: { 's1-01': legacy } } });
  assert.deepEqual(marked.body.entries['s1-01'].history, [first, second]);
  const oldNote = entry('2026-10-05T11:00:00.000Z', { note: '旧页面新增的记录' });
  const appended = await f.call('/api/sync', { key, payload: { entries: { 's1-01': oldNote } } });
  assert.deepEqual(appended.body.entries['s1-01'].history.slice(0, 2), [first, second]);
  assert.equal(appended.body.entries['s1-01'].history[2].legacy, true);
  assert.equal(appended.body.entries['s1-01'].history[2].createdAt, oldNote.updatedAt);
  const duplicate = await f.call('/api/sync', { key, payload: { entries: { 's1-01': oldNote } } });
  assert.deepEqual(duplicate.body.entries['s1-01'].history, appended.body.entries['s1-01'].history, 'repeating an old-client save does not duplicate its legacy entry');
  const beforeHistoryChange = duplicate.body.versions.entries['s1-01'];
  const changedHistory = { ...duplicate.body.entries['s1-01'], history: [first, second] };
  const sameStamp = await f.call('/api/sync', { key, payload: { entries: { 's1-01': changedHistory }, expected: { entries: { 's1-01': beforeHistoryChange } } } });
  assert.equal(sameStamp.status, 200);
  assert.notEqual(sameStamp.body.versions.entries['s1-01'], beforeHistoryChange, 'history is part of the CAS version even when other fields have not changed');
  const staleUndo = await f.call('/api/sync', { key, payload: { entries: { 's1-01': record }, expected: { entries: { 's1-01': beforeHistoryChange } } } });
  assert.equal(staleUndo.status, 409);
  const undo = await f.call('/api/sync', { key, payload: { entries: { 's1-01': { ...record, updatedAt: '2026-10-05T12:00:00.000Z' } }, expected: { entries: { 's1-01': sameStamp.body.versions.entries['s1-01'] } } } });
  assert.equal(undo.status, 200);
  assert.deepEqual(undo.body.entries['s1-01'].history, [first], 'explicit history can restore an earlier journal without changing original creation times');
  await f.restart();
  assert.deepEqual((await f.call('/api/state', { key })).body.entries['s1-01'].history, [first]);
  assert.deepEqual((await f.call('/api/state', { key: randomUUID() })).body.entries, {});
});

test('history validation and byte limits reject the whole request without dropping saved history', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const item = { id: randomUUID(), createdAt: FIRST, note: '一次练习' };
  const history = Array.from({ length: 10 }, () => ({ id: randomUUID(), createdAt: FIRST, note: '练'.repeat(3000) }));
  assert.ok(Buffer.byteLength(JSON.stringify(history)) < MAX_HISTORY_BYTES);
  const original = entry(FIRST, { note: history.at(-1).note, history });
  const seeded = await f.call('/api/sync', { key, payload: { config, configUpdatedAt: FIRST, entries: { 's1-01': original } } });
  assert.equal(seeded.status, 200);
  const invalid = [null, {}, [null], [{ ...item, id: 'bad-id' }], [{ ...item, createdAt: '2026-02-30T00:00:00.000Z' }],
    [{ ...item, note: 'x'.repeat(4001) }], [{ ...item, legacy: false }], [{ ...item, extra: true }],
    [item, { ...item, id: item.id.toUpperCase() }], [{ ...item, id: 'legacy-s1-02-0123456789abcdef', legacy: true }],
    Array.from({ length: 12 }, () => ({ id: randomUUID(), createdAt: FIRST, note: '练'.repeat(3000) }))];
  for (const value of invalid) {
    const result = await f.call('/api/sync', { key, payload: { config: { ...config, program: 'basic' }, configUpdatedAt: SECOND,
      entries: { 's1-01': entry(SECOND, { history: value }), 's1-02': entry() } } });
    assert.equal(result.status, 400);
    assert.ok(result.body.message);
  }
  const overflowingLegacy = await f.call('/api/sync', { key, payload: { config: { ...config, program: 'basic' }, configUpdatedAt: SECOND,
    entries: { 's1-01': entry(SECOND, { note: '新'.repeat(4000) }), 's1-02': entry() } } });
  assert.equal(overflowingLegacy.status, 400);
  assert.match(overflowingLegacy.body.message, /历史记录过大/);
  const after = (await f.call('/api/state', { key })).body;
  assert.deepEqual(after.entries, seeded.body.entries);
  assert.deepEqual(after.config, config);
  assert.equal(after.configUpdatedAt, FIRST);
  assert.ok(Buffer.byteLength(JSON.stringify({ entries: { 's1-01': original }, expected: { entries: { 's1-01': after.versions.entries['s1-01'] } } })) < SYNC_BODY_LIMIT);
  const copy = structuredClone([item]);
  normalizeHistory('s1-01', { history: copy });
  assert.deepEqual(copy, [item], 'normalization does not mutate past records');
  assert.equal(normalizeJournalTimestamp('2026-10-05T16:00:00+08:00'), FIRST);
  assert.deepEqual(normalizeHistory('s1-01', entry('2026-10-05T16:00:00+08:00')), normalizeHistory('s1-01', entry(FIRST)), 'equivalent timestamps create the same legacy identifier');
  assert.throws(() => normalizeJournalTimestamp('9999-12-31T23:59:59-23:59'), /ISO/);
});

test('invalid bodies are rejected before any part of the request is stored', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const invalidRecords = [
    { status: 'unknown' }, { minutes: -1 }, { minutes: 0.5 }, { minutes: 100001 }, { minutes: '15' },
    { note: null }, { note: 'a'.repeat(4001) }, { title: 4 }, { title: 'a'.repeat(161) },
    { updatedAt: '2026-02-30T08:00:00.000Z' }, { updatedAt: '2026-10-05' },
    { updatedAt: '2026-10-05T24:00:00.000Z' }, { updatedAt: '2026-10-05T08:00:00+99:00' }, { unexpected: true },
  ];
  const invalidBodies = [null, [], {}, { entries: [] }, { entries: null }, { entries: {}, unexpected: true },
    { entries: { 's1-00': entry() } }, { entries: { 's1-15': entry() } }, { entries: { 's2-21': entry() } },
    { entries: { 's5-01': entry() } }, { entries: { 's1-01': null } }, { entries: { 's1-01': {} } },
    ...invalidRecords.map(change => ({ entries: { 's1-01': entry(), 's1-02': entry(FIRST, change) } })),
    ...[{ startDate: '2026-02-30' }, { program: 'other' }, { days: [1, 1] }, { days: [1] },
      { sessionMinutes: 25 }, { startDate: null }, { days: 'Monday' }, { extra: true }]
      .map(change => ({ config: { ...config, ...change }, configUpdatedAt: FIRST, entries: { 's1-01': entry() } })),
    { config, entries: {} }, { config: null, configUpdatedAt: FIRST, entries: {} },
    { configUpdatedAt: 'invalid', entries: {} },
    { entries: {}, expected: null }, { entries: {}, expected: { entries: {}, config: null } },
    { entries: { 's1-01': entry() }, expected: { entries: {} } },
    { entries: { 's1-01': entry() }, expected: { entries: { 's1-01': 'not-a-version' } } },
    { entries: { 's1-01': entry() }, expected: { entries: { 's1-01': null, 's1-02': null } } },
    { config, configUpdatedAt: FIRST, entries: {}, expected: { entries: {} } },
  ];
  for (const payload of invalidBodies) {
    const response = await f.call('/api/sync', { key, payload });
    assert.equal(response.status, 400);
    assert.ok(response.body.message);
  }
  assert.equal((await f.call('/api/sync', { key, method: 'POST', raw: '{"entries":' })).status, 400);
  const unchanged = await f.call('/api/state', { key });
  assert.deepEqual(unchanged.body.entries, {});
  assert.equal(unchanged.body.config, null);
});

test('oversized declared and chunked request bodies return 413 without writing data', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const body = JSON.stringify({ entries: {}, padding: 'x'.repeat(160 * 1024) });
  for (const chunked of [false, true]) {
    const response = await f.raw('/api/sync', { method: 'POST', key, body, chunked });
    assert.equal(response.status, 413);
    assert.ok(response.body.message);
  }
  assert.deepEqual((await f.call('/api/state', { key })).body.entries, {});
});
