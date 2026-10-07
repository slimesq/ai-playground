'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
let browser, server, directory, baseURL;

async function unusedPort() {
  const socket = net.createServer();
  await once(socket.listen(0, '127.0.0.1'), 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'av-outline-ui-'));
  const port = await unusedPort();
  baseURL = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: project,
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(directory, 'tracker.db'),
      BACKUP_DIR: path.join(directory, 'backups'), TRACKER_API_KEY: '', NODE_ENV: 'test' },
    stdio: 'ignore'
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
    await delay(60);
  }
  assert.ok(ready, 'The isolated tracker server should start');
  browser = await chromium.launch({
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
    headless: true, args: ['--no-sandbox']
  });
}, { timeout: 20_000 });

after(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}, { timeout: 15_000 });

async function pageAt(t, width = 1280, { clockInstall = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  if (clockInstall) await page.clock.install({ time: new Date('2026-10-07T04:00:00Z') });
  else await page.clock.setFixedTime(new Date('2026-10-07T04:00:00Z'));
  await page.route('**/api/config', route => route.fulfill({ json: { authRequired: false } }));
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { state: { entries: body.state.entries }, serverTime: new Date().toISOString() } });
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy && !activeSyncPromise);
  return page;
}

async function seedEntries(page, entries) {
  await page.evaluate(records => {
    const stamp = freshTimestamp();
    for (const [id, { done, progress }] of Object.entries(records)) {
      state.entries[id] = createEntry(done, stamp, undefined, progress);
    }
    localRevision++;
    saveState(); render();
  }, entries);
}

const outlineIds = page => page.locator('#weekTasks .task-outline-item')
  .evaluateAll(items => items.map(item => item.dataset.taskId));

function weekGroupFor(page, taskId) {
  return page.locator('#weekTasks details.outline-week-group')
    .filter({ has: page.locator(`.task-outline-item[data-task-id="${taskId}"]`) });
}

async function dialogToastGeometry(page) {
  return page.evaluate(() => {
    const toast = document.querySelector('#taskDialog .toast');
    const status = document.querySelector('#detailTaskStatus');
    const button = document.querySelector('#detailToggleBtn');
    const box = element => element.getBoundingClientRect();
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    if (!toast || !status || !button) return null;
    const toastBox = box(toast), statusBox = box(status), buttonBox = box(button);
    const x = (buttonBox.left + buttonBox.right) / 2;
    const y = (buttonBox.top + buttonBox.bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return { statusCovered: overlaps(toastBox, statusBox), buttonCovered: overlaps(toastBox, buttonBox),
      buttonHittable: hit === button || button.contains(hit), x, y };
  });
}

async function focusedControl(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    return { id: element?.id || '', tag: element?.tagName || '',
      visible: !!element?.getClientRects().length && !element.closest('[hidden]'),
      safePlanner: !!element?.matches('#pageTitle, #weekTitle, #progressListTitle, #taskFilter, #outlineWeekSelect, .task-title, .task-outline-title, .outline-week-summary, .task-outline-content > summary'),
      outlineTitleOrDetails: !!element?.matches('.task-outline-title, .task-outline-content > summary'),
      dangerousToggle: !!element?.matches('[data-task-action="toggle"], #detailToggleBtn'),
      taskDialog: !!element?.closest('#taskDialog'),
      task: element?.closest('[data-task-id]')?.dataset.taskId || '',
      week: element?.closest('.outline-week-group')?.dataset.resultWeek || '' };
  });
}

async function keyboardCompleteFromPendingList(page, deepOutline = false) {
  if (deepOutline) {
    await page.locator('#progress-total-ls').click();
    await page.locator('#taskFilter').selectOption('pending');
    await page.locator('#outlineWeekSelect').selectOption('18');
  } else {
    await page.locator('.nav-item[data-view="planner"]').click();
    await page.locator('#taskFilter').selectOption('pending');
  }
  const checks = page.locator(deepOutline
    ? '#weekTasks .outline-week-group[open] .outline-check'
    : '#weekTasks .task-card .check');
  assert.ok(await checks.count() >= 2, 'The list needs a next incomplete task to expose accidental keyboard check-ins');
  const [id, nextId] = await Promise.all([0, 1].map(index => checks.nth(index)
    .evaluate(button => button.closest('[data-task-id]').dataset.taskId)));
  await checks.first().focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(taskId => taskDone(taskId)
    && document.activeElement?.matches('#toastRegion .toast-action'), id);
  return { id, nextId };
}

test('cancelling a completed record cannot move keyboard focus to the next destructive control', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const ids = await page.evaluate(() => allTasks.filter(task => task.track === 'ls').slice(0, 2).map(task => task.id));
  await seedEntries(page, Object.fromEntries(ids.map(id => [id, { done: true }])));
  await page.locator('#progress-completed-ls').click();
  assert.deepEqual(await outlineIds(page), ids);
  const firstCheck = page.locator(`#weekTasks .task-outline-item[data-task-id="${ids[0]}"] .outline-check`);
  await firstCheck.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => !taskDone(id), ids[0]);
  assert.equal(await page.evaluate(id => taskDone(id), ids[1]), true);
  assert.equal(await page.evaluate(id => {
    const next = document.querySelector(`#weekTasks [data-task-id="${CSS.escape(id)}"] .outline-check`);
    return document.activeElement === next;
  }, ids[1]), false, 'Focus must not silently land on another task’s check-in toggle');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(id => taskDone(id), ids[1]), true, 'A repeated keypress must not cancel the next record');
});

test('leaving a progress outline returns to the previously selected plan week', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('.nav-item[data-view="planner"]').click();
  await page.locator('#weekSelect').selectOption('8');
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-total-ls').click();
  assert.equal(await page.evaluate(() => progressListScope?.track), 'ls');
  await page.locator('#exitProgressListBtn').click();
  assert.equal(await page.locator('#weekSelect').inputValue(), '8');
  assert.equal(await page.evaluate(() => selectedWeek), 8);
  assert.equal(await page.evaluate(() => progressListScope), null);
});

test('all four completion filters retain outline rows and the project scope', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const ids = await page.evaluate(() => {
    const tasks = DATA.milestones.find(goal => goal.id === 'yibo').taskIds;
    return { done: tasks[0], partial: tasks.find(id => taskById.get(id).activity === 'practice'),
      pending: tasks.find(id => id !== tasks[0] && taskById.get(id).activity === 'video') };
  });
  await seedEntries(page, {
    [ids.done]: { done: true },
    [ids.partial]: { done: false, progress: { kind: 'practice', workedMinutes: 20, completedSteps: [0] } }
  });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  const scope = { phase: 'courses', track: 'ydy', project: 'yibo' };
  for (const [filter, expected] of [
    ['all', [ids.done, ids.partial, ids.pending]],
    ['pending', [ids.partial, ids.pending]],
    ['partial', [ids.partial]],
    ['done', [ids.done]]
  ]) {
    await page.locator('#taskFilter').selectOption(filter);
    assert.deepEqual(await page.evaluate(() => progressListScope), scope);
    const listed = await outlineIds(page);
    for (const id of expected) assert.ok(listed.includes(id), `${filter} must include ${id}`);
    if (filter === 'partial' || filter === 'done') assert.deepEqual(listed, expected);
    assert.equal(await page.locator('#weekTasks .task-card').count(), 0, `${filter} must retain readable outline rows`);
    if (filter === 'all') assert.match(await page.locator(`#weekTasks [data-task-id="${ids.pending}"] .outline-task-status`).textContent(), /未开始/);
    if (filter === 'partial') {
      assert.equal(await page.locator('#outlineNextPartialBtn').isVisible(), false, 'A partial-only list does not need a duplicate shortcut');
      assert.equal(await page.locator('#outlineNextPendingBtn').isVisible(), true);
    }
    assert.equal(await page.locator('#clearFiltersBtn').isVisible(), filter !== 'all', 'Clear appears only for an active state filter');
    if (filter === 'pending') {
      await page.locator('#clearFiltersBtn').click();
      assert.equal(await page.locator('#taskFilter').inputValue(), 'all');
      assert.deepEqual(await page.evaluate(() => progressListScope), scope, 'Clearing status keeps the project outline');
      assert.equal(await page.locator('#clearFiltersBtn').isVisible(), false);
    }
  }
});

test('a scoped week keeps its full completion denominator when status filters hide rows', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const ids = DATA.milestones.find(goal => goal.id === 'yibo').taskIds;
    const week = taskById.get(ids[0]).week;
    const sameWeek = ids.filter(id => taskById.get(id).week === week);
    return { done: sameWeek[0], pending: sameWeek[1], total: sameWeek.length };
  });
  assert.ok(sample.total >= 2, 'The fixture needs a week with both completed and incomplete project work');
  await seedEntries(page, { [sample.done]: { done: true } });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  for (const [filter, visible] of [['all', sample.done], ['done', sample.done], ['pending', sample.pending]]) {
    await page.locator('#taskFilter').selectOption(filter);
    const group = weekGroupFor(page, visible);
    assert.match(await group.locator('.outline-week-count').textContent(),
      new RegExp(`1\\s*/\\s*${sample.total}\\s*已完成`), `${filter} must count all scoped tasks that week`);
    assert.equal(await group.locator('.task-outline-item').count(), filter === 'all' ? sample.total : filter === 'done' ? 1 : sample.total - 1);
  }
});

test('typing a search from a scoped completion list restores all sources and states', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => ({
    doneYdy: DATA.milestones.find(goal => goal.id === 'yibo').taskIds[0],
    pendingLs: allTasks.find(task => task.track === 'ls').id
  }));
  await seedEntries(page, { [sample.doneYdy]: { done: true } });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-completed-yibo').click();
  assert.equal(await page.locator('#taskFilter').inputValue(), 'done');
  assert.equal(await page.locator('#trackFilter').inputValue(), 'ydy');
  await page.locator('#taskSearch').fill('课程');
  assert.equal(await page.evaluate(() => progressListScope), null);
  assert.equal(await page.locator('#trackFilter').inputValue(), 'all');
  assert.equal(await page.locator('#taskFilter').inputValue(), 'all');
  assert.equal(await page.locator(`#weekTasks .task-card[data-task-id="${sample.doneYdy}"]`).count(), 1);
  assert.equal(await page.locator(`#weekTasks .task-card[data-task-id="${sample.pendingLs}"]`).count(), 1,
    'A global search must reveal an unfinished task from another source');
  await page.locator('#trackFilter').selectOption('ls');
  assert.equal(await page.locator(`#weekTasks .task-card[data-task-id="${sample.doneYdy}"]`).count(), 0);
  await page.locator('#taskFilter').selectOption('done');
  assert.equal(await page.locator('#weekTasks .task-card').count(), 0, 'Explicit source and status filters still apply after the search');
});

test('empty and completed mobile outlines omit shortcuts with no actionable target', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 320);
  const ids = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'yibo').taskIds);
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  assert.equal(await page.locator('#outlineNextPartialBtn').isVisible(), false);
  assert.equal(await page.locator('#outlineNextPendingBtn').isVisible(), true);
  await page.locator('#taskFilter').selectOption('done');
  assert.equal(await page.locator('#weekTasks .task-outline-item').count(), 0);
  assert.equal(await page.locator('#outlineNavigation').isVisible(), false, 'An empty outline has no usable week or task target');
  await seedEntries(page, Object.fromEntries(ids.map(id => [id, { done: true }])));
  assert.equal(await page.locator('#outlineNavigation').isVisible(), true);
  assert.equal(await page.locator('#outlineNextPartialBtn').isVisible(), false);
  assert.equal(await page.locator('#outlineNextPendingBtn').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('continue learning has one clear detail action', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const lsIds = await page.evaluate(() => allTasks.filter(task => task.track === 'ls').map(task => task.id));
  await seedEntries(page, Object.fromEntries(lsIds.map(id => [id, { done: true }])));
  const card = page.locator('#continueBox .continue-task');
  await card.waitFor();
  assert.equal(await card.locator('h3.continue-title').count(), 1);
  assert.equal(await card.locator('[data-task-action="details"]').count(), 1);
  await card.locator('[data-task-action="details"]').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
});

test('outline week selector and next-work controls open only the relevant week', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const target = await page.evaluate(() => {
    const tasks = allTasks.filter(task => task.track === 'ydy' && phaseForWeek(task.week).id === 'courses');
    return { all: tasks.map(task => task.id), partial: tasks.find(task => task.week === 10 && task.activity === 'practice').id,
      pending: tasks.find(task => task.week === 11 && task.activity === 'video').id,
      weekEight: tasks.find(task => task.week === 8).id };
  });
  await seedEntries(page, Object.fromEntries(target.all.map(id => [id,
    id === target.partial ? { done: false, progress: { kind: 'practice', workedMinutes: 15, completedSteps: [0] } }
      : { done: id !== target.pending }])));
  await page.locator('#progress-total-ydy').click();
  assert.equal(await page.locator('#weekTasks details.outline-week-group[open]').count(), 1, 'Long outlines start with one relevant week expanded');
  await page.locator('#outlineWeekSelect').selectOption('8');
  assert.equal(await weekGroupFor(page, target.weekEight).getAttribute('open'), '');
  assert.equal(await page.locator('#weekTasks details.outline-week-group[open]').count(), 1);
  await page.locator('#outlineNextPartialBtn').click();
  assert.equal(await weekGroupFor(page, target.partial).getAttribute('open'), '');
  assert.equal(await page.locator('#weekTasks details.outline-week-group[open]').count(), 1);
  await page.locator('#outlineNextPendingBtn').click();
  assert.equal(await weekGroupFor(page, target.pending).getAttribute('open'), '', 'Next incomplete advances beyond the current partial task');
});

test('Back and Forward restore an expanded week, task details, and scroll position', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const id = await page.evaluate(() => allTasks.find(task => task.track === 'ls' && task.week === 8).id);
  await page.locator('#progress-total-ls').click();
  await page.locator('#outlineWeekSelect').selectOption('8');
  const group = weekGroupFor(page, id);
  assert.equal(await group.getAttribute('open'), '');
  const details = page.locator(`#weekTasks details.task-outline-content[data-outline-task-id="${id}"]`);
  await details.locator('summary').click();
  assert.equal(await details.getAttribute('open'), '');
  await page.evaluate(() => window.scrollTo(0, Math.min(650, document.documentElement.scrollHeight - innerHeight)));
  const priorScroll = await page.evaluate(() => window.scrollY);
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#navigationBackBtn').click();
  assert.equal(await group.getAttribute('open'), '');
  assert.equal(await details.getAttribute('open'), '');
  assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - priorScroll) <= 20, 'Back restores the outline reading position');
  await page.locator('#navigationForwardBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  await page.locator('#navigationBackBtn').click();
  assert.equal(await group.getAttribute('open'), '');
  assert.equal(await details.getAttribute('open'), '');
});

test('recorded practice steps and completed progress remain auditable with update times', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const tasks = DATA.milestones.find(goal => goal.id === 'yibo').taskIds.map(id => taskById.get(id));
    const practice = tasks.find(task => task.activity === 'practice' && task.steps?.length >= 3);
    const video = tasks.find(task => task.activity === 'video' && taskLearningSegments(task).length);
    const segment = taskLearningSegments(video)[0];
    return { practice: practice.id, practiceWeek: practice.week, video: video.id, steps: practice.steps.length,
      stop: Math.min(segment.endSecond, segment.startSecond + 30) };
  });
  await seedEntries(page, {
    [sample.practice]: { done: true, progress: { kind: 'practice', workedMinutes: 35, completedSteps: [0, 2] } },
    [sample.video]: { done: true, progress: { kind: 'video', segmentIndex: 0, positionSecond: sample.stop } }
  });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  const practiceRow = page.locator(`#weekTasks .task-outline-item[data-task-id="${sample.practice}"]`);
  const videoRow = page.locator(`#weekTasks .task-outline-item[data-task-id="${sample.video}"]`);
  assert.match(await practiceRow.textContent(), /已投入.*35\s*分/);
  assert.match(await videoRow.textContent(), /已存观看位置/);
  for (const row of [practiceRow, videoRow]) {
    const time = row.locator('time[data-record-update]');
    assert.equal(await time.count(), 1);
    assert.ok(await time.getAttribute('datetime'), 'The displayed update time remains machine-readable');
  }
  await page.locator('#outlineWeekSelect').selectOption(String(sample.practiceWeek));
  await practiceRow.locator('details.task-outline-content > summary').click();
  const states = await practiceRow.locator('.outline-step-status').allTextContents();
  assert.equal(states.length, sample.steps);
  assert.match(states[0], /已记录/);
  assert.match(states[1], /未记录/);
  assert.match(states[2], /已记录/);
});

test('saved record links open safely while punctuation and markup stay outside links', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const practice = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'yibo').taskIds
    .find(id => taskById.get(id).activity === 'practice'));
  const note = '演示 https://example.com/demo)。配对 https://example.com/paired(ok)；资料 https://example.com/run，<img src=x onerror=window.__injected=true> javascript:alert(1) ftp://example.com/file';
  await page.evaluate(({ practice, note }) => {
    const stamp = freshTimestamp();
    state.entries[practice] = createEntry(true, stamp, undefined,
      { kind: 'practice', workedMinutes: 20, completedSteps: [0], note });
    state.entries['milestone:yibo'] = createEntry(false, stamp, note);
    localRevision++;
    saveState(); render();
  }, { practice, note });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  const outlineNote = page.locator(`#weekTasks .task-outline-item[data-task-id="${practice}"] .task-outline-content p`).filter({ hasText: '演示' });
  assert.equal(await outlineNote.count(), 1);
  await page.locator('#outlineWeekSelect').selectOption(String(await page.evaluate(id => taskById.get(id).week, practice)));
  await page.locator(`#weekTasks .task-outline-item[data-task-id="${practice}"] .task-outline-title`).click();
  const readonlyNote = page.locator('#taskDialog .progress-readonly-note');
  assert.equal(await readonlyNote.count(), 1);
  await page.locator('#closeTaskBtn').click();
  await page.locator('.nav-item[data-view="milestones"]').click();
  const reviewNote = page.locator('#milestones [data-milestone-id="yibo"] .goal-review p');
  assert.equal(await reviewNote.count(), 1);
  for (const container of [outlineNote, readonlyNote, reviewNote]) {
    assert.deepEqual(await container.locator('a.record-link').evaluateAll(links => links.map(link => link.getAttribute('href'))),
      ['https://example.com/demo', 'https://example.com/paired(ok)', 'https://example.com/run']);
    assert.equal(await container.locator('img, script, a[href^="javascript:"], a[href^="ftp:"]').count(), 0);
    assert.match(await container.textContent(), /<img src=x onerror=/, 'HTML-looking evidence remains plain text');
    assert.match(await container.textContent(), /javascript:alert\(1\)/, 'Unsafe schemes remain plain text');
    for (const link of await container.locator('a.record-link').all()) {
      assert.equal(await link.getAttribute('target'), '_blank');
      const rel = (await link.getAttribute('rel') || '').split(/\s+/);
      assert.ok(rel.includes('noopener') && rel.includes('noreferrer'));
    }
  }
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  await page.context().route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Safe link</title>' }));
  const popupPromise = page.waitForEvent('popup');
  await reviewNote.locator('a.record-link').first().click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(new URL(popup.url()).pathname, '/demo');
  await popup.close();
});

test('today task has one completion action and one detail action; Undo keeps its original state', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const today = page.locator('#todayBox .today-task').first();
  const id = await today.getAttribute('data-task-id');
  assert.ok(id);
  assert.equal(await today.locator('[data-task-action="toggle"]').count(), 1);
  assert.equal(await today.locator('[data-task-action="details"]').count(), 1);
  await today.locator('[data-task-action="toggle"]').click();
  await page.waitForFunction(taskId => taskDone(taskId), id);
  await page.locator('#toastRegion .toast-action').click();
  await page.waitForFunction(taskId => !taskDone(taskId), id);
  await page.locator('.nav-item[data-view="planner"]').click();
  const ordinary = page.locator('#weekTasks .task-card').first();
  assert.equal(await ordinary.locator('.check[data-task-action="toggle"]').count(), 1);
  assert.equal(await ordinary.locator('.task-title[data-task-action="details"]').count(), 1);
  assert.equal(await ordinary.locator('.task-actions [data-task-action="details"]').count(), 0);
});

test('global search exposes one visible clear action in its empty state', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('.nav-item[data-view="planner"]').click();
  await page.locator('#taskSearch').fill('FLV');
  assert.ok(await page.locator('#weekTasks .task-card').count() > 0);
  assert.equal(await page.locator('#clearFiltersBtn').isVisible(), true);
  assert.equal(await page.locator('#weekTasks [data-clear-filters]').count(), 0);
  await page.locator('#taskSearch').fill('zzzxxyy-no-match');
  assert.equal(await page.locator('#weekTasks .task-card').count(), 0);
  assert.equal(await page.locator('#clearFiltersBtn').isVisible(), false);
  const emptyClear = page.locator('#weekTasks [data-clear-filters]');
  assert.equal(await emptyClear.isVisible(), true);
  await emptyClear.click();
  assert.equal(await page.locator('#taskSearch').inputValue(), '');
  assert.ok(await page.locator('#weekTasks .task-card').count() > 0, 'Clearing the empty search restores the week tasks');
});

test('scoped and search views keep one visible title and history restores visible focus', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('.nav-item[data-view="planner"]').click();
  assert.equal(await page.locator('.planner-topbar').isVisible(), true);
  assert.match(await page.locator('#planPhaseCaption').textContent(), /2026年.*2027年/);
  assert.doesNotMatch(await page.locator('#planPhaseCaption').textContent(), /课程计划|项目深化|\d+\s*周/);
  assert.match(await page.locator('#phase-courses').textContent(), /34\s*周/);
  assert.match(await page.locator('#phase-projects').textContent(), /18\s*周/);
  await page.locator('#taskSearch').fill('FLV');
  assert.equal(await page.locator('.planner-topbar').isVisible(), false);
  assert.equal(await page.locator('#pageSubtitle').isVisible(), false);
  assert.equal(await page.locator('#pageTitle').isVisible(), true);
  assert.equal(await page.evaluate(() => !!document.activeElement && !document.activeElement.closest('[hidden]')), true);
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-total-ls').click();
  assert.equal(await page.locator('.planner-topbar').isVisible(), false);
  assert.equal(await page.locator('#pageSubtitle').isVisible(), false);
  const titleBounds = await page.locator('#pageTitle').boundingBox();
  assert.ok(titleBounds.y >= 0 && titleBounds.y + titleBounds.height <= page.viewportSize().height,
    'Opening an outline must keep its only title inside the viewport');
  assert.equal(await page.evaluate(() => !!document.activeElement && !document.activeElement.closest('[hidden]')), true);
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  await page.locator('#navigationForwardBtn').click();
  assert.equal(await page.locator('#plannerView').isVisible(), true);
  assert.equal(await page.evaluate(() => !!document.activeElement && !document.activeElement.closest('[hidden]')), true,
    'Returning to a scoped view must not focus its hidden weekly heading');
});

test('milestone summary distinguishes the next project from tasks done but not yet accepted', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('.nav-item[data-view="milestones"]').click();
  const yibo = page.locator('#milestones [data-milestone-id="yibo"]');
  assert.match(await page.locator('#milestoneSummary .roadmap-next small').textContent(), /下一项目目标/);
  await yibo.locator('[data-milestone-review]').click();
  assert.equal(await page.locator('#milestoneReviewDialog').isVisible(), true, 'Early acceptance can be recorded before all tasks are checked');
  await page.locator('#closeMilestoneReviewBtn').click();
  const ids = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'yibo').taskIds);
  await seedEntries(page, Object.fromEntries(ids.map(id => [id, { done: true }])));
  assert.match(await yibo.locator('.goal-status').textContent(), /待验收/);
  assert.match(await page.locator('#milestoneSummary .roadmap-next small').textContent(), /下一项待验收/);
  assert.equal(await yibo.locator('[data-milestone-review]').isEnabled(), true);
});

async function reloadOutline(page) {
  await page.reload();
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy && !activeSyncPromise);
}

async function syncRecordRefresh(page) {
  await page.evaluate(() => syncToServer({ silent: true }));
  await page.waitForFunction(() => !syncState.busy && !activeSyncPromise);
}

test('refresh restores the outline scope, located week, expanded task and cursor', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const id = DATA.milestones.find(goal => goal.id === 'yibo').taskIds
      .find(id => taskById.get(id).week === 8 && taskById.get(id).activity === 'practice');
    return { id, week: taskById.get(id).week };
  });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  await page.locator('#outlineWeekSelect').selectOption(String(sample.week));
  const details = page.locator(`#weekTasks .task-outline-content[data-outline-task-id="${sample.id}"]`);
  await details.locator('summary').click();
  await details.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => Math.abs(JSON.parse(localStorage.getItem(UI_STORE_KEY))?.outlineState?.scroll - scrollY) < 2);
  await page.waitForFunction(id => JSON.parse(localStorage.getItem(UI_STORE_KEY))?.outlineState?.tasks?.includes(id), sample.id);
  const before = await page.evaluate(() => ({
    scope: progressListScope,
    state: JSON.parse(localStorage.getItem(UI_STORE_KEY)).outlineState
  }));
  assert.equal(before.state.scope, JSON.stringify(before.scope));
  assert.deepEqual(before.state.weeks, [sample.week]);
  assert.ok(before.state.cursor, 'Locating a week persists its task cursor');
  await reloadOutline(page);
  assert.deepEqual(await page.evaluate(() => progressListScope), before.scope);
  assert.equal(await page.locator('#outlineWeekSelect').inputValue(), String(sample.week));
  assert.equal(await page.locator('#weekTasks .outline-week-group[open]').count(), 1);
  assert.equal(await weekGroupFor(page, sample.id).getAttribute('open'), '');
  assert.equal(await details.getAttribute('open'), '', 'The previously expanded task remains expanded after startup sync');
  assert.equal(await page.evaluate(() => outlineCursorTaskId), before.state.cursor);
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - before.state.scroll) < 4, 'Refresh resumes the saved reading position');
});

test('refresh preserves deliberately collapsed outline weeks', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('#progress-total-ls').click();
  await page.locator('#outlineExpandAllBtn').click();
  assert.ok(await page.locator('#weekTasks .outline-week-group[open]').count() > 1);
  await page.locator('#outlineExpandAllBtn').click();
  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem(UI_STORE_KEY))?.outlineState;
    return saved && Array.isArray(saved.weeks) && saved.weeks.length === 0;
  });
  assert.equal(await page.locator('#weekTasks .outline-week-group[open]').count(), 0);
  await reloadOutline(page);
  assert.equal(await page.evaluate(() => progressListScope?.track), 'ls');
  assert.ok(await page.locator('#weekTasks .outline-week-group').count() > 1);
  assert.equal(await page.locator('#weekTasks .outline-week-group[open]').count(), 0,
    'Startup must distinguish deliberate collapse from missing saved state');
  await syncRecordRefresh(page);
  assert.equal(await page.locator('#weekTasks .outline-week-group[open]').count(), 0,
    'A background render must not reopen an intentionally collapsed outline');
});

test('expired outline weeks and foreign task ids are discarded without changing scope', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const ids = DATA.milestones.find(goal => goal.id === 'yibo').taskIds;
    const id = ids.find(id => taskById.get(id).week === 8 && taskById.get(id).activity === 'practice');
    const foreign = allTasks.find(task => task.track === 'ls' && task.week === 8).id;
    return { id, foreign, ids, week: 8, scope: { phase: 'courses', track: 'ydy', project: 'yibo' } };
  });
  await page.evaluate(sample => localStorage.setItem(UI_STORE_KEY, JSON.stringify({
    view: 'planner', phase: 'courses', week: 1, filter: 'all', track: 'ydy', search: '',
    progressScope: sample.scope,
    outlineState: { scope: JSON.stringify(sample.scope), weeks: [8, 35, 9999],
      tasks: [sample.id, sample.foreign, 'removed-task-id'], cursor: sample.foreign }
  })), sample);
  await reloadOutline(page);
  assert.deepEqual(await page.evaluate(() => progressListScope), sample.scope);
  assert.deepEqual(await outlineIds(page), sample.ids);
  assert.equal(await weekGroupFor(page, sample.id).getAttribute('open'), '');
  assert.equal(await page.locator(`.task-outline-content[data-outline-task-id="${sample.id}"]`).getAttribute('open'), '');
  assert.equal(await page.locator('#weekTasks .outline-week-group[data-result-week="35"], #weekTasks .outline-week-group[data-result-week="9999"]').count(), 0);
  assert.equal(await page.evaluate(id => outlineCursorTaskId === id, sample.foreign), false,
    'A saved cursor must not locate a task from a different source');
});

test('saved outline expansion from another scope cannot leak into a reopened project', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const ids = DATA.milestones.find(goal => goal.id === 'yibo').taskIds;
    const id = ids.find(id => taskById.get(id).week === 8 && taskById.get(id).activity === 'practice');
    return { id, ids, scope: { phase: 'courses', track: 'ydy', project: 'yibo' },
      staleScope: { phase: 'courses', track: 'ls', project: '' } };
  });
  await page.evaluate(sample => localStorage.setItem(UI_STORE_KEY, JSON.stringify({
    view: 'planner', phase: 'courses', week: 1, filter: 'all', track: 'ydy', search: '',
    progressScope: sample.scope,
    outlineState: { scope: JSON.stringify(sample.staleScope), weeks: [8], tasks: [sample.id], cursor: sample.id }
  })), sample);
  await reloadOutline(page);
  assert.deepEqual(await page.evaluate(() => progressListScope), sample.scope);
  assert.deepEqual(await outlineIds(page), sample.ids);
  assert.equal(await page.locator(`.task-outline-content[data-outline-task-id="${sample.id}"]`).getAttribute('open'), null,
    'Task expansion belongs to its saved scope, even when a stored id happens to exist in the current scope');
  assert.equal(await weekGroupFor(page, sample.id).getAttribute('open'), null,
    'The mismatched scope must not force its saved week open');
});

test('outline record links retain focus within the same task and record after mock sync', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const ids = DATA.milestones.find(goal => goal.id === 'yibo').taskIds
      .filter(id => taskById.get(id).activity === 'practice').slice(0, 2);
    return { first: ids[0], target: ids[1] };
  });
  const href = 'https://example.com/shared-result';
  await page.evaluate(({ sample, href }) => {
    const stamp = freshTimestamp();
    for (const id of [sample.first, sample.target]) {
      state.entries[id] = createEntry(true, stamp, `成果 ${href}`,
        { kind: 'practice', workedMinutes: 20, completedSteps: [0], note: `学习 ${href}` });
    }
    localRevision++; saveState(); render();
  }, { sample, href });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  await page.locator('#outlineExpandAllBtn').click();
  const row = page.locator(`#weekTasks .task-outline-item[data-task-id="${sample.target}"]`);
  await row.locator('.task-outline-content > summary').click();
  const record = row.locator('.outline-content-section').filter({ has: page.locator('h4', { hasText: '成果记录' }) });
  const link = record.locator('.record-link');
  await link.focus();
  await syncRecordRefresh(page);
  assert.equal(await link.evaluate(element => element === document.activeElement), true,
    'The same URL in another task or learning note must not capture the focused result link');
  assert.equal(await link.getAttribute('href'), href);
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const entries = route.request().postDataJSON().state.entries;
    const current = entries[sample.target];
    entries[sample.target] = { ...current, evidence: '已移除成果网址',
      updatedAt: new Date(Date.parse(current.updatedAt) + 60_000).toISOString() };
    return route.fulfill({ json: { state: { entries }, serverTime: entries[sample.target].updatedAt } });
  });
  await syncRecordRefresh(page);
  assert.equal(await link.count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.matches('a.record-link, [data-task-action="toggle"]')), false,
    'Removing a result link must not transfer focus to another record or check-in control');
  const doneBefore = await page.evaluate(() => allTasks.filter(task => taskDone(task.id)).map(task => task.id));
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => allTasks.filter(task => taskDone(task.id)).map(task => task.id)), doneBefore);
});

test('milestone evidence links keep their project focus across mock sync and disappear safely', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => DATA.milestones.filter(goal => goal.kind === 'project').slice(0, 2).map(goal => goal.id));
  const href = 'https://example.com/shared-demo';
  await page.evaluate(({ sample, href }) => {
    const stamp = freshTimestamp();
    for (const id of sample) state.entries[`milestone:${id}`] = createEntry(false, stamp, `演示 ${href}`);
    localRevision++; saveState(); render();
  }, { sample, href });
  await page.locator('.nav-item[data-view="milestones"]').click();
  const target = sample[1];
  const link = page.locator(`#milestones [data-milestone-id="${target}"] .goal-review .record-link`);
  await link.focus();
  await syncRecordRefresh(page);
  assert.equal(await link.evaluate(element => element === document.activeElement), true,
    'The matching URL in another project must not capture keyboard focus');
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const entries = route.request().postDataJSON().state.entries;
    const current = entries[`milestone:${target}`];
    entries[`milestone:${target}`] = { ...current, evidence: '网址已移除',
      updatedAt: new Date(Date.parse(current.updatedAt) + 60_000).toISOString() };
    return route.fulfill({ json: { state: { entries }, serverTime: entries[`milestone:${target}`].updatedAt } });
  });
  await syncRecordRefresh(page);
  assert.equal(await link.count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.matches('a.record-link, [data-task-action="toggle"]')), false,
    'A removed evidence link must not redirect focus to another project’s URL or task toggle');
  assert.equal(await page.evaluate(id => milestoneReview(DATA.milestones.find(goal => goal.id === id)).done, target), false);
});

async function scopedFilterFixture(page) {
  const sample = await page.evaluate(() => {
    const tasks = DATA.milestones.find(goal => goal.id === 'yibo').taskIds.map(id => taskById.get(id));
    return {
      done: tasks.find(task => task.week === 1 && task.activity === 'video').id,
      partial: tasks.find(task => task.week === 8 && task.activity === 'practice').id,
      pending: tasks.find(task => task.week === 6 && task.activity === 'practice').id,
      scope: { phase: 'courses', track: 'ydy', project: 'yibo' }
    };
  });
  await seedEntries(page, {
    [sample.done]: { done: true },
    [sample.partial]: { done: false, progress: { kind: 'practice', workedMinutes: 20, completedSteps: [0] } }
  });
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  return sample;
}

async function outlineReading(page) {
  return page.evaluate(() => ({
    filter: $('taskFilter').value,
    selectedWeek: $('outlineWeekSelect').value,
    weeks: Array.from($('weekTasks').querySelectorAll('.outline-week-group[open]'), group => Number(group.dataset.resultWeek)),
    tasks: Array.from($('weekTasks').querySelectorAll('.task-outline-content[open]'), task => task.dataset.outlineTaskId),
    cursor: JSON.parse(localStorage.getItem(UI_STORE_KEY))?.outlineState?.cursor,
    scroll: scrollY
  }));
}

async function locateFilterReading(page, filter, id, week, desiredScroll) {
  await page.locator('#taskFilter').selectOption(filter);
  await page.locator('#outlineWeekSelect').selectOption(String(week));
  const details = page.locator(`#weekTasks .task-outline-content[data-outline-task-id="${id}"]`);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  await page.evaluate(top => window.scrollTo({
    top: Math.min(top, Math.max(0, document.documentElement.scrollHeight - innerHeight)), behavior: 'instant'
  }), desiredScroll);
  await page.waitForFunction(id => {
    const saved = JSON.parse(localStorage.getItem(UI_STORE_KEY))?.outlineState;
    return saved?.tasks?.includes(id) && Math.abs(saved.scroll - scrollY) < 3;
  }, id);
  return outlineReading(page);
}

async function assertFilterReading(page, expected, message) {
  await page.waitForFunction(expected => {
    const group = $('weekTasks').querySelector(`.outline-week-group[data-result-week="${expected.selectedWeek}"]`);
    return $('taskFilter').value === expected.filter && group?.open
      && Math.abs(scrollY - expected.scroll) < 5;
  }, expected);
  const actual = await outlineReading(page);
  assert.equal(actual.selectedWeek, expected.selectedWeek, `${message}: located week`);
  assert.deepEqual(actual.weeks, expected.weeks, `${message}: expanded weeks`);
  assert.deepEqual(actual.tasks, expected.tasks, `${message}: expanded task contents`);
  assert.equal(actual.cursor, expected.cursor, `${message}: task cursor`);
  assert.ok(Math.abs(actual.scroll - expected.scroll) < 5, `${message}: reading scroll`);
}

test('completion filters keep separate reading positions across switching and refresh', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await scopedFilterFixture(page);
  const all = await locateFilterReading(page, 'all', sample.partial, 8, 420);
  const done = await locateFilterReading(page, 'done', sample.done, 1, 0);
  assert.equal(await page.locator('#weekTasks .outline-week-group').count(), 1,
    'The completed view must exercise the regression where week 8 is filtered out');
  await page.locator('#taskFilter').selectOption('all');
  await assertFilterReading(page, all, 'Returning from completed to all');
  const pending = await locateFilterReading(page, 'pending', sample.pending, 6, 260);
  const partial = await locateFilterReading(page, 'partial', sample.partial, 8, 100);
  for (const expected of [all, pending, partial, done]) {
    await page.locator('#taskFilter').selectOption(expected.filter);
    await assertFilterReading(page, expected, `Returning to ${expected.filter}`);
  }
  await reloadOutline(page);
  assert.deepEqual(await page.evaluate(() => progressListScope), sample.scope);
  await assertFilterReading(page, done, 'Refreshing the completed view');
  for (const expected of [all, pending, partial]) {
    await page.locator('#taskFilter').selectOption(expected.filter);
    await assertFilterReading(page, expected, `Restoring saved ${expected.filter} after refresh`);
  }
});

test('Back and Forward restore the correct completion filter reading state', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await scopedFilterFixture(page);
  const all = await locateFilterReading(page, 'all', sample.partial, 8, 420);
  const done = await locateFilterReading(page, 'done', sample.done, 1, 0);
  // Changing the status and explicitly locating its week are separate browsing positions.
  for (let step = 0; step < 2; step++) {
    await page.locator('#navigationBackBtn').click();
    await page.waitForFunction(() => !locationNavigationBusy && !restoringLocation);
  }
  await assertFilterReading(page, all, 'History Back to all tasks');
  for (let step = 0; step < 2; step++) {
    await page.locator('#navigationForwardBtn').click();
    await page.waitForFunction(() => !locationNavigationBusy && !restoringLocation);
  }
  await assertFilterReading(page, done, 'History Forward to completed tasks');
  await page.locator('#taskFilter').selectOption('all');
  await assertFilterReading(page, all, 'Switching filters after history restoration');
});

test('application preparation keeps dates and three static steps without repeated completion statuses', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('.nav-item[data-view="milestones"]').click();
  const application = page.locator('#applicationMilestone');
  const dates = await page.evaluate(() => [DATA.applicationMilestone.start, DATA.applicationMilestone.end]);
  assert.deepEqual(await application.locator('.application-dates time').evaluateAll(items => items.map(item => item.getAttribute('datetime'))), dates);
  assert.equal(await application.locator('.application-requirements, .application-requirement').count(), 0,
    'Task and acceptance statuses already belong to their milestone cards');
  const preparation = application.locator('ol, ul');
  assert.equal(await preparation.count(), 1, 'Application preparation has one concise checklist');
  assert.equal(await preparation.locator('li').count(), 3);
  const steps = await preparation.locator('li').allTextContents();
  assert.ok(steps.every(step => step.trim().length > 0));
  assert.match(await application.textContent(), /提前投递/,
    'An unfinished study plan still explains that applications may start early');
  assert.equal(await page.evaluate(() => allTasks.every(task => taskDone(task.id))), false);
  assert.equal(await page.evaluate(() => DATA.milestones.filter(goal => goal.kind === 'project').every(goal => milestoneReview(goal)?.done)), false);
  const ids = await page.evaluate(() => DATA.applicationMilestone.prerequisiteIds
    .flatMap(id => milestoneTasks(DATA.milestones.find(goal => goal.id === id)).map(task => task.id)));
  await seedEntries(page, Object.fromEntries(ids.map(id => [id, { done: true }])));
  assert.deepEqual(await preparation.locator('li').allTextContents(), steps,
    'Preparation steps stay useful and static when check-in progress changes');
  assert.equal(await application.locator('.application-requirements, .application-requirement').count(), 0);
  assert.deepEqual(await application.locator('.application-dates time').evaluateAll(items => items.map(item => item.getAttribute('datetime'))), dates);
  assert.match(await application.textContent(), /提前投递/);
});

test('reopening the same progress count resumes its filter-specific outline reading', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await scopedFilterFixture(page);
  const all = await locateFilterReading(page, 'all', sample.partial, 8, 420);
  const done = await locateFilterReading(page, 'done', sample.done, 1, 120);
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-project-total-yibo').click();
  await assertFilterReading(page, all, 'Reopening the project total');
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-total-ls').click();
  await page.locator('#outlineWeekSelect').selectOption('12');
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-project-completed-yibo').click();
  await assertFilterReading(page, done, 'Reopening the completed count after a different scope');
  await page.locator('#taskFilter').selectOption('all');
  await assertFilterReading(page, all, 'Completed and total counts retain separate reading states');
});

test('ordinary navigation resumes an outline without overwriting it with the other page scroll', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390);
  const sample = await scopedFilterFixture(page);
  const expected = await locateFilterReading(page, 'all', sample.partial, 8, 520);
  for (const view of ['overview', 'milestones']) {
    await page.locator(`.nav-item[data-view="${view}"]`).click();
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
    await page.locator('.nav-item[data-view="planner"]').click();
    await assertFilterReading(page, expected, `Returning from ${view}`);
  }
  // Leave before the scroll debounce fires; navigation must capture the current position itself.
  await page.evaluate(() => {
    window.scrollTo({ top: 650, behavior: 'instant' });
    document.querySelector('.nav-item[data-view="overview"]').click();
  });
  await page.locator('.nav-item[data-view="planner"]').click();
  expected.scroll = 650;
  await assertFilterReading(page, expected, 'Immediate navigation after scrolling');
  await reloadOutline(page);
  await assertFilterReading(page, expected, 'Refresh after navigation resumes the same reading position');
  await syncRecordRefresh(page);
  await assertFilterReading(page, expected, 'Background sync leaves the resumed position alone');
});

test('reopening a deliberately collapsed outline keeps its weeks collapsed', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('#progress-total-ls').click();
  await page.locator('#outlineExpandAllBtn').click();
  await page.locator('#outlineExpandAllBtn').click();
  await page.locator('.nav-item[data-view="milestones"]').click();
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-total-ls').click();
  assert.equal(await page.locator('#weekTasks .outline-week-group[open]').count(), 0);
});

for (const track of ['ls', 'ydy', 'review']) {
  test(`Continue records show all completed ${track} tasks across the plan and allow correcting a check-in`, { timeout: 30_000 }, async t => {
    const page = await pageAt(t);
    const fixture = await page.evaluate(track => {
      const tasks = allTasks.filter(task => task.track === track);
      const stamp = freshTimestamp();
      for (const task of tasks) state.entries[task.id] = createEntry(true, stamp, `成果 https://example.com/record/${task.id}`);
      localRevision++; saveState();
      selectWeek(38);
      activateView('overview');
      continueTrackChoice = track; renderContinue();
      return { ids: tasks.map(task => task.id), last: tasks.at(-1).id,
        phases: [...new Set(tasks.map(task => phaseForWeek(task.week).id))] };
    }, track);
    assert.match(await page.locator('#continueBox').textContent(), /这一方向已全部打卡/);
    await page.locator('#continueBox [data-continue-records]').click();
    assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'all', track, project: '' });
    assert.equal(await page.locator('#taskFilter').inputValue(), 'done');
    assert.deepEqual(await outlineIds(page), fixture.ids, 'The entry includes every task in the completed direction');
    assert.match(await page.locator('#progressListSummary').textContent(), /全计划/);
    assert.equal(await page.locator('#weekTasks a.record-link').count(), fixture.ids.length, 'Each saved result link is available');
    const labels = await page.locator('#weekTasks .outline-week-summary h3').allTextContents();
    if (fixture.phases.length > 1) {
      assert.ok(labels.some(label => label.startsWith('课程计划')));
      assert.ok(labels.some(label => label.startsWith('项目深化')));
    }
    const lastWeek = await page.evaluate(id => taskById.get(id).week, fixture.last);
    await page.locator('#outlineWeekSelect').selectOption(String(lastWeek));
    const last = page.locator(`#weekTasks .task-outline-item[data-task-id="${fixture.last}"]`);
    await last.locator('.task-outline-content > summary').click();
    const link = last.locator('a.record-link');
    assert.equal(await link.isVisible(), true);
    assert.equal(await link.getAttribute('href'), `https://example.com/record/${fixture.last}`);
    await reloadOutline(page);
    assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'all', track, project: '' });
    assert.deepEqual(await outlineIds(page), fixture.ids, 'All-phase records survive refresh');
    assert.equal(await page.locator('#outlineWeekSelect').inputValue(), String(lastWeek));
    await last.locator('.outline-check').click();
    await page.waitForFunction(id => !taskDone(id), fixture.last);
    assert.deepEqual(await outlineIds(page), fixture.ids.filter(id => id !== fixture.last), 'Cancelled check-ins leave the completed records list');
    assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'all', track, project: '' });
    await page.locator('#exitProgressListBtn').click();
    assert.equal(await page.locator('#weekSelect').inputValue(), '38', 'Returning to the week restores the original phase and week');
  });
}

test('Back and Forward preserve all-phase records and their located deepening week', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const tasks = allTasks.filter(task => task.track === 'ydy');
    const stamp = freshTimestamp();
    for (const task of tasks) state.entries[task.id] = createEntry(true, stamp);
    localRevision++; saveState();
    continueTrackChoice = 'ydy'; renderContinue();
    return tasks.find(task => task.week === 38).id;
  });
  await page.locator('#continueBox [data-continue-records]').click();
  const expected = await locateFilterReading(page, 'done', sample, 38, 420);
  await page.locator('.nav-item[data-view="milestones"]').click();
  await page.locator('#navigationBackBtn').click();
  await page.waitForFunction(() => !locationNavigationBusy && !restoringLocation);
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'all', track: 'ydy', project: '' });
  await assertFilterReading(page, expected, 'Back to all-phase records');
  await page.locator('#navigationForwardBtn').click();
  await page.waitForFunction(() => !locationNavigationBusy && !restoringLocation);
  assert.equal(await page.evaluate(() => selectedView), 'milestones');
  await page.locator('#navigationBackBtn').click();
  await page.waitForFunction(() => !locationNavigationBusy && !restoringLocation);
  await assertFilterReading(page, expected, 'Back after Forward retains the original records position');
});

test('clearing an outline status filter keeps the resumed position after focus, re-entry and refresh', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390);
  const sample = await scopedFilterFixture(page);
  const expected = await locateFilterReading(page, 'all', sample.partial, 8, 520);
  await page.locator('#taskFilter').selectOption('done');
  await page.locator('#clearFiltersBtn').click();
  // Focus can trigger a smooth scroll that overwrites the saved position after the action returns.
  await page.waitForTimeout(700);
  await assertFilterReading(page, expected, 'Clearing the completed filter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'taskSearch');
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-project-total-yibo').click();
  await assertFilterReading(page, expected, 'Reopening after clearing filters');
  await reloadOutline(page);
  await assertFilterReading(page, expected, 'Refreshing after clearing filters');
});

test('a note-only practice record is visible in details, outlines and weekday and weekend recommendations', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const id = 'av59-sat5-v1-w01-practice';
  const note = '已检查构建配置 https://example.com/build';
  await page.evaluate(id => openTaskDetails(id), id);
  await page.locator('#taskProgressNote').fill(note);
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(({ id, note }) => taskProgress(id)?.note === note, { id, note });
  assert.match(await page.locator('#detailTaskStatus').textContent(), /已存部分进度/);
  assert.deepEqual(await page.evaluate(id => taskProgress(id), id),
    { kind: 'practice', workedMinutes: 0, completedSteps: [], note });
  assert.equal(await page.evaluate(() => allTasks.filter(task => taskDone(task.id)).length), 0);
  await page.locator('#closeTaskBtn').click();
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  const row = page.locator(`#weekTasks .task-outline-item[data-task-id="${id}"]`);
  assert.match(await row.locator('.outline-task-status').textContent(), /进行中/);
  assert.match(await row.locator('.task-outline-progress').textContent(), /已存学习记录/);
  await page.locator('#taskFilter').selectOption('partial');
  assert.deepEqual(await outlineIds(page), [id]);
  await page.locator('.nav-item[data-view="milestones"]').click();
  const milestone = page.locator('[data-milestone-id="yibo"]');
  assert.equal(await milestone.locator('.goal-status').textContent(), '进行中');
  assert.equal(await milestone.locator('.goal-progress-label > strong').textContent(), '0 / 20');
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    state.entries['av59-sat5-v1-w01-watch'] = createEntry(true, stamp);
    localRevision++; saveState(); activateView('overview');
  });
  const recommended = page.locator('#continueBox .continue-task');
  assert.equal(await recommended.getAttribute('data-task-id'), id);
  assert.equal(await recommended.locator('.continue-session-note').textContent(), '已存学习记录');
  assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, id), 0);
  assert.equal(await page.evaluate(id => taskDone(id), id), false);
  await page.clock.setFixedTime(new Date('2026-10-17T04:00:00Z'));
  await page.evaluate(() => render());
  assert.equal(await recommended.getAttribute('data-task-id'), id);
  assert.equal(await recommended.locator('.continue-session-note').textContent(), '已存学习记录');
  await recommended.locator('[data-task-action="toggle"]').click();
  await page.waitForFunction(id => taskDone(id), id);
  await page.evaluate(id => openTaskDetails(id), id);
  assert.equal(await page.locator('#detailTaskStatus').textContent(), '已打卡');
  assert.match(await page.locator('.progress-readonly-note').textContent(), /已检查构建配置/);
  assert.equal(await page.locator('.progress-readonly-note a').getAttribute('href'), 'https://example.com/build');
  assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, id), 0,
    'Saving or completing a note cannot invent practice minutes');
});

test('milestones distinguish empty progress from minutes, steps, notes and video stops without increasing completion', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.locator('.nav-item[data-view="milestones"]').click();
  const practice = 'av59-sat5-v1-w01-practice';
  const video = 'av59-sat5-v1-w01-watch';
  const cases = [
    { id: practice, progress: { kind: 'practice' }, status: '未开始' },
    { id: practice, progress: { kind: 'practice', workedMinutes: 0, completedSteps: [], note: '  \n ' }, status: '未开始' },
    { id: video, progress: { kind: 'video' }, status: '未开始' },
    { id: practice, progress: { kind: 'practice', workedMinutes: 60, completedSteps: [] }, status: '进行中' },
    { id: practice, progress: { kind: 'practice', workedMinutes: 0, completedSteps: [0] }, status: '进行中' },
    { id: practice, progress: { kind: 'practice', workedMinutes: 0, completedSteps: [], note: '已保存构建记录' }, status: '进行中' },
    { id: video, progress: { kind: 'video', segmentIndex: 0, positionSecond: 60 }, status: '进行中' }
  ];
  const card = page.locator('[data-milestone-id="yibo"]');
  for (const fixture of cases) {
    await seedEntries(page, {
      [practice]: { done: false }, [video]: { done: false },
      [fixture.id]: { done: false, progress: fixture.progress }
    });
    assert.equal(await card.locator('.goal-status').textContent(), fixture.status);
    assert.equal(await card.locator('.goal-progress-label > strong').textContent(), '0 / 20');
    assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), '0');
    assert.equal(await page.evaluate(() => allTasks.filter(task => taskDone(task.id)).length), 0);
  }
});

test('partial milestone progress preserves parallel, overdue, checked and acceptance status rules', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const goal = DATA.milestones.find(item => item.id === 'yibo');
    return { ids: goal.taskIds, date: dateAt(goal.date, 1),
      ls: allTasks.find(task => task.track === 'ls').id };
  });
  await seedEntries(page, {
    [sample.ls]: { done: false, progress: { kind: 'video', segmentIndex: 0, positionSecond: 60 } },
    'av59-sat5-v1-w01-practice': { done: false, progress: { kind: 'practice', workedMinutes: 60, completedSteps: [] } }
  });
  await page.locator('.nav-item[data-view="milestones"]').click();
  const courses = page.locator('[data-milestone-id="courses"]');
  assert.equal(await courses.locator('.goal-status').textContent(), '进行中');
  assert.equal(await courses.locator('.goal-meter').getAttribute('aria-valuenow'), '0');
  const yibo = page.locator('[data-milestone-id="yibo"]');
  assert.equal(await yibo.locator('.goal-status').textContent(), '进行中');
  await page.clock.setFixedTime(new Date(`${sample.date}T04:00:00Z`));
  await page.evaluate(() => render());
  assert.equal(await yibo.locator('.goal-status').textContent(), '待补');
  assert.equal(await yibo.locator('.goal-progress-label > strong').textContent(), '0 / 20');
  await seedEntries(page, Object.fromEntries(sample.ids.map(id => [id, { done: true }])));
  assert.equal(await yibo.locator('.goal-status').textContent(), '待验收');
  assert.equal(await yibo.locator('.goal-progress-label > strong').textContent(), '20 / 20');
  await seedEntries(page, { 'milestone:yibo': { done: true } });
  assert.equal(await yibo.locator('.goal-status').textContent(), '已验收');
  await seedEntries(page, Object.fromEntries(sample.ids.map(id => [id, { done: false }])));
  assert.equal(await yibo.locator('.goal-status').textContent(), '已验收', 'Early acceptance remains independent of task check-ins');
  assert.equal(await yibo.locator('.goal-progress-label > strong').textContent(), '0 / 20');
});

test('practice progress toast leaves manual completion reachable and each Undo restores only its own change', { timeout: 90_000 }, async t => {
  const id = 'av59-sat5-v1-w01-practice';
  for (const width of [320, 390, 1280]) {
    const page = await pageAt(t, width);
    await page.evaluate(taskId => openTaskDetails(taskId), id);
    await page.locator('#practiceSessionMinutes').fill('40');
    await page.locator('[data-progress-step="0"]').check();
    await page.locator('[data-progress-action="save-practice"]').click();
    await page.locator('#taskDialog .toast-action').waitFor();
    assert.deepEqual(await page.evaluate(taskId => ({ done: taskDone(taskId),
      minutes: taskProgress(taskId)?.workedMinutes, steps: taskProgress(taskId)?.completedSteps }), id),
    { done: false, minutes: 40, steps: [0] }, `${width}px: recording effort and one step must not auto-complete the task`);

    const beforeCompletion = await dialogToastGeometry(page);
    assert.ok(beforeCompletion, `${width}px: the progress toast is in the task dialog`);
    assert.equal(beforeCompletion.statusCovered, false, `${width}px: toast must not cover the status`);
    assert.equal(beforeCompletion.buttonCovered, false, `${width}px: toast must not cover the completion button`);
    assert.equal(beforeCompletion.buttonHittable, true, `${width}px: a mouse must hit the completion button`);
    await page.mouse.click(beforeCompletion.x, beforeCompletion.y);
    await page.waitForFunction(taskId => taskDone(taskId), id);
    assert.match(await page.locator('#detailTaskStatus').textContent(), /已打卡/);
    assert.deepEqual(await page.evaluate(taskId => ({ minutes: taskProgress(taskId)?.workedMinutes,
      steps: taskProgress(taskId)?.completedSteps }), id), { minutes: 40, steps: [0] });

    await page.locator('#taskDialog .toast-action').click();
    await page.waitForFunction(taskId => !taskDone(taskId), id);
    assert.deepEqual(await page.evaluate(taskId => ({ minutes: taskProgress(taskId)?.workedMinutes,
      steps: taskProgress(taskId)?.completedSteps }), id), { minutes: 40, steps: [0] },
    `${width}px: Undo of completion must preserve saved practice progress`);

    await page.locator('#practiceSessionMinutes').fill('5');
    await page.locator('[data-progress-action="save-practice"]').click();
    await page.waitForFunction(taskId => taskProgress(taskId)?.workedMinutes === 45, id);
    await page.locator('#taskDialog .toast-action').click();
    await page.waitForFunction(taskId => taskProgress(taskId)?.workedMinutes === 40, id);
    assert.deepEqual(await page.evaluate(taskId => ({ done: taskDone(taskId),
      minutes: taskProgress(taskId)?.workedMinutes, steps: taskProgress(taskId)?.completedSteps }), id),
    { done: false, minutes: 40, steps: [0] }, `${width}px: Undo of a later progress save restores its preceding record`);
  }
});

test('a pending Undo follows the topmost confirmation and returns to the task, then the page', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390);
  await page.evaluate(id => openTaskDetails(id), 'av59-sat5-v1-w01-practice');
  await page.locator('#practiceSessionMinutes').fill('40');
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.locator('#taskDialog .toast-action').waitFor();
  await page.locator('#taskProgressNote').fill('未保存的草稿');
  await page.locator('#closeTaskBtn').click();
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#toastRegion')?.closest('dialog')?.id === 'confirmDialog');
  assert.equal(await page.locator('#confirmDialog .toast-action').isVisible(), true,
    'Undo stays reachable inside the active native modal');

  await page.locator('#confirmCancelBtn').click();
  await page.waitForFunction(() => document.querySelector('#toastRegion')?.closest('dialog')?.id === 'taskDialog');
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  assert.equal(await page.locator('#taskProgressNote').inputValue(), '未保存的草稿');
  await page.locator('#taskProgressNote').fill('');
  await page.waitForFunction(() => !detailProgressDirty);
  await page.locator('#closeTaskBtn').click();
  await page.waitForFunction(() => document.querySelector('#toastRegion')?.parentElement === document.body);
  assert.equal(await page.locator('#toastRegion .toast-action').isVisible(), true,
    'Undo stays available after the task dialog closes');
});

test('Escape from a focused Undo restores keyboard focus after cancelling a dirty-exit confirmation', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390);
  const id = 'av59-sat5-v1-w01-practice';
  await page.evaluate(taskId => openTaskDetails(taskId), id);
  await page.locator('#practiceSessionMinutes').fill('40');
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(taskId => taskProgress(taskId)?.workedMinutes === 40, id);
  await page.locator('#practiceSessionMinutes').fill('10');
  await page.locator('#taskDialog .toast-action').focus();
  assert.equal(await page.evaluate(() => document.activeElement?.matches('#taskDialog .toast-action')), true);

  await page.keyboard.press('Escape');
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#confirmDialog .toast-action').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#toastRegion')?.closest('dialog')?.id === 'taskDialog'
    && document.activeElement?.matches('#taskDialog .toast-action'));
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  assert.equal(await page.locator('#practiceSessionMinutes').inputValue(), '10', 'Cancelling exit keeps the unsaved draft');

  await page.keyboard.press('Enter');
  await page.waitForFunction(taskId => !taskProgress(taskId) && !taskDone(taskId), id);
  assert.equal(await page.locator('#practiceSessionMinutes').inputValue(), '10',
    'Undoing the saved 40 minutes does not discard the newer unsaved 10-minute draft');
  assert.equal(await page.evaluate(() => detailProgressDirty), true);
  assert.equal(await page.evaluate(taskId => taskDone(taskId), id), false,
    'The repeated keyboard action must not complete the task');
});

test('a long mobile toast wraps without hiding task controls or leaving an empty footer spacer', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 320);
  await page.evaluate(id => openTaskDetails(id), 'av59-sat5-v1-w01-practice');
  await page.evaluate(() => showToast('这条较长的学习记录提示用于检查小屏幕换行。请核对本次保存的实践分钟数、步骤和任务状态，然后决定是否完成打卡。'.repeat(2),
    { label: '撤销', run: () => {} }));
  const lines = await page.locator('#taskDialog .toast > span').evaluate(span => {
    const style = getComputedStyle(span);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
    return span.getBoundingClientRect().height / lineHeight;
  });
  assert.ok(lines > 1.5, 'A narrow toast wraps rather than widening beyond the viewport');
  const geometry = await dialogToastGeometry(page);
  assert.ok(geometry);
  assert.equal(geometry.statusCovered, false);
  assert.equal(geometry.buttonCovered, false);
  assert.equal(geometry.buttonHittable, true);
  const footerBottomBeforeDismiss = await page.locator('#taskDialog .dialog-footer').evaluate(footer => footer.getBoundingClientRect().bottom);
  await page.locator('#taskDialog .toast-close').click();
  assert.equal(await page.locator('#toastRegion .toast').count(), 0);
  const afterDismiss = await page.evaluate(() => ({
    toastRegionHeight: document.querySelector('#taskDialog #toastRegion')?.getBoundingClientRect().height,
    footerBottom: document.querySelector('#taskDialog .dialog-footer').getBoundingClientRect().bottom,
    buttonHit: (() => {
      const button = document.querySelector('#detailToggleBtn');
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      return hit === button || button.contains(hit);
    })()
  }));
  assert.ok(afterDismiss.toastRegionHeight <= 1, 'An empty toast region must not reserve footer space');
  assert.ok(Math.abs(afterDismiss.footerBottom - footerBottomBeforeDismiss) <= 2,
    'Dismissing the toast must not shift the footer to a stale offset');
  assert.equal(afterDismiss.buttonHit, true);
});

test('an older progress Undo cannot erase a newer record for the same task received from sync', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const id = 'av59-sat5-v1-w01-practice';
  await page.evaluate(taskId => openTaskDetails(taskId), id);
  await page.locator('#practiceSessionMinutes').fill('40');
  await page.locator('[data-progress-step="0"]').check();
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(taskId => taskProgress(taskId)?.workedMinutes === 40 && !activeSyncPromise, id);
  const newer = { done: false, updatedAt: '2030-01-01T00:00:00.000Z',
    progress: { kind: 'practice', workedMinutes: 60, completedSteps: [0, 1], note: '另一设备新增的验证' } };
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { state: { entries: { ...body.state.entries, [id]: newer } }, serverTime: new Date().toISOString() } });
  });
  await page.evaluate(() => syncToServer({ silent: true }));
  await page.waitForFunction(taskId => taskProgress(taskId)?.workedMinutes === 60, id);
  assert.equal(await page.locator('#taskDialog .toast-action').isVisible(), true, 'The earlier Undo is still offered briefly');
  await page.locator('#taskDialog .toast-action').click();
  assert.deepEqual(await page.evaluate(taskId => ({ done: taskDone(taskId), progress: taskProgress(taskId) }), id),
    { done: false, progress: newer.progress }, 'Undo must not replace the later synced minutes, steps or note');
  assert.match(await page.locator('#toastRegion .toast').textContent(), /记录已更新.*未撤销/);
});

test('undoing completion during an unsaved edit updates the footer without discarding the draft', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390);
  const id = 'av59-sat5-v1-w01-practice';
  await page.evaluate(taskId => openTaskDetails(taskId), id);
  assert.match(await page.locator('label[for="taskProgressNote"]').textContent(), /学习记录/);
  await page.locator('#practiceSessionMinutes').fill('40');
  await page.locator('#taskProgressNote').fill('第一次验证');
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(taskId => taskProgress(taskId)?.workedMinutes === 40, id);
  await page.locator('#closeTaskBtn').click();
  await page.locator('#taskDialog').waitFor({ state: 'hidden' });
  await page.evaluate(taskId => openTaskDetails(taskId), id);
  assert.equal(await page.locator('#taskProgressNote').inputValue(), '第一次验证',
    'A prior learning note can be reopened and edited');
  await page.locator('#detailToggleBtn').click();
  await page.waitForFunction(taskId => taskDone(taskId), id);
  await page.locator('#editTaskProgressBtn').click();
  await page.locator('#practiceSessionMinutes').fill('10');
  await page.locator('#taskProgressNote').fill('第二次验证，尚未保存');
  await page.locator('#taskDialog .toast-action').click();
  await page.waitForFunction(taskId => !taskDone(taskId), id);
  assert.match(await page.locator('#detailTaskStatus').textContent(), /尚未打卡/);
  assert.equal(await page.locator('#detailToggleBtn').textContent(), '标记完成');
  assert.equal(await page.locator('#detailToggleBtn').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#practiceSessionMinutes').inputValue(), '10');
  assert.equal(await page.locator('#taskProgressNote').inputValue(), '第二次验证，尚未保存');
  assert.equal(await page.evaluate(() => detailProgressDirty), true);
  assert.deepEqual(await page.evaluate(taskId => taskProgress(taskId), id),
    { kind: 'practice', workedMinutes: 40, completedSteps: [], note: '第一次验证' },
    'Completion Undo retains the last saved note and minutes while the new draft stays editable');
});

test('an ordinary Undo still restores its task when another task receives a newer record', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const first = 'av59-sat5-v1-w01-practice';
  const second = 'av59-sat5-v1-w02-practice';
  await seedEntries(page, { [first]: { done: false,
    progress: { kind: 'practice', workedMinutes: 15, completedSteps: [0] } } });
  await page.evaluate(id => changeTask(id, true), first);
  await page.locator('#toastRegion .toast-action').waitFor();
  await seedEntries(page, { [second]: { done: true } });
  await page.locator('#toastRegion .toast-action').click();
  assert.deepEqual(await page.evaluate(([a, b]) => ({ firstDone: taskDone(a), firstProgress: taskProgress(a),
    secondDone: taskDone(b) }), [first, second]),
  { firstDone: false, firstProgress: { kind: 'practice', workedMinutes: 15, completedSteps: [0] }, secondDone: true },
  'A change to an unrelated task must not disable a valid single-task Undo');
});

test('Undo checks a newer localStorage record even before a storage event, but keeps unrelated stored changes', { timeout: 45_000 }, async t => {
  const changedSameTask = await pageAt(t);
  const ids = await changedSameTask.evaluate(() => allTasks.filter(task => task.track === 'ls').slice(0, 2).map(task => task.id));
  const [first, second] = ids;
  await changedSameTask.evaluate(id => changeTask(id, true), first);
  await changedSameTask.waitForFunction(() => !activeSyncPromise);
  await changedSameTask.evaluate(id => {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    stored.entries[id] = createEntry(false, '2030-01-01T00:00:00.000Z');
    localStorage.setItem(STORE_KEY, JSON.stringify(stored)); // Same-document writes do not dispatch a storage event.
  }, first);
  await changedSameTask.locator('#toastRegion .toast-action').click();
  assert.match(await changedSameTask.locator('#toastRegion .toast').textContent(), /记录已更新.*未撤销/);
  assert.equal(await changedSameTask.evaluate(id => JSON.parse(localStorage.getItem(STORE_KEY)).entries[id].updatedAt, first),
    '2030-01-01T00:00:00.000Z', 'A stale Undo must not overwrite the unseen same-task record on disk');

  const changedOtherTask = await pageAt(t);
  await changedOtherTask.evaluate(id => changeTask(id, true), first);
  await changedOtherTask.waitForFunction(() => !activeSyncPromise);
  await changedOtherTask.evaluate(id => {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    stored.entries[id] = createEntry(true, '2030-01-01T00:00:00.000Z');
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  }, second);
  await changedOtherTask.locator('#toastRegion .toast-action').click();
  assert.deepEqual(await changedOtherTask.evaluate(([a, b]) => ({ live: [taskDone(a), taskDone(b)],
    stored: [JSON.parse(localStorage.getItem(STORE_KEY)).entries[a].done,
      JSON.parse(localStorage.getItem(STORE_KEY)).entries[b].done] }), ids),
  { live: [false, true], stored: [false, true] },
  'A valid Undo restores its target and merges an unrelated stored record into memory and storage');
});

test('partial-import and reset Undo reject an entire batch if one affected task changes afterward', { timeout: 60_000 }, async t => {
  const [first, second] = ['av59-sat5-v1-w01-practice', 'av59-sat5-v1-w02-practice'];
  const imported = await pageAt(t);
  await imported.locator('#openSyncBtn').click();
  const backup = { version: 3, entries: Object.fromEntries([first, second].map(id =>
    [id, { done: true, updatedAt: '2026-10-01T00:00:00.000Z' }])) };
  await imported.locator('#importFile').setInputFiles({ name: 'backup.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)) });
  await imported.locator('#confirmDialog').waitFor({ state: 'visible' });
  await imported.locator('#confirmAcceptBtn').click();
  await imported.waitForFunction(([a, b]) => taskDone(a) && taskDone(b), [first, second]);
  await imported.locator('#syncDialog .toast-action').waitFor();
  await seedEntries(imported, { [first]: { done: false } });
  await imported.locator('#syncDialog .toast-action').click();
  assert.deepEqual(await imported.evaluate(([a, b]) => [taskDone(a), taskDone(b)], [first, second]), [false, true],
    'Import Undo must not partly revert the unchanged second record after the first changes');
  assert.match(await imported.locator('#toastRegion .toast').textContent(), /记录已更新.*未撤销/);

  const cleared = await pageAt(t);
  await seedEntries(cleared, { [first]: { done: true }, [second]: { done: true } });
  await cleared.locator('#openSyncBtn').click();
  await cleared.locator('#resetBtn').click();
  await cleared.locator('#confirmDialog').waitFor({ state: 'visible' });
  await cleared.locator('#confirmAcceptBtn').click();
  await cleared.waitForFunction(([a, b]) => !taskDone(a) && !taskDone(b), [first, second]);
  await cleared.locator('#syncDialog .toast-action').waitFor();
  await seedEntries(cleared, { [first]: { done: true } });
  await cleared.locator('#syncDialog .toast-action').click();
  assert.deepEqual(await cleared.evaluate(([a, b]) => [taskDone(a), taskDone(b)], [first, second]), [true, false],
    'Reset Undo must not partly restore the unchanged second record after the first changes');
  assert.match(await cleared.locator('#toastRegion .toast').textContent(), /记录已更新.*未撤销/);
});

test('transition-week preview keeps distinct visible day types and full accessible labels at every width', { timeout: 60_000 }, async t => {
  const categories = [
    { short: /零声/, full: /零声课程/ }, { short: /面试/, full: /面试准备/ },
    { short: /项目/, full: /易道云.*项目|项目练习/ }, { short: /项目/, full: /易道云.*项目|项目练习/ },
    { short: /项目/, full: /易道云.*项目|项目练习/ }, { short: /易道云|项目/, full: /易道云.*项目/ },
    { short: /周日|机动/, full: /周日机动/ }
  ];
  for (const width of [320, 390, 1280]) {
    const page = await pageAt(t, width);
    await page.clock.setFixedTime(new Date('2027-05-12T04:00:00Z'));
    await page.evaluate(() => render());
    assert.equal(await page.locator('#previewWeekLabel').textContent().then(text => /第\s*32\s*周/.test(text)), true);
    const days = page.locator('#overviewWeekPreview .preview-day');
    assert.equal(await days.count(), 7);
    for (let index = 0; index < categories.length; index++) {
      const day = days.nth(index);
      const short = day.locator('.preview-title');
      assert.equal(await short.isVisible(), true, `${width}px day ${index + 1} needs a visible type, not only a color dot`);
      assert.match(await short.innerText(), categories[index].short);
      if (width <= 390) {
        const size = await short.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        assert.ok(size.scroll <= size.client + 1, `${width}px day ${index + 1} type label must not be clipped`);
      }
      assert.match(await day.getAttribute('aria-label'), categories[index].full,
        `${width}px day ${index + 1} keeps the full category for assistive technology`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
});

for (const { name, width, deepOutline, dismiss } of [
  { name: 'weekly list close', width: 390, deepOutline: false, dismiss: 'close' },
  { name: 'weekly list timeout', width: 1280, deepOutline: false, dismiss: 'timeout' },
  { name: 'deep outline close', width: 390, deepOutline: true, dismiss: 'close' },
  { name: 'deep outline timeout', width: 1280, deepOutline: true, dismiss: 'timeout' }
]) {
  test(`keyboard check-in ${name} returns from a vanished toast to a safe list control`, { timeout: 30_000 }, async t => {
    const page = await pageAt(t, width, { clockInstall: dismiss === 'timeout' });
    const { nextId } = await keyboardCompleteFromPendingList(page, deepOutline);
    const scrollBefore = await page.evaluate(() => scrollY);
    if (dismiss === 'close') {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.matches('#toastRegion .toast-close')), true,
        'Keyboard users can reach the toast close button from Undo');
      await page.keyboard.press('Enter');
    } else await page.clock.fastForward(12_050);
    await page.waitForFunction(() => !$('toastRegion').childElementCount);
    const focus = await focusedControl(page);
    assert.equal(focus.visible, true, 'Focus returns to a rendered control when the toast disappears');
    assert.equal(focus.safePlanner, true, `Focus must stay in the current list, not ${focus.tag || 'BODY'}`);
    assert.equal(focus.dangerousToggle, false, 'Focus must not move to another completion toggle');
    if (deepOutline) {
      assert.equal(await page.locator('#outlineWeekSelect').inputValue(), '18');
      assert.equal(await page.locator('#weekTasks .outline-week-group[data-result-week="18"]').getAttribute('open'), '');
      assert.ok(focus.week === '18' || focus.id === 'outlineWeekSelect',
        'Focus must return inside week 18 or to its explicit week locator, not the page start');
      assert.ok((await page.evaluate(() => scrollY)) > 500, 'A deep reading position must not jump back to the page top');
      assert.ok(Math.abs((await page.evaluate(() => scrollY)) - scrollBefore) < 250,
        'Removing the toast must not jump away from the selected outline week');
    }
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(id => taskDone(id), nextId), false,
      'The next Enter must not silently check in the next task');
  });
}

test('toast expiry does not steal focus from a control the user selected afterward', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390, { clockInstall: true });
  const { nextId } = await keyboardCompleteFromPendingList(page, true);
  await page.locator('#outlineWeekSelect').focus();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'outlineWeekSelect');
  await page.clock.fastForward(12_050);
  await page.waitForFunction(() => !$('toastRegion').childElementCount);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'outlineWeekSelect',
    'A dismissal timer must not override a later deliberate focus choice');
  assert.equal(await page.evaluate(id => taskDone(id), nextId), false);
});

test('replacing a focused Undo restores list focus without moving a later user focus choice', { timeout: 45_000 }, async t => {
  const focusedUndo = await pageAt(t, 390);
  const { id, nextId } = await keyboardCompleteFromPendingList(focusedUndo, true);
  const priorScroll = await focusedUndo.evaluate(() => scrollY);
  await focusedUndo.evaluate(() => showToast('新的同步提示'));
  assert.match(await focusedUndo.locator('#toastRegion .toast').textContent(), /新的同步提示/);
  const restored = await focusedControl(focusedUndo);
  assert.equal(restored.visible, true);
  assert.equal(restored.safePlanner, true, 'Replacing the focused Undo must restore a safe outline control');
  assert.equal(restored.dangerousToggle, false);
  assert.ok(restored.week === '18' || restored.id === 'outlineWeekSelect');
  assert.ok(Math.abs((await focusedUndo.evaluate(() => scrollY)) - priorScroll) < 250,
    'Replacing the toast must not jump back to the start of a deep outline');
  assert.deepEqual(await focusedUndo.evaluate(([a, b]) => [taskDone(a), taskDone(b)], [id, nextId]), [true, false],
    'Replacing the notice does not run its old Undo or check in another task');

  const movedFocus = await pageAt(t, 390);
  await keyboardCompleteFromPendingList(movedFocus, true);
  await movedFocus.locator('#outlineWeekSelect').focus();
  await movedFocus.evaluate(() => showToast('另一条新提示'));
  assert.equal(await movedFocus.evaluate(() => document.activeElement?.id), 'outlineWeekSelect',
    'Replacing an old Undo must not steal a newer intentional focus choice');
});

test('keyboard Undo restores a safe list focus without completing the next task', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390);
  const { id, nextId } = await keyboardCompleteFromPendingList(page, true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(taskId => !taskDone(taskId), id);
  const focus = await focusedControl(page);
  assert.equal(focus.visible, true);
  assert.equal(focus.safePlanner, true, 'Undo must leave keyboard focus in the current task outline');
  assert.equal(focus.dangerousToggle, false, 'Undo must not focus the restored completion toggle');
  assert.equal(focus.task, id, 'Undo focuses its restored task rather than another row');
  assert.equal(focus.outlineTitleOrDetails, true, 'The restored focus target is the task title or details summary');
  assert.equal(await page.evaluate(id => taskDone(id), nextId), false);
  assert.equal(await page.locator('#outlineWeekSelect').inputValue(), '18');
});

test('an expired Undo inside dirty confirmation leaves focus in the modal and returns safely to its task', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390, { clockInstall: true });
  const id = 'av59-sat5-v1-w01-practice';
  await page.evaluate(taskId => openTaskDetails(taskId), id);
  await page.locator('#practiceSessionMinutes').fill('40');
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(taskId => taskProgress(taskId)?.workedMinutes === 40, id);
  await page.locator('#practiceSessionMinutes').fill('10');
  await page.locator('#taskDialog .toast-action').focus();
  await page.keyboard.press('Escape');
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#confirmDialog .toast-action').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'confirmCancelBtn');
  await page.clock.fastForward(12_050);
  await page.waitForFunction(() => !$('toastRegion').childElementCount);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'confirmCancelBtn',
    'An expired Undo cannot steal focus from confirmation controls');
  await page.keyboard.press('Escape');
  await page.locator('#confirmDialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.closest('#taskDialog'));
  const focus = await focusedControl(page);
  assert.equal(focus.visible, true);
  assert.equal(focus.taskDialog, true, 'The stale Undo reference must not strand focus on BODY outside the parent modal');
  assert.equal(focus.dangerousToggle, false);
  assert.equal(await page.locator('#practiceSessionMinutes').inputValue(), '10', 'Cancelling confirmation preserves the unsaved draft');
  await page.keyboard.press('Tab');
  assert.equal((await focusedControl(page)).taskDialog, true, 'Keyboard navigation remains inside the task modal');
});
