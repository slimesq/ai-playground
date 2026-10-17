import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp, BODY_LIMIT } from '../server.js';
import { catalog } from '../catalog.js';

const KEY_A = 'abcdefghijklmnopqrstuvwxyz_1234567890-ABC';
const KEY_B = 'another-private-device_123456789012345678';
const course = catalog.courses[0];
const section = course.sections.find(item => item.lessons.length >= 2);
const otherSection = course.sections.find(item => item.id !== section.id);
const otherCourse = catalog.courses[1];

function payload(changes = {}) {
  return { id: randomUUID(), courseId: course.id, sectionId: section.id,
    lessonIds: [section.lessons[0].id], note: '完成第一遍学习，记录今天的练习。',
    occurredAt: '2026-10-16T15:00:00.000Z', ...changes };
}

function backupRecord(changes = {}) {
  return { ...payload(), createdAt: '2026-10-16T15:10:00.123Z', deletedAt: null, ...changes };
}

async function start(t, options = {}) {
  const app = createApp({ databaseFile: ':memory:', ...options });
  await new Promise((accept, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', accept);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  return {
    ...app, base,
    async call(path = '/api/checkins', { key = KEY_A, method = 'GET', body, headers = {}, rawBody } = {}) {
      const result = await fetch(`${base}${path}`, {
        method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await result.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: result.status, headers: result.headers, data };
    },
  };
}

async function temporaryDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rehab-server-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('health is public; all record routes require a private valid bearer code and disable caching', async t => {
  const app = await start(t);
  assert.deepEqual((await app.call('/api/health', { key: null })).data, { ok: true });
  for (const path of ['/api/checkins', `/api/checkins/${randomUUID()}`, `/api/checkins/${randomUUID()}/restore`, '/api/unknown']) {
    const response = await app.call(path, { key: null });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const key of ['a'.repeat(31), 'a'.repeat(97), 'a'.repeat(31) + '!', 'a'.repeat(31) + ' ']) {
    assert.equal((await app.call('/api/checkins', { key })).status, 401);
  }
  for (const key of ['a'.repeat(32), 'a'.repeat(96)]) {
    assert.equal((await app.call('/api/checkins', { key })).status, 200);
  }
});

test('a check-in preserves actual learning time, adds server creation time, and permits repeated lessons', async t => {
  const app = await start(t, { clock: () => new Date('2026-10-16T16:05:06.789Z') });
  const input = payload({ occurredAt: '2026-10-16T23:00:00+08:00', note: '  保留换行\n与原输入  ' });
  const first = await app.call('/api/checkins', { method: 'POST', body: input });
  assert.equal(first.status, 201);
  assert.deepEqual(first.data.record, { ...input, occurredAt: '2026-10-16T15:00:00.000Z',
    createdAt: '2026-10-16T16:05:06.789Z', deletedAt: null });
  const second = await app.call('/api/checkins', { method: 'POST', body: { ...input, id: randomUUID() } });
  assert.equal(second.status, 201);
  const all = await app.call();
  assert.equal(all.data.records.length, 2);
  assert.equal(all.data.serverTime, '2026-10-16T16:05:06.789Z');
  assert.notEqual(all.data.records[0].id, all.data.records[1].id);
  assert.equal(all.data.records[0].lessonIds[0], all.data.records[1].lessonIds[0]);
});

test('retrying one UUID is idempotent while a changed payload conflicts without overwriting', async t => {
  const app = await start(t);
  const input = payload({ lessonIds: [section.lessons[0].id, section.lessons[1].id, section.lessons[0].id] });
  const first = await app.call('/api/checkins', { method: 'POST', body: input });
  assert.equal(first.status, 201);
  assert.deepEqual(first.data.record.lessonIds, [section.lessons[0].id, section.lessons[1].id]);
  const retry = await app.call('/api/checkins', { method: 'POST', body: { ...input,
    id: input.id.toUpperCase(), lessonIds: [section.lessons[1].id, section.lessons[0].id] } });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, first.data);
  for (const change of [{ note: '改动内容' }, { lessonIds: [section.lessons[0].id] }, { occurredAt: '2026-10-17T15:00:00Z' }]) {
    assert.equal((await app.call('/api/checkins', { method: 'POST', body: { ...input, ...change } })).status, 409);
  }
  assert.deepEqual((await app.call()).data.records, [first.data.record]);
});

test('sync-code namespaces isolate records even when UUIDs match and store only hashed codes', async t => {
  const app = await start(t);
  const input = payload();
  const first = await app.call('/api/checkins', { method: 'POST', body: input });
  assert.deepEqual((await app.call('/api/checkins', { key: KEY_B })).data.records, []);
  for (const [method, path] of [['DELETE', `/api/checkins/${input.id}`], ['POST', `/api/checkins/${input.id}/restore`]]) {
    assert.equal((await app.call(path, { method, key: KEY_B })).status, 404);
  }
  const second = await app.call('/api/checkins', { method: 'POST', key: KEY_B, body: { ...input, note: '另一份独立记录' } });
  assert.equal(second.status, 201);
  assert.deepEqual((await app.call()).data.records, [first.data.record]);
  assert.deepEqual((await app.call('/api/checkins', { key: KEY_B })).data.records, [second.data.record]);
  const namespaces = app.db.prepare('SELECT DISTINCT namespace FROM checkins').all().map(row => row.namespace).sort();
  assert.deepEqual(namespaces, [KEY_A, KEY_B].map(key => createHash('sha256').update(key).digest('hex')).sort());
  assert.equal(JSON.stringify((await app.call()).data).includes(KEY_A), false);
});

test('soft deletion is idempotent and restore retains original content and both original timestamps', async t => {
  let time = '2026-10-16T16:00:00Z';
  const app = await start(t, { clock: () => new Date(time) });
  const input = payload();
  const first = await app.call('/api/checkins', { method: 'POST', body: input });
  time = '2026-10-17T10:00:00Z';
  const deleted = await app.call(`/api/checkins/${input.id}`, { method: 'DELETE' });
  assert.deepEqual(deleted.data, { id: input.id, deletedAt: '2026-10-17T10:00:00.000Z' });
  assert.deepEqual((await app.call()).data.records, []);
  time = '2026-10-18T10:00:00Z';
  assert.deepEqual((await app.call(`/api/checkins/${input.id}`, { method: 'DELETE' })).data, deleted.data);
  const retried = await app.call('/api/checkins', { method: 'POST', body: input });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.record.deletedAt, deleted.data.deletedAt, 'retry does not accidentally undo a deletion');
  assert.deepEqual((await app.call()).data.records, []);
  for (let count = 0; count < 2; count++) {
    const restored = await app.call(`/api/checkins/${input.id}/restore`, { method: 'POST' });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.data, first.data);
  }
  assert.deepEqual((await app.call()).data.records, [first.data.record]);
});

test('records and deletion states survive restart using an isolated SQLite file', async t => {
  const dir = await temporaryDirectory(t);
  const databaseFile = join(dir, 'private', 'records.db');
  const before = await start(t, { databaseFile });
  const active = payload();
  const deleted = payload({ note: '恢复时不能改变时间' });
  const first = (await before.call('/api/checkins', { method: 'POST', body: active })).data.record;
  const second = (await before.call('/api/checkins', { method: 'POST', body: deleted })).data.record;
  await before.call(`/api/checkins/${deleted.id}`, { method: 'DELETE' });
  await before.close();
  const after = await start(t, { databaseFile });
  assert.deepEqual((await after.call()).data.records, [first]);
  assert.deepEqual((await after.call(`/api/checkins/${deleted.id}/restore`, { method: 'POST' })).data.record, second);
  await after.close();
  const storedBytes = await readFile(databaseFile);
  assert.equal(storedBytes.includes(Buffer.from(KEY_A)), false, 'the raw sync code is not written to SQLite');
});

test('invalid IDs, parents, lists, notes and dates are rejected before storing anything', async t => {
  const app = await start(t);
  const invalid = [
    null, [], {}, { ...payload(), extra: 'unrecognized' },
    payload({ id: 'not-a-uuid' }), payload({ id: "'); DROP TABLE checkins;--" }),
    payload({ courseId: '__proto__' }), payload({ courseId: Number(course.id) }),
    payload({ courseId: otherCourse.id }), payload({ sectionId: 'missing' }),
    payload({ sectionId: otherSection.id }), payload({ lessonIds: [] }),
    payload({ lessonIds: [section.lessons[0].id, 'missing'] }),
    payload({ lessonIds: [otherSection.lessons[0].id] }), payload({ lessonIds: null }),
    payload({ lessonIds: [Number(section.lessons[0].id)] }),
    payload({ note: null }), payload({ note: '字'.repeat(2001) }), payload({ note: '\u0000' }),
    ...['2026-02-30T10:00:00Z', '2026-10-16', '2026-10-16T10:00:00', '2026-10-16T24:00:00Z',
      '2026-10-16T10:00:00+25:00', '2026-10-16T10:00:00Zjunk', null].map(occurredAt => payload({ occurredAt })),
  ];
  for (const input of invalid) {
    assert.equal((await app.call('/api/checkins', { method: 'POST', body: input })).status, 400);
  }
  assert.deepEqual((await app.call()).data.records, []);
  assert.equal((await app.call('/api/checkins', { method: 'POST', body: payload({ note: '字'.repeat(2000) }) })).status, 201);
  assert.equal((await app.call('/api/checkins', { method: 'POST', body: payload({ occurredAt: '2028-02-29T10:00:00Z' }) })).status, 201);
});

test('UTF-8 byte limit is enforced for content-length and streamed bodies, and malformed JSON is rejected', async t => {
  const app = await start(t);
  assert.equal((await app.call('/api/checkins', { method: 'POST', rawBody: '{bad json' })).status, 400);
  assert.equal((await app.call('/api/checkins', { method: 'POST', rawBody: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const huge = JSON.stringify(payload({ note: '界'.repeat(Math.ceil(BODY_LIMIT / 3)) }));
  assert.ok(huge.length < BODY_LIMIT, 'test text is smaller in characters but larger in UTF-8 bytes');
  assert.equal((await app.call('/api/checkins', { method: 'POST', rawBody: huge })).status, 413);
  const streamed = await new Promise((accept, reject) => {
    const request = httpRequest(`${app.base}/api/checkins`, { method: 'POST', headers: {
      Authorization: `Bearer ${KEY_A}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
    } }, response => { response.resume(); response.on('end', () => accept(response.statusCode)); });
    request.on('error', reject);
    for (let start = 0; start < huge.length; start += 1000) request.write(huge.slice(start, start + 1000));
    request.end();
  });
  assert.equal(streamed, 413);
  assert.deepEqual((await app.call()).data.records, []);
});

test('foreign and malformed origins fail while direct and proxied same-origin requests succeed', async t => {
  const app = await start(t);
  for (const Origin of ['https://elsewhere.example', 'null', `${app.base}/fake`, `${app.base}?fake`, `${app.base}#fake`, app.base.replace('http:', 'https:')]) {
    const response = await app.call('/api/checkins', { method: 'POST', body: payload(), headers: { Origin } });
    assert.equal(response.status, 403);
  }
  assert.equal((await app.call('/api/checkins', { headers: { Origin: app.base } })).status, 200);
  assert.equal((await app.call('/api/checkins', { headers: { Origin: app.base.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' } })).status, 200);
  assert.deepEqual((await app.call()).data.records, []);
});

test('static serving supports icons and HEAD without exposing source, traversal targets, dotfiles or symlinks', async t => {
  const dir = await temporaryDirectory(t);
  const publicDir = join(dir, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>康复学习</title>');
  await writeFile(join(publicDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(publicDir, '.private.json'), '{"secret":true}');
  await writeFile(join(dir, 'private.json'), '{"secret":true}');
  await symlink(join(dir, 'private.json'), join(publicDir, 'leak.json'));
  const app = await start(t, { publicDir });
  assert.equal((await app.call('/', { key: null })).status, 200);
  const favicon = await app.call('/favicon.svg', { key: null });
  assert.equal(favicon.headers.get('content-type'), 'image/svg+xml');
  const head = await app.call('/', { key: null, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.data, '');
  for (const path of ['/server.js', '/data/rehab.db', '/.private.json', '/%2eprivate.json', '/leak.json', '/%2e%2e%2fprivate.json', '/%5c..%5cprivate.json', '/%00.json']) {
    const response = await app.call(path, { key: null });
    assert.equal(response.status, 404, path);
    assert.equal(JSON.stringify(response.data).includes('secret'), false);
  }
  assert.equal((await app.call('/%ZZ')).status, 400);
  assert.equal((await app.call('/', { method: 'POST', body: {} })).status, 405);
});

test('API methods and unknown records fail without altering the learning timeline', async t => {
  const app = await start(t);
  assert.equal((await app.call('/api/checkins', { method: 'PATCH', body: payload() })).status, 405);
  assert.equal((await app.call('/api/missing')).status, 404);
  assert.equal((await app.call(`/api/checkins/${randomUUID()}`, { method: 'DELETE' })).status, 404);
  assert.equal((await app.call('/api/checkins/not-a-uuid', { method: 'DELETE' })).status, 400);
  assert.deepEqual((await app.call()).data.records, []);
});

test('import restores a backup on another device with exact original learning and creation times', async t => {
  const app = await start(t, { clock: () => new Date('2026-11-20T10:00:00Z') });
  const input = backupRecord({ occurredAt: '2026-10-16T23:00:00.456+08:00', createdAt: '2026-10-16T23:10:00.123+08:00' });
  const first = await app.call('/api/checkins/import', { method: 'POST', body: { records: [input] } });
  assert.equal(first.status, 200);
  const canonical = { ...input, occurredAt: '2026-10-16T15:00:00.456Z', createdAt: '2026-10-16T15:10:00.123Z' };
  assert.deepEqual(first.data, { added: 1, existing: 0, restored: 0, conflicts: [], records: [canonical] });
  assert.deepEqual((await app.call()).data.records, [canonical]);
  const otherDevice = await app.call('/api/checkins/import', { method: 'POST', key: KEY_B, body: { records: first.data.records } });
  assert.deepEqual(otherDevice.data, first.data);
  assert.deepEqual((await app.call('/api/checkins', { key: KEY_B })).data.records, [canonical]);
  const privateRecord = backupRecord({ note: '只属于第二个同步码的记录' });
  await app.call('/api/checkins/import', { method: 'POST', key: KEY_B, body: { records: [privateRecord] } });
  assert.deepEqual((await app.call()).data.records, [canonical], 'import does not mix namespaces');
  assert.equal((await app.call('/api/checkins/import', { method: 'POST', key: null, body: { records: [input] } })).status, 401);
});

test('import is idempotent, deduplicates one UUID, and preserves distinct UUIDs for repeated lessons', async t => {
  const app = await start(t);
  const first = backupRecord({ lessonIds: [section.lessons[0].id, section.lessons[1].id, section.lessons[0].id] });
  const second = { ...first, id: randomUUID() };
  const repeated = { ...first, id: first.id.toUpperCase(), lessonIds: [section.lessons[1].id, section.lessons[0].id] };
  const input = { records: [first, repeated, second] };
  const initial = await app.call('/api/checkins/import', { method: 'POST', body: input });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.added, 2);
  assert.equal(initial.data.records.length, 2);
  assert.deepEqual(initial.data.records.map(item => item.id), [first.id, second.id]);
  assert.deepEqual(initial.data.records[0].lessonIds, [section.lessons[0].id, section.lessons[1].id]);
  for (let count = 0; count < 2; count++) {
    const retry = await app.call('/api/checkins/import', { method: 'POST', body: input });
    assert.deepEqual(retry.data, { ...initial.data, added: 0, existing: 2 });
  }
  assert.equal((await app.call()).data.records.length, 2);
});

test('import keeps conflicting server records unchanged and returns canonical values including deletion state', async t => {
  const app = await start(t, { clock: () => new Date('2026-10-16T18:00:00Z') });
  const active = payload();
  const removed = payload({ note: '已经删除的原记录' });
  const activeRecord = (await app.call('/api/checkins', { method: 'POST', body: active })).data.record;
  const removedRecord = (await app.call('/api/checkins', { method: 'POST', body: removed })).data.record;
  const deletion = await app.call(`/api/checkins/${removed.id}`, { method: 'DELETE' });
  const fresh = backupRecord();
  const result = await app.call('/api/checkins/import', { method: 'POST', body: { records: [
    { ...activeRecord, note: '备份中另一个内容' }, { ...removedRecord, note: '不应恢复这个冲突' }, fresh,
  ] } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { added: 1, existing: 0, restored: 0, conflicts: [active.id, removed.id],
    records: [activeRecord, { ...removedRecord, deletedAt: deletion.data.deletedAt }, fresh] });
  assert.deepEqual((await app.call()).data.records.map(item => item.id).sort(), [active.id, fresh.id].sort());
});

test('import restores a matching deleted record while preserving the server original creation time', async t => {
  let time = '2026-10-16T18:00:00Z';
  const app = await start(t, { clock: () => new Date(time) });
  const input = payload();
  const original = (await app.call('/api/checkins', { method: 'POST', body: input })).data.record;
  time = '2026-10-17T18:00:00Z';
  await app.call(`/api/checkins/${input.id}`, { method: 'DELETE' });
  const body = { records: [{ ...original, createdAt: '2026-10-15T10:00:00.000Z' }] };
  const restored = await app.call('/api/checkins/import', { method: 'POST', body });
  assert.deepEqual(restored.data, { added: 0, existing: 0, restored: 1, conflicts: [], records: [original] });
  assert.deepEqual((await app.call()).data.records, [original]);
  const retry = await app.call('/api/checkins/import', { method: 'POST', body });
  assert.deepEqual(retry.data, { added: 0, existing: 1, restored: 0, conflicts: [], records: [original] });
});

test('an invalid final import record or inconsistent duplicate rejects the entire batch before writes', async t => {
  const app = await start(t);
  const valid = backupRecord();
  for (const invalid of [
    backupRecord({ note: '字'.repeat(2001) }), backupRecord({ createdAt: '2026-02-30T00:00:00Z' }),
    backupRecord({ createdAt: null }), backupRecord({ extra: 'unexpected' }),
    backupRecord({ sectionId: otherSection.id }), backupRecord({ deletedAt: '2026-10-16T00:00:00Z' }),
    { ...valid, note: '相同编号不同内容' }, { ...valid, createdAt: '2026-10-17T15:10:00.123Z' },
  ]) {
    const result = await app.call('/api/checkins/import', { method: 'POST', body: { records: [valid, invalid] } });
    assert.equal(result.status, 400);
    assert.deepEqual((await app.call()).data.records, []);
  }
  for (const body of [null, [], {}, { records: null }, { records: [], syncCode: KEY_B }]) {
    assert.equal((await app.call('/api/checkins/import', { method: 'POST', body })).status, 400);
  }
});

test('import enforces the 100-record and UTF-8 body limits before committing a batch', async t => {
  const app = await start(t);
  const tooMany = Array.from({ length: 101 }, () => backupRecord());
  assert.equal((await app.call('/api/checkins/import', { method: 'POST', body: { records: tooMany } })).status, 400);
  const tooLarge = { records: Array.from({ length: 20 }, () => backupRecord({ note: '界'.repeat(2000) })) };
  assert.ok(JSON.stringify(tooLarge).length < BODY_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > BODY_LIMIT);
  assert.equal((await app.call('/api/checkins/import', { method: 'POST', body: tooLarge })).status, 413);
  assert.deepEqual((await app.call()).data.records, []);
  assert.deepEqual((await app.call('/api/checkins/import', { method: 'POST', body: { records: [] } })).data,
    { added: 0, existing: 0, restored: 0, conflicts: [], records: [] });
  const fullBatch = await app.call('/api/checkins/import', { method: 'POST', body: { records: tooMany.slice(0, 100) } });
  assert.equal(fullBatch.status, 200);
  assert.equal(fullBatch.data.added, 100);
  assert.equal((await app.call()).data.records.length, 100);
});

test('a database failure during import rolls back earlier inserts and restores in the same transaction', async t => {
  const app = await start(t);
  const removed = payload();
  const original = (await app.call('/api/checkins', { method: 'POST', body: removed })).data.record;
  const deletion = await app.call(`/api/checkins/${removed.id}`, { method: 'DELETE' });
  app.db.exec("CREATE TEMP TRIGGER reject_import BEFORE INSERT ON checkins WHEN NEW.note = 'test failure' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const result = await app.call('/api/checkins/import', { method: 'POST', body: { records: [
    original, backupRecord(), backupRecord({ note: 'test failure' }),
  ] } });
  assert.equal(result.status, 500);
  assert.equal(result.data.error.includes('test failure'), false, 'database errors do not leak internals');
  assert.deepEqual((await app.call()).data.records, []);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS total FROM checkins').get().total, 1);
  assert.equal(app.db.prepare('SELECT deleted_at FROM checkins WHERE id = ?').get(removed.id).deleted_at, deletion.data.deletedAt);
});
