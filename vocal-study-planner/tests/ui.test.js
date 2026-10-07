import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createStudyServer } from '../server.js';
import { DEFAULT_CONFIG, LESSONS, buildPlan } from '../public/plan.js';

let directory, server, browser, base;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vocal-ui-'));
  server = createStudyServer({ databasePath: join(directory, 'test.db') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function pageAt(t, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Shanghai', acceptDownloads: true });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.clock.setFixedTime(new Date('2026-10-05T13:30:00Z'));
  await page.goto(base);
  await page.locator('#catalogList .catalog-group').first().waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent.startsWith('已同步'));
  return page;
}

async function state(page) {
  return page.evaluate(() => {
    const key = localStorage.getItem('vocal-study-planner:active-key');
    return { key, ...JSON.parse(localStorage.getItem('vocal-study-planner:profile:' + key)) };
  });
}

async function waitSync(page) {
  await page.waitForFunction(() => !document.querySelector('#syncNowBtn').disabled && document.querySelector('#syncStatus').textContent.startsWith('已同步'));
}

async function expandPhase(page, phaseId) {
  const toggle = page.locator(`[data-phase-toggle="${phaseId}"]`);
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
async function openCourse(page, id) {
  const lesson = LESSONS.find(item => item.id === id);
  assert.ok(lesson, id);
  await page.locator('#catalogPhase').selectOption('all');
  await page.locator('#catalogStatus').selectOption('all');
  await page.locator('#catalogSearch').fill('');
  await expandPhase(page, lesson.phaseId);
  await page.locator(`#catalogList [data-lesson-id="${id}"] .lesson-card-title`).click();
  await page.locator('#lessonDialog').waitFor({ state: 'visible' });
}
async function close(page, id = 'lessonDialog') { await page.locator(`#${id} [data-close="${id}"]`).first().click(); }
async function openData(page) {
  if (!(await page.locator('#settingsDialog').evaluate(dialog => dialog.open))) await page.locator('#openSettings').click();
  if (!(await page.locator('#dataPanel').evaluate(panel => panel.open))) await page.locator('#dataPanel summary').click();
}

async function syncCourseRecords(page, patches) {
  await waitSync(page);
  const current = await state(page);
  const newest = Math.max(Date.parse(current.configUpdatedAt), ...Object.values(current.entries).map(record => Date.parse(record.updatedAt)));
  const updatedAt = new Date(newest + 100).toISOString();
  const entries = Object.fromEntries(Object.entries(patches).map(([id, patch]) => {
    const record = { status: 'pending', minutes: 0, note: '', ...current.entries[id], ...patch, updatedAt };
    if (Object.hasOwn(patch, 'note') && !Object.hasOwn(patch, 'history')) delete record.history;
    return [id, record];
  }));
  const response = await fetch(base + 'api/sync', {
    method: 'POST', headers: { 'X-Study-Key': current.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  assert.equal(response.status, 200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitSync(page);
}

async function syncCourseStatuses(page, statuses) {
  await syncCourseRecords(page, Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, minutes: 0 }])));
}

test('one learning page groups each course once under its first planned week', async t => {
  const page = await pageAt(t);
  assert.equal(await page.locator('#pageTitle').textContent(), '学习计划');
  assert.equal(await page.locator('#todayView').isVisible(), true);
  assert.equal(await page.locator('#catalogView').isVisible(), true);
  assert.equal(await page.locator('.primary-nav, #planView, #stageOverview, #phasePanel, #weekSchedule, #schedulePanel, #weekSelect, #firstWeek, #nextWeek').count(), 0);
  assert.equal(await page.locator('#catalogList .catalog-group').count(), 4);
  const ids = await page.locator('#catalogList .lesson-card').evaluateAll(cards => cards.map(card => card.dataset.lessonId));
  assert.equal(ids.length, 74);
  assert.equal(new Set(ids).size, 74, 'repeat practice sessions do not duplicate course check-in cards');
  assert.equal(await page.locator('[data-phase-toggle="foundation"]').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-phase-toggle="style"]').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's1-01');
  assert.deepEqual(await page.locator('#phase-foundation .week-group[data-week="1"] .lesson-card').evaluateAll(cards =>
    cards.map(card => card.dataset.lessonId)), ['s1-01', 's1-02']);
  assert.match(await page.locator('#phase-foundation .week-group[data-week="1"] .week-heading').textContent(), /第\s*1\s*周/);
  assert.match(await page.locator('#catalogList [data-lesson-id="s1-10"] .lesson-card-meta').textContent(), /第\s*6\s*[–—-]\s*7\s*周/);

  const weekOneTone = await page.locator('#phase-foundation .week-group[data-week="1"]').getAttribute('data-week-tone');
  const weekTwoTone = await page.locator('#phase-foundation .week-group[data-week="2"]').getAttribute('data-week-tone');
  assert.ok(['a', 'b'].includes(weekOneTone));
  assert.ok(['a', 'b'].includes(weekTwoTone));
  assert.notEqual(weekOneTone, weekTwoTone, 'adjacent weeks alternate their grouping tone');
  const scheduled = buildPlan();
  for (const phase of scheduled.phasePlans) {
    const firstSession = scheduled.sessions.find(session => session.phaseId === phase.id);
    const card = page.locator(`#catalogList [data-lesson-id="${firstSession.lessonId}"]`);
    const group = await card.evaluate(element => ({
      week: Number(element.closest('.week-group').dataset.week),
      tone: element.closest('.week-group').dataset.weekTone,
    }));
    assert.equal(group.week, firstSession.weekNumber, `${phase.id} uses its scheduled calendar week`);
    assert.equal(group.tone, group.week % 2 ? 'a' : 'b', 'week tones stay tied to calendar weeks across rest gaps');
  }
});

test('phase rest weeks stay inside their preceding phase, preserve course totals and update program completion dates', async t => {
  const page = await pageAt(t);
  const separators = page.locator('#catalogList .phase-rest');
  const expectedRests = [
    { after: 'foundation', before: 'breath', dates: ['2026-12-05', '2026-12-11'] },
    { after: 'breath', before: 'voice', dates: ['2027-02-27', '2027-03-05'] },
    { after: 'voice', before: 'style', dates: ['2027-05-19', '2027-05-25'] },
  ];
  assert.equal(await separators.count(), 3);
  for (const expected of expectedRests) {
    const marker = page.locator(`#catalogList .phase-rest[data-before-phase="${expected.before}"]`);
    const text = await marker.textContent();
    assert.match(text, /休息一周/);
    assert.deepEqual(await marker.locator('time').evaluateAll(times => times.map(time => time.getAttribute('datetime'))), expected.dates);
    for (const date of expected.dates) {
      assert.ok(text.includes(`${date.slice(0, 4)}.${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))}`));
    }
    assert.equal(await marker.getAttribute('data-after-phase'), expected.after);
    assert.equal(await marker.evaluate(element => element.parentElement.id), `phase-${expected.after}`);
    assert.equal(await marker.evaluate(element => element === element.parentElement.lastElementChild), true,
      'rest follows all courses within its preceding phase');
    assert.equal(await marker.locator('button, input, .lesson-card').count(), 0, 'rest is a schedule note, not a check-in task');
    const toggle = page.locator(`[data-phase-toggle="${expected.after}"]`);
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    assert.equal(await marker.isVisible(), true);
    await toggle.click();
    assert.equal(await marker.isVisible(), false, 'collapsing its phase hides the rest note');
    await toggle.click();
    assert.equal(await marker.isVisible(), true, 'reopening its phase restores the rest note');
  }
  assert.equal(await page.locator('#catalogList > .phase-rest').count(), 0);
  assert.equal(await page.locator('#phase-style .phase-rest').count(), 0, 'the final phase has no trailing rest');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 74);
  assert.equal(await page.locator('#overallProgress [role="progressbar"]').getAttribute('aria-valuemax'), '74');
  assert.equal(await page.locator('#overallProgress [role="progressbar"]').getAttribute('aria-valuenow'), '0');
  for (const [selector, value, reset] of [
    ['#catalogSearch', '呼吸', ''],
    ['#catalogStatus', 'pending', 'all'],
    ['#catalogPhase', 'breath', 'all'],
  ]) {
    const control = page.locator(selector);
    if (selector === '#catalogSearch') await control.fill(value); else await control.selectOption(value);
    assert.equal(await separators.count(), 0, `${selector} hides unrelated rest separators`);
    if (selector === '#catalogSearch') await control.fill(reset); else await control.selectOption(reset);
    assert.equal(await separators.count(), 3);
  }
  await page.locator('#openSettings').click();
  assert.match(await page.locator('#settingsPreview').textContent(), /阶段间各休息一周（共 3 周）/);
  assert.match(await page.locator('#settingsPreview').textContent(), /2027\.8\.9/);
  await page.locator('#program').selectOption('basic');
  assert.match(await page.locator('#settingsPreview').textContent(), /阶段间各休息一周（共 2 周）/);
  assert.match(await page.locator('#settingsPreview').textContent(), /2027\.5\.18/);
  await page.locator('#saveSettings').click();
  assert.equal(await separators.count(), 2);
  assert.equal(await page.locator('#catalogList .phase-rest[data-before-phase="style"]').count(), 0);
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 54);
  assert.equal(await page.locator('#overallProgress [role="progressbar"]').getAttribute('aria-valuemax'), '54');
  await waitSync(page); await page.reload(); await waitSync(page);
  assert.equal(await separators.count(), 2, 'rest weeks survive a saved program change and reload');
});

test('a status-filtered phase keeps its full-course denominator', async t => {
  const page = await pageAt(t);
  await page.locator('#catalogList [data-lesson-id="s1-01"] .lesson-complete').click();
  await page.locator('#catalogStatus').selectOption('done');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 1);
  assert.match(await page.locator('[data-phase-toggle="foundation"] .catalog-stage-count').textContent(), /1\s*\/\s*14/,
    'one matching completed result is still one of fourteen phase lessons');
  await page.locator('#catalogStatus').selectOption('pending');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 73);
  assert.match(await page.locator('[data-phase-toggle="foundation"] .catalog-stage-count').textContent(), /1\s*\/\s*14/);
});

test('search reaches later weeks without changing their tone and clears all catalog filters', async t => {
  const page = await pageAt(t);
  const styleWeek = buildPlan().sessions.find(session => session.lessonId === 's4-01').weekNumber;
  const styleGroup = page.locator(`#phase-style .week-group[data-week="${styleWeek}"]`);
  const originalTone = await styleGroup.getAttribute('data-week-tone');
  await page.locator('#catalogSearch').fill('平衡混声技巧与实践运用一');
  assert.equal(await page.locator('#catalogList [data-lesson-id="s4-01"]').isVisible(), true);
  await page.locator('#catalogList [data-lesson-id="s4-01"] .lesson-complete').click();
  await page.locator('#catalogSearch').fill('');
  await page.locator('#catalogPhase').selectOption('style');
  await page.locator('#catalogStatus').selectOption('done');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 1);
  assert.equal(await styleGroup.getAttribute('data-week-tone'), originalTone);
  await page.locator('#catalogSearch').fill('不存在的混声课程');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 0);
  assert.equal(await page.locator('[data-clear-search]').count(), 1, 'an empty result still has one clear-filter action');

  await page.locator('#catalogSearch').fill('平衡混声');
  assert.equal(await page.locator('#catalogPhase').inputValue(), 'style');
  assert.equal(await page.locator('#catalogStatus').inputValue(), 'done');
  assert.deepEqual(await page.locator('#catalogList .lesson-card').evaluateAll(cards => cards.map(card => card.dataset.lessonId)), ['s4-01']);
  assert.match(await page.locator('#catalogCount').innerText(), /阶段|风格/);
  assert.match(await page.locator('#catalogCount').innerText(), /已完成/);
  assert.equal(await page.locator('#catalogCount #clearCatalogFilters').count(), 1);
  assert.equal(await styleGroup.getAttribute('data-week-tone'), originalTone);

  await page.locator('#clearCatalogFilters').click();
  assert.equal(await page.locator('#catalogPhase').inputValue(), 'all');
  assert.equal(await page.locator('#catalogStatus').inputValue(), 'all');
  assert.equal(await page.locator('#catalogSearch').inputValue(), '');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 74);
});

test('legacy week links locate a group without filtering the directory, including after browser Back', async t => {
  const page = await pageAt(t);
  await page.goto(`${base}#plan/week/18`);
  await page.reload();
  await page.locator('#catalogList .catalog-group').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 74);
  const target = page.locator('#phase-breath .week-group[data-week="18"] .week-heading');
  assert.equal(await target.isVisible(), true);
  assert.match(await target.textContent(), /第\s*18\s*周/);
  await page.waitForFunction(() => {
    const heading = document.querySelector('#phase-breath .week-group[data-week="18"] .week-heading');
    const box = heading?.getBoundingClientRect();
    return box && box.top < innerHeight && box.bottom > 0;
  });
  assert.equal(await page.locator('#todayView').isVisible(), true);
  assert.equal(await page.locator('#catalogView').isVisible(), true);
  await page.evaluate(() => { location.hash = '#catalog'; });
  await page.waitForFunction(() => location.hash === '#catalog');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 74);
  assert.equal(await page.locator('#catalogHeading').isVisible(), true);
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#plan/week/18');
  assert.equal(await target.isVisible(), true);
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 74);
  assert.equal(await page.locator('#pageTitle').textContent(), '学习计划');
});

test('legacy minutes stay intact when notes are saved, completed, undone and refreshed', async t => {
  const page = await pageAt(t);
  await syncCourseRecords(page, {
    's1-03': { status: 'learning', minutes: 25, note: '旧学习记录' },
    's1-04': { status: 'learning', minutes: 35, note: '' },
  });
  assert.equal((await state(page)).entries['s1-04'].status, 'learning', 'existing learning states are not migrated');
  await openCourse(page, 's1-03');
  assert.equal((await state(page)).config.sessionMinutes, DEFAULT_CONFIG.sessionMinutes);
  assert.equal(await page.locator('#lessonMinutes, [data-add-minutes]').count(), 0);
  await page.locator('#lessonNote').fill('音符辨认；录音待复听。<script>alert(1)</script>');
  await page.locator('#saveLesson').click();
  assert.equal((await state(page)).entries['s1-03'].status, 'learning');
  assert.equal((await state(page)).entries['s1-03'].minutes, 25);
  assert.equal(await page.locator('#lessonNote').inputValue(), '', 'saving a note clears the composer');
  assert.equal(await page.locator('#lessonDialog .history-entry').count(), 2);
  await page.locator('#lessonComplete').click();
  assert.equal((await state(page)).entries['s1-03'].status, 'done');
  await page.locator('#lessonDialog .toast-action').click();
  const record = (await state(page)).entries['s1-03'];
  assert.equal(record.status, 'learning'); assert.equal(record.minutes, 25);
  assert.match(record.note, /<script>/);
  assert.equal(record.history.length, 2, 'completion Undo does not remove prior learning entries');
  assert.equal(record.history.filter(item => item.legacy).length, 1);
  assert.equal(record.history.find(item => item.legacy).note, '旧学习记录');
  assert.equal(await page.locator('#lessonComplete').textContent(), '完成此课');
  await close(page); await waitSync(page); await page.reload(); await waitSync(page);
  await openCourse(page, 's1-03');
  assert.equal((await state(page)).entries['s1-03'].minutes, 25);
  assert.equal(await page.locator('#lessonNote').inputValue(), '');
  const notes = await page.locator('#lessonDialog .history-entry .history-note').allTextContents();
  assert.ok(notes.some(note => note.includes('旧学习记录')));
  assert.ok(notes.some(note => note.includes('录音待复听')));
  assert.match(await page.locator('#lessonDialog .history-entry').filter({ hasText: '旧学习记录' }).textContent(), /原有记录.*最后更新时间/);
  assert.equal(await page.locator('#lessonDialog script').count(), 0);
  await close(page);
  const oldCourse = page.locator('#catalogList [data-lesson-id="s1-04"]');
  await oldCourse.locator('.lesson-complete').click();
  assert.equal((await state(page)).entries['s1-04'].status, 'done');
  await oldCourse.locator('.lesson-complete').click();
  assert.equal((await state(page)).entries['s1-04'].status, 'pending', 'hidden historical minutes do not imply active learning');
  assert.equal((await state(page)).entries['s1-04'].minutes, 35);
  await openCourse(page, 's1-04');
  await page.locator('#lessonComplete').click(); await page.locator('#lessonComplete').click();
  assert.equal((await state(page)).entries['s1-04'].status, 'pending');
  assert.equal((await state(page)).entries['s1-04'].minutes, 35);
});

test('learning notes append with second-precision times, survive sync and backup, and Undo removes only the new entry', async t => {
  const page = await pageAt(t);
  await openCourse(page, 's1-05');
  const originalTitle = await page.locator('#lessonTitleInput').inputValue();
  const additions = [
    ['2026-10-05T13:30:00.000Z', '第一段练习'],
    ['2026-10-05T13:31:07.000Z', '第二段练习'],
    ['2026-10-05T13:32:09.000Z', '第二段练习'],
  ];
  const ids = [];
  for (const [clockTime, note] of additions) {
    await page.clock.setFixedTime(new Date(clockTime));
    await page.locator('#lessonNote').fill(note);
    await page.locator('#saveLesson').click();
    const record = (await state(page)).entries['s1-05'];
    assert.equal(record.history.length, ids.length + 1);
    assert.equal(record.history.at(-1).note, note);
    assert.equal(record.note, note, 'legacy latest-note field follows the newest history entry');
    assert.equal(await page.locator('#lessonNote').inputValue(), '', 'the composer clears after each save');
    assert.equal(await page.locator('#lessonHistoryTitle').isVisible(), true);
    assert.equal(await page.locator('#lessonDialog ol.history-list li.history-entry').count(), ids.length + 1);
    const item = record.history.at(-1);
    ids.push(item.id);
    const timelineEntry = page.locator(`#lessonDialog .history-entry[data-history-id="${item.id}"]`);
    assert.equal(await timelineEntry.locator('.history-note').textContent(), note);
    const time = timelineEntry.locator('time[datetime]');
    assert.equal(await time.getAttribute('datetime'), item.createdAt);
    const shanghaiTime = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(item.createdAt));
    assert.ok((await time.textContent()).includes(shanghaiTime), 'visible time includes Shanghai seconds');
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal(await page.locator('#lessonDialog .history-note').filter({ hasText: '第二段练习' }).count(), 2,
    'saving identical text again is a separate event');
  const beforeUndo = (await state(page)).entries['s1-05'].history;
  assert.ok(Date.parse(beforeUndo[0].createdAt) < Date.parse(beforeUndo[1].createdAt));
  assert.ok(Date.parse(beforeUndo[1].createdAt) < Date.parse(beforeUndo[2].createdAt));

  await page.locator('#lessonDialog .toast-action').click();
  const afterUndo = (await state(page)).entries['s1-05'];
  assert.deepEqual(afterUndo.history.map(item => item.id), ids.slice(0, 2));
  assert.equal(afterUndo.note, '第二段练习');
  assert.equal(await page.locator('#lessonDialog .history-entry').count(), 2);
  await page.locator('#lessonComplete').click();
  assert.equal((await state(page)).entries['s1-05'].history.length, 2);
  await page.locator('#lessonComplete').click();
  assert.equal((await state(page)).entries['s1-05'].history.length, 2);
  await page.locator('#lessonTitleInput').fill(`${originalTitle}（练习版）`);
  await page.locator('#saveLesson').click();
  assert.equal((await state(page)).entries['s1-05'].history.length, 2, 'renaming does not fabricate a learning event');
  await close(page); await waitSync(page); await page.reload(); await waitSync(page);
  await openCourse(page, 's1-05');
  assert.equal(await page.locator('#lessonNote').inputValue(), '');
  assert.deepEqual((await state(page)).entries['s1-05'].history.map(item => item.createdAt),
    afterUndo.history.map(item => item.createdAt));
  const key = (await state(page)).key;
  const synced = await fetch(base + 'api/state', { headers: { 'X-Study-Key': key } }).then(response => response.json());
  assert.deepEqual(synced.entries['s1-05'].history.map(item => item.createdAt),
    afterUndo.history.map(item => item.createdAt));
  await close(page); await openData(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBackup').click();
  const exported = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.entries['s1-05'].history.map(item => item.createdAt),
    afterUndo.history.map(item => item.createdAt));

  const restoredPage = await pageAt(t);
  await openData(restoredPage);
  restoredPage.once('dialog', dialog => dialog.accept());
  await restoredPage.locator('#restoreFile').setInputFiles({
    name: 'history-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  });
  await restoredPage.waitForFunction(() => document.querySelector('#dataFeedback').textContent.includes('已恢复'));
  assert.deepEqual((await state(restoredPage)).entries['s1-05'].history.map(item => item.createdAt),
    afterUndo.history.map(item => item.createdAt));
  await close(restoredPage, 'settingsDialog');
  await openCourse(restoredPage, 's1-05');
  assert.equal(await restoredPage.locator('#lessonDialog .history-entry').count(), 2);
  assert.equal(await restoredPage.locator('#lessonNote').inputValue(), '');
});

test('learning records have no time control, and the settings icon actually renders', async t => {
  const page = await pageAt(t);
  await syncCourseRecords(page, {
    's1-02': { status: 'learning', minutes: 35, note: '旧记录仍保留' },
    's1-03': { status: 'done', minutes: 0, note: '' },
  });
  const statusIcons = [];
  for (const [id, status] of [['s1-01', 'pending'], ['s1-02', 'learning'], ['s1-03', 'done']]) {
    const badge = page.locator(`#catalogList [data-lesson-id="${id}"] .lesson-status.${status}`);
    assert.equal(await badge.count(), 1);
    statusIcons.push(await badge.locator('svg use').getAttribute('href'));
  }
  assert.equal(new Set(statusIcons).size, 3, 'pending, learning, and done have distinct visible icons');
  const assets = await page.evaluate(async () => {
    const links = Array.from(document.querySelectorAll('link[rel="icon"]'));
    const icons = await Promise.all(links.map(async link => {
      const url = new URL(link.getAttribute('href'), location.href);
      const response = await fetch(url);
      return { origin: url.origin, path: url.pathname, status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    }));
    const button = document.querySelector('#openSettings svg');
    return { icons, settingsIconWidth: button.getBBox().width };
  });
  assert.ok(assets.icons.some(icon => /\/favicon(?:-[a-z0-9-]+)?\.png$/.test(icon.path)));
  assert.ok(assets.icons.some(icon => /\/favicon(?:-[a-z0-9-]+)?\.ico$/.test(icon.path)));
  for (const icon of assets.icons) {
    assert.equal(icon.origin, new URL(base).origin);
    assert.equal(icon.status, 200);
    assert.ok(icon.bytes > 100);
  }
  assert.ok(assets.settingsIconWidth > 0);
  async function expectIcon(selector, symbol) {
    const use = page.locator(`${selector} svg use`);
    assert.equal(await use.count(), 1);
    assert.equal(await use.getAttribute('href'), `icons.svg#${symbol}`);
  }
  await expectIcon('#openSettings', 'sliders');
  assert.doesNotMatch(await page.locator('main').innerText(), /\d+\s*(?:分钟|小时)|预留/);
  await openCourse(page, 's1-01');
  assert.equal(await page.locator('#lessonMinutes, [data-add-minutes], #lessonDialog input[type="number"]').count(), 0);
  assert.doesNotMatch(await page.locator('#lessonDialog').innerText(), /\d+\s*(?:分钟|小时)|预留/);
  await expectIcon('#saveLesson', 'save'); await expectIcon('#lessonComplete', 'check');
  await page.locator('#lessonNote').fill('只保存本课练习记录');
  await page.locator('#saveLesson').click();
  assert.equal((await state(page)).entries['s1-01'].status, 'learning');
  assert.equal((await state(page)).entries['s1-01'].minutes, 0);
  assert.equal(await page.locator('#lessonNote').inputValue(), '');
  assert.equal((await state(page)).entries['s1-01'].history.length, 1);
  await expectIcon('#saveLesson', 'save');
  await page.locator('#lessonComplete').click();
  assert.equal(await page.locator('#lessonComplete').getAttribute('aria-pressed'), 'true');
  await expectIcon('#lessonComplete', 'undo'); await expectIcon('#lessonDialog .toast-action', 'undo');
  await page.locator('#lessonDialog .toast-action').click();
  assert.equal((await state(page)).entries['s1-01'].status, 'learning');
  assert.equal((await state(page)).entries['s1-01'].minutes, 0);
  assert.equal((await state(page)).entries['s1-01'].history.length, 1);
  assert.equal((await state(page)).entries['s1-02'].minutes, 35);
  await expectIcon('#lessonComplete', 'check'); await expectIcon('#saveLesson', 'save');
});

test('early completion keeps scheduled dates and global search reaches later courses', async t => {
  const page = await pageAt(t);
  await page.locator('#catalogSearch').fill('混声');
  assert.ok(await page.locator('#catalogList .lesson-card').count() >= 7);
  await page.locator('#catalogSearch').fill('平衡混声技巧与实践运用一');
  const card = page.locator('#catalogList [data-lesson-id="s4-01"]');
  const timing = await card.locator('.lesson-card-meta').textContent();
  await card.locator('.lesson-complete').click();
  assert.equal((await state(page)).entries['s4-01'].status, 'done');
  assert.equal(await card.locator('.lesson-card-meta').textContent(), timing);
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's1-01');
  await card.locator('.lesson-card-title').click();
  await page.locator('[data-course-locate="s4-01"]').click();
  await page.locator('#lessonDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#catalogSearch').inputValue(), '');
  assert.equal(await page.locator('#catalogPhase').inputValue(), 'all');
  assert.equal(await page.locator('#catalogList [data-lesson-id="s4-01"]').isVisible(), true);
});

test('next learning advances early, keeps the earliest unfinished course, and preserves weekly dates', async t => {
  const page = await pageAt(t);
  const mainCourse = page.locator('#todayCourses .lesson-card');
  async function expectNext(id) {
    assert.equal(await page.locator('#todayView .lesson-card').count(), 1, 'the next course has a single homepage entry');
    assert.equal(await mainCourse.getAttribute('data-lesson-id'), id);
    assert.equal(await page.locator('#todayCoursesHeading').textContent(), '下一次学习');
  }
  await expectNext('s1-01');
  assert.match(await mainCourse.locator('.lesson-card-meta').textContent(), /原计划.*10 月 7 日/);
  const firstWeek = page.locator('#phase-foundation .week-group[data-week="1"]');
  const weeklyDates = await firstWeek.locator('.lesson-card').evaluateAll(cards => cards.map(card => ({
    id: card.dataset.lessonId, timing: card.querySelector('.lesson-card-meta').textContent,
  })));
  const weeklyHeading = await firstWeek.locator('.week-heading').textContent();

  await mainCourse.locator('.lesson-complete').click();
  await expectNext('s1-02');
  await page.locator('#toastRegion .toast-action').click();
  await expectNext('s1-01');
  await mainCourse.locator('.lesson-complete').click();
  await expectNext('s1-02');
  await mainCourse.locator('.lesson-complete').click();
  await expectNext('s1-03');

  await page.locator('#catalogList [data-lesson-id="s1-04"] .lesson-complete').click();
  await expectNext('s1-03');
  await openCourse(page, 's1-03');
  await page.locator('#lessonNote').fill('音符辨认还需要继续练习');
  await page.locator('#saveLesson').click(); await close(page);
  await expectNext('s1-03');
  assert.equal(await mainCourse.getAttribute('data-state'), 'learning');
  await mainCourse.locator('.lesson-complete').click();
  await expectNext('s1-05');

  await page.locator('#catalogList [data-lesson-id="s1-02"] .lesson-complete').click();
  await expectNext('s1-02');
  await waitSync(page); await page.reload(); await waitSync(page);
  await expectNext('s1-02');
  assert.deepEqual(await firstWeek.locator('.lesson-card').evaluateAll(cards => cards.map(card => ({
    id: card.dataset.lessonId, timing: card.querySelector('.lesson-card-meta').textContent,
  }))), weeklyDates);
  assert.equal(await firstWeek.locator('.week-heading').textContent(), weeklyHeading);
});

test('the next course follows early progress and moves back after cancellation', async t => {
  const page = await pageAt(t);
  await syncCourseStatuses(page, Object.fromEntries(LESSONS.filter(lesson => lesson.phaseId === 'foundation').map(lesson => [lesson.id, 'done'])));
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's2-01');
  assert.match(await page.locator('#todayCourses .lesson-card-meta').textContent(), /12 月 12 日/,
    'the next phase remains available early while keeping its date after the planned rest');
  assert.equal(await page.locator('#catalogList .phase-rest').count(), 3, 'early completion does not remove planned rest periods');
  await page.locator('#todayCourses .lesson-complete').click();
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's2-02');
  await expandPhase(page, 'foundation');
  await page.locator('#catalogList [data-lesson-id="s1-14"] .lesson-complete').click();
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's1-14');
  await waitSync(page); await page.reload(); await waitSync(page);
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's1-14');
});

test('finishing every course shows an ending state instead of a scheduled completed card, including after refresh', async t => {
  const page = await pageAt(t);
  await syncCourseStatuses(page, Object.fromEntries(LESSONS.map(lesson => [lesson.id, lesson.id === 's4-20' ? 'learning' : 'done'])));
  assert.equal(await page.locator('#todayView .lesson-card').count(), 1);
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's4-20');
  await page.locator('#todayCourses .lesson-complete').click();
  assert.equal(await page.locator('#todayView .lesson-card').count(), 0);
  assert.equal(await page.locator('#todayCoursesHeading').textContent(), '学习记录');
  assert.match(await page.locator('#todayCourses .empty-state').textContent(), /全部课程已完成/);
  assert.equal(await page.locator('#overallProgress [role="progressbar"]').getAttribute('aria-valuenow'), '74');
  await waitSync(page); await page.reload(); await waitSync(page);
  assert.equal(await page.locator('#todayView .lesson-card').count(), 0);
  assert.match(await page.locator('#todayCourses .empty-state').textContent(), /全部课程已完成/);
  await page.locator('#catalogStatus').selectOption('done');
  await page.locator('#catalogList [data-lesson-id="s4-20"] .lesson-complete').click();
  assert.equal(await page.locator('#todayCourses .lesson-card').getAttribute('data-lesson-id'), 's4-20');
});

test('a filtered-out completed course returns keyboard focus safely after dismissing Undo', async t => {
  const page = await pageAt(t, 390);
  await page.locator('#catalogStatus').selectOption('pending');
  const first = page.locator('#catalogList [data-lesson-id="s1-01"] .lesson-complete');
  await first.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.matches('#toastRegion .toast-action')), true);
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
  assert.equal(await page.evaluate(() => document.activeElement.matches('.lesson-complete')), false);
  assert.equal((await state(page)).entries['s1-02'], undefined);
});

test('settings save is enabled only while the form differs from the saved schedule', async t => {
  const page = await pageAt(t);
  await page.locator('#openSettings').click();
  const save = page.locator('#saveSettings');
  assert.equal(await save.isDisabled(), true);
  const originalDate = await page.locator('#startDate').inputValue();
  await page.locator('#startDate').fill('2026-10-12');
  assert.equal(await save.isEnabled(), true);
  await page.locator('#startDate').fill(originalDate);
  assert.equal(await save.isDisabled(), true);
  await page.locator('#settingsForm input[name="days"][value="2"]').check();
  assert.equal(await save.isEnabled(), true);
  await page.locator('#settingsForm input[name="days"][value="2"]').uncheck();
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual((await state(page)).config.days, DEFAULT_CONFIG.days);
});

test('week groups are rebuilt from changed start date and weekdays instead of static course rows', async t => {
  const page = await pageAt(t);
  const firstHeading = await page.locator('#phase-foundation .week-group[data-week="1"] .week-heading').textContent();
  assert.equal(await page.locator('#catalogList [data-lesson-id="s1-10"]').evaluate(card => card.closest('.week-group')?.dataset.week), '6');
  await page.locator('#openSettings').click();
  await page.locator('#startDate').fill('2026-10-12');
  await page.locator('#settingsForm input[name="days"][value="3"]').uncheck();
  await page.locator('#settingsForm input[name="days"][value="6"]').uncheck();
  await page.locator('#settingsForm input[name="days"][value="2"]').check();
  await page.locator('#settingsForm input[name="days"][value="5"]').check();
  await page.locator('#saveSettings').click();
  await waitSync(page);
  const newHeading = await page.locator('#phase-foundation .week-group[data-week="1"] .week-heading').textContent();
  assert.notEqual(newHeading, firstHeading);
  assert.match(newHeading, /10\s*(?:月|\.)\s*12/);
  assert.equal(await page.locator('#catalogList [data-lesson-id="s1-10"]').evaluate(card => card.closest('.week-group')?.dataset.week), '7');
  assert.match(await page.locator('#catalogList [data-lesson-id="s1-01"] .lesson-card-meta').textContent(), /10 月 13 日/);
  const ids = await page.locator('#catalogList .lesson-card').evaluateAll(cards => cards.map(card => card.dataset.lessonId));
  assert.equal(ids.length, 74);
  assert.equal(new Set(ids).size, 74);
});

test('custom learning days and program survive refresh while existing records remain', async t => {
  const page = await pageAt(t);
  await openCourse(page, 's1-01'); await page.locator('#lessonComplete').click(); await close(page);
  await page.locator('#openSettings').click();
  await page.locator('#settingsForm input[value="3"]').uncheck();
  assert.match(await page.locator('#settingsPreview').textContent(), /至少两个|有效/);
  assert.equal(await page.locator('#settingsDialog').isVisible(), true);
  assert.deepEqual((await state(page)).config.days, [3, 6]);
  await page.locator('#settingsForm input[value="6"]').uncheck();
  await page.locator('#settingsForm input[value="2"]').check();
  await page.locator('#settingsForm input[value="5"]').check();
  await page.locator('#program').selectOption('basic');
  assert.equal(await page.locator('#sessionMinutes, #lessonMinutes, [data-add-minutes]').count(), 0);
  await page.locator('#settingsDialog [type="submit"][form="settingsForm"]').click();
  await waitSync(page); await page.reload(); await waitSync(page);
  assert.deepEqual((await state(page)).config.days, [2, 5]);
  assert.equal((await state(page)).entries['s1-01'].status, 'done');
  assert.match(await page.locator('#brandProgram').textContent(), /全能班/);
  assert.equal(await page.locator('#catalogList .catalog-group').count(), 3);
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 54);
  await page.locator('#openSettings').click();
  assert.equal(await page.locator('#program').inputValue(), 'basic');
  assert.equal(await page.locator('#settingsForm input[value="2"]').isChecked(), true);
  assert.equal(await page.locator('#settingsForm input[value="5"]').isChecked(), true);
  await close(page, 'settingsDialog');
  await openCourse(page, 's1-01');
  await page.locator('#lessonNote').fill('调整排期后仍保留原课完成状态');
  await page.locator('#saveLesson').click();
  assert.equal((await state(page)).entries['s1-01'].status, 'done');
  assert.equal((await state(page)).entries['s1-01'].minutes, 0);
  assert.equal((await state(page)).config.sessionMinutes, DEFAULT_CONFIG.sessionMinutes);
});

test('a historical 30-minute config and actual minutes remain unchanged through offline reload and sync', async t => {
  const page = await pageAt(t);
  await syncCourseRecords(page, { 's1-01': { status: 'learning', minutes: 25, note: '保留原有练习记录' } });
  await openCourse(page, 's1-01');
  await page.locator('#lessonComplete').click(); await close(page);
  await waitSync(page);
  const before = await state(page);
  const historical = { ...before.config, days: [2, 5], sessionMinutes: 30 };
  const historicalStamp = new Date(Date.parse(before.configUpdatedAt) + 1000).toISOString();
  const canonicalResponse = await fetch(base + 'api/sync', {
    method: 'POST',
    headers: { 'X-Study-Key': before.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: historical, configUpdatedAt: historicalStamp, entries: {} }),
  });
  assert.equal(canonicalResponse.status, 200);
  assert.equal((await canonicalResponse.json()).config.sessionMinutes, 30);
  await page.evaluate(() => {
    const key = localStorage.getItem('vocal-study-planner:active-key');
    const storageKey = 'vocal-study-planner:profile:' + key;
    const value = JSON.parse(localStorage.getItem(storageKey));
    value.config.days = [2, 5]; value.config.sessionMinutes = 30;
    value.configUpdatedAt = '2026-10-01T00:00:00.000Z';
    localStorage.setItem(storageKey, JSON.stringify(value));
  });
  await page.route('**/api/**', route => route.abort());
  await page.reload();
  await page.locator('#catalogList .catalog-group').first().waitFor({ state: 'attached' });
  const migrated = await state(page);
  assert.equal(migrated.config.sessionMinutes, 30);
  assert.deepEqual(migrated.config.days, [2, 5]);
  assert.equal(migrated.entries['s1-01'].status, 'done');
  assert.equal(migrated.entries['s1-01'].minutes, 25);
  assert.equal(migrated.entries['s1-01'].note, '保留原有练习记录');
  await page.unroute('**/api/**');
  await page.waitForFunction(() => !document.querySelector('#syncNowBtn').disabled);
  await openData(page);
  await page.locator('#syncNowBtn').click(); await waitSync(page);
  await close(page, 'settingsDialog');
  await waitSync(page); await page.reload(); await waitSync(page);
  assert.equal((await state(page)).config.sessionMinutes, 30);
  assert.equal((await state(page)).entries['s1-01'].minutes, 25);
});

test('course titles remain editable and numbered without source notices', async t => {
  const page = await pageAt(t);
  await openCourse(page, 's4-18');
  assert.equal(await page.locator('#catalogList .lesson-number').count(), 74);
  assert.equal(await page.locator('#catalogList [data-lesson-id="s4-18"] .lesson-number').textContent(), '04 / 18');
  assert.equal(await page.locator('#catalogList .source-tag, #lessonDialog .source-note').count(), 0);
  assert.doesNotMatch(await page.locator('#lessonDialog').textContent(), /待核对|图片|遮挡/);
  assert.match(await page.locator('#lessonDialog .detail-course-meta').textContent(), /阶段 4 · 第 18 课/);
  await page.locator('#lessonTitleInput').fill('个人台风塑造');
  await page.locator('#saveLesson').click(); await close(page);
  await page.locator('#catalogSearch').fill('个人台风塑造');
  assert.equal(await page.locator('#catalogList .lesson-card').count(), 1);
  assert.equal(await page.locator('#catalogList .source-tag').count(), 0);
  assert.equal((await state(page)).entries['s4-18'].status, 'pending');
  assert.equal((await state(page)).entries['s4-18'].history.length, 0, 'renaming a course is not a learning entry');
});

test('another device can restore the same plan and a newer record cannot be overwritten silently', async t => {
  const first = await pageAt(t);
  await syncCourseRecords(first, { 's1-03': { status: 'learning', minutes: 20, note: '首次练习' } });
  await openCourse(first, 's1-03');
  await first.locator('#lessonNote').fill('原设备整理后的练习记录');
  await first.locator('#saveLesson').click(); await close(first); await waitSync(first);
  const original = await state(first);
  assert.equal(original.entries['s1-03'].minutes, 20);
  const second = await pageAt(t);
  await openData(second); await second.locator('#connectCode').fill(original.key);
  await second.locator('#connectForm [type="submit"]').click();
  await second.waitForFunction(() => document.querySelector('#dataFeedback').textContent.startsWith('已连接'));
  await close(second, 'settingsDialog');
  assert.equal((await state(second)).entries['s1-03'].minutes, 20);
  assert.equal((await state(second)).entries['s1-03'].note, '原设备整理后的练习记录');
  await openCourse(first, 's1-03'); await first.locator('#lessonNote').fill('未保存草稿');
  await syncCourseRecords(second, { 's1-03': { minutes: 35 } });
  await openCourse(second, 's1-03');
  await second.locator('#lessonNote').fill('另一设备的新记录'); await second.locator('#saveLesson').click();
  await waitSync(second);
  await first.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await first.waitForFunction(() => {
    const key = localStorage.getItem('vocal-study-planner:active-key');
    return JSON.parse(localStorage.getItem('vocal-study-planner:profile:' + key)).entries['s1-03'].note === '另一设备的新记录';
  });
  assert.equal(await first.locator('#lessonNote').inputValue(), '未保存草稿');
  first.once('dialog', dialog => dialog.dismiss());
  await first.locator('#saveLesson').click();
  assert.equal((await state(first)).entries['s1-03'].note, '另一设备的新记录');
  assert.equal((await state(first)).entries['s1-03'].minutes, 35);
  assert.equal(await first.locator('#lessonNote').inputValue(), '未保存草稿');
});

test('remote course changes refresh a pristine dialog but preserve and flag a dirty draft', async t => {
  const page = await pageAt(t);
  await openCourse(page, 's1-03');
  await syncCourseRecords(page, {
    's1-03': { status: 'done', title: '远端课程名称', note: '远端已完成记录' },
  });
  await page.waitForFunction(() => document.querySelector('#lessonTitleInput')?.value === '远端课程名称');
  assert.equal(await page.locator('#lessonNote').inputValue(), '', 'a pristine dialog shows remote notes in history, not as a new draft');
  assert.match(await page.locator('#lessonDialog .history-note').first().textContent(), /远端已完成记录/);
  assert.equal(await page.locator('#lessonDialog .lesson-status.done').count(), 1);
  assert.equal(await page.locator('#lessonComplete').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#lessonDialogTitle').textContent(), /远端课程名称/);

  await page.locator('#lessonNote').fill('本机尚未保存的草稿');
  await syncCourseRecords(page, {
    's1-03': { status: 'learning', title: '远端二次改名', note: '远端二次更新' },
  });
  await page.waitForFunction(() => document.querySelector('#detailFeedback')?.textContent.trim().length > 0);
  assert.equal(await page.locator('#lessonNote').inputValue(), '本机尚未保存的草稿');
  assert.equal(await page.locator('#lessonTitleInput').inputValue(), '远端课程名称');
  assert.match(await page.locator('#detailFeedback').textContent(), /更新|冲突|另一设备/);
  assert.equal((await state(page)).entries['s1-03'].note, '远端二次更新');
});

test('remote equal-timestamp changes converge and invalidate an older Undo', async t => {
  const page = await pageAt(t);
  await page.locator('#catalogList [data-lesson-id="s1-02"] .lesson-complete').click();
  await waitSync(page);
  const current = await state(page);
  const record = { ...current.entries['s1-02'], minutes: 50, note: '同一时间戳的服务器记录' };
  delete record.history; // Simulate an older client that only knows the latest-note field.
  const response = await fetch(base + 'api/sync', { method: 'POST', headers: { 'X-Study-Key': current.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: { 's1-02': record } }) });
  assert.equal(response.status, 200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => {
    const key = localStorage.getItem('vocal-study-planner:active-key');
    return JSON.parse(localStorage.getItem('vocal-study-planner:profile:' + key)).entries['s1-02'].note === '同一时间戳的服务器记录';
  });
  await page.locator('#toastRegion .toast-action').click();
  assert.equal((await state(page)).entries['s1-02'].minutes, 50);
  assert.equal((await state(page)).entries['s1-02'].note, '同一时间戳的服务器记录');
  assert.match(await page.locator('#toastRegion').textContent(), /新记录.*未撤销/);
});

test('an open settings draft asks before overwriting a remotely updated schedule', async t => {
  const page = await pageAt(t);
  await page.locator('#openSettings').click();
  await page.locator('#settingsForm input[name="days"][value="3"]').uncheck();
  await page.locator('#settingsForm input[name="days"][value="2"]').check();
  const current = await state(page);
  const updated = { ...current.config, days: [1, 5] };
  const response = await fetch(base + 'api/sync', { method: 'POST', headers: { 'X-Study-Key': current.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: updated, configUpdatedAt: new Date(Date.parse(current.configUpdatedAt) + 100).toISOString(), entries: {} }) });
  assert.equal(response.status, 200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => {
    const key = localStorage.getItem('vocal-study-planner:active-key');
    return JSON.stringify(JSON.parse(localStorage.getItem('vocal-study-planner:profile:' + key)).config.days) === '[1,5]';
  });
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#settingsDialog [type="submit"][form="settingsForm"]').click();
  assert.deepEqual((await state(page)).config.days, [1, 5]);
  assert.equal(await page.locator('#settingsForm input[name="days"][value="2"]').isChecked(), true);
  assert.equal(await page.locator('#settingsForm input[name="days"][value="6"]').isChecked(), true);
});

test('large journals import and sync in bounded batches and invalid backups leave state intact', async t => {
  const page = await pageAt(t);
  const entries = Object.fromEntries(LESSONS.slice(0, 16).map(lesson => [lesson.id, { status: 'learning', minutes: 20, note: '练'.repeat(4000), updatedAt: '2026-10-01T00:00:00.000Z' }]));
  await openData(page);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restoreFile').setInputFiles({ name: 'journal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'vocal-study-planner', version: 1, config: DEFAULT_CONFIG, entries })) });
  await page.waitForFunction(() => document.querySelector('#dataFeedback').textContent.includes('已恢复'));
  await waitSync(page);
  const current = await state(page);
  const remote = await fetch(base + 'api/state', { headers: { 'X-Study-Key': current.key } }).then(response => response.json());
  assert.equal(Object.keys(remote.entries).length, 16);
  assert.equal(remote.entries['s1-01'].note.length, 4000);
  assert.equal(remote.entries['s1-01'].minutes, 20);
  assert.equal(remote.entries['s1-01'].history.length, 1);
  assert.equal(remote.entries['s1-01'].history[0].legacy, true);
  assert.equal(remote.entries['s1-01'].history[0].createdAt, '2026-10-01T00:00:00.000Z');
  const before = JSON.stringify(current.entries);
  await page.locator('#restoreFile').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1}') });
  await page.waitForFunction(() => document.querySelector('#dataFeedback').textContent.includes('本网站'));
  assert.equal(JSON.stringify((await state(page)).entries), before);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#exportBackup').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.version, 2); assert.equal(Object.keys(exported.entries).length, 16);
  assert.equal(exported.entries['s1-01'].minutes, 20);
  assert.equal(exported.entries['s1-01'].history[0].createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(Object.hasOwn(exported, 'key'), false);
});

test('undoing a backup restore preserves a newer unsaved settings draft and asks before overwrite', async t => {
  const page = await pageAt(t);
  const original = await state(page);
  await openData(page);
  const imported = { ...original.config, startDate: '2026-11-02', days: [2, 5] };
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restoreFile').setInputFiles({
    name: 'new-schedule.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'vocal-study-planner', version: 1, config: imported, entries: {} })),
  });
  await page.waitForFunction(() => document.querySelector('#dataFeedback').textContent.includes('已恢复'));
  assert.equal((await state(page)).config.startDate, '2026-11-02');
  assert.equal(await page.locator('#startDate').inputValue(), '2026-11-02');

  await page.locator('#startDate').fill('2026-11-09');
  await page.locator('#settingsDialog .toast-action').click();
  await page.waitForFunction(date => {
    const key = localStorage.getItem('vocal-study-planner:active-key');
    return JSON.parse(localStorage.getItem('vocal-study-planner:profile:' + key)).config.startDate === date;
  }, original.config.startDate);
  assert.equal(await page.locator('#startDate').inputValue(), '2026-11-09', 'the unsaved form draft survives import Undo');
  assert.deepEqual((await state(page)).config.days, original.config.days);

  let confirmation = '';
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
  await page.locator('#settingsDialog [type="submit"][form="settingsForm"]').click();
  assert.match(confirmation, /排期|覆盖/, 'saving a draft against a changed config requires confirmation');
  assert.equal((await state(page)).config.startDate, original.config.startDate);
  assert.equal(await page.locator('#startDate').inputValue(), '2026-11-09');
});

test('the single learning page and dialogs fit phones and desktop with the next action in view', async t => {
  for (const width of [320, 390, 1280]) {
    const page = await pageAt(t, width);
    const recordButton = await page.locator('#todayCourses .lesson-open').first().boundingBox();
    assert.ok(recordButton.y + recordButton.height < 800, `Primary learning action is in the first screen at ${width}px`);
    assert.equal(await page.locator('#todayView').isVisible(), true);
    assert.equal(await page.locator('#catalogView').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Learning page fits ${width}px`);
    assert.equal(await page.locator('#phase-foundation .week-group[data-week="1"] .week-heading').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Weekly groups fit ${width}px`);
    await openCourse(page, 's4-18');
    await page.locator('#lessonNote').fill('本次练习记录');
    await page.locator('#saveLesson').click();
    assert.equal(await page.locator('#lessonDialog #toastRegion').count(), 1);
    const completion = page.locator('#lessonComplete');
    assert.equal(await completion.evaluate(button => {
      const box = button.getBoundingClientRect();
      const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return target === button || button.contains(target);
    }), true, `Completion stays reachable at ${width}px`);
    await close(page); await page.locator('#openSettings').click();
    assert.equal(await page.locator('#settingsDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    await openData(page);
    assert.equal(await page.locator('#settingsDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    assert.doesNotMatch(await page.locator('#settingsDialog').innerText(), /\d+\s*(?:分钟|小时)|预留/);
  }
});

async function writeFromAnotherDevice(page, id, patch) {
  const current = await state(page);
  const latest = Math.max(Date.now(), Date.parse(current.configUpdatedAt), ...Object.values(current.entries).map(record => Date.parse(record.updatedAt)));
  const record = { status: 'learning', minutes: 0, note: '', title: '', ...current.entries[id], ...patch,
    updatedAt: new Date(latest + 100).toISOString() };
  if (Object.hasOwn(patch, 'note') && !Object.hasOwn(patch, 'history')) delete record.history;
  const response = await fetch(base + 'api/sync', { method: 'POST',
    headers: { 'X-Study-Key': current.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: { [id]: record } }) });
  assert.equal(response.status, 200);
  return record;
}

async function serverEntry(page, id) {
  const current = await state(page);
  const response = await fetch(base + 'api/state', { headers: { 'X-Study-Key': current.key } });
  assert.equal(response.status, 200);
  return (await response.json()).entries[id];
}

test('saving before a remote edit has been pulled preserves both versions until an explicit choice', async t => {
  const page = await pageAt(t);
  await syncCourseRecords(page, { 's1-03': { note: '最初记录', status: 'learning' } });
  await openCourse(page, 's1-03');
  await page.locator('#lessonNote').fill('设备 A 整理的本地草稿');
  await writeFromAnotherDevice(page, 's1-03', { note: '设备 B 刚保存的新记录', status: 'done' });
  await page.locator('#saveLesson').click();
  await page.waitForFunction(() => !document.querySelector('#syncNowBtn').disabled && !document.querySelector('#syncConflictBanner').hidden);
  assert.equal((await serverEntry(page, 's1-03')).note, '设备 B 刚保存的新记录');
  await close(page);
  await page.locator('#syncConflictBanner button').click();
  const conflicts = page.locator('#syncConflictDialog');
  assert.match(await conflicts.textContent(), /设备 A 整理的本地草稿/);
  assert.match(await conflicts.textContent(), /设备 B 刚保存的新记录/);
  page.once('dialog', dialog => dialog.accept());
  await conflicts.locator('[data-sync-choice="remote"][data-sync-course="s1-03"]').click();
  await page.waitForFunction(() => document.querySelector('#syncConflictBanner').hidden);
  assert.equal((await state(page)).entries['s1-03'].note, '设备 B 刚保存的新记录');
  assert.equal((await state(page)).entries['s1-03'].status, 'done');
  assert.equal((await serverEntry(page, 's1-03')).note, '设备 B 刚保存的新记录');
});

test('Undo cannot overwrite an edit from another device before the next pull', async t => {
  const page = await pageAt(t);
  await page.locator('#todayCourses .lesson-complete').click();
  await waitSync(page);
  await writeFromAnotherDevice(page, 's1-01', { note: '另一设备已补充笔记', status: 'done' });
  await page.locator('#toastRegion .toast-action').click();
  await page.waitForFunction(() => document.querySelector('#toastRegion').textContent.includes('本次未撤销'));
  await waitSync(page);
  assert.equal((await serverEntry(page, 's1-01')).note, '另一设备已补充笔记');
  assert.equal((await serverEntry(page, 's1-01')).status, 'done');
  assert.equal((await state(page)).entries['s1-01'].note, '另一设备已补充笔记');
  assert.equal(await page.locator('#syncConflictBanner').isVisible(), false);
});

test('offline edits retain their original base through reload and require confirmation to replace a remote edit', async t => {
  const page = await pageAt(t);
  await page.route('**/api/**', route => route.abort());
  await openCourse(page, 's1-04');
  await page.locator('#lessonNote').fill('离线保存的练习草稿');
  await page.locator('#saveLesson').click();
  await page.waitForFunction(() => !document.querySelector('#syncNowBtn').disabled);
  await page.reload();
  await page.locator('#catalogList .catalog-group').first().waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('#syncNowBtn').disabled);
  assert.equal((await state(page)).entries['s1-04'].note, '离线保存的练习草稿');
  await writeFromAnotherDevice(page, 's1-04', { note: '服务器上的新练习记录', status: 'done' });
  await page.unroute('**/api/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator('#syncConflictBanner').waitFor({ state: 'visible' });
  assert.equal((await serverEntry(page, 's1-04')).note, '服务器上的新练习记录');
  await page.reload();
  await page.locator('#syncConflictBanner').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#syncNowBtn').disabled);
  await page.locator('#syncConflictBanner button').click();
  assert.match(await page.locator('#syncConflictDialog').textContent(), /离线保存的练习草稿/);
  assert.match(await page.locator('#syncConflictDialog').textContent(), /服务器上的新练习记录/);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-sync-choice="local"][data-sync-course="s1-04"]').click();
  await waitSync(page);
  const merged = await serverEntry(page, 's1-04');
  assert.equal(merged.note, '离线保存的练习草稿');
  assert.ok(merged.history.some(item => item.note === '离线保存的练习草稿'));
  assert.ok(merged.history.some(item => item.note === '服务器上的新练习记录'));
  assert.equal(await page.locator('#syncConflictBanner').isVisible(), false);
});
