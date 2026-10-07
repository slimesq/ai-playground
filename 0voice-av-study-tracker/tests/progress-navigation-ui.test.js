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
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'av-progress-navigation-'));
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
  assert.ok(ready, 'Isolated tracker server should start');
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
});

async function pageAt(t, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.clock.setFixedTime(new Date('2026-10-07T04:00:00Z'));
  await page.route('**/api/config', route => route.fulfill({ json: { authRequired: false } }));
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { state: { entries: body.state.entries }, serverTime: new Date().toISOString() } });
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy && !activeSyncPromise);
  return page;
}

async function markDone(page, ids) {
  await page.evaluate(taskIds => {
    const stamp = freshTimestamp();
    for (const id of taskIds) state.entries[id] = createEntry(true, stamp);
    localRevision++;
    saveState(); render();
  }, ids);
}

const listedIds = page => page.locator('#weekTasks .search-week-group .task-outline-item')
  .evaluateAll(cards => cards.map(card => card.dataset.taskId));
const outlineIds = page => page.locator('#weekTasks .task-outline-item')
  .evaluateAll(items => items.map(item => item.dataset.taskId));

test('zero-check-in totals open every scoped course or project task, including unfinished work', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const scopes = await page.evaluate(() => ({
    courseYdy: allTasks.filter(task => task.track === 'ydy' && phaseForWeek(task.week).id === 'courses').map(task => task.id),
    deepeningYdy: allTasks.filter(task => task.track === 'ydy' && phaseForWeek(task.week).id === 'projects').map(task => task.id),
    yibo: DATA.milestones.find(goal => goal.id === 'yibo').taskIds
  }));
  assert.equal(await page.locator('#progress-completed-ydy').isDisabled(), true);
  assert.equal(await page.locator('#progress-total-ydy').isDisabled(), false);
  assert.match(await page.locator('#progress-total-ydy').textContent(), new RegExp(String(scopes.courseYdy.length)));
  await page.locator('#progress-total-ydy').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'courses', track: 'ydy', project: '' });
  assert.equal(await page.locator('#taskFilter').inputValue(), 'all');
  assert.deepEqual(await outlineIds(page), scopes.courseYdy);
  assert.equal(await page.locator('#weekTasks .task-card').count(), 0, 'All-task outline should use its own readable rows');

  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  await page.locator('#projectProgressDetails > summary').click();
  assert.equal(await page.locator('#progress-project-completed-yibo').isDisabled(), true);
  assert.equal(await page.locator('#progress-project-total-yibo').isDisabled(), false);
  await page.locator('#progress-project-total-yibo').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'courses', track: 'ydy', project: 'yibo' });
  assert.deepEqual(await outlineIds(page), scopes.yibo);
  await page.locator(`#weekTasks .task-outline-item[data-task-id="${scopes.yibo[0]}"] .task-outline-title`).click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  assert.equal(await page.evaluate(() => detailTaskId), scopes.yibo[0]);
  await page.locator('#closeTaskBtn').click();
  assert.deepEqual(await outlineIds(page), scopes.yibo);

  await page.locator('#navigationBackBtn').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'courses', track: 'ydy', project: 'yibo' });
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  await page.locator('#progress-phase-projects').click();
  await page.locator('#progress-total-ydy').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'projects', track: 'ydy', project: '' });
  assert.deepEqual(await outlineIds(page), scopes.deepeningYdy);
  assert.ok(scopes.deepeningYdy.every(id => !scopes.courseYdy.includes(id)));
});

test('project outline shows completion, partial work, pending tasks and their real lesson or practice details', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const ids = DATA.milestones.find(goal => goal.id === 'yibo').taskIds;
    const tasks = ids.map(id => taskById.get(id));
    const video = tasks.find(task => task.learningSegments?.some(segment => segment.startSecond > 0));
    const practice = tasks.find(task => task.activity === 'practice' && task.steps?.length && task.deliverables?.length);
    const done = tasks.find(task => task.id !== video.id && task.id !== practice.id);
    return { done: done.id, partial: practice.id, pending: video.id, videoWeek: video.week, practiceWeek: practice.week,
      segments: video.learningSegments.map(segment => ({ title: segment.title,
        start: clockSecond(segment.startSecond), end: clockSecond(segment.endSecond) })),
      steps: practice.steps, deliverables: practice.deliverables };
  });
  assert.ok(sample.segments.some(segment => segment.start !== '00:00:00'), 'The real lesson fixture must test an original nonzero interval');
  await page.evaluate(({ done, partial }) => {
    const stamp = freshTimestamp();
    state.entries[done] = createEntry(true, stamp);
    state.entries[partial] = createEntry(false, stamp, undefined,
      { kind: 'practice', workedMinutes: 20, completedSteps: [0], note: '已验证第一步' });
    localRevision++;
    saveState(); render();
  }, sample);
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-yibo').click();
  const status = async id => page.locator(`#weekTasks .task-outline-item[data-task-id="${id}"] .outline-task-status`).textContent();
  assert.match(await status(sample.done), /已完成/);
  assert.match(await status(sample.partial), /进行中/);
  assert.match(await status(sample.pending), /未开始/);
  assert.equal(await page.locator(`#weekTasks [data-task-id="${sample.done}"] .outline-task-status.is-done`).count(), 1);
  assert.equal(await page.locator(`#weekTasks [data-task-id="${sample.partial}"] .outline-task-status.is-partial`).count(), 1);

  const videoDetails = page.locator(`#weekTasks details.task-outline-content[data-outline-task-id="${sample.pending}"]`);
  await page.locator('#outlineWeekSelect').selectOption(String(sample.videoWeek));
  await videoDetails.locator('summary').click();
  const videoText = await videoDetails.textContent();
  for (const segment of sample.segments) {
    assert.ok(videoText.includes(segment.title), `Outline omits original lesson ${segment.title}`);
    assert.ok(videoText.includes(segment.start) && videoText.includes(segment.end), `Outline omits original video interval for ${segment.title}`);
  }
  const practiceDetails = page.locator(`#weekTasks details.task-outline-content[data-outline-task-id="${sample.partial}"]`);
  await page.locator('#outlineWeekSelect').selectOption(String(sample.practiceWeek));
  await practiceDetails.locator('summary').click();
  const practiceText = await practiceDetails.textContent();
  for (const item of [...sample.steps, ...sample.deliverables]) assert.ok(practiceText.includes(item), `Outline omits practice item ${item}`);

  const priorProgress = await page.evaluate(id => taskProgress(id), sample.partial);
  await page.locator(`#weekTasks [data-task-id="${sample.partial}"] .outline-check`).click();
  await page.waitForFunction(id => taskDone(id), sample.partial);
  assert.match(await status(sample.partial), /已完成/);
  assert.deepEqual(await page.evaluate(id => taskProgress(id), sample.partial), priorProgress);
  await page.locator('#toastRegion .toast-action').click();
  await page.waitForFunction(id => !taskDone(id), sample.partial);
  assert.match(await status(sample.partial), /进行中/);
  assert.deepEqual(await page.evaluate(id => taskProgress(id), sample.partial), priorProgress, 'Undo must keep partial practice work');

  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-project-completed-yibo').click();
  assert.deepEqual(await listedIds(page), [sample.done], 'Completed entry must omit partial and pending outline tasks');
  assert.equal(await page.locator('#weekTasks .task-outline-item').count(), 1);
});

test('Back and Forward preserve a deepening project outline and its expanded task details', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const projectIds = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'studio-baseline').taskIds);
  await page.locator('#progress-phase-projects').click();
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-total-studio-baseline').click();
  assert.deepEqual(await outlineIds(page), projectIds);
  const details = page.locator(`#weekTasks details.task-outline-content[data-outline-task-id="${projectIds[0]}"]`);
  await details.locator('summary').click();
  assert.equal(await details.getAttribute('open'), '');
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  assert.equal(await page.locator('#progress-phase-projects').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#projectProgressDetails').getAttribute('open'), '');
  await page.locator('#navigationForwardBtn').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'projects', track: 'ydy', project: 'studio-baseline' });
  assert.equal(await page.locator('#taskFilter').inputValue(), 'all');
  assert.deepEqual(await outlineIds(page), projectIds);
  assert.equal(await details.getAttribute('open'), '', 'A task expanded in the outline remains expanded after history navigation');
});

test('completed source list includes every done course week and excludes other sources and phases', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const inPhase = (task, phase) => phaseForWeek(task.week).id === phase;
    return {
      earlyCourse: allTasks.find(task => task.track === 'ls' && task.week === 1).id,
      laterCourse: allTasks.find(task => task.track === 'ls' && task.week >= 10).id,
      courseProject: allTasks.find(task => task.track === 'ydy' && inPhase(task, 'courses')).id,
      deepeningProject: allTasks.find(task => task.track === 'ydy' && inPhase(task, 'projects')).id
    };
  });
  await markDone(page, Object.values(sample));
  assert.equal(await page.locator('#progress-completed-ls').isDisabled(), false);
  await page.locator('#progress-completed-ls').click();
  assert.equal(await page.locator('#plannerView').isVisible(), true);
  assert.equal(await page.locator('#progressListContext').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'courses', track: 'ls', project: '' });
  assert.equal(await page.locator('#taskFilter').inputValue(), 'done');
  assert.deepEqual(await listedIds(page), [sample.earlyCourse, sample.laterCourse]);
  assert.match(await page.locator('#progressListTitle').textContent(), /零声/);
  assert.match(await page.locator('#progressListSummary').textContent(), /2/);
  await page.locator('#exitProgressListBtn').click();
  assert.equal(await page.locator('#progressListContext').isVisible(), false);
  assert.equal(await page.locator('#weekTasks .search-week-group').count(), 0);
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.locator('#progress-completed-ydy').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'courses', track: 'ydy', project: '' });
  assert.deepEqual(await listedIds(page), [sample.courseProject], 'A course-phase project count must exclude deepening work');
});

test('project completion list isolates one milestone and one phase, including cross-week tasks', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const sample = await page.evaluate(() => {
    const byId = id => taskById.get(id);
    const project = id => DATA.milestones.find(goal => goal.id === id);
    const yibo = project('yibo').taskIds;
    return {
      firstYibo: yibo[0], laterYibo: yibo.find(id => byId(id).week >= 8),
      otherCourse: project('yunzhujiao').taskIds[0],
      deepening: project('studio-baseline').taskIds[0]
    };
  });
  assert.ok(sample.laterYibo, 'The project fixture should cross several weeks');
  await markDone(page, Object.values(sample));
  await page.locator('#projectProgressDetails > summary').click();
  assert.equal(await page.locator('#projectProgressDetails').getAttribute('open'), '');
  const courseProjects = await page.locator('#projectProgressDetails [data-progress-project-id]')
    .evaluateAll(rows => rows.map(row => row.dataset.progressProjectId));
  assert.deepEqual(courseProjects, ['yibo', 'yunzhujiao', 'studio-course']);
  await page.locator('#progress-project-completed-yibo').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'courses', track: 'ydy', project: 'yibo' });
  assert.deepEqual(await listedIds(page), [sample.firstYibo, sample.laterYibo]);
  assert.match(await page.locator('#progressListTitle').textContent(), /易播/);
  assert.ok(!(await listedIds(page)).includes(sample.otherCourse));
  assert.ok(!(await listedIds(page)).includes(sample.deepening));
});

test('removing an incorrect completion updates the list and count, and Undo restores both', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const ids = await page.evaluate(() => [
    allTasks.find(task => task.track === 'ls' && task.week === 1).id,
    allTasks.find(task => task.track === 'ls' && task.week === 2).id
  ]);
  await markDone(page, ids);
  await page.locator('#progress-completed-ls').click();
  assert.deepEqual(await listedIds(page), ids);
  await page.locator(`#weekTasks [data-task-id="${ids[0]}"] .outline-check`).click();
  await page.waitForFunction(id => !taskDone(id), ids[0]);
  assert.deepEqual(await listedIds(page), [ids[1]]);
  assert.match(await page.locator('#progressListSummary').textContent(), /1/);
  await page.locator('#toastRegion .toast-action').click();
  await page.waitForFunction(id => taskDone(id), ids[0]);
  assert.deepEqual(await listedIds(page), ids);
  assert.match(await page.locator('#progressListSummary').textContent(), /2/);
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  assert.match(await page.locator('#progress-completed-ls').textContent(), /2/);
});

test('Back and Forward restore the deepening project completion scope and expanded progress details', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const taskId = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'studio-baseline').taskIds[0]);
  await markDone(page, [taskId]);
  await page.locator('#progress-phase-projects').click();
  await page.locator('#projectProgressDetails > summary').click();
  const deepeningProjects = await page.locator('#projectProgressDetails [data-progress-project-id]')
    .evaluateAll(rows => rows.map(row => row.dataset.progressProjectId));
  assert.deepEqual(deepeningProjects, ['studio-baseline', 'studio-rtc', 'studio-validation']);
  await page.locator('#progress-project-completed-studio-baseline').click();
  assert.deepEqual(await listedIds(page), [taskId]);
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'projects', track: 'ydy', project: 'studio-baseline' });
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  assert.equal(await page.locator('#progress-phase-projects').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#projectProgressDetails').getAttribute('open'), '');
  await page.locator('#navigationForwardBtn').click();
  assert.equal(await page.locator('#progressListContext').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'projects', track: 'ydy', project: 'studio-baseline' });
  assert.deepEqual(await listedIds(page), [taskId]);
});

test('empty counts are disabled, source and project names jump to first unfinished task, and all-done project opens its list', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  for (const id of ['progress-completed-ls', 'progress-completed-ydy', 'progress-completed-review']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} must not lead to an empty completion list`);
  }
  await page.locator('#progress-track-ls').click();
  const firstCourse = await page.evaluate(() => allTasks.find(task => task.track === 'ls' && phaseForWeek(task.week).id === 'courses'));
  assert.equal(await page.locator('#plannerView').isVisible(), true);
  assert.equal(await page.locator('#weekSelect').inputValue(), String(firstCourse.week));
  assert.equal(await page.locator(`#weekTasks [data-task-id="${firstCourse.id}"]`).isVisible(), true);
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  await page.locator('#projectProgressDetails > summary').click();
  await page.locator('#progress-project-yibo').click();
  const firstYibo = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'yibo').taskIds[0]);
  assert.equal(await page.locator(`#weekTasks [data-task-id="${firstYibo}"]`).isVisible(), true);
  await page.locator('#navigationBackBtn').click();
  const allYibo = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'yibo').taskIds);
  await markDone(page, allYibo);
  await page.locator('#progress-project-yibo').click();
  assert.deepEqual(await page.evaluate(() => progressListScope), { phase: 'courses', track: 'ydy', project: 'yibo' });
  assert.deepEqual(await listedIds(page), allYibo);
});

test('expanded progress and completion list fit a 320px mobile viewport', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 320);
  const id = await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'yibo').taskIds[0]);
  await markDone(page, [id]);
  await page.locator('#projectProgressDetails > summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#progress-project-completed-yibo').click();
  assert.deepEqual(await listedIds(page), [id]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#navigationBackBtn').click();
  await page.locator('#progress-project-total-yibo').click();
  assert.equal(await outlineIds(page).then(ids => ids.length),
    await page.evaluate(() => DATA.milestones.find(goal => goal.id === 'yibo').taskIds.length));
  await page.locator(`#weekTasks details.task-outline-content[data-outline-task-id="${id}"] > summary`).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'Expanded mobile outline should not overflow horizontally');
});
