import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { catalog } from '../catalog.js';

const STORE_KEY = 'rehab-study-tracker.v1';
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

after(async () => { await browser?.close(); });

async function fixture(t, { width = 1280, height = 900, expectedConsoleErrors = [] } = {}) {
  const app = createApp({ databaseFile: ':memory:' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/`;
  const contexts = [];
  const errors = [];
  t.after(async () => {
    for (const context of contexts) await context.close();
    await app.close();
    assert.deepEqual(errors, [], 'browser scripts must not throw');
  });
  async function attachPage(context) {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !expectedConsoleErrors.some(pattern => pattern.test(message.text()))) {
        errors.push(message.text());
      }
    });
    await page.goto(base);
    await page.locator('#courseNav [data-course-id]').first().waitFor();
    await synced(page);
    return page;
  }
  async function newPage() {
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Asia/Shanghai', acceptDownloads: true });
    contexts.push(context);
    return attachPage(context);
  }
  return { base, page: await newPage(), newPage, newTab: page => attachPage(page.context()) };
}

async function state(page) {
  return page.evaluate(readJournal, STORE_KEY);
}

// Read the durable source directly: localStorage is only an optional cache.
async function readJournal(key) {
  return new Promise((resolve, reject) => {
    const opened = indexedDB.open(key);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result;
      const transaction = db.transaction('journal', 'readonly');
      const request = transaction.objectStore('journal').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

async function serverRecords(base, page) {
  const local = await state(page);
  const response = await fetch(new URL('api/checkins', base), {
    headers: { Authorization: `Bearer ${local.syncKey}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).records;
}

async function synced(page) {
  // Playwright's polling predicate treats a Promise as truthy. Poll the async
  // IndexedDB read here instead of passing an async callback to waitForFunction.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await state(page);
    if (value?.outbox.length === 0 && await page.locator('#syncStatus').getAttribute('data-state') === 'ready') return;
    await delay(30);
  }
  assert.fail(`sync did not settle: ${await page.locator('#syncStatus').textContent()}`);
}

async function openLesson(page, lesson) {
  const button = page.locator(`[data-checkin-lesson="${lesson.id}"]`);
  await button.click();
  await page.locator('#checkinDialog').waitFor({ state: 'visible' });
  assert.deepEqual(await checkedLessons(page), [lesson.id]);
}

async function checkedLessons(page) {
  return page.locator('#checkinLessons input:checked').evaluateAll(inputs => inputs.map(input => input.value));
}

async function save(page, note = '', { waitForSync = true } = {}) {
  await page.locator('#checkinNote').fill(note);
  await page.locator('#saveCheckinButton').click();
  await page.locator('#checkinDialog').waitFor({ state: 'hidden' });
  if (waitForSync) await synced(page);
}

async function closeDialog(page, id = 'checkinDialog') {
  await page.locator(`#${id} .close-dialog`).click();
  await page.locator(`#${id}`).waitFor({ state: 'hidden' });
}

async function selectCourse(page, course) {
  await page.locator(`#courseNav [data-course-id="${course.id}"]`).click();
  await page.waitForFunction(id => document.querySelector('#courseNav [aria-current="page"]')?.dataset.courseId === id, course.id);
}

test('four complete original catalogs and global search retain the official training groups', async t => {
  const { page } = await fixture(t);
  assert.equal(await page.locator('.brand strong').textContent(), '训练手记');
  assert.deepEqual(await page.locator('#courseNav [data-course-id]').evaluateAll(buttons => buttons.map(button => button.dataset.courseId)), catalog.courses.map(course => course.id));
  for (const course of catalog.courses) {
    await selectCourse(page, course);
    assert.equal(await page.locator('#courseHeader h1').textContent(), course.title);
    assert.deepEqual(await page.locator('#catalogContent [data-section-id]').evaluateAll(groups => groups.map(group => group.dataset.sectionId)), course.sections.map(section => section.id));
    assert.equal(Number(await page.locator('#courseHeader progress').getAttribute('max')), course.lessonCount);
    assert.equal(Number(await page.locator('#courseHeader progress').getAttribute('value')), 0);
  }

  await selectCourse(page, catalog.courses[0]);
  await page.locator('#searchInput').fill('腹式呼吸3');
  await page.locator('#section-122014 [data-lesson-id="840388"]').waitFor();
  assert.equal(await page.locator('#section-122014 .group-title').textContent(), '训练日1');
  const expected = catalog.courses.flatMap(course => course.sections.flatMap(section => section.lessons.filter(lesson => `${course.title} ${course.fullTitle} ${section.title} ${lesson.title}`.includes('腹式呼吸3'))));
  assert.deepEqual(await page.locator('#catalogContent [data-lesson-id]').evaluateAll(rows => rows.map(row => row.dataset.lessonId)), expected.map(lesson => lesson.id));
  assert.match(await page.locator('#catalogSummary').textContent(), new RegExp(`全课程搜索.*${expected.length} 节匹配`));
  assert.equal(await page.locator('#courseNav [aria-current="page"]').getAttribute('data-course-id'), catalog.courses[0].id);
  assert.equal(await page.locator('[data-lesson-id="840388"] .lesson-source').getAttribute('href'), 'https://www.bilibili.com/cheese/play/ep840388');

  await page.locator('[data-checkin-lesson="840388"]').click();
  assert.equal(await page.locator('#checkinCourse').textContent(), '腰背康复');
  assert.equal(await page.locator('#checkinSection').textContent(), '训练日1');
  await closeDialog(page);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.checkinLesson), '840388', 'closing a dialog returns keyboard focus to its trigger');

  await page.locator('#searchInput').fill('不存在的动作_42');
  await page.locator('#catalogContent .empty-state').waitFor();
  assert.equal(await page.locator('#catalogContent [data-lesson-id]').count(), 0);
  await page.locator('#catalogSummary [data-reset-filters]').click();
  assert.equal(await page.locator('#searchInput').inputValue(), '');
  assert.equal(await page.locator('#catalogContent [data-section-id]').count(), catalog.courses[0].sections.length);
});

test('repeating one lesson creates separate real-time records, retains both after reload, and counts unique practiced lessons', async t => {
  const { page, base } = await fixture(t);
  const lesson = catalog.courses[0].sections[0].lessons[0];
  const before = Date.now();
  await openLesson(page, lesson);
  await save(page, '第一次记录');
  await openLesson(page, lesson);
  await save(page, '第二次记录');
  const after = Date.now();
  const records = (await serverRecords(base, page)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(record => record.id)).size, 2);
  assert.deepEqual(records.map(record => record.lessonIds), [[lesson.id], [lesson.id]]);
  assert.deepEqual(records.map(record => record.note), ['第一次记录', '第二次记录']);
  for (const record of records) {
    assert.ok(Date.parse(record.occurredAt) >= before && Date.parse(record.occurredAt) <= after, 'check-in time comes from the save action, not a planned date');
    assert.ok(Date.parse(record.createdAt) >= before && Date.parse(record.createdAt) <= after);
  }
  assert.ok(Date.parse(records[1].occurredAt) > Date.parse(records[0].occurredAt));
  assert.equal(await page.locator('#courseHeader progress').getAttribute('value'), '1');
  assert.match(await page.locator(`[data-lesson-id="${lesson.id}"] .lesson-repeat`).textContent(), /2 次/);
  await page.screenshot({ path: '/tmp/rehab-study-tracker-desktop.png', fullPage: false });

  await page.locator('#historyTab').click();
  await page.locator('#historyPanel').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.history-record').evaluateAll(rows => rows.map(row => row.dataset.recordId)), [records[1].id, records[0].id]);
  assert.deepEqual(await page.locator('.history-record time').evaluateAll(times => times.map(time => time.dateTime)), [records[1].occurredAt, records[0].occurredAt]);
  const displayedTimes = await page.locator('.history-record time').allTextContents();
  const format = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  assert.deepEqual(displayedTimes, [records[1], records[0]].map(record => format.format(new Date(record.occurredAt))));
  await page.reload(); await synced(page);
  assert.equal(await page.locator('.history-record').count(), 2);
  assert.deepEqual((await state(page)).records.map(record => record.id).sort(), records.map(record => record.id).sort());
});

test('a group check-in saves only selected actions, preserves plain-text notes, and filters by actual practice', async t => {
  const { page, base } = await fixture(t);
  const section = catalog.courses[0].sections[0];
  await page.locator(`[data-checkin-section="${section.id}"]`).click();
  assert.deepEqual(await checkedLessons(page), section.lessons.map(lesson => lesson.id));
  await page.locator('#toggleAllLessons').click();
  assert.equal(await page.locator('#saveCheckinButton').isDisabled(), true);
  const selected = [section.lessons[0].id, section.lessons[2].id];
  for (const id of selected) await page.locator(`#checkinLessons input[value="${id}"]`).check();
  const note = '<img src=x onerror="window.unexpectedNoteScript=true"> & 保持原文\n第二行';
  await save(page, note);
  const [record] = await serverRecords(base, page);
  assert.deepEqual(record.lessonIds, selected);
  assert.equal(record.sectionId, section.id);
  assert.equal(record.note, note);
  assert.equal(await page.locator('#courseHeader progress').getAttribute('value'), '2');
  await page.locator('[data-filter="practiced"]').click();
  assert.deepEqual(await page.locator('#catalogContent [data-lesson-id]').evaluateAll(rows => rows.map(row => row.dataset.lessonId)), selected);
  await page.locator('[data-filter="unpracticed"]').click();
  assert.equal(await page.locator('#catalogContent [data-lesson-id]').count(), catalog.courses[0].lessonCount - selected.length);
  for (const id of selected) assert.equal(await page.locator(`#catalogContent [data-lesson-id="${id}"]`).count(), 0);

  await page.locator('#historyTab').click();
  assert.equal(await page.locator('.record-note').textContent(), note);
  assert.equal(await page.locator('.record-note img').count(), 0);
  assert.equal(await page.evaluate(() => window.unexpectedNoteScript), undefined);
  await page.locator('.record-lessons summary').click();
  assert.deepEqual(await page.locator('.record-lessons li').allTextContents(), [section.lessons[0].title, section.lessons[2].title]);
  await page.locator('[data-locate-section]').click();
  await page.locator('#catalogPanel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-filter="all"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator(`[data-toggle-section="${section.id}"]`).getAttribute('aria-expanded'), 'true');
});

test('same-code devices see server records and deletion or undo keeps the original record and timestamp', async t => {
  const { page, base, newPage } = await fixture(t);
  const lesson = catalog.courses[0].sections[0].lessons[0];
  await openLesson(page, lesson); await save(page, '跨设备保留');
  const original = (await serverRecords(base, page))[0];
  const syncKey = (await state(page)).syncKey;
  const other = await newPage();
  assert.equal((await state(other)).records.length, 0, 'a new device starts with a separate sync namespace');
  await other.locator('#settingsButton').click();
  await other.locator('#otherSyncKey').fill(syncKey);
  await other.locator('#switchKeyButton').click();
  await other.waitForFunction(key => JSON.parse(localStorage.getItem('rehab-study-tracker.v1')).syncKey === key, syncKey);
  await closeDialog(other, 'settingsDialog');
  await other.locator('#historyTab').click();
  assert.equal(await other.locator(`[data-record-id="${original.id}"]`).count(), 1);

  await other.locator(`[data-delete-record="${original.id}"]`).click();
  await synced(other);
  assert.equal((await serverRecords(base, other)).length, 0);
  await other.locator('#toastRegion button').click();
  await synced(other);
  const restored = (await serverRecords(base, other))[0];
  assert.equal(restored.id, original.id);
  assert.equal(restored.occurredAt, original.occurredAt);
  assert.equal(restored.createdAt, original.createdAt);
  assert.equal(restored.note, original.note);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await synced(page);
  assert.deepEqual((await state(page)).records.map(record => record.id), [original.id]);

  await other.locator(`[data-delete-record="${original.id}"]`).click(); await synced(other);
  await page.reload(); await synced(page);
  assert.equal((await state(page)).records.length, 0, 'a server deletion is reflected on another device after reload');
  assert.equal(await page.locator('#courseHeader progress').getAttribute('value'), '0');
});

test('offline create-delete-restore order survives reload and reconnects without losing or duplicating the record', async t => {
  const { page, base } = await fixture(t, { expectedConsoleErrors: [/status of 503/] });
  let blocked = true;
  const mutations = [];
  await page.route('**/api/checkins**', async route => {
    if (blocked) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试连接暂不可用' }) });
    if (route.request().method() !== 'GET') mutations.push([route.request().method(), new URL(route.request().url()).pathname]);
    await route.continue();
  });
  const lesson = catalog.courses[0].sections[0].lessons[0];
  await openLesson(page, lesson); await save(page, '离线备注仍保留', { waitForSync: false });
  await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'offline');
  const original = (await state(page)).records[0];
  await page.locator('#historyTab').click();
  await page.locator(`[data-delete-record="${original.id}"]`).click();
  await page.locator('#toastRegion button').click();
  assert.deepEqual((await state(page)).outbox.map(operation => operation.kind), ['create', 'delete', 'restore']);
  // Let the failed request release its cross-tab lease before simulating a reload.
  await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'offline');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'offline');
  assert.deepEqual((await state(page)).outbox.map(operation => operation.kind), ['create', 'delete', 'restore']);
  assert.equal(await page.locator('.record-note').textContent(), original.note);
  assert.equal(await page.locator('.history-record time').getAttribute('datetime'), original.occurredAt);

  const originalKey = (await state(page)).syncKey;
  await page.locator('#settingsButton').click();
  await page.locator('#otherSyncKey').fill('b'.repeat(64));
  await page.locator('#switchKeyButton').click();
  await page.waitForFunction(() => document.querySelector('#settingsError').textContent.includes('待同步'));
  assert.equal((await state(page)).syncKey, originalKey, 'switching namespaces cannot strand pending local records');
  await closeDialog(page, 'settingsDialog');
  blocked = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await synced(page);
  assert.deepEqual(mutations, [['POST', '/api/checkins'], ['DELETE', `/api/checkins/${original.id}`], ['POST', `/api/checkins/${original.id}/restore`]]);
  const remote = await serverRecords(base, page);
  assert.equal(remote.length, 1);
  assert.equal(remote[0].id, original.id);
  assert.equal(remote[0].note, original.note);
  assert.equal(remote[0].occurredAt, original.occurredAt);
});

test('an aborted durable write preserves the draft; a failed cache still saves and exports the durable record', async t => {
  const { page, base } = await fixture(t);
  const section = catalog.courses[0].sections[0];
  await page.locator(`[data-checkin-section="${section.id}"]`).click();
  await page.locator('#toggleAllLessons').click();
  const selected = [section.lessons[1].id, section.lessons[3].id];
  for (const id of selected) await page.locator(`#checkinLessons input[value="${id}"]`).check();
  await page.locator('#checkinNote').fill('存储失败也不能丢失这段备注');
  await page.evaluate(() => {
    window.originalJournalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = window.originalJournalPut.call(this, value, key);
      if (this.name === 'journal' && key === 'current') this.transaction.abort();
      return request;
    };
  });
  await page.locator('#saveCheckinButton').click();
  await page.waitForFunction(() => document.querySelector('#checkinError').textContent.length > 0);
  assert.equal(await page.locator('#checkinDialog').isVisible(), true);
  assert.ok(await page.locator('#checkinError').textContent());
  assert.deepEqual(await checkedLessons(page), selected);
  assert.equal(await page.locator('#checkinNote').inputValue(), '存储失败也不能丢失这段备注');
  assert.equal((await state(page)).records.length, 0);
  assert.equal((await serverRecords(base, page)).length, 0);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.originalJournalPut;
    delete window.originalJournalPut;
    window.originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'rehab-study-tracker.v1') throw new DOMException('test cache is full', 'QuotaExceededError');
      return window.originalStorageSetItem.call(this, key, value);
    };
  });
  await page.locator('#saveCheckinButton').click(); await synced(page);
  const local = await state(page);
  assert.equal(local.records.length, 1);
  assert.deepEqual(local.records[0].lessonIds, selected);
  assert.equal(await page.locator('#checkinDialog').isVisible(), false, 'cache failure must not turn a durable save into an error');
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).records.length, STORE_KEY), 0, 'the stale compatibility cache is not mistaken for durable state');
  assert.equal((await serverRecords(base, page)).length, 1);
  await page.locator('#settingsButton').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#settingsExportButton').click();
  const download = await downloaded;
  const text = await readFile(await download.path(), 'utf8');
  const exported = JSON.parse(text);
  assert.equal(exported.format, 'rehab-study-tracker');
  assert.deepEqual(exported.records, local.records);
  assert.equal(exported.version, 2);
  assert.equal(Object.hasOwn(exported, 'pendingOperations'), false);
  assert.equal(text.includes(local.syncKey), false);
  assert.equal(Object.hasOwn(exported, 'syncKey'), false);
  await page.reload(); await synced(page);
  assert.deepEqual((await state(page)).records, local.records, 'reload reads the durable journal even when the former cache was stale');
});

test('two offline tabs atomically preserve both records through reload and sync each one exactly once', async t => {
  const { page, base, newTab } = await fixture(t, { expectedConsoleErrors: [/status of 503/] });
  const other = await newTab(page);
  const originalKey = (await state(page)).syncKey;
  assert.equal((await state(other)).syncKey, originalKey);
  let blocked = true;
  const postedIds = [];
  await page.context().route('**/api/checkins**', async route => {
    if (blocked) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试离线' }) });
    if (route.request().method() === 'POST' && new URL(route.request().url()).pathname === '/api/checkins') postedIds.push(route.request().postDataJSON().id);
    await route.continue();
  });
  const section = catalog.courses[0].sections[0];
  await openLesson(page, section.lessons[0]);
  await openLesson(other, section.lessons[1]);
  await Promise.all([
    save(page, '标签页 A 的记录', { waitForSync: false }),
    save(other, '标签页 B 的记录', { waitForSync: false }),
  ]);
  const beforeReload = await state(page);
  assert.deepEqual(beforeReload.records.map(record => record.note).sort(), ['标签页 A 的记录', '标签页 B 的记录']);
  assert.equal(beforeReload.outbox.length, 2);
  assert.equal(new Set(beforeReload.records.map(record => record.id)).size, 2);
  await Promise.all([page.reload(), other.reload()]);
  for (const tab of [page, other]) {
    await tab.locator('#courseNav [data-course-id]').first().waitFor();
    const restored = await state(tab);
    assert.equal(restored.syncKey, originalKey);
    assert.deepEqual(restored.records.map(record => record.id).sort(), beforeReload.records.map(record => record.id).sort());
    assert.equal(restored.outbox.length, 2);
    await tab.locator('#historyTab').click();
    await tab.locator('.history-record').first().waitFor();
    assert.equal(await tab.locator('.history-record').count(), 2);
  }
  blocked = false;
  await Promise.all([page, other].map(tab => tab.evaluate(() => window.dispatchEvent(new Event('online')))));
  await Promise.all([synced(page), synced(other)]);
  const remote = await serverRecords(base, page);
  assert.deepEqual(remote.map(record => record.id).sort(), beforeReload.records.map(record => record.id).sort());
  assert.deepEqual(postedIds.sort(), beforeReload.records.map(record => record.id).sort(), 'the per-namespace lease prevents tabs from uploading the same queue item twice');
  for (const tab of [page, other]) assert.deepEqual((await state(tab)).outbox, []);
});

test('a delayed sync-code connection cannot discard a new pending check-in in the original namespace', async t => {
  const { page, base } = await fixture(t, { expectedConsoleErrors: [/status of 503/] });
  const originalKey = (await state(page)).syncKey;
  const targetKey = 'c'.repeat(64);
  let releaseTarget;
  let markTargetSeen;
  let blockOriginalWrites = true;
  const targetGate = new Promise(resolve => { releaseTarget = resolve; });
  const targetSeen = new Promise(resolve => { markTargetSeen = resolve; });
  await page.route('**/api/checkins**', async route => {
    const request = route.request();
    if (request.method() === 'GET' && request.headers().authorization === `Bearer ${targetKey}`) {
      markTargetSeen();
      await targetGate;
    }
    if (blockOriginalWrites && request.method() === 'POST' && request.headers().authorization === `Bearer ${originalKey}`) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试旧同步码写入暂不可用' }) });
    }
    await route.continue();
  });
  try {
    await page.locator('#settingsButton').click();
    await page.locator('#otherSyncKey').fill(targetKey);
    await page.locator('#switchKeyButton').click();
    await targetSeen;
    await closeDialog(page, 'settingsDialog');
    await openLesson(page, catalog.courses[0].sections[0].lessons[0]);
    await save(page, '连接等待期间保存的原记录', { waitForSync: false });
    await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'offline');
    const pending = await state(page);
    assert.equal(pending.syncKey, originalKey);
    assert.equal(pending.records.length, 1);
    assert.equal(pending.outbox.length, 1);
    releaseTarget();
    await page.waitForFunction(() => document.querySelector('#settingsError').textContent.includes('待同步'));
    const retained = await state(page);
    assert.equal(retained.syncKey, originalKey);
    assert.deepEqual(retained.records, pending.records);
    assert.deepEqual(retained.outbox, pending.outbox);
    blockOriginalWrites = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await synced(page);
    assert.deepEqual((await serverRecords(base, page)).map(record => record.id), pending.records.map(record => record.id));
    const targetResponse = await fetch(new URL('api/checkins', base), { headers: { Authorization: `Bearer ${targetKey}` } });
    assert.equal(targetResponse.status, 200);
    assert.deepEqual((await targetResponse.json()).records, []);
  } finally { releaseTarget(); }
});

test('an open draft keeps its original namespace when another tab switches the shared sync code', async t => {
  const { page, base, newTab } = await fixture(t);
  const other = await newTab(page);
  const originalKey = (await state(page)).syncKey;
  const targetKey = 'd'.repeat(64);
  const lesson = catalog.courses[0].sections[0].lessons[0];
  await openLesson(page, lesson);
  await page.locator('#checkinNote').fill('属于原同步码的未保存草稿');
  await other.locator('#settingsButton').click();
  await other.locator('#otherSyncKey').fill(targetKey);
  await other.locator('#switchKeyButton').click();
  await other.waitForFunction(key => document.querySelector('#currentSyncKey').value === key, targetKey);
  assert.equal((await state(other)).syncKey, targetKey);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.querySelector('#syncStatus').title.includes('另一标签'));
  await page.locator('#saveCheckinButton').click();
  await page.waitForFunction(() => document.querySelector('#checkinError').textContent.includes('另一标签'));
  assert.equal(await page.locator('#checkinDialog').isVisible(), true);
  assert.equal(await page.locator('#checkinNote').inputValue(), '属于原同步码的未保存草稿');
  assert.deepEqual(await checkedLessons(page), [lesson.id]);
  assert.equal(await page.locator('#saveCheckinButton').isDisabled(), false);
  const canonical = await state(page);
  assert.equal(canonical.syncKey, targetKey);
  assert.deepEqual(canonical.records, []);
  assert.deepEqual(canonical.outbox, []);
  for (const key of [originalKey, targetKey]) {
    const response = await fetch(new URL('api/checkins', base), { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).records, [], 'the draft cannot be silently saved to either namespace');
  }
});

test('320px layouts keep courses and long dialogs within the viewport and allow scrolling to every selection', async t => {
  const { page } = await fixture(t, { width: 320, height: 700 });
  async function noOverflow(selector = 'body') {
    const dimensions = await page.locator(selector).evaluate(element => ({
      scroll: element.scrollWidth, client: element.clientWidth,
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: innerWidth,
    }));
    assert.ok(dimensions.scroll <= dimensions.client + 1, `${selector} has no horizontal scrolling: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.left >= -1 && dimensions.right <= dimensions.viewport + 1, `${selector} fits the viewport`);
  }
  for (const course of catalog.courses) {
    await selectCourse(page, course);
    await noOverflow();
  }
  const knee = catalog.courses.find(course => course.id === '21198');
  const section = knee.sections.find(section => section.title === '理论课');
  await page.locator(`[data-checkin-section="${section.id}"]`).click();
  await noOverflow('#checkinDialog');
  await noOverflow('#checkinLessons');
  assert.equal(await page.locator('#checkinLessons input').count(), section.lessons.length);
  const scroller = await page.locator('#checkinLessons').evaluate(element => ({ scroll: element.scrollHeight, client: element.clientHeight }));
  assert.ok(scroller.scroll > scroller.client, 'long action lists provide vertical scrolling');
  await page.screenshot({ path: '/tmp/rehab-study-tracker-dialog-320.png', fullPage: false });
  const last = page.locator('#checkinLessons input').last();
  await last.uncheck();
  assert.ok(await page.locator('#checkinLessons').evaluate(element => element.scrollTop > 0));
  await page.locator('#checkinNote').fill('手机训练记录');
  await page.locator('#saveCheckinButton').click(); await synced(page);
  await page.locator('#historyTab').click();
  await noOverflow();
  assert.equal(await page.locator('.history-record').count(), 1);
  await page.locator('.record-lessons summary').click();
  assert.equal(await page.locator('.record-lessons li').count(), section.lessons.length - 1);
  await page.locator('#settingsButton').click();
  await noOverflow('#settingsDialog');
  await page.locator('#otherSyncKey').fill('a'.repeat(96));
  await noOverflow('#settingsDialog');
  await closeDialog(page, 'settingsDialog');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settingsButton');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#catalogTab').click();
  await page.locator('#catalogPanel').waitFor({ state: 'visible' });
  await page.screenshot({ path: '/tmp/rehab-study-tracker-mobile-390.png', fullPage: false });
});
