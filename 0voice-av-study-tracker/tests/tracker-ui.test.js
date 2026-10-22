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

const PROJECT_DIR = path.resolve(__dirname, '..');
const STORE_KEY = 'av_study_tracker_regenerated_v2';
const API_KEY_STORE = 'av_study_tracker_sync_key';
const FIXED_TIME = new Date('2026-09-29T04:00:00Z');
const record = done => ({ done, updatedAt: FIXED_TIME.toISOString() });
let browser;
let serverProcess;
let temporaryDirectory;
let baseURL;
let serverOutput = '';

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'av-tracker-ui-'));
  const port = await unusedPort();
  baseURL = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(temporaryDirectory, 'tracker.db'),
      BACKUP_DIR: path.join(temporaryDirectory, 'backups'),
      TRACKER_API_KEY: '',
      BACKUP_INTERVAL_MINUTES: '60',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', chunk => { serverOutput += chunk; });
  serverProcess.stderr.on('data', chunk => { serverOutput += chunk; });
  serverProcess.on('error', error => { serverOutput += error.message; });
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the isolated server to start listening. */ }
    await delay(50);
  }
  assert.ok(ready, `Test server did not start:\n${serverOutput}`);
  browser = await chromium.launch({
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
    headless: true,
    args: ['--no-sandbox']
  });
}, { timeout: 20_000 });

after(async () => {
  try {
    if (browser) await browser.close();
  } finally {
    if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
      const exited = once(serverProcess, 'exit');
      const forceKill = setTimeout(() => serverProcess.kill('SIGKILL'), 5_000);
      serverProcess.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(forceKill); }
    }
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}, { timeout: 15_000 });

async function settled(page) {
  await page.waitForFunction(() => !activeSyncPromise && !syncState.busy);
}

async function fixture(t, { seed = {}, auth = false, mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    timezoneId: 'Asia/Shanghai'
  });
  const page = await context.newPage();
  const pageErrors = [];
  const activeBlocks = new Set();
  page.on('pageerror', error => pageErrors.push(error.message));
  t.after(async () => {
    for (const release of activeBlocks) release();
    try { await page.unrouteAll({ behavior: 'wait' }); }
    finally { await context.close(); }
    assert.deepEqual(pageErrors, [], 'The UI should not throw browser errors');
  });
  await page.clock.setFixedTime(FIXED_TIME);
  if (Object.keys(seed).length) {
    await context.addInitScript(({ key, entries }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ entries }));
    }, { key: STORE_KEY, entries: seed });
  }

  let serverEntries = {};
  let nextBlock = null;
  let rejectReplace = false;
  const calls = [];
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { message: 'Unexpected API in isolated UI test' } }));
  await page.route('**/api/config', route => route.fulfill({ json: { authRequired: auth } }));
  await page.route('**/api/sync', async route => {
    const body = route.request().postDataJSON();
    const key = route.request().headers()['x-api-key'];
    calls.push({ body, key });
    if (auth && key !== 'new-key') return route.fulfill({ status: 401, json: { message: 'Invalid key' } });
    if (body.mode === 'replace' && rejectReplace) {
      rejectReplace = false;
      return route.fulfill({ status: 503, json: { message: 'Try again later' } });
    }
    if (body.mode === 'replace') serverEntries = { ...body.state.entries };
    else {
      for (const [id, entry] of Object.entries(body.state.entries)) {
        if (!serverEntries[id] || entry.updatedAt > serverEntries[id].updatedAt) serverEntries[id] = entry;
      }
    }
    const response = { state: { entries: { ...serverEntries } }, serverTime: new Date().toISOString() };
    const blocked = nextBlock;
    nextBlock = null;
    if (blocked) { blocked.started(); await blocked.gate; }
    await route.fulfill({ json: response });
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => syncState.reachable !== null);
  if (!auth) {
    await settled(page);
    assert.equal(await page.evaluate(() => syncState.status), '进度已同步');
  }
  const tasks = await page.evaluate(() => allTasks.map(task => ({ id: task.id, date: task.date, optional: task.optional === true })));
  return {
    context, page, tasks, calls,
    server: () => serverEntries,
    inject: (id, entry) => { serverEntries[id] = entry; },
    rejectNextReplace: () => { rejectReplace = true; },
    blockNextSync() {
      let started, release;
      const begun = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      activeBlocks.add(release);
      nextBlock = { started, gate };
      return { begun, release: () => { activeBlocks.delete(release); release(); } };
    }
  };
}

function displayedMinutes(label) {
  const displayed = label.match(/^本次\s*(.*?)\s*·/)?.[1] || label;
  const parts = [...displayed.matchAll(/(\d+(?:\.\d+)?)\s*(小时|分钟|分|秒)/g)];
  assert.ok(parts.length > 0, `A duration label must contain a readable unit: ${label}`);
  return parts.reduce((sum, part) => sum + Number(part[1]) * ({ 小时: 60, 分钟: 1, 分: 1, 秒: 1 / 60 })[part[2]], 0);
}

async function planner(page) {
  await page.locator('.nav-item[data-view="planner"]').click();
}

async function upload(page, data) {
  await page.locator('#importFile').setInputFiles({
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))
  });
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  await page.locator('#confirmAcceptBtn').click();
}

test('queued check-ins survive an older response and reload', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const [a, b] = f.tasks.map(task => task.id);
  await planner(f.page);
  const blocked = f.blockNextSync();
  await f.page.locator('#weekTasks .check').nth(0).click();
  await blocked.begun;
  await f.page.locator('#weekTasks .check').nth(0).click();
  await f.page.locator('#weekTasks .check').nth(1).click();
  blocked.release();
  await settled(f.page);
  assert.equal(f.server()[a].done, false);
  assert.equal(f.server()[b].done, true);
  assert.ok(f.server()[b].updatedAt > f.server()[a].updatedAt, 'Clicks in a fixed millisecond need increasing timestamps');
  await f.page.reload();
  await settled(f.page);
  assert.deepEqual(await f.page.evaluate(([a, b]) => [taskDone(a), taskDone(b)], [a, b]), [false, true]);
  f.inject(a, { done: true, updatedAt: f.server()[a].updatedAt });
  await f.page.evaluate(() => syncToServer({ silent: true }));
  await settled(f.page);
  assert.equal(await f.page.evaluate(id => taskDone(id), a), true, 'The server wins equal-timestamp conflicts');
});

test('a full restore survives a failed replace and reload without losing archives', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { seed: { 'old-project': record(true) } });
  const [a, b] = f.tasks.map(task => task.id);
  await planner(f.page);
  const blocked = f.blockNextSync();
  await f.page.locator('#weekTasks .check').first().click();
  await blocked.begun;
  await f.page.locator('#openSyncBtn').click();
  f.rejectNextReplace();
  await upload(f.page, { entries: Object.fromEntries(f.tasks.map(task => [task.id, record(task.id === b)])) });
  blocked.release();
  await f.page.waitForFunction(() => !activeSyncPromise && state.pendingReplace);
  assert.equal(await f.page.evaluate(key => JSON.parse(localStorage.getItem(key)).pendingReplace, STORE_KEY), true);
  assert.equal(f.calls.at(-1).body.mode, 'replace');
  assert.equal(await f.page.locator('#syncDialog .toast-action').isVisible(), true);
  await f.page.reload();
  await f.page.waitForFunction(() => !activeSyncPromise && !state.pendingReplace && syncState.status === '进度已同步');
  assert.equal(f.calls.at(-1).body.mode, 'replace');
  assert.equal(f.server()[a].done, false);
  assert.equal(f.server()[b].done, true);
  assert.equal(f.server()['old-project'].done, true);
  assert.equal(f.tasks.filter(task => f.server()[task.id].done).length, 1);

  await f.page.locator('#openSyncBtn').click();
  const [download] = await Promise.all([
    f.page.waitForEvent('download'), f.page.locator('#exportBtn').click()
  ]);
  const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(Object.keys(exported.entries).length, f.tasks.length);
  assert.equal(exported.archivedEntries['old-project'].done, true);
});

test('partial-import undo preserves another device’s unrelated progress', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const [a, b] = f.tasks.map(task => task.id);
  await planner(f.page);
  await f.page.locator('#weekTasks .check').first().click();
  await settled(f.page);
  await f.page.locator('#openSyncBtn').click();
  await upload(f.page, { entries: { [a]: record(false) } });
  await settled(f.page);
  f.inject(b, { done: true, updatedAt: new Date(Date.now() + 1000).toISOString() });
  await f.page.evaluate(() => syncToServer({ silent: true }));
  await settled(f.page);
  await f.page.locator('#syncDialog .toast-action').click();
  await settled(f.page);
  assert.equal(f.server()[a].done, true);
  assert.equal(f.server()[b].done, true);
  assert.deepEqual(await f.page.evaluate(([a, b]) => [taskDone(a), taskDone(b)], [a, b]), [true, true]);
});

test('mobile details and keyboard check-ins keep focus and modal undo usable', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { mobile: true });
  const [, b] = f.tasks.map(task => task.id);
  const multipartTask = await f.page.evaluate(() => DATA.weeks[0].tasks.find(task => task.segments?.length > 1));
  assert.ok(multipartTask, 'The first week should exercise original courses split across a session');
  const multipart = multipartTask.id;
  await planner(f.page);
  await f.page.locator('#taskFilter').selectOption('pending');
  await f.page.locator('#weekTasks .check').first().focus();
  await f.page.keyboard.press('Space');
  await settled(f.page);
  await f.page.waitForFunction(() => document.activeElement?.matches('#toastRegion .toast-action'));
  assert.equal(await f.page.evaluate(id => taskDone(id), b), false, 'Completing a filtered-out task must not advance to another check-in toggle');
  await f.page.locator('#clearFiltersBtn').click();
  await f.page.locator(`#weekTasks [data-task-id="${multipart}"] .task-title`).click();
  assert.equal(await f.page.locator('#taskDialog .segment-row').count(), multipartTask.segments.length);
  await f.page.locator('#detailToggleBtn').focus();
  await f.page.keyboard.press('Space');
  await f.page.locator('#taskDialog .toast-action').click();
  await settled(f.page);
  assert.equal(await f.page.evaluate(id => taskDone(id), multipart), false);
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(id => document.activeElement?.matches('#weekTasks .task-title') && document.activeElement.closest('[data-task-id]').dataset.taskId === id, multipart);
  for (const width of [320, 390]) {
    await f.page.setViewportSize({ width, height: 844 });
    const layout = await f.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')].filter(element => element.getClientRects().length && element.getBoundingClientRect().right > innerWidth + 1)
        .map(element => ({ tag: element.tagName, id: element.id, cls: element.className, right: Math.round(element.getBoundingClientRect().right) })).slice(0, 15) }));
    assert.ok(layout.scroll <= width + 1, `The ${width}px planner overflows: ${JSON.stringify(layout)}`);
  }
});

test('offline cache and in-memory keys still work when browser storage fails', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { auth: true });
  const [a, , c] = f.tasks.map(task => task.id);
  await f.page.evaluate(key => localStorage.setItem(key, 'old-key'), API_KEY_STORE);
  await f.page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, API_KEY_STORE);
  await f.page.locator('#openSyncBtn').click();
  await f.page.locator('#apiKeyInput').fill('new-key');
  await f.page.locator('#setKeyBtn').click();
  await f.page.waitForFunction(() => syncState.status === '进度已同步' && !activeSyncPromise);
  assert.equal(f.calls.at(-1).key, 'new-key');
  await f.page.locator('#closeSyncBtn').click();
  await planner(f.page);
  await f.context.setOffline(true);
  await f.page.locator('#weekTasks .check').nth(2).click();
  assert.equal(await f.page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key)).entries[id].done, { key: STORE_KEY, id: c }), true);
  await f.context.setOffline(false);
  await f.page.waitForFunction(() => syncState.status === '进度已同步' && !activeSyncPromise);
  assert.equal(f.server()[c].done, true);
  await f.page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('Denied', 'SecurityError'); }; });
  await f.page.locator('#weekTasks .check').first().click();
  await settled(f.page);
  await f.page.locator('#openSyncBtn').click();
  assert.equal(await f.page.locator('#syncStatus').textContent(), '浏览器保存失败');
  assert.equal(f.server()[a].done, true);
});

test('milestone completion follows every required task, advances the next project, and rolls back with task cancellation', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const goals = await f.page.evaluate(() => DATA.milestones.map(milestone => ({
    id: milestone.id,
    kind: milestone.kind,
    catalogTaskIds: milestone.taskIds,
    taskIds: milestoneTasks(milestone).map(task => task.id),
    tasks: milestoneTasks(milestone).map(task => ({ id: task.id, track: task.track }))
  })));
  assert.equal(new Set(goals.map(goal => goal.id)).size, goals.length, 'Milestone IDs must be unique');
  assert.ok(goals.every(goal => ['project', 'parallel'].includes(goal.kind) && goal.taskIds.length > 0));
  const assignedIds = goals.flatMap(goal => goal.taskIds);
  const expectedRequired = f.tasks.filter(task => !task.optional);
  assert.equal(assignedIds.length, expectedRequired.length);
  assert.equal(new Set(assignedIds).size, assignedIds.length, 'A task must not advance two milestones');
  assert.deepEqual([...assignedIds].sort(), expectedRequired.map(task => task.id).sort(), 'Every required task belongs to one milestone; on-demand pools stay separate');
  for (const goal of goals) {
    assert.deepEqual(goal.tasks.map(task => task.id), goal.taskIds, 'Required milestone references must resolve');
    assert.deepEqual(goal.taskIds, goal.catalogTaskIds, 'Milestone references resolve to their required tasks');
  }
  const projects = goals.filter(goal => goal.kind === 'project');
  const parallel = goals.filter(goal => goal.kind === 'parallel');
  assert.ok(projects.length > 0 && parallel.length > 0, 'Projects and parallel learning both have goals');
  const courses = goals.find(goal => goal.id === 'courses');
  const learningIds = await f.page.evaluate(() => requiredLearningTasks().filter(task => task.track === 'ls').map(task => task.id));
  assert.deepEqual(courses.tasks.filter(task => task.track === 'ls').map(task => task.id), learningIds, 'The course milestone counts every required Zero Voice session');

  await f.page.locator('.nav-item[data-view="milestones"]').click();
  assert.equal(await f.page.locator('#milestones article.goal-card').count(), projects.length);
  assert.equal(await f.page.locator('#parallelMilestones article.goal-card').count(), parallel.length);
  await f.page.clock.setFixedTime(new Date('2030-01-01T04:00:00Z'));
  await f.page.evaluate(() => render());
  assert.deepEqual(await f.page.locator('#milestones .goal-status').allTextContents(), Array(projects.length).fill('待补'));
  assert.deepEqual(await f.page.locator('#parallelMilestones .goal-status').allTextContents(), Array(parallel.length).fill('未开始'));
  for (const goal of goals) {
    const meter = f.page.locator(`[data-milestone-id="${goal.id}"] .goal-meter`);
    assert.equal(await meter.getAttribute('aria-valuenow'), '0');
    assert.equal(await meter.getAttribute('aria-valuemax'), String(goal.taskIds.length));
  }
  assert.equal(await f.page.locator('.application-status').textContent(), '先完成全部必修学习');

  await f.page.evaluate(id => changeTask(id, true, false), courses.taskIds[0]);
  await settled(f.page);
  assert.equal(await f.page.locator('[data-milestone-id="courses"] .goal-status').textContent(), '进行中');
  assert.equal(await f.page.locator('[data-milestone-id="courses"] .goal-meter').getAttribute('aria-valuenow'), '1');
  assert.deepEqual(await f.page.locator('#milestones .goal-status').allTextContents(), Array(projects.length).fill('待补'));
  for (const other of parallel.filter(goal => goal.id !== courses.id)) {
    assert.equal(await f.page.locator(`[data-milestone-id="${other.id}"] .goal-status`).textContent(), '未开始');
  }

  const project = projects[0];
  const card = f.page.locator(`[data-milestone-id="${project.id}"]`);
  await f.page.evaluate(id => changeTask(id, true, false), project.taskIds[0]);
  await settled(f.page);
  assert.equal(await card.locator('.goal-status').textContent(), '待补');
  assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), '1');
  for (const other of projects.slice(1)) {
    assert.equal(await f.page.locator(`[data-milestone-id="${other.id}"] .goal-status`).textContent(), '待补');
  }
  await f.page.evaluate(ids => { for (const id of ids) changeTask(id, true, false); }, project.taskIds.slice(1, -1));
  await settled(f.page);
  assert.equal(await card.locator('.goal-status').textContent(), '待补', 'The final original self-test remains a real completion requirement');
  assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), String(project.taskIds.length - 1));
  await f.page.evaluate(id => changeTask(id, true, false), project.taskIds.at(-1));
  await settled(f.page);
  assert.equal(await card.locator('.goal-status').textContent(), '已完成');
  assert.equal(await card.locator('.goal-status').getAttribute('data-state'), 'checked');
  assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), String(project.taskIds.length));
  assert.equal(await f.page.locator('[data-milestone-review]').count(), 0, 'Project completion has no second acceptance action');
  assert.equal(await f.page.evaluate(id => Object.hasOwn(state.entries, milestoneReviewKey(id)), project.id), false,
    'Automatic completion cannot create a separate historical review record');
  assert.equal(await f.page.locator('#milestoneSummary .roadmap-completed strong').textContent(), `1 / ${projects.length} 个已完成`);
  assert.equal(await f.page.locator('#milestones .goal-card.is-next').getAttribute('data-milestone-id'), projects[1].id);
  assert.equal(await f.page.locator('.application-status').textContent(), '先完成全部必修学习');
  await f.page.locator(`#milestone-next-${project.id}`).click();
  assert.equal(await f.page.evaluate(() => detailTaskId), project.taskIds.at(-1), 'A checked project opens its final acceptance task');
  await f.page.locator('#detailToggleBtn').click();
  await settled(f.page);
  assert.equal(await card.locator('.goal-status').textContent(), '待补', 'Cancelling the final self-test immediately reopens the project');
  assert.equal(await f.page.locator('#milestoneSummary .roadmap-completed strong').textContent(), `0 / ${projects.length} 个已完成`);
  await f.page.locator('#taskDialog .toast-action').click();
  await settled(f.page);
  assert.equal(await card.locator('.goal-status').textContent(), '已完成', 'Undo restores completion from the original task record');
  assert.equal(await f.page.locator('#milestoneSummary .roadmap-completed strong').textContent(), `1 / ${projects.length} 个已完成`);
  await f.page.locator('#detailToggleBtn').click();
  await settled(f.page);
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(id => document.activeElement?.id === `milestone-next-${id}`, project.id);
  assert.equal(await card.locator('.goal-status').textContent(), '待补', 'Cancelling a task must undo the checked state');
  assert.equal(await f.page.locator('#milestones .goal-card.is-next').getAttribute('data-milestone-id'), project.id);
  assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), String(project.taskIds.length - 1));
  assert.equal(await f.page.locator('[data-milestone-id="courses"] .goal-status').textContent(), '进行中');
});

test('milestone actions open the next unfinished task and clear stale planner filters', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { mobile: true });
  const targets = await f.page.evaluate(() => DATA.milestones.map(milestone => {
    const [first, next] = milestoneTasks(milestone);
    return {
      milestoneId: milestone.id,
      firstId: first.id,
      nextId: next.id,
      track: next.track,
      phase: phaseForWeek(next.week).id,
      week: DATA.weeks.find(week => week.tasks.some(task => task.id === next.id)).week
    };
  }));
  for (const target of targets) {
    await f.page.evaluate(id => changeTask(id, true, false), target.firstId);
    await settled(f.page);
    await planner(f.page);
    await f.page.locator('#taskFilter').selectOption('done');
    await f.page.locator('#trackFilter').selectOption(target.track === 'ls' ? 'ydy' : 'ls');
    await f.page.locator('#taskSearch').fill('no matching milestone task');
    await f.page.locator('.nav-item[data-view="milestones"]').click();
    await f.page.locator(`#milestone-next-${target.milestoneId}`).click();
    assert.equal(await f.page.evaluate(() => detailTaskId), target.nextId, 'Already checked tasks should be skipped');
    await f.page.locator('#closeTaskBtn').click();
    await f.page.waitForFunction(id => document.activeElement?.id === `milestone-next-${id}`, target.milestoneId);
    await f.page.locator(`#milestone-plan-${target.milestoneId}`).click();
    assert.equal(await f.page.locator('#plannerView').isVisible(), true);
    assert.equal(await f.page.locator('#taskSearch').inputValue(), '');
    assert.equal(await f.page.locator('#taskFilter').inputValue(), 'all');
    assert.equal(await f.page.locator('#trackFilter').inputValue(), target.track);
    assert.equal(await f.page.locator('#weekSelect').inputValue(), String(target.week));
    assert.equal(await f.page.locator(`#planPhaseSwitch button[data-phase="${target.phase}"]`).getAttribute('aria-pressed'), 'true', 'Opening a milestone task selects its plan phase');
    assert.equal(await f.page.locator(`#weekTasks [data-task-id="${target.nextId}"]`).first().isVisible(), true);
    await f.page.waitForFunction(id => document.activeElement?.closest('#weekTasks [data-task-id]')?.dataset.taskId === id, target.nextId);
  }
});

test('courses and career share weekly day cards while career keeps its short material-week heading', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  assert.deepEqual(await f.page.evaluate(() => ({
    weeks: DATA.weeks.length,
    tasks: allTasks.length,
    required: requiredTasks().length,
    zeroVoiceSources: DATA.courseCatalog.length,
    zeroVoiceSessions: allTasks.filter(task => task.track === 'ls').length
  })), { weeks: 36, tasks: 208, required: 207, zeroVoiceSources: 117, zeroVoiceSessions: 122 });
  const careerPhase = await f.page.evaluate(() => planPhases.find(phase => phase.id === 'career'));
  assert.equal(await f.page.locator('#phase-projects').count(), 0);
  assert.equal(await f.page.locator('#progress-phase-projects').count(), 0);
  const courses = f.page.locator('#planPhaseSwitch button[data-phase="courses"]');
  const career = f.page.locator('#planPhaseSwitch button[data-phase="career"]');
  const listedWeeks = () => f.page.locator('#weekList .week-chip').evaluateAll(buttons => buttons.map(button => Number(button.dataset.week)));
  const optionWeeks = () => f.page.locator('#weekSelect option').evaluateAll(options => options.map(option => Number(option.value)));

  assert.equal(await courses.getAttribute('aria-pressed'), 'true');
  assert.equal(await career.getAttribute('aria-pressed'), 'false');
  assert.match(await courses.textContent(), /33\s*周/);
  assert.match(await f.page.locator('#planPhaseCaption').textContent(), /2026年10月5日.*2027年5月23日/);
  assert.deepEqual(await optionWeeks(), Array.from({ length: 33 }, (_, index) => index + 1));
  assert.deepEqual(await listedWeeks(), Array.from({ length: 33 }, (_, index) => index + 1));
  assert.equal(await f.page.locator('#weekTitle').textContent(), '第 1 周');
  assert.equal(await f.page.locator('#weekPrevBtn').isDisabled(), true);
  await f.page.locator('#weekSelect').selectOption('33');
  assert.equal(await f.page.locator('#weekNextBtn').isDisabled(), true, 'Course next must stop at week 33');

  await career.click();
  assert.equal(await courses.getAttribute('aria-pressed'), 'false');
  assert.equal(await career.getAttribute('aria-pressed'), 'true');
  assert.match(await career.textContent(), /按进度推进/);
  assert.doesNotMatch(await career.textContent(), /3\s*周/);
  const materials = f.page.locator('#weekTasks .day-group .task-card');
  const expectedSessions = () => f.page.evaluate(() => scheduledTasksForWeek(selectedWeekData()).map(task => task.id));
  assert.deepEqual(await materials.evaluateAll(cards => cards.map(card => card.dataset.taskId)), await expectedSessions());
  assert.deepEqual(await optionWeeks(), Array.from({ length: careerPhase.endWeek - careerPhase.startWeek + 1 }, (_, index) => index + careerPhase.startWeek));
  assert.deepEqual(await listedWeeks(), Array.from({ length: careerPhase.endWeek - careerPhase.startWeek + 1 }, (_, index) => index + careerPhase.startWeek));
  assert.equal(await f.page.locator('#weekTitle').textContent(), '材料第 1 周');
  assert.equal(await f.page.locator('#weekTopic').textContent(), await f.page.evaluate(() => selectedWeekData().range));
  for (const selector of ['.planner-topbar', '.week-navigation', '#weekTopic', '#weekMeta', '#allWeeksDetails']) {
    assert.equal(await f.page.locator(selector).isVisible(), true, `${selector} matches course navigation`);
  }
  assert.equal(await f.page.locator('#planPhaseCaption').isVisible(), false);
  assert.equal(await f.page.locator('#trackFilter').isVisible(), false);
  assert.equal(await f.page.locator('#weekTasks [data-career-board], #weekTasks [data-career-open-task]').count(), 0);
  assert.equal(await f.page.locator('[data-career-section="teacher"]').getAttribute('open'), null);
  assert.equal(await f.page.locator('[data-career-section="interviews"]').getAttribute('open'), null);
  await f.page.locator('#weekNextBtn').click();
  assert.equal(await f.page.locator('#weekTitle').textContent(), '材料第 2 周');
  assert.deepEqual(await materials.evaluateAll(cards => cards.map(card => card.dataset.taskId)), await expectedSessions());
  await f.page.locator('#weekSelect').selectOption(String(careerPhase.endWeek));
  assert.equal(await f.page.locator('#weekNextBtn').isDisabled(), true);
  assert.deepEqual(await materials.evaluateAll(cards => cards.map(card => card.dataset.taskId)), await expectedSessions());
  await courses.click();
  assert.equal(await f.page.locator('.week-navigation').isVisible(), true);
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '33', 'Course navigation retains its own reading position');
  assert.equal(await f.page.locator('#weekTasks [data-career-board]').count(), 0);
});

test('a saved week from before phase preferences defaults to the first course week', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  // An obsolete preference from the older calendar must not reopen a removed week.
  await f.page.evaluate(() => localStorage.setItem(UI_STORE_KEY, JSON.stringify({ view: 'planner', week: 52, filter: 'all', track: 'all', search: '' })));
  await f.page.reload();
  await settled(f.page);
  assert.equal(await f.page.locator('#plannerView').isVisible(), true);
  assert.equal(await f.page.locator('#planPhaseSwitch button[data-phase="courses"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '1');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '第 1 周');
  assert.equal(await f.page.locator('#weekSelect option').count(), 33);
});

test('global search switches to the result phase while keeping the result week visible', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const dates = await f.page.evaluate(() => ({
    course: DATA.weeks[0].tasks[0].date,
    project: DATA.weeks[33].tasks[0].date
  }));
  await f.page.locator('#taskSearch').fill(dates.project);
  const projectGroup = f.page.locator('#weekTasks .search-week-group[data-result-week="34"]');
  assert.equal(await projectGroup.isVisible(), true, 'Search spans the other plan phase');
  const projectHeading = await projectGroup.locator('.search-week-heading').textContent();
  assert.match(projectHeading, /求职材料与面试/);
  assert.match(projectHeading, /材料第 1 周/);
  const projectTopics = await f.page.evaluate(() => weekTopics(DATA.weeks[33]));
  for (const topic of projectTopics) assert.ok(projectHeading.includes(topic.title), `Search group omits ${topic.title}`);
  await projectGroup.locator('[data-search-week="34"]').click();
  assert.equal(await f.page.locator('#planPhaseSwitch button[data-phase="career"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '34');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '材料第 1 周');
  assert.equal(await f.page.locator('#taskSearch').inputValue(), '');

  await f.page.locator('#taskSearch').fill(dates.course);
  const courseGroup = f.page.locator('#weekTasks .search-week-group[data-result-week="1"]');
  assert.equal(await courseGroup.isVisible(), true);
  await courseGroup.locator('[data-search-week="1"]').click();
  assert.equal(await f.page.locator('#planPhaseSwitch button[data-phase="courses"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '1');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '第 1 周');
});

test('a multi-lesson Zero Voice session names every actual lesson in cards and today', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const split = await f.page.evaluate(() => {
    const task = DATA.weeks[0].tasks.find(item => item.track === 'ls' && new Set((item.segments || []).map(segment => lessonById.get(segment.lessonId)?.title)).size > 1);
    return task && { id: task.id, date: task.date, titles: [...new Set(task.segments.map(segment => lessonById.get(segment.lessonId).title))] };
  });
  assert.ok(split && split.titles.length > 1, 'The first course week needs a session with multiple real lessons');
  await planner(f.page);
  const title = await f.page.locator(`#weekTasks [data-task-id="${split.id}"] .task-title`).textContent();
  for (const lessonTitle of split.titles) assert.ok(title.includes(lessonTitle), `Planner title omits ${lessonTitle}`);

  await f.page.evaluate(id => {
    const courses = requiredLearningTasks().filter(task => task.track === 'ls');
    const stamp = freshTimestamp();
    for (const task of courses.slice(0, courses.findIndex(task => task.id === id))) {
      state.entries[task.id] = createEntry(true, stamp);
    }
    localRevision++; saveState(); render(); syncToServer({ silent: true });
  }, split.id);
  await settled(f.page);
  await f.page.clock.setFixedTime(new Date(`${split.date}T12:00:00+08:00`));
  await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const todayTitle = await f.page.locator(`#todayBox [data-task-id="${split.id}"] .task-title`).textContent();
  for (const lessonTitle of split.titles) assert.ok(todayTitle.includes(lessonTitle), `Today title omits ${lessonTitle}`);
});

test('search matches only the relevant weekly topic line for each task source', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const firstWeek = await f.page.evaluate(() => {
    const week = DATA.weeks[0];
    return {
      lsTopic: weekTopics(week).find(topic => topic.track === 'ls').title,
      lsIds: week.tasks.filter(task => task.track === 'ls').map(task => task.id),
      ydyIds: week.tasks.filter(task => task.track === 'ydy').map(task => task.id),
      lsTitles: week.tasks.filter(task => task.track === 'ls').map(task => task.title)
    };
  });
  assert.ok(firstWeek.lsTitles.every(title => !title.includes(firstWeek.lsTopic)), 'The topic query must exercise the topic index, not task titles');
  const resultIds = () => f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId));

  await f.page.locator('#taskSearch').fill('零声');
  const sourceResults = await resultIds();
  for (const id of firstWeek.lsIds) assert.ok(sourceResults.includes(id), `Source search omits ${id}`);
  for (const id of firstWeek.ydyIds) assert.ok(!sourceResults.includes(id), `Source search incorrectly includes ${id}`);

  await f.page.locator('#taskSearch').fill(firstWeek.lsTopic);
  const topicResults = await resultIds();
  for (const id of firstWeek.lsIds) assert.ok(topicResults.includes(id), `Weekly Zero Voice topic omits ${id}`);
  for (const id of firstWeek.ydyIds) assert.ok(!topicResults.includes(id), `Zero Voice topic incorrectly includes ${id}`);
});

test('global search filters all weeks without changing the selected week and supports result actions', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  assert.equal(await f.page.locator('#trackProgress .track-progress-item').count(), 2);
  assert.equal(await f.page.locator('#trackProgress .track-progress-item.review').count(), 0, 'Interview preparation is absent before its actual phase');
  await f.page.locator('.nav-item[data-view="overview"]').click();
  assert.equal(await f.page.locator('#progress-phase-projects').count(), 0, 'No extra project phase remains between learning and career');
  await f.page.locator('#progress-phase-career').click();
  assert.equal(await f.page.locator('#trackProgress .track-progress-item.review').count(), 1, 'Interview preparation has its own phase after learning');
  const interviewWeek = await f.page.evaluate(() => DATA.weeks.find(week => week.tasks.some(task => task.track === 'review')).week);
  await f.page.evaluate(week => localStorage.setItem(UI_STORE_KEY, JSON.stringify({ view: 'planner', phase: 'career', week, filter: 'all', track: 'review', search: '' })), interviewWeek);
  await f.page.reload();
  await settled(f.page);
  assert.equal(await f.page.locator('#trackFilter').isVisible(), false, 'The single career source needs no repeated type selector');
  const preparationIds = await f.page.evaluate(() => DATA.careerWorkflow.preparationTaskIds);
  const scheduledIds = await f.page.evaluate(() => scheduledTasksForWeek(selectedWeekData()).map(task => task.id));
  assert.deepEqual(await f.page.locator('#weekTasks .day-group .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId)), scheduledIds);
  assert.equal(await f.page.locator('#weekTasks [data-career-section] .task-card').count(), 16);
  assert.equal(await f.page.locator('#weekTasks [data-career-section][open]').count(), 0, 'Teacher and later interview content starts folded');
  await f.page.locator(`#weekTasks [data-task-id="${preparationIds[0]}"] .task-title`).first().click();
  assert.match(await f.page.locator('#taskDialogTitle').textContent(), /项目|材料|梳理/);
  assert.equal(await f.page.locator('#taskDialog .segment-row').count(), 0, 'Interview work is not a repeat of the Zero Voice video plan');
  const materialSteps = await f.page.evaluate(id => taskById.get(id).steps, preparationIds[0]);
  for (const step of materialSteps) assert.ok((await f.page.locator('#taskDialogBody').textContent()).includes(step));
  await f.page.locator('#closeTaskBtn').click();
  await f.page.locator('#phase-courses').click();
  await f.page.locator('#weekSelect').selectOption('32');
  await f.page.locator('#trackFilter').selectOption('ydy');
  const weekdayProject = await f.page.evaluate(() => scheduledTasksForWeek(selectedWeekData()).find(task => task.track === 'ydy' && task.day === '周二'));
  assert.ok(weekdayProject, 'Project development starts on weekdays after the last Zero Voice session');
  assert.match(await f.page.locator(`#day-${weekdayProject.date} [data-task-id="${weekdayProject.id}"] .duration-chip`).textContent(), /本次 40 分钟.*模块预计总/);
  assert.equal(await f.page.locator('#weekTasks .task-card .track.review').count(), 0, 'Project filtering excludes interview work');
  await f.page.locator('#phase-courses').click();
  await f.page.locator('#weekSelect').selectOption('7');
  await f.page.locator('#trackFilter').selectOption('ls');
  await f.page.locator('#taskSearch').fill('零声');
  const courseIds = await f.page.evaluate(() => allTasks.filter(task => task.track === 'ls').map(task => task.id));
  const resultIds = () => f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId));
  assert.deepEqual((await resultIds()).sort(), [...courseIds].sort(), 'A source search includes all lessons from the entire catalog');
  const courseWeeks = await f.page.evaluate(() => DATA.weeks.filter(week => week.tasks.some(task => task.track === 'ls')).map(week => week.week));
  assert.deepEqual(await f.page.locator('#weekTasks > .search-week-group').evaluateAll(groups => groups.map(group => Number(group.dataset.resultWeek))), courseWeeks);
  assert.match(await f.page.locator('#weekCount').textContent(), /全计划/);
  assert.ok((await f.page.locator('#weekCount').textContent()).includes(String(courseIds.length)));
  assert.ok((await f.page.locator('#weekCount').textContent()).includes(String(courseWeeks.length)));
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '7');

  const lastCourseId = courseIds.at(-1);
  const lastCourse = f.page.locator(`#weekTasks [data-task-id="${lastCourseId}"]`);
  await lastCourse.locator('.task-title').click();
  assert.equal(await f.page.evaluate(() => detailTaskId), lastCourseId);
  assert.match(await f.page.locator('#taskDialogTitle').textContent(), /零声课程/);
  const finalSegmentCount = await f.page.evaluate(id => taskById.get(id).segments.length, lastCourseId);
  assert.equal(await f.page.locator('#taskDialog .segment-row').count(), finalSegmentCount, 'The final Zero Voice session still shows its original playback intervals');
  await f.page.locator('#closeTaskBtn').click();
  await f.page.waitForFunction(id => document.activeElement?.closest('[data-task-id]')?.dataset.taskId === id, lastCourseId);
  await lastCourse.locator('.check').click();
  await settled(f.page);
  assert.equal(f.server()[lastCourseId].done, true);
  await f.page.locator('#taskFilter').selectOption('done');
  assert.deepEqual(await resultIds(), [lastCourseId], 'Completed filtering applies across the whole plan');
  await f.page.locator('#taskFilter').selectOption('pending');
  assert.deepEqual((await resultIds()).sort(), courseIds.slice(0, -1).sort());
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '7');
  await f.page.locator('#taskSearch').fill('');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '7', 'Clearing the query returns to the previous week');
  assert.equal(await f.page.locator('#weekTasks > .search-week-group').count(), 0);
  assert.deepEqual(await f.page.locator('#weekTasks > .day-group .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId)),
    await f.page.evaluate(() => DATA.weeks[6].tasks.filter(task => task.track === 'ls' && isRequiredTask(task)).map(task => task.id)));

  const lesson = await f.page.evaluate(() => {
    const last = allTasks.filter(task => task.track === 'ls' && task.segments?.length).at(-1);
    const lessonId = last.segments.at(-1).lessonId;
    return { title: lessonById.get(lessonId).title, taskIds: allTasks.filter(task => task.segments?.some(segment => segment.lessonId === lessonId)).map(task => task.id) };
  });
  await f.page.locator('#taskFilter').selectOption('all');
  await f.page.locator('#taskSearch').fill(lesson.title);
  const lessonResults = await resultIds();
  for (const id of lesson.taskIds) assert.ok(lessonResults.includes(id), 'Searching an original lesson title finds every scheduled segment');
  await f.page.locator('#taskSearch').fill('零声');
  await f.page.locator('#taskFilter').selectOption('done');
  await f.page.locator('#weekTasks [data-search-week]').click();
  assert.equal(await f.page.locator('#taskSearch').inputValue(), '');
  assert.equal(await f.page.locator('#taskFilter').inputValue(), 'all');
  assert.equal(await f.page.locator('#trackFilter').inputValue(), 'all');
  const lastCourseWeek = await f.page.evaluate(id => { const week = DATA.weeks.find(week => week.tasks.some(task => task.id === id));
    return { ...week, tasks: scheduledTasksForWeek(week), onDemand: onDemandTasksForScope({ phase: phaseForWeek(week).id, track: 'all', project: '' }).length }; }, lastCourseId);
  assert.equal(await f.page.locator('#weekSelect').inputValue(), String(lastCourseWeek.week));
  assert.equal(await f.page.locator('#weekTasks .task-card').count(), lastCourseWeek.tasks.length + lastCourseWeek.onDemand);
  assert.equal(await f.page.locator(`#weekTasks [data-task-id="${lastCourseId}"]`).isVisible(), true);

  const transitionCases = await f.page.evaluate(() => [[DATA.planRhythm.zeroVoiceCompletionDate, 'ls'], [DATA.planRhythm.weekdayTransitionDate, 'ydy'], [DATA.careerWorkflow.preparationStartDate, 'review']]);
  for (const [date, track] of transitionCases) {
    await f.page.evaluate(track => {
      const stamp = freshTimestamp();
      for (const task of allTasks) {
        if (track === 'ydy' && task.track === 'ls' || track === 'review' && ['ls', 'ydy'].includes(task.track)) state.entries[task.id] = createEntry(true, stamp);
      }
      saveState();
    }, track);
    await f.page.clock.setFixedTime(new Date(`${date}T04:00:00Z`));
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await f.page.locator('.nav-item[data-view="overview"]').click();
    assert.equal(await f.page.locator(`#todayBox .task-card .track.${track}`).count(), 1);
    for (const width of [390, 1280]) {
      await f.page.setViewportSize({ width, height: 900 });
      const contrasts = await f.page.locator('#todayBox .task-card .task-title, #todayBox .task-card .task-desc, #todayBox .task-card .duration-chip').evaluateAll(elements => {
        const rgba = color => {
          const channels = color.match(/[\d.]+/g).map(Number);
          return [channels[0], channels[1], channels[2], channels[3] ?? 1];
        };
        const luminance = color => color.slice(0, 3).map(channel => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        return elements.map(element => {
          const ancestors = [];
          for (let current = element; current; current = current.parentElement) ancestors.unshift(current);
          let background = [255, 255, 255];
          for (const ancestor of ancestors) {
            const [red, green, blue, alpha] = rgba(getComputedStyle(ancestor).backgroundColor);
            background = [red, green, blue].map((channel, index) => channel * alpha + background[index] * (1 - alpha));
          }
          const foreground = rgba(getComputedStyle(element).color);
          const visibleForeground = foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
          const light = luminance(visibleForeground), dark = luminance(background);
          return { element: element.className, contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
        });
      });
      assert.ok(contrasts.length >= 3);
      assert.ok(contrasts.every(item => item.contrast >= 4.5), `Today's ${track} task must stay readable at ${width}px: ${JSON.stringify(contrasts)}`);
    }
  }
});

test('parallel week topics remain visible without polluting task search and week navigation works after clearing search', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const weeks = await f.page.evaluate(() => DATA.weeks.map(week => ({ week: week.week, start: week.start, topics: weekTopics(week), projectTopic: week.projectTopic })));
  const visibleTopics = async weekNumber => {
    const text = await f.page.locator('#weekTopic').textContent();
    for (const topic of weeks[weekNumber - 1].topics) {
      assert.ok(text.includes(topic.label), `Week ${weekNumber} planner omits ${topic.label}`);
      assert.ok(text.includes(topic.title), `Week ${weekNumber} planner omits ${topic.title}`);
    }
  };
  assert.equal(await f.page.locator('#weekSelect option').count(), 33);
  assert.equal(await f.page.locator('.week-chip').count(), 33);
  for (const week of weeks) {
    assert.ok(Array.isArray(week.topics) && week.topics.length >= 1, `Week ${week.week} needs its actual source topics`);
    assert.ok(week.topics.every(topic => topic.track && topic.label && topic.title), `Week ${week.week} topics need source labels and titles`);
    if (week.topics.some(topic => topic.track === 'ydy')) assert.ok(typeof week.projectTopic === 'string' && week.projectTopic.trim(), `Week ${week.week} keeps its project topic`);
  }
  assert.deepEqual(new Set(weeks[0].topics.map(topic => topic.track)), new Set(['ls', 'ydy']), 'The first week exposes both course lines');
  const lastZeroVoiceWeek = await f.page.evaluate(() => Math.max(...allTasks.filter(task => task.track === 'ls').map(task => task.week)));
  assert.deepEqual(new Set(weeks[lastZeroVoiceWeek - 1].topics.map(topic => topic.track)), new Set(['ls', 'ydy']), 'The last Zero Voice week still includes both learning sources');
  for (const week of weeks.slice(lastZeroVoiceWeek, 33)) {
    assert.deepEqual(new Set(week.topics.map(topic => topic.track)), new Set(['ydy']),
      `Week ${week.week} continues original project work without inventing further Zero Voice or early interview assignments`);
  }
  assert.deepEqual(new Set(weeks[33].topics.map(topic => topic.track)), new Set(['review']), 'Career follows the original course work directly');
  for (const week of weeks.slice(0, 33)) {
    const chipText = await f.page.locator(`.week-chip[data-week="${week.week}"] .week-chip-topic`).textContent();
    for (const topic of week.topics) assert.ok(chipText.includes(topic.title), `Week ${week.week} chip omits ${topic.title}`);
  }
  await visibleTopics(1);
  await f.page.locator('#weekSelect').selectOption('33');
  await visibleTopics(33);
  await f.page.locator('#weekSelect').selectOption('1');
  const overviewText = await f.page.locator('#overviewWeekCaption').textContent();
  for (const topic of weeks[0].topics) assert.ok(overviewText.includes(topic.title), `Overview omits ${topic.title}`);
  assert.equal(await f.page.locator('#allWeeksDetails > summary svg.disclosure-chevron').count(), 1);
  assert.equal(await f.page.locator('.month-group > summary svg.disclosure-chevron').count(), await f.page.locator('.month-group').count());

  await f.page.locator('#taskSearch').fill('云助教');
  const projectResults = await f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId));
  const linkedProjectIds = await f.page.evaluate(() => allTasks.filter(task => task.title.includes('云助教') || task.learningSegments?.some(segment => segment.courseTitle.includes('云助教'))).map(task => task.id));
  assert.ok(linkedProjectIds.length > 0);
  for (const id of linkedProjectIds) assert.ok(projectResults.includes(id), `Search should find the linked project task ${id}`);
  const unrelatedCourseIds = await f.page.evaluate(() => allTasks.filter(task => task.track === 'ls' && !task.title.includes('云助教')).map(task => task.id));
  assert.ok(unrelatedCourseIds.every(id => !projectResults.includes(id)), 'A week topic must not pull unrelated original courses into results');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '1');
  await f.page.locator('#taskSearch').fill('');
  await f.page.locator('#weekSelect').selectOption('11');
  assert.equal(await f.page.locator('#taskSearch').inputValue(), '');
  await visibleTopics(11);
  for (const [button, expectedWeek] of [['#weekNextBtn', 12], ['#weekPrevBtn', 11], ['#jumpFirstBtn', 1]]) {
    await f.page.locator('#taskSearch').fill('零声');
    assert.equal(await f.page.locator('.week-navigation').isVisible(), false, 'Search mode hides single-week navigation');
    await f.page.locator('#taskSearch').fill('');
    await f.page.locator(button).click();
    assert.equal(await f.page.locator('#taskSearch').inputValue(), '');
    assert.equal(await f.page.locator('#weekSelect').inputValue(), String(expectedWeek));
    await visibleTopics(expectedWeek);
  }
  await f.page.locator('#allWeeksDetails').evaluate(element => { element.open = true; });
  await f.page.locator('#taskSearch').fill('零声');
  assert.equal(await f.page.locator('.week-navigation').isVisible(), false);
  await f.page.locator('#taskSearch').fill('');
  await f.page.locator('.week-chip[data-week="4"]').click();
  assert.equal(await f.page.locator('#taskSearch').inputValue(), '');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '4');
  await visibleTopics(4);

  await f.page.clock.setFixedTime(new Date(`${weeks[14].start}T12:00:00+08:00`));
  await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await f.page.locator('#taskSearch').fill('零声');
  assert.equal(await f.page.locator('.week-navigation').isVisible(), false);
  await f.page.locator('#taskSearch').fill('');
  await f.page.locator('#jumpTodayBtn').click();
  assert.equal(await f.page.locator('#taskSearch').inputValue(), '');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '15');
  await visibleTopics(15);
});

test('first-week and current-week actions respect Shanghai midnight and plan boundaries', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { mobile: true });
  await planner(f.page);
  const weeks = await f.page.evaluate(() => DATA.weeks.map(week => ({ week: week.week, start: week.start, end: week.end })));
  const startInstant = Date.parse(`${weeks[0].start}T00:00:00+08:00`);
  const endInstant = Date.parse(`${weeks.at(-1).end}T23:59:59.999+08:00`);
  const setTime = async instant => {
    await f.page.clock.setFixedTime(new Date(instant));
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  };
  assert.equal(await f.page.locator('#jumpFirstBtn').textContent(), '回到首周');
  assert.equal(await f.page.locator('#jumpTodayBtn').textContent(), '回到本周');
  await setTime(startInstant - 1);
  assert.equal(await f.page.locator('#jumpTodayBtn').isDisabled(), true);
  assert.equal(await f.page.locator('#currentWeekHint').isVisible(), true);
  assert.match(await f.page.locator('#currentWeekHint').textContent(), /尚未开始/);
  assert.equal(await f.page.locator('.week-chip-title').filter({ hasText: '本周' }).count(), 0);
  await f.page.locator('#weekSelect').selectOption('8');
  await f.page.locator('#jumpFirstBtn').click();
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '1');

  const secondWeekStart = Date.parse(`${weeks[1].start}T00:00:00+08:00`);
  const projectStart = Date.parse(`${weeks[33].start}T00:00:00+08:00`);
  const crossMonthWeek = weeks.find(week => week.start.slice(0, 7) !== week.end.slice(0, 7));
  assert.ok(crossMonthWeek, 'The fixture should exercise a week that crosses a month boundary');
  for (const [instant, expectedWeek] of [
    [startInstant, 1],
    [secondWeekStart - 1, 1],
    [secondWeekStart, 2],
    [Date.parse(`${crossMonthWeek.end}T00:00:00+08:00`), crossMonthWeek.week],
    [projectStart, 34],
    [endInstant, weeks.at(-1).week]
  ]) {
    if (await f.page.evaluate(() => selectedPhase === 'career')) await f.page.locator('#phase-courses').click();
    await setTime(instant);
    assert.equal(await f.page.locator('#jumpTodayBtn').isDisabled(), false);
    const targetPhase = await f.page.evaluate(week => phaseForWeek(week).id, expectedWeek);
    const currentPhase = await f.page.evaluate(() => selectedPhase);
    assert.equal(await f.page.locator('#currentWeekHint').isVisible(), currentPhase !== targetPhase);
    await f.page.locator('#jumpTodayBtn').click();
    assert.equal(await f.page.locator('#weekSelect').inputValue(), String(expectedWeek));
    assert.equal(await f.page.locator(`#planPhaseSwitch button[data-phase="${targetPhase}"]`).getAttribute('aria-pressed'), 'true', 'Returning to this week also selects its phase');
    assert.equal(await f.page.locator('#currentWeekHint').isVisible(), false);
    if (targetPhase === 'career') {
      assert.equal(await f.page.locator('#weekTasks .day-group .task-card').count(), await f.page.evaluate(() => scheduledTasksForWeek(selectedWeekData()).length));
      assert.equal(await f.page.locator('.week-navigation').isVisible(), true);
      assert.equal(await f.page.locator('#allWeeksDetails').isVisible(), true);
      assert.equal(await f.page.locator('#weekTopic').textContent(), await f.page.evaluate(() => selectedWeekData().range));
    } else {
      assert.equal(await f.page.locator('.week-chip-title').filter({ hasText: '本周' }).count(), 1);
      assert.match(await f.page.locator(`.week-chip[data-week="${expectedWeek}"] .week-chip-title`).textContent(), /本周/);
    }
  }
  await f.page.locator('#phase-courses').click();
  await setTime(endInstant + 1);
  assert.equal(await f.page.locator('#jumpTodayBtn').isDisabled(), true);
  assert.equal(await f.page.locator('#jumpTodayBtn').textContent(), '回到本周');
  assert.equal(await f.page.locator('#currentWeekHint').isVisible(), true);
  const afterReferenceHint = await f.page.locator('#currentWeekHint').textContent();
  assert.match(afterReferenceHint, /参考|按进度|老师|继续/);
  assert.doesNotMatch(afterReferenceHint, /学习计划已.*结束/);
  assert.equal(await f.page.locator('.week-chip-title').filter({ hasText: '本周' }).count(), 0);
  await f.page.locator('#phase-career').click();
  await f.page.locator('#jumpFirstBtn').click();
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '34');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '材料第 1 周');
  assert.equal(await f.page.locator('.week-navigation').isVisible(), true,
    'Reference-week navigation stays available while the actual career workflow remains open ended');
  assert.doesNotMatch(await f.page.locator('#weekTasks').textContent(), /学习计划已.*结束/);
});

test('Saturday reserves five full hours for videos plus independent code practice and searchable sections', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { mobile: true });
  await planner(f.page);
  const week = await f.page.evaluate(() => ({ ...DATA.weeks[0], tasks: scheduledTasksForWeek(DATA.weeks[0]) }));
  for (const day of ['周一', '周二', '周三', '周四', '周五']) {
    const assignments = week.tasks.filter(task => task.day === day);
    assert.equal(assignments.length, 1, `${day}: no extra weekday project task`);
    const task = assignments[0];
    assert.equal(task.track, 'ls');
    assert.equal(await f.page.locator(`#weekTasks [data-task-id="${task.id}"] .duration-chip`).textContent(), `${task.durationMinutes} 分钟`);
  }
  const saturday = week.tasks.filter(task => task.day === '周六');
  assert.ok(saturday.length >= 2 && saturday.length <= 3);
  const videoMinutes = saturday.filter(task => task.activity === 'video').reduce((sum, task) => sum + task.durationMinutes, 0);
  const saturdayMinutes = saturday.reduce((sum, task) => sum + (task.sessionMinutes ?? task.durationMinutes), 0);
  assert.equal(videoMinutes, 300, 'Five hours belongs to course playback alone');
  assert.ok(saturdayMinutes > videoMinutes, 'Code reproduction must remain additional to the five-hour video block');
  assert.match(await f.page.locator('#weekMeta').textContent(), /易道云视频 5 小时/);
  for (const task of saturday) {
    assert.equal(task.track, 'ydy');
    assert.equal(await f.page.locator(`#weekTasks [data-task-id="${task.id}"]`).isVisible(), true);
  }
  const visibleMinutes = await f.page.locator(`#day-${saturday[0].date} .duration-chip`).allTextContents();
  assert.ok(Math.abs(visibleMinutes.reduce((total, text) => total + displayedMinutes(text), 0) - saturdayMinutes) < 0.02, 'Visible blocks include playback and the current module session without counting its full estimate twice');
  const practice = saturday.find(task => !task.learningSegments?.length && task.budget.practiceMinutes > 0);
  assert.ok(practice, 'Saturday must distinguish implementation practice from course viewing');
  const practiceCard = f.page.locator(`#day-${practice.date} [data-task-id="${practice.id}"]`);
  assert.ok(Math.abs(displayedMinutes(await practiceCard.locator('.duration-chip').textContent()) - (practice.sessionMinutes ?? practice.durationMinutes)) < 0.01, 'The practice block displays its own duration');
  assert.equal(await practiceCard.locator('.task-desc').textContent(), practice.steps[0], 'The card should identify the first concrete action');
  await practiceCard.locator('.task-title').click();
  assert.ok((await f.page.locator('#taskDialog .detail-meta').textContent()).includes((await practiceCard.locator('.duration-chip').textContent()).split('·').at(-1).trim()), 'The full module estimate remains available separately in the detail metadata');
  assert.equal(await f.page.locator('#taskDialog .detail-budget').count(), 0, 'A single practice budget is already in the task metadata');
  assert.equal(await f.page.locator('#taskDialog .segment-row').count(), 0, 'Hands-on practice must not be presented as a new video assignment');
  assert.deepEqual(await f.page.locator('#taskDialog .practice-step-list label > span').allTextContents(), practice.steps);
  assert.deepEqual(await f.page.locator('#taskDialog .detail-deliverables li').allTextContents(), practice.deliverables);
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(id => document.activeElement?.closest('#weekTasks [data-task-id]')?.dataset.taskId === id, practice.id);

  const task = await f.page.evaluate(() => allTasks.find(item => item.track === 'ydy'
    && item.learningSegments?.some(segment => segment.startSecond % 60 || segment.endSecond % 60)));
  assert.ok(task, 'The Edoyun schedule must exercise real video times with second precision');
  await f.page.locator('#weekSelect').selectOption(String(task.week));
  const card = f.page.locator(`#weekTasks [data-task-id="${task.id}"]`);
  const cardDescription = await card.locator('.task-desc').textContent();
  if (task.learningSegments.length === 1) {
    assert.ok(cardDescription.includes('–'), 'A single course fragment should show its playback interval on the card');
  } else {
    assert.ok(cardDescription.includes(String(task.learningSegments.length)), 'The card should identify the number of course fragments');
  }
  await card.locator('.task-title').click();
  const rows = f.page.locator('#taskDialog .segment-row');
  assert.equal(await rows.count(), task.learningSegments.length);
  const timestamp = seconds => {
    const text = new Date(seconds * 1000).toISOString().slice(11, 19);
    return seconds < 3600 ? text.slice(3) : text.replace(/^0/, '');
  };
  for (const [index, segment] of task.learningSegments.entries()) {
    const row = rows.nth(index);
    assert.equal(await row.locator('strong').textContent(), segment.title);
    assert.equal(await row.locator('.segment-course').textContent(), `${segment.courseTitle} · ${segment.chapterTitle}`);
    assert.ok((await row.textContent()).includes(`${timestamp(segment.startSecond)} – ${timestamp(segment.endSecond)}`), 'Playback intervals retain their actual seconds');
    assert.equal(await row.locator('.segment-source').textContent(), `原视频总时长 ${timestamp(segment.totalSeconds)}`);
  }
  assert.equal(await f.page.locator('#taskDialog .detail-budget').count(), 0, 'A single video budget is already in the task metadata');
  assert.ok((await f.page.locator('#taskDialog .detail-meta').textContent()).includes(await card.locator('.duration-chip').textContent()), 'Original video total remains available in the metadata');
  for (const width of [320, 390]) {
    await f.page.setViewportSize({ width, height: 844 });
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Task details must fit at ${width}px`);
  }
  assert.deepEqual(await f.page.locator('#taskDialog .detail-steps li').allTextContents(), task.steps);
  assert.deepEqual(await f.page.locator('#taskDialog .detail-deliverables li').allTextContents(), task.deliverables);
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(id => document.activeElement?.closest('#weekTasks [data-task-id]')?.dataset.taskId === id, task.id);

  const title = task.learningSegments.find(segment => segment.startSecond % 60 || segment.endSecond % 60).title;
  const expectedIds = await f.page.evaluate(title => allTasks.filter(item => item.learningSegments?.some(segment => segment.title === title)).map(item => item.id), title);
  await f.page.locator('#taskSearch').fill(title);
  const results = await f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId));
  assert.ok(expectedIds.length > 0);
  for (const id of expectedIds) assert.ok(results.includes(id), `Real section title search must find every scheduled interval: ${id}`);
  assert.equal(await f.page.locator('#weekSelect').inputValue(), String(task.week));
  await f.page.locator('#trackFilter').selectOption('ls');
  assert.equal(await f.page.locator('#weekTasks .task-card').count(), 0, 'Source filtering must apply to new section title matches');
  await f.page.locator('#weekTasks [data-clear-filters]').click();
  assert.equal(await f.page.locator('#taskSearch').inputValue(), '');
  assert.equal(await card.isVisible(), true);
});

test('course playback uses each project quota without filling Studio weeks back to five hours', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { mobile: true });
  await planner(f.page);
  for (const [number, expectedSeconds] of [[6, 2639], [7, 0], [8, 0], [9, 14400], [16, 14400], [17, 12567], [18, 0], [19, 0], [20, 7200], [25, 7200], [31, 3923], [32, 0]]) {
    await f.page.locator('#weekSelect').selectOption(String(number));
    const week = await f.page.evaluate(number => { const week = DATA.weeks.find(item => item.week === number);
      return { ...week, tasks: scheduledTasksForWeek(week), topics: weekTopics(week) }; }, number);
    const saturday = week.tasks.filter(task => task.day === '周六');
    const videos = saturday.filter(task => task.activity === 'video');
    assert.equal(Math.round(videos.reduce((sum, task) => sum + task.durationMinutes * 60, 0)), expectedSeconds);
    const topic = week.topics.find(topic => topic.track === 'ydy')?.title;
    if (topic) assert.ok((await f.page.locator('#weekTopic').textContent()).includes(topic), `Week ${number} names current playback and separate reproduction`);
    else assert.equal(saturday.length, 0, 'A finished project tail can leave a genuinely free Saturday');
    if (saturday.length) {
      const visibleMinutes = await f.page.locator(`#day-${saturday[0].date} .duration-chip`).allTextContents();
      assert.ok(Math.abs(visibleMinutes.reduce((sum, label) => sum + displayedMinutes(label), 0)
        - saturday.reduce((sum, task) => sum + (task.sessionMinutes ?? task.durationMinutes), 0)) < 0.02, `Week ${number} shows its complete Saturday total`);
    }
    assert.ok(new Set(week.tasks.filter(task => task.projectId).map(task => task.projectId)).size <= 1,
      `Week ${number} must keep Edoyun projects strictly separate`);
    for (const video of videos) {
      const card = f.page.locator(`#weekTasks [data-task-id="${video.id}"]`);
      assert.equal(await card.isVisible(), true);
      assert.ok(Math.abs(displayedMinutes(await card.locator('.duration-chip').textContent()) - video.durationMinutes) < 0.02);
    }
    if (number === 6) {
      assert.deepEqual([...new Set(videos.map(task => task.projectId))], ['yibo'], 'Cloud video waits until all Yibo practice and verification finish');
      assert.match(topic, /课程观看/);
      assert.ok(saturday.some(task => task.activity === 'practice'), 'Video and module practice remain distinct');
    }
    if ([20, 25].includes(number)) {
      assert.match(await f.page.locator('#weekMeta').textContent(), /易道云视频 2 小时/);
    }
    if (number === 31) {
      assert.equal(videos[0].date, '2027-05-08');
      assert.match(await f.page.locator('#weekMeta').textContent(), /易道云视频 1 小时 5 分钟 23 秒/);
      assert.equal(videos[0].learningSegments.at(-1).title, '6.5 AI旁路分析引擎与热插拔Hook架构');
    }
    if (number === 32) {
      assert.equal(videos.length, 0, 'After the last original video, the remaining original project modules continue without new footage');
      assert.equal(/易道云视频/.test(await f.page.locator('#weekMeta').textContent()), false);
    }
  }
  await f.page.locator('#weekSelect').selectOption('1');
  const firstVideo = f.page.locator('#weekTasks [data-task-id="ydy5h-v1-w01-yibo"]');
  const firstPractice = f.page.locator('#weekTasks [data-task-id="edoyun-module-v1-yibo-environment-ipc"]');
  assert.equal(await firstVideo.locator('.done-label').count(), 0);
  await firstVideo.locator('[data-task-action="toggle"]').click();
  await settled(f.page);
  assert.equal(await firstVideo.locator('.done-label').textContent(), '已完成');
  assert.equal(await firstVideo.evaluate(card => card.classList.contains('is-done')), true);
  assert.equal(await firstVideo.locator('[data-task-action="toggle"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await firstPractice.locator('.done-label').count(), 0, 'Video check-in never completes separate reproduction');
  assert.equal(await firstPractice.locator('[data-progress-action="record-session"]').count(), 1);
  assert.equal(await f.page.evaluate(() => taskDone('edoyun-module-v1-yibo-environment-ipc')), false);
  await f.page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('all twelve Course Studio video cards show two-hour blocks, current topics and prerequisites without old five-hour cards', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const studio = await f.page.evaluate(() => allTasks.filter(task => task.projectId === 'studio-course' && task.activity === 'video'));
  assert.equal(studio.length, 12);
  assert.deepEqual(studio.map(task => task.week), Array.from({ length: 12 }, (_, index) => index + 20));
  assert.deepEqual(studio.map(task => Math.round(task.durationMinutes * 60)), [...Array(11).fill(7200), 3923]);
  assert.equal(await f.page.evaluate(() => allTasks.some(task => /^ydy5h-v1-w\d+-studio-course$/.test(task.id))), false);
  const futurePrerequisites = await f.page.evaluate(() => allTasks.filter(task => (task.prerequisiteTaskIds || [])
    .some(id => !taskById.has(id) || taskPlanEnd(taskById.get(id)) > task.date)).map(task => task.id));
  assert.deepEqual(futurePrerequisites, [], 'Project practice may only reference video/tasks already scheduled by that day');
  for (const task of studio) {
    await f.page.locator('#weekSelect').selectOption(String(task.week));
    const card = f.page.locator(`#weekTasks [data-task-id="${task.id}"]`);
    assert.equal(await card.isVisible(), true);
    assert.ok(Math.abs(displayedMinutes(await card.locator('.duration-chip').textContent()) - task.durationMinutes) < 0.02);
    const topic = await f.page.evaluate(week => weekTopics(DATA.weeks.find(item => item.week === week))
      .find(item => item.track === 'ydy').title, task.week);
    assert.equal(await f.page.locator('#weekTopic .week-topic-line.ydy .week-topic-title').textContent(), topic,
      'Each Studio week shows its actual course and module topics');
    assert.equal(await f.page.locator('#weekTasks [data-task-id^="ydy5h-"][data-task-id$="studio-course"]').count(), 0);
  }
  await f.page.locator('#weekSelect').selectOption('20');
  assert.match(await f.page.locator('#weekMeta').textContent(), /易道云视频 2 小时/);
  if (process.env.TRACKER_REVIEW_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.TRACKER_REVIEW_SCREENSHOT_DIR, { recursive: true });
    await f.page.screenshot({ path: path.join(process.env.TRACKER_REVIEW_SCREENSHOT_DIR, 'studio-two-hour-desktop.png'), fullPage: true });
  }
  await f.page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Two-hour Studio cards must fit at 320px');
  if (process.env.TRACKER_REVIEW_SCREENSHOT_DIR) await f.page.screenshot({ path: path.join(process.env.TRACKER_REVIEW_SCREENSHOT_DIR, 'studio-two-hour-mobile.png'), fullPage: true });
});

test('an old five-hour Studio completion and playback stop stay visible on the new two-hour course cards', { timeout: 30_000 }, async t => {
  const oldId = 'ydy5h-v1-w13-studio-course';
  const f = await fixture(t, { seed: { [oldId]: { ...record(true), evidence: '旧安排完成记录' } } });
  const firstId = 'ydy2h-v1-w13-studio-course';
  assert.equal(await f.page.evaluate(id => taskDone(id), firstId), true, 'A completed former video block covers the first new two-hour block');
  await planner(f.page);
  await f.page.locator('#weekSelect').selectOption('20');
  const card = f.page.locator(`#weekTasks [data-task-id="${firstId}"]`);
  assert.equal(await card.locator('.done-label').textContent(), '已完成');
  await card.locator('.task-title').click();
  const archive = f.page.locator('#taskDialogBody .outline-content-section details');
  await archive.locator('summary').click();
  assert.match(await archive.textContent(), /原任务已完成.*旧安排完成记录/s);
  await f.page.locator('#closeTaskBtn').click();
  const position = await f.page.evaluate(id => {
    const old = legacyVideoTaskById.get(id);
    const segment = old.learningSegments[0];
    const position = segment.startSecond + 73;
    state.entries[id] = createEntry(false, freshTimestamp(), '旧停点证据', { kind: 'video', segmentIndex: 0, positionSecond: position, note: '旧计划停点笔记' });
    localRevision++; saveState(); render(); syncToServer({ silent: true });
    return position;
  }, oldId);
  await settled(f.page);
  await card.locator('.task-title').click();
  assert.equal(await f.page.locator('#videoPositionText').inputValue(), await f.page.evaluate(value => clockSecond(value), position));
  assert.equal(await f.page.evaluate(id => taskDone(id), firstId), false, 'A changed unfinished old block overrides its former completion');
  await f.page.locator('#taskDialogBody .outline-content-section details summary').click();
  assert.match(await f.page.locator('#taskDialogBody .outline-content-section details').textContent(), /原任务未完成.*旧计划停点笔记.*旧停点证据/s);
  await f.page.locator('#closeTaskBtn').click();
  await f.page.reload();
  await settled(f.page);
  await f.page.evaluate(id => openTaskDetails(id), firstId);
  assert.equal(await f.page.locator('#videoPositionText').inputValue(), await f.page.evaluate(value => clockSecond(value), position));
});

test('unified Edoyun search separates the only cloud course pass from its practice and moves directly from course completion to career', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const plan = await f.page.evaluate(() => ({
    cloud: allTasks.filter(task => task.projectId === 'yunzhujiao'),
    oldPracticeIds: (DATA.legacyPracticeTasks || []).map(task => task.id),
    goals: DATA.milestones.map(goal => ({ id: goal.id, date: goal.date,
      lastTaskDate: milestoneTasks(goal).map(task => taskPlanEnd(task)).sort().at(-1) })),
    phases: planPhases
  }));
  assert.equal(plan.cloud.filter(task => task.activity === 'video').length, 9);
  assert.equal(plan.cloud.filter(task => task.activity === 'practice').length, 11);
  assert.ok(plan.cloud.every(task => task.week >= 9 && task.week <= 19), 'The old cloud course and practice sequence must not recur after the unified course pass');
  assert.equal(plan.phases[0].end, '2027-05-23');
  assert.equal(plan.phases[1].start, '2027-05-24', 'Career materials follow course and project completion with no extra deepening phase');
  await f.page.locator('#taskSearch').fill('云助教');
  const visibleIds = await f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId));
  assert.equal(new Set(visibleIds).size, visibleIds.length, 'Search must render every scheduled task only once');
  assert.ok(plan.oldPracticeIds.every(id => !visibleIds.includes(id)), 'Archived practice records are not current scheduled assignments');
  const transitionId = 'ydy5h-v1-w06-yibo';
  const transitionSummary = await f.page.evaluate(id => taskById.get(id).summary, transitionId);
  assert.ok(transitionSummary.includes('云助教'), 'The Yibo handoff explicitly mentions the next project');
  assert.ok(visibleIds.includes(transitionId), 'Global search includes a real summary match from another project');
  const transitionMatch = f.page.locator(`#weekTasks [data-task-id="${transitionId}"] .search-match-context`);
  assert.equal(await transitionMatch.locator(':scope > span').textContent(), '匹配说明');
  assert.equal(await transitionMatch.locator('p').textContent(), transitionSummary,
    'The result explains why the Yibo handoff matches Cloud Teaching');
  for (const id of ['edoyun-module-v1-yibo-crypto', 'ydy2h-v1-w13-studio-course', 'edoyun-module-v1-studio-course-environment-qt']) {
    assert.ok(!visibleIds.includes(id), `Cloud search must not pull unrelated project task ${id} into cloud results`);
  }
  for (const task of plan.cloud) {
    const card = f.page.locator(`#weekTasks [data-task-id="${task.id}"]`);
    assert.equal(await card.count(), 1, `The unified cloud task ${task.id} appears once`);
    assert.equal(await card.locator('.track.ydy').textContent(), task.activity === 'video' ? '易道云视频' : '配套练习');
    assert.match(await card.locator('.task-title').textContent(), task.activity === 'video' ? /课程观看/ : /云助教/);
  }
  if (process.env.TRACKER_REVIEW_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.TRACKER_REVIEW_SCREENSHOT_DIR, { recursive: true });
    await f.page.screenshot({ path: path.join(process.env.TRACKER_REVIEW_SCREENSHOT_DIR, 'unified-cloud-desktop.png') });
  }
  await f.page.locator('#taskSearch').fill('Course Studio');
  const studioIds = await f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId));
  const zeroVoiceIds = await f.page.evaluate(() => allTasks.filter(task => task.track === 'ls').map(task => task.id));
  assert.ok(studioIds.length > 0, 'Course Studio still finds its actual course and project tasks');
  assert.ok(zeroVoiceIds.every(id => !studioIds.includes(id)), 'The phase name must not pull parallel Zero Voice lessons into Course Studio results');
  await f.page.locator('.nav-item[data-view="milestones"]').click();
  for (const goal of plan.goals) {
    if (goal.date) {
      assert.equal(goal.date, goal.lastTaskDate, `${goal.id}: milestone is the last real task date`);
      assert.equal(await f.page.locator(`[data-milestone-id="${goal.id}"] time`).getAttribute('datetime'), goal.date);
    } else {
      assert.equal(goal.id, 'career');
      assert.equal(await f.page.locator(`[data-milestone-id="${goal.id}"] time`).count(), 0, 'External collaboration has no invented completion date');
    }
  }
  await planner(f.page);
  await f.page.locator('#taskSearch').fill('');
  assert.equal(await f.page.locator('#phase-projects').count(), 0);
  await f.page.locator('#phase-career').click();
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '34');
  const career = await f.page.evaluate(() => selectedWeekData());
  assert.ok(career.tasks.length > 0 && career.tasks.every(task => task.track === 'review'), 'Career materials follow original course completion without additional polishing');
  const materials = await f.page.evaluate(() => {
    const sessions = id => {
      const task = taskById.get(id);
      return { id, minutes: task.durationMinutes,
        sessions: taskWorkSessions(task).map(({ date, minutes }) => ({ date, minutes })) };
    };
    return { projects: DATA.careerWorkflow.projectPreparationTaskIds.map(sessions),
      skills: DATA.careerWorkflow.skillPreparationTaskIds.map(sessions) };
  });
  const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  assert.deepEqual(materials.projects.map(task => task.sessions.length), [4, 2, 5, 3],
    'Remote, Yibo, Cloud and Studio keep all 14 project-material sessions');
  for (const task of materials.projects) {
    assert.ok(task.sessions.every(session => weekday(session.date) > 0 && weekday(session.date) < 6 && session.minutes === 40),
      `${task.id}: project materials use 40-minute weekdays`);
    assert.equal(task.sessions.reduce((sum, session) => sum + session.minutes, 0), task.minutes);
  }
  assert.deepEqual(materials.skills.map(task => task.minutes), [120, 60, 60],
    'Audio/video, build tools and C++ skills retain their two/one/one-hour modules');
  const skillDays = new Map();
  for (const task of materials.skills) {
    assert.equal(task.sessions.length, 1);
    for (const session of task.sessions) {
      assert.equal(weekday(session.date), 6, `${task.id}: skill materials stay on Saturday`);
      assert.equal(session.minutes, task.minutes);
      skillDays.set(session.date, (skillDays.get(session.date) || 0) + session.minutes);
    }
  }
  assert.deepEqual([...skillDays.values()], [120, 120], 'Skills occupy two Saturdays of two hours each');
  assert.ok([...materials.projects, ...materials.skills].flatMap(task => task.sessions)
    .every(session => weekday(session.date) !== 0), 'Sunday remains free of fixed material sessions');
  assert.equal(await f.page.locator('#weekTasks .track.ydy').count(), 0);
  await f.page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'The unified 320px planner must fit its viewport');
  if (process.env.TRACKER_REVIEW_SCREENSHOT_DIR) await f.page.screenshot({ path: path.join(process.env.TRACKER_REVIEW_SCREENSHOT_DIR, 'unified-career-mobile.png'), fullPage: true });
});

test('continue learning catches up from the first gap, advances after check-in, and resets its source on weekends', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  assert.equal(await f.page.locator('#continueBox .continue-inline-status').count(), 1, 'The next lesson already shown in Today stays compact');
  assert.equal(await f.page.locator('#continueBox [data-continue-today]').count(), 1, 'The compact notice still links to today’s task');
  await f.page.clock.setFixedTime(new Date('2026-10-20T04:00:00Z'));
  await f.page.evaluate(() => render());
  const lsIds = await f.page.evaluate(() => allTasks.filter(task => task.track === 'ls').map(task => task.id));
  assert.equal(await f.page.locator('#todayBox .task-card').getAttribute('data-task-id'), lsIds[0]);
  assert.match(await f.page.locator('#todayHint').textContent(), /原计划/);
  await f.page.locator('#todayBox [data-task-action="toggle"]').click();
  await settled(f.page);
  assert.equal(await f.page.locator('#todayBox .task-card').getAttribute('data-task-id'), lsIds[1]);
  await f.page.evaluate(id => changeTask(id, true, false), lsIds[5]);
  await settled(f.page);
  assert.equal(await f.page.locator('#todayBox .task-card').getAttribute('data-task-id'), lsIds[1], 'Finishing a later lesson must preserve the earlier gap');
  await f.page.clock.setFixedTime(new Date('2026-10-24T04:00:00Z'));
  await f.page.evaluate(() => render());
  assert.equal(await f.page.locator('#continue-track-ydy').getAttribute('aria-pressed'), 'true', 'Saturday defaults to 易道云');
  await f.page.locator('#continue-track-ls').click();
  assert.equal(await f.page.locator('#continue-track-ls').getAttribute('aria-pressed'), 'true', 'The user can still choose 零声 manually');
  await f.page.clock.setFixedTime(new Date('2026-10-25T04:00:00Z'));
  await f.page.evaluate(() => render());
  assert.equal(await f.page.locator('#continue-track-ydy').getAttribute('aria-pressed'), 'true', 'Manual choice does not push 零声 on Sunday');
});

test('finishing 零声 ahead of schedule opens weekday project practice and phase progress stays separate', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { mobile: true });
  await f.page.clock.setFixedTime(new Date('2026-10-21T04:00:00Z'));
  await f.page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    localRevision++; saveState(); render(); syncToServer({ silent: true });
  });
  await settled(f.page);
  const expectedPractice = await f.page.evaluate(() => allTasks.find(task => task.track === 'ydy' && task.activity === 'practice' && !taskDone(task.id)));
  assert.equal(await f.page.locator('#continue-track-ydy').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.page.locator('#todayBox .task-card').getAttribute('data-task-id'), expectedPractice.id);
  assert.match(await f.page.locator('#todayBox .continue-prerequisite').textContent(), /前置任务尚未打卡.*周六先补前置/);
  await f.page.locator('#todayBox [data-task-action="details"]').first().click();
  const prerequisiteLink = f.page.locator('#taskDialogBody .detail-prerequisites [data-prerequisite-task-id]').first();
  const prerequisite = await prerequisiteLink.getAttribute('data-prerequisite-task-id');
  assert.ok(prerequisite, 'Practice links to its prerequisite lesson task');
  await prerequisiteLink.click();
  await f.page.locator('#plannerView').waitFor({ state: 'visible' });
  assert.equal(await f.page.locator('#plannerView').isVisible(), true);
  assert.equal(await f.page.locator(`#weekTasks [data-task-id="${prerequisite}"]`).isVisible(), true);
  await f.page.waitForFunction(id => document.activeElement?.closest('#weekTasks [data-task-id]')?.dataset.taskId === id, prerequisite);

  await f.page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredTasks().filter(task => phaseForWeek(task.week).id === 'courses')) state.entries[task.id] = createEntry(true, stamp);
    localRevision++; saveState(); render(); syncToServer({ silent: true });
  });
  await settled(f.page);
  await f.page.locator('.nav-item[data-view="overview"]').click();
  const counts = await f.page.evaluate(() => ({ courses: requiredTasks().filter(task => phaseForWeek(task.week).id === 'courses').length, all: requiredTasks().length, done: requiredTasks().filter(task => taskDone(task.id)).length,
    career: requiredTasks().filter(task => phaseForWeek(task.week).id === 'career').length,
    careerDone: requiredTasks().filter(task => phaseForWeek(task.week).id === 'career' && taskDone(task.id)).length }));
  assert.equal(await f.page.locator('#progressPct').textContent(), '100%');
  assert.equal(await f.page.locator('#doneDays').textContent(), String(counts.courses));
  assert.equal(await f.page.locator('#totalDays').textContent(), String(counts.courses));
  assert.match(await f.page.locator('#overallProgressSummary').textContent(), new RegExp(`全计划必修 ${counts.done} / ${counts.all} 项`));
  await f.page.locator('#progress-phase-career').click();
  assert.equal(await f.page.locator('#progressPct').textContent(), `${Math.round(counts.careerDone * 100 / counts.career)}%`);
  assert.equal(await f.page.locator('#doneDays').textContent(), String(counts.careerDone), 'Zero Voice completed ahead remains counted in its actual phase');
  assert.equal(await f.page.evaluate(() => allLearningComplete()), true, 'The original course work is the entire required learning gate');
  assert.equal(await f.page.locator('#overallProgressSummary').textContent(), `全计划必修 ${counts.done} / ${counts.all} 项 · ${Math.round(counts.done * 100 / counts.all)}% · 按需补漏 0 / 1`);
});

test('legacy project evidence stays folded and read-only across reload and export without completing current work', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const project = await f.page.evaluate(() => {
    const goal = DATA.milestones.find(goal => goal.kind === 'project');
    return { id: goal.id, reviewKey: milestoneReviewKey(goal) };
  });
  const scriptCount = await f.page.locator('script').count();
  const evidence = '原演示地址：https://example.invalid/demo <script>alert(1)</script>';
  const original = { done: true, updatedAt: '2026-09-28T03:04:05.000Z', evidence };
  f.inject(project.reviewKey, original);
  await f.page.evaluate(() => syncToServer({ silent: true }));
  await settled(f.page);
  await f.page.locator('.nav-item[data-view="milestones"]').click();
  const card = f.page.locator(`[data-milestone-id="${project.id}"]`);
  const history = card.locator(`details[data-project-history="${project.id}"]`);
  const oldRecord = history.locator(`[data-historical-review-key="${project.reviewKey}"]`);
  assert.equal(await card.locator('.goal-status').textContent(), '未开始', 'An old acceptance cannot mark current task work complete');
  assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), '0');
  assert.equal(await history.getAttribute('open'), null, 'Historical explanations are folded by default');
  assert.match(await history.locator('summary').textContent(), /已有成果记录/);
  await history.locator('summary').click();
  assert.equal(await oldRecord.isVisible(), true);
  assert.equal(await oldRecord.locator('time').getAttribute('datetime'), original.updatedAt);
  assert.ok((await oldRecord.textContent()).includes(evidence));
  assert.equal(await oldRecord.locator('a[href="https://example.invalid/demo"]').count(), 1);
  assert.equal(await history.locator('button,input,textarea,[contenteditable="true"]').count(), 0, 'Historical evidence has no editor or completion control');
  assert.equal(await f.page.locator('[data-milestone-review],#milestoneReviewDialog').count(), 0);
  assert.equal(await f.page.locator('script').count(), scriptCount, 'Evidence text must not create an executable script');
  assert.deepEqual(await f.page.evaluate(key => state.entries[key], project.reviewKey), original);
  await f.page.reload();
  await f.page.waitForFunction(() => syncState.reachable !== null);
  await settled(f.page);
  assert.equal(await history.getAttribute('open'), null, 'Reload restores the compact milestone view');
  assert.equal(await card.locator('.goal-status').textContent(), '未开始');
  assert.deepEqual(await f.page.evaluate(key => state.entries[key], project.reviewKey), original);
  await f.page.locator('#openSyncBtn').click();
  const [download] = await Promise.all([f.page.waitForEvent('download'), f.page.locator('#exportBtn').click()]);
  const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(backup.version, 3);
  assert.equal(Object.keys(backup.entries).length, f.tasks.length);
  const exported = backup.milestoneReviews?.[project.reviewKey.slice('milestone:'.length)] || backup.archivedEntries?.[project.reviewKey];
  assert.deepEqual(exported, original, 'Export preserves the exact old status, UTC timestamp and explanation');
});

test('the career phase clears an unavailable source filter while global search can still find earlier courses', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  await f.page.locator('#trackFilter').selectOption('ls');
  await f.page.locator('#phase-career').click();
  assert.equal(await f.page.locator('#trackFilter').inputValue(), 'all');
  assert.deepEqual(await f.page.locator('#weekTasks .day-group .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId)),
    await f.page.evaluate(() => scheduledTasksForWeek(selectedWeekData()).map(task => task.id)));
  assert.equal(await f.page.locator('#trackFilter').isVisible(), false);
  assert.equal(await f.page.locator('#weekTasks .task-card .track.ls').count(), 0, 'The career overview must not pull in earlier course-phase assignments');
  const title = await f.page.evaluate(() => allTasks.find(task => task.track === 'ls').title);
  await f.page.locator('#taskSearch').fill(title);
  assert.equal(await f.page.locator('#weekTasks [data-career-board]').count(), 0);
  assert.equal(await f.page.locator('#trackFilter').isVisible(), true, 'Global search keeps the full source filter');
  assert.ok(await f.page.locator('#weekTasks .task-card').count() > 0);
  assert.equal(await f.page.locator('#weekTasks .task-card .track.ydy').count(), 0);
  assert.equal(await f.page.locator('#trackFilter').inputValue(), 'all', 'Global search does not alter the source selection');
  await f.page.locator('#taskSearch').fill('');
  assert.deepEqual(await f.page.locator('#weekTasks .day-group .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId)),
    await f.page.evaluate(() => scheduledTasksForWeek(selectedWeekData()).map(task => task.id)));
  assert.equal(await f.page.locator('#trackFilter').isVisible(), false);
  assert.equal(await f.page.locator('#weekTasks .task-card .track.ls').count(), 0, 'Clearing global search returns to the career reference week');
});

test('project reference directions follow source filters without leaking into search or task outlines', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const directions = f.page.locator('#weekTasks [data-optional-extension-id]');
  assert.equal(await directions.count(), 3);
  for (const track of ['ls', 'review', 'ydy', 'all']) {
    await f.page.locator('#trackFilter').selectOption(track);
    assert.equal(await directions.count(), ['all', 'ydy'].includes(track) ? 3 : 0,
      `Project references must follow the selected ${track} source`);
  }
  const title = await f.page.evaluate(() => allTasks.find(task => task.track === 'ls').title);
  await f.page.locator('#taskSearch').fill(title);
  assert.equal(await directions.count(), 0);
  assert.ok(await f.page.locator('#weekTasks .task-card').count() > 0);
  await f.page.locator('#taskSearch').fill('');
  assert.equal(await directions.count(), 3);
  await f.page.evaluate(() => openProgressList('ydy', 'studio-course', 'all', 'courses'));
  assert.equal(await f.page.locator('#plannerView').evaluate(node => node.classList.contains('is-outline')), true);
  assert.equal(await directions.count(), 0, 'An exact task outline contains no unrelated reference directions');
});

test('compact milestone details retain expanded context across sync and Back and Forward', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  await f.page.locator('.nav-item[data-view="milestones"]').click();
  const requirements = f.page.locator('#milestonesView [data-project-requirements]');
  assert.equal(await requirements.count(), 6);
  assert.equal(await f.page.locator('#milestonesView [data-project-requirements][open]').count(), 0);
  const readinessIds = await f.page.evaluate(() => DATA.applicationMilestone.readinessTaskIds);
  const application = f.page.locator('#application-preparation');
  assert.deepEqual(await application.locator('[data-task-id]').evaluateAll(nodes => nodes.map(node => node.dataset.taskId)), readinessIds,
    'The compact checklist retains all existing preparation task links');
  assert.equal(await application.locator('li').first().isVisible(), false);
  const summaries = ['courses', 'career', 'application-preparation'].map(id => `#project-requirements-summary-${id}`);
  for (const summary of summaries) {
    await f.page.locator(summary).focus();
    await f.page.keyboard.press('Enter');
  }
  const opened = () => f.page.locator('#milestonesView [data-project-requirements][open]')
    .evaluateAll(nodes => nodes.map(node => node.dataset.projectRequirements).sort());
  const expectedOpen = ['application-preparation', 'career', 'courses'];
  assert.deepEqual(await opened(), expectedOpen);
  f.inject(readinessIds[0], { done: true, updatedAt: '2026-10-23T01:02:03.000Z' });
  await f.page.evaluate(() => syncToServer({ silent: true }));
  await settled(f.page);
  assert.deepEqual(await opened(), expectedOpen, 'Progress synchronization preserves the open reading context');
  assert.equal(await application.locator('.application-preparation-count').textContent(), `1 / ${readinessIds.length}`);
  assert.equal(await application.locator(`[data-task-id="${readinessIds[0]}"] .badge`).textContent(), '已打卡');
  assert.equal(await f.page.evaluate(() => applicationReadiness().ready), false, 'One recorded material cannot bypass the learning and teacher requirements');
  const targetId = readinessIds[1];
  const target = application.locator(`[data-task-id="${targetId}"] button`);
  await target.click();
  assert.equal(await f.page.evaluate(() => detailTaskId), targetId);
  await f.page.locator('#taskHistoryBackBtn').click();
  await f.page.waitForFunction(() => !locationNavigationBusy && !restoringLocation && !$('taskDialog').open);
  assert.equal(await f.page.locator('#milestonesView').isVisible(), true);
  assert.deepEqual(await opened(), expectedOpen);
  assert.equal(await target.evaluate(node => node === document.activeElement), true);
  await f.page.locator('#navigationForwardBtn').click();
  await f.page.waitForFunction(id => !locationNavigationBusy && !restoringLocation && $('taskDialog').open && detailTaskId === id, targetId);
  await f.page.locator('#taskHistoryBackBtn').click();
  await f.page.waitForFunction(() => !locationNavigationBusy && !restoringLocation && !$('taskDialog').open);
  await planner(f.page);
  await f.page.locator('#navigationBackBtn').click();
  await f.page.waitForFunction(() => !locationNavigationBusy && !restoringLocation && selectedView === 'milestones');
  assert.deepEqual(await opened(), expectedOpen, 'Returning from another page restores all opened checklist sections');
});

test('synchronized legacy review flags cannot override automatic completion or hide a cancelled video', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const project = await f.page.evaluate(() => {
    const goal = DATA.milestones.find(goal => goal.kind === 'project');
    return { id: goal.id, reviewKey: milestoneReviewKey(goal), taskIds: milestoneTasks(goal).map(task => task.id) };
  });
  await f.page.evaluate(ids => { for (const id of ids) changeTask(id, true, false); }, project.taskIds);
  await settled(f.page);
  await f.page.locator('.nav-item[data-view="milestones"]').click();
  const card = f.page.locator(`[data-milestone-id="${project.id}"]`);
  assert.equal(await card.locator('.goal-status').textContent(), '已完成');
  const declined = { done: false, updatedAt: '2026-10-01T00:00:00.000Z', evidence: '另一设备保留的原验收未完成说明' };
  f.inject(project.reviewKey, declined);
  await f.page.evaluate(() => syncToServer({ silent: true }));
  await settled(f.page);
  assert.equal(await card.locator('.goal-status').textContent(), '已完成', 'An old false review cannot block complete current work');
  assert.deepEqual(await f.page.evaluate(key => state.entries[key], project.reviewKey), declined);
  const history = card.locator(`details[data-project-history="${project.id}"]`);
  assert.equal(await history.getAttribute('open'), null);
  assert.ok((await history.textContent()).includes(declined.evidence));
  const videoId = project.taskIds[0];
  assert.equal(await f.page.evaluate(id => taskById.get(id).activity, videoId), 'video');
  await f.page.evaluate(id => openTaskDetails(id), videoId);
  await f.page.locator('#detailToggleBtn').click();
  await settled(f.page);
  assert.equal(await f.page.evaluate(id => taskDone(id), videoId), false);
  assert.notEqual(await card.locator('.goal-status').textContent(), '已完成', 'A missing video reopens the project even while its final self-test remains checked');
  assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), String(project.taskIds.length - 1));
  const accepted = { done: true, updatedAt: '2026-10-02T00:00:00.000Z', evidence: '另一设备更新后的旧成果说明' };
  f.inject(project.reviewKey, accepted);
  await f.page.evaluate(() => syncToServer({ silent: true }));
  await settled(f.page);
  assert.notEqual(await card.locator('.goal-status').textContent(), '已完成', 'An old true review cannot conceal unfinished current footage');
  assert.equal(await f.page.evaluate(id => taskDone(id), videoId), false);
  assert.deepEqual(await f.page.evaluate(key => state.entries[key], project.reviewKey), accepted);
  assert.deepEqual(f.server()[project.reviewKey], accepted);
  await f.page.keyboard.press('Escape');
  assert.equal(await history.getAttribute('open'), null);
  assert.ok((await history.textContent()).includes(accepted.evidence));
  assert.equal(await history.locator('button,input,textarea').count(), 0);
  assert.equal(await f.page.locator('[data-milestone-review],#milestoneReviewDialog').count(), 0);
});
