import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { catalog } from '../catalog.js';

const STORE_KEY = 'rehab-study-tracker.v1';
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function state(page) {
  return page.evaluate(key => new Promise((resolve, reject) => {
    const open = indexedDB.open(key);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('journal', 'readonly');
      const get = transaction.objectStore('journal').get('current');
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
      transaction.oncomplete = () => db.close();
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), STORE_KEY);
}

async function until(predicate, message = 'condition did not settle', timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  assert.fail(message);
}

async function synced(page) {
  await until(async () => !(await state(page)).outbox.length
    && await page.locator('#syncStatus').getAttribute('data-state') === 'ready', 'backup sync did not settle');
}

async function fixture(t, { width = 1280, height = 900, expectedConsoleErrors = [], initialSetup, initialSync = true } = {}) {
  const app = createApp({ databaseFile: ':memory:' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/`;
  const contexts = [];
  const errors = [];
  t.after(async () => {
    for (const context of contexts) await context.close();
    await app.close();
    assert.deepEqual(errors, [], 'backup operations must not throw browser errors');
  });
  async function attachPage(context, prepare, waitForSync = true) {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !expectedConsoleErrors.some(pattern => pattern.test(message.text()))) errors.push(message.text());
    });
    if (prepare) {
      await page.route(base, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="icon" href="data:,">' }));
      await page.goto(base);
      await prepare(page);
      await page.unroute(base);
    }
    await page.goto(base);
    await page.locator('#courseNav [data-course-id]').first().waitFor();
    if (waitForSync) await synced(page);
    return page;
  }
  async function newPage(prepare, waitForSync = true) {
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Asia/Shanghai', acceptDownloads: true });
    contexts.push(context);
    return attachPage(context, prepare, waitForSync);
  }
  return { base, page: await newPage(initialSetup, initialSync), newPage, newTab: page => attachPage(page.context()) };
}

function record(courseIndex = 0, sectionIndex = 0, overrides = {}) {
  const course = catalog.courses[courseIndex];
  const section = course.sections[sectionIndex];
  return {
    id: randomUUID(), courseId: course.id, sectionId: section.id,
    lessonIds: section.lessons.slice(0, 2).map(lesson => lesson.id),
    note: `原始记录 · ${course.title} / ${section.title}`,
    occurredAt: '2025-11-03T01:02:03.123Z',
    createdAt: '2025-12-04T05:06:07.456Z', deletedAt: null,
    ...overrides,
  };
}
function backup(records, version = 2, extra = {}) {
  return { format: 'rehab-study-tracker', version, exportedAt: '2026-10-15T12:34:56.789Z', catalogVersion: catalog.version, records, ...extra };
}
const sorted = records => [...records].sort((a, b) => a.id.localeCompare(b.id));

async function api(base, key, path = 'checkins', { method = 'GET', body } = {}) {
  const response = await fetch(new URL(`api/${path}`, base), {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function seed(base, page, records) {
  const key = (await state(page)).syncKey;
  await api(base, key, 'checkins/import', { method: 'POST', body: { records } });
  await page.reload(); await synced(page);
  return key;
}
async function remote(base, page) {
  return (await api(base, (await state(page)).syncKey)).records;
}
async function settings(page) {
  if (!await page.locator('#settingsDialog').isVisible()) await page.locator('#settingsButton').click();
}
async function checkin(page, note) {
  const lesson = catalog.courses[0].sections[0].lessons[0];
  await page.locator(`[data-checkin-lesson="${lesson.id}"]`).click();
  await page.locator('#checkinNote').fill(note);
  await page.locator('#saveCheckinButton').click();
  await page.locator('#checkinDialog').waitFor({ state: 'hidden' });
  await synced(page);
}

async function upload(page, value, name = '训练备份.json') {
  await settings(page);
  await page.locator('#backupFile').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
}
async function preview(page, value, name) {
  await upload(page, value, name);
  await page.locator('#importPreview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#confirmImportButton').isEnabled(), true);
}
async function confirm(page, { online = true } = {}) {
  await page.locator('#confirmImportButton').click();
  await page.locator('#importPreview').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#backupFeedback').textContent(), /已合并/);
  if (online) await synced(page);
}
async function downloadBackup(page) {
  await settings(page);
  const result = page.waitForEvent('download');
  await page.locator('#settingsExportButton').click();
  const download = await result;
  const path = await download.path();
  return { path, text: await readFile(path, 'utf8'), filename: download.suggestedFilename() };
}

// The round trip uses an actual browser download and the file input on a
// separate browser context, not an internal import function or shared storage.
test('a real four-course export imports into a fresh device with original IDs and both timestamps intact', async t => {
  const { base, page, newPage } = await fixture(t);
  await checkin(page, '同一动作第一次打卡');
  await checkin(page, '同一动作第二次打卡');
  const repeatIds = (await state(page)).records.map(record => record.id);
  const seeded = catalog.courses.flatMap((_, courseIndex) => [record(courseIndex, 0), record(courseIndex, 1)]);
  await seed(base, page, seeded);
  const source = await state(page);
  const exported = await downloadBackup(page);
  const data = JSON.parse(exported.text);
  assert.equal(data.format, 'rehab-study-tracker');
  assert.equal(data.version, 2);
  assert.equal(data.catalogVersion, catalog.version);
  assert.deepEqual(sorted(data.records), sorted(source.records));
  assert.equal(new Set(data.records.map(record => record.courseId)).size, 4);
  assert.equal(data.records.length, seeded.length + 2);
  for (const key of ['syncKey', 'outbox', 'pendingOperations']) assert.equal(Object.hasOwn(data, key), false);
  assert.equal(exported.text.includes(source.syncKey), false);

  const target = await newPage();
  const targetKey = (await state(target)).syncKey;
  assert.notEqual(targetKey, source.syncKey);
  await settings(target);
  await target.locator('#backupFile').setInputFiles(exported.path);
  await target.locator('#importPreview').waitFor({ state: 'visible' });
  assert.match(await target.locator('#importSummary').textContent(), new RegExp(`共 ${data.records.length} 条记录`));
  for (const course of catalog.courses) assert.ok((await target.locator('#importSummary').textContent()).includes(course.title));
  assert.equal((await state(target)).records.length, 0, 'choosing a file only previews it');
  assert.equal((await remote(base, target)).length, 0);
  await confirm(target);
  const imported = await state(target);
  assert.equal(imported.syncKey, targetKey);
  assert.deepEqual(sorted(imported.records), sorted(data.records));
  assert.deepEqual(sorted(await remote(base, target)), sorted(data.records));
  assert.ok(repeatIds.every(id => imported.records.some(record => record.id === id)), 'both different-ID repeated check-ins remain independent');
  assert.ok(seeded.every(record => imported.records.some(imported => imported.id === record.id && imported.createdAt === record.createdAt && imported.occurredAt === record.occurredAt)));

  await preview(target, data, exported.filename);
  assert.match(await target.locator('#importSummary').textContent(), /预计新增 0 条/);
  await confirm(target);
  assert.deepEqual(sorted(await remote(base, target)), sorted(data.records), 'reimporting a file never doubles its records');
  await target.reload(); await synced(target);
  assert.deepEqual(sorted((await state(target)).records), sorted(data.records));
});

test('legacy v1 imports its final record snapshot without replaying offline operations or overwriting current records', async t => {
  const { page, base } = await fixture(t);
  const existing = record(3, 3, { note: '目标现有记录必须保留' });
  const originalKey = await seed(base, page, [existing]);
  const incoming = [record(1, 2), record(2, 0)];
  const ghost = record(0, 3, { note: '旧队列中的新增不应重放' });
  const { createdAt, deletedAt, ...ghostPayload } = ghost;
  const legacy = backup([...incoming, { ...existing, note: '文件中的同编号旧内容不得覆盖目标' }], 1, {
    pendingOperations: [
      { opId: randomUUID(), kind: 'delete', id: existing.id },
      { opId: randomUUID(), kind: 'create', payload: ghostPayload },
      { opId: randomUUID(), kind: 'restore', id: ghost.id, record: ghost },
    ],
  });
  const mutations = [];
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') mutations.push([request.method(), new URL(request.url()).pathname]); });
  await preview(page, legacy, '旧版离线记录.json');
  await confirm(page);
  assert.equal((await state(page)).syncKey, originalKey);
  assert.deepEqual(sorted((await state(page)).records), sorted([existing, ...incoming]));
  assert.deepEqual(sorted(await remote(base, page)), sorted([existing, ...incoming]));
  assert.deepEqual(mutations, [['POST', '/api/checkins/import']], 'legacy delete/create/restore diagnostics are never sent to the server');
});

test('cancelled, malformed, foreign, and invalid-final-record backups cannot partially alter local or server data', async t => {
  const { page, base } = await fixture(t);
  const existing = record();
  await seed(base, page, [existing]);
  const baseline = await state(page);
  const candidate = record(2, 2);
  await preview(page, backup([candidate]));
  await page.locator('#cancelImportButton').click();
  assert.equal(await page.locator('#importPreview').isVisible(), false);
  assert.deepEqual(await state(page), baseline);
  const invalidFiles = [
    ['broken.json', '{"format":'],
    ['foreign.json', backup([candidate], 2, { format: 'some-other-tracker' })],
    ['invalid-last.json', backup([candidate, record(1, 0, { lessonIds: ['missing-lesson'] })])],
    ['conflicting-id.json', backup([candidate, { ...candidate, note: '相同编号但内容不同' }])],
  ];
  for (const [name, value] of invalidFiles) {
    await upload(page, value, name);
    await page.waitForFunction(() => {
      const text = document.querySelector('#backupFeedback').textContent;
      return text && !text.includes('正在检查');
    });
    assert.equal(await page.locator('#importPreview').isVisible(), false, `${name} offers no confirmation for invalid data`);
    assert.equal(await page.locator('#confirmImportButton').isVisible(), false);
    assert.deepEqual(await state(page), baseline, `${name} leaves canonical records and the outbox unchanged`);
    assert.deepEqual(await remote(base, page), [existing]);
  }
});

test('confirming a preview merges records added by another tab after preview and preserves existing same-ID content', async t => {
  const { page, base, newTab } = await fixture(t);
  const existing = record(2, 1, { note: '现有原文' });
  const ownerKey = await seed(base, page, [existing]);
  const other = await newTab(page);
  const incoming = [record(1, 1), record(3, 4)];
  await preview(page, backup([...incoming, { ...existing, note: '旧备份副本' }]));
  await checkin(other, '预览后另一标签新增');
  const concurrent = (await state(other)).records.find(record => record.note === '预览后另一标签新增');
  assert.ok(concurrent);
  await confirm(page);
  const expected = [existing, concurrent, ...incoming];
  assert.equal((await state(page)).syncKey, ownerKey);
  assert.deepEqual(sorted((await state(page)).records), sorted(expected));
  assert.deepEqual(sorted(await remote(base, page)), sorted(expected));
  assert.deepEqual(sorted((await state(other)).records), sorted(expected));
});

test('a preview cannot import into a different namespace selected by another tab', async t => {
  const { page, base, newTab } = await fixture(t);
  const originalKey = (await state(page)).syncKey;
  const other = await newTab(page);
  const targetKey = 'e'.repeat(64);
  await preview(page, backup([record(2, 2)]));
  await settings(other);
  await other.locator('#otherSyncKey').fill(targetKey);
  await other.locator('#switchKeyButton').click();
  await other.waitForFunction(key => document.querySelector('#currentSyncKey').value === key, targetKey);
  await page.locator('#confirmImportButton').click();
  await page.waitForFunction(() => document.querySelector('#backupFeedback').textContent.includes('另一标签'));
  const current = await state(page);
  assert.equal(current.syncKey, targetKey);
  assert.deepEqual(current.records, []);
  assert.deepEqual(current.outbox, []);
  for (const key of [originalKey, targetKey]) assert.deepEqual((await api(base, key)).records, []);
});

test('offline Unicode backups larger than 96 KiB persist atomically through reload and sync in bounded batches', async t => {
  const { page, base } = await fixture(t, { expectedConsoleErrors: [/status of 503/] });
  const records = Array.from({ length: 48 }, (_, index) => record(index % 4, index % 2, { note: `${index} ${'训练🙂'.repeat(400)}` }));
  const value = backup(records);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 96 * 1024);
  let blocked = true;
  const requests = [];
  await page.route('**/api/checkins/import', async route => {
    if (blocked) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试离线导入' }) });
    const request = route.request();
    requests.push({ bytes: Buffer.byteLength(request.postData()), records: request.postDataJSON().records });
    await route.continue();
  });
  await preview(page, value, '包含中文和emoji的完整备份.json');
  await confirm(page, { online: false });
  await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'offline');
  const offline = await state(page);
  assert.deepEqual(sorted(offline.records), sorted(records));
  assert.ok(offline.outbox.length > 1);
  assert.ok(offline.outbox.every(operation => operation.kind === 'import'));
  assert.deepEqual(sorted(offline.outbox.flatMap(operation => operation.payload.records)), sorted(records));
  for (const operation of offline.outbox) assert.ok(Buffer.byteLength(JSON.stringify(operation.payload)) <= 96 * 1024);
  assert.deepEqual(await remote(base, page), []);
  const exported = JSON.parse((await downloadBackup(page)).text);
  assert.equal(exported.version, 2);
  assert.deepEqual(sorted(exported.records), sorted(records));
  for (const key of ['syncKey', 'outbox', 'pendingOperations']) assert.equal(Object.hasOwn(exported, key), false);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'offline');
  const restored = await state(page);
  assert.deepEqual(restored.outbox, offline.outbox);
  assert.deepEqual(sorted(restored.records), sorted(records));
  blocked = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await synced(page);
  assert.ok(requests.length > 1);
  assert.ok(requests.every(request => request.bytes <= 96 * 1024 && request.records.length <= 100));
  assert.deepEqual(sorted(requests.flatMap(request => request.records)), sorted(records));
  assert.deepEqual(sorted(await remote(base, page)), sorted(records));
  assert.deepEqual((await state(page)).outbox, []);
});

test('a 320px backup preview wraps its filename and lets the user reach and confirm the merge', async t => {
  const { page, base } = await fixture(t, { width: 320, height: 700 });
  const records = catalog.courses.map((_, index) => record(index, 0));
  const filename = '四门课程备份_<img src=x onerror=alert(1)>_' + '很长的文件名称'.repeat(10) + '.json';
  await preview(page, backup(records), filename);
  assert.equal(await page.locator('.backup-filename').textContent(), filename);
  assert.equal(await page.locator('#importSummary img').count(), 0);
  for (const selector of ['body', '#settingsDialog', '#importPreview']) {
    const size = await page.locator(selector).evaluate(element => ({
      scroll: element.scrollWidth, width: element.clientWidth,
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: innerWidth,
    }));
    assert.ok(size.scroll <= size.width + 1, `${selector} must not scroll horizontally: ${JSON.stringify(size)}`);
    assert.ok(size.left >= -1 && size.right <= size.viewport + 1, `${selector} must fit a 320px screen`);
  }
  await page.locator('#confirmImportButton').scrollIntoViewIfNeeded();
  const button = await page.locator('#confirmImportButton').boundingBox();
  assert.ok(button.y >= 0 && button.y + button.height <= 701, 'confirmation remains reachable inside the scrollable dialog');
  await page.screenshot({ path: '/tmp/rehab-backup-preview-320.png', fullPage: false });
  await confirm(page);
  assert.deepEqual(sorted(await remote(base, page)), sorted(records));
});

test('upgrading a v1 IndexedDB journal preserves existing records and its unsent create operation before importing', async t => {
  const original = record(0, 1, { note: '升级前的离线记录' });
  const { createdAt, deletedAt, ...payload } = original;
  const legacy = { syncKey: 'f'.repeat(64), records: [original], outbox: [{ opId: randomUUID(), kind: 'create', payload }] };
  let blocked = true;
  const { page, base } = await fixture(t, {
    expectedConsoleErrors: [/status of 503/], initialSync: false,
    initialSetup: async page => {
      await page.evaluate(({ key, legacy }) => new Promise((resolve, reject) => {
        const open = indexedDB.open(key, 1);
        open.onupgradeneeded = () => open.result.createObjectStore('journal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('journal', 'readwrite');
          transaction.objectStore('journal').put(legacy, 'current');
          transaction.oncomplete = () => { db.close(); localStorage.setItem(key, JSON.stringify(legacy)); resolve(); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      }), { key: STORE_KEY, legacy });
      await page.route('**/api/checkins**', async route => {
        if (blocked && route.request().method() !== 'GET') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '升级时暂未联网' }) });
        await route.continue();
      });
    },
  });
  await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'offline');
  const version = await page.evaluate(key => new Promise(resolve => {
    const open = indexedDB.open(key);
    open.onsuccess = () => { const version = open.result.version; open.result.close(); resolve(version); };
  }), STORE_KEY);
  assert.equal(version, 2);
  assert.deepEqual(await state(page), legacy, 'the schema upgrade keeps the complete old record and create queue');
  blocked = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await synced(page);
  const oldRemote = await remote(base, page);
  assert.equal(oldRemote.length, 1);
  assert.equal(oldRemote[0].id, original.id);
  assert.equal(oldRemote[0].occurredAt, original.occurredAt);
  assert.equal(oldRemote[0].note, original.note);
  const incoming = record(3, 5);
  await preview(page, backup([incoming])); await confirm(page);
  assert.deepEqual(sorted(await remote(base, page)), sorted([...oldRemote, incoming]));
});
