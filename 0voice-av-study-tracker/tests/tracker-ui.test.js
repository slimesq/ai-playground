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
  const tasks = await page.evaluate(() => allTasks.map(task => ({ id: task.id, date: task.date })));
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
  const parts = [...label.matchAll(/(\d+(?:\.\d+)?)\s*(小时|分钟|分|秒)/g)];
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
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
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

test('milestone progress covers each task once and never treats dates or check-ins as project acceptance', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const goals = await f.page.evaluate(() => DATA.milestones.map(milestone => ({
    id: milestone.id,
    kind: milestone.kind,
    taskIds: milestone.taskIds,
    tasks: milestoneTasks(milestone).map(task => ({ id: task.id, track: task.track }))
  })));
  assert.equal(new Set(goals.map(goal => goal.id)).size, goals.length, 'Milestone IDs must be unique');
  assert.ok(goals.every(goal => ['project', 'parallel'].includes(goal.kind) && goal.taskIds.length > 0));
  const assignedIds = goals.flatMap(goal => goal.taskIds);
  assert.equal(assignedIds.length, f.tasks.length);
  assert.equal(new Set(assignedIds).size, assignedIds.length, 'A task must not advance two milestones');
  assert.deepEqual([...assignedIds].sort(), f.tasks.map(task => task.id).sort(), 'Every scheduled task belongs to one milestone');
  for (const goal of goals) assert.deepEqual(goal.tasks.map(task => task.id), goal.taskIds, 'All milestone references must resolve');
  const projects = goals.filter(goal => goal.kind === 'project');
  const parallel = goals.filter(goal => goal.kind === 'parallel');
  assert.ok(projects.length > 0 && parallel.length > 0, 'Projects and parallel learning both have goals');
  const courses = goals.find(goal => goal.id === 'courses');
  const learningIds = await f.page.evaluate(() => allTasks.filter(task => task.track === 'ls').map(task => task.id));
  assert.deepEqual(courses.tasks.filter(task => task.track === 'ls').map(task => task.id), learningIds, 'The course milestone contains every preserved first-pass session');

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
  assert.equal(await f.page.locator('.application-status').textContent(), '日期参考');

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
  await f.page.evaluate(ids => { for (const id of ids) changeTask(id, true, false); }, project.taskIds.slice(1));
  await settled(f.page);
  assert.equal(await card.locator('.goal-status').textContent(), '待验收');
  assert.equal(await card.locator('.goal-meter').getAttribute('aria-valuenow'), String(project.taskIds.length));
  assert.equal(await card.locator(`#milestone-review-${project.id}`).isEnabled(), true, 'Finished tasks still need an explicit project acceptance action');
  assert.equal(await f.page.locator('.application-status').textContent(), '日期参考');
  await f.page.locator(`#milestone-next-${project.id}`).click();
  assert.equal(await f.page.evaluate(() => detailTaskId), project.taskIds.at(-1), 'A checked project opens its final acceptance task');
  await f.page.locator('#detailToggleBtn').click();
  await settled(f.page);
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(id => document.activeElement?.id === `milestone-next-${id}`, project.id);
  assert.equal(await card.locator('.goal-status').textContent(), '待补', 'Cancelling a task must undo the checked state');
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
    assert.equal(await f.page.locator(`#planPhaseSwitch button[data-phase="${target.week <= 34 ? 'courses' : 'projects'}"]`).getAttribute('aria-pressed'), 'true', 'Opening a milestone task selects its plan phase');
    assert.equal(await f.page.locator(`#weekTasks [data-task-id="${target.nextId}"]`).isVisible(), true);
    await f.page.waitForFunction(id => document.activeElement?.closest('#weekTasks [data-task-id]')?.dataset.taskId === id, target.nextId);
  }
});

test('course and project phases scope week navigation and label project weeks locally', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const courses = f.page.locator('#planPhaseSwitch button[data-phase="courses"]');
  const projects = f.page.locator('#planPhaseSwitch button[data-phase="projects"]');
  const listedWeeks = () => f.page.locator('#weekList .week-chip').evaluateAll(buttons => buttons.map(button => Number(button.dataset.week)));
  const optionWeeks = () => f.page.locator('#weekSelect option').evaluateAll(options => options.map(option => Number(option.value)));

  assert.equal(await courses.getAttribute('aria-pressed'), 'true');
  assert.equal(await projects.getAttribute('aria-pressed'), 'false');
  assert.match(await courses.textContent(), /34\s*周/);
  assert.match(await f.page.locator('#planPhaseCaption').textContent(), /2026年10月5日.*2027年5月30日/);
  assert.deepEqual(await optionWeeks(), Array.from({ length: 34 }, (_, index) => index + 1));
  assert.deepEqual(await listedWeeks(), Array.from({ length: 34 }, (_, index) => index + 1));
  assert.equal(await f.page.locator('#weekTitle').textContent(), '第 1 周');
  assert.equal(await f.page.locator('#weekPrevBtn').isDisabled(), true);
  await f.page.locator('#weekSelect').selectOption('34');
  assert.equal(await f.page.locator('#weekNextBtn').isDisabled(), true, 'Course next must stop at week 34');

  await projects.click();
  assert.equal(await courses.getAttribute('aria-pressed'), 'false');
  assert.equal(await projects.getAttribute('aria-pressed'), 'true');
  assert.match(await projects.textContent(), /18\s*周/);
  assert.match(await f.page.locator('#planPhaseCaption').textContent(), /2027年5月31日.*10月3日/);
  assert.deepEqual(await optionWeeks(), Array.from({ length: 18 }, (_, index) => index + 35));
  assert.deepEqual(await listedWeeks(), Array.from({ length: 18 }, (_, index) => index + 35));
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '35');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '深化第 1 周');
  const firstProjectTopics = await f.page.evaluate(() => DATA.weeks[34].topics);
  const projectTopicText = await f.page.locator('#weekTopic').textContent();
  for (const topic of firstProjectTopics) assert.ok(projectTopicText.includes(topic.title), `Project phase omits ${topic.title}`);
  assert.equal(await f.page.locator('#weekPrevBtn').isDisabled(), true, 'Project previous must stop at week 35');
  await f.page.locator('#weekNextBtn').click();
  assert.equal(await f.page.locator('#weekTitle').textContent(), '深化第 2 周');
  await f.page.locator('#weekSelect').selectOption('52');
  assert.equal(await f.page.locator('#weekNextBtn').isDisabled(), true, 'Project next must stop at week 52');
});

test('a saved week from before phase preferences defaults to the first course week', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => localStorage.setItem(UI_STORE_KEY, JSON.stringify({ view: 'planner', week: 52, filter: 'all', track: 'all', search: '' })));
  await f.page.reload();
  await settled(f.page);
  assert.equal(await f.page.locator('#plannerView').isVisible(), true);
  assert.equal(await f.page.locator('#planPhaseSwitch button[data-phase="courses"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '1');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '第 1 周');
  assert.equal(await f.page.locator('#weekSelect option').count(), 34);
});

test('global search switches to the result phase while keeping the result week visible', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  const dates = await f.page.evaluate(() => ({
    course: DATA.weeks[0].tasks[0].date,
    project: DATA.weeks[34].tasks[0].date
  }));
  await f.page.locator('#taskSearch').fill(dates.project);
  const projectGroup = f.page.locator('#weekTasks .search-week-group[data-result-week="35"]');
  assert.equal(await projectGroup.isVisible(), true, 'Search spans the other plan phase');
  const projectHeading = await projectGroup.locator('.search-week-heading').textContent();
  assert.match(projectHeading, /深化/);
  assert.match(projectHeading, /第\s*1\s*周/);
  const projectTopics = await f.page.evaluate(() => DATA.weeks[34].topics);
  for (const topic of projectTopics) assert.ok(projectHeading.includes(topic.title), `Search group omits ${topic.title}`);
  await projectGroup.locator('[data-search-week="35"]').click();
  assert.equal(await f.page.locator('#planPhaseSwitch button[data-phase="projects"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '35');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '深化第 1 周');
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
      lsTopic: week.topics.find(topic => topic.track === 'ls').title,
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
  assert.equal(await f.page.locator('#trackProgress .track-progress-item').count(), 3);
  assert.equal(await f.page.locator('#trackProgress .track-progress-item.review').count(), 1, 'Interview preparation has its own nonempty progress category');
  const interviewWeek = await f.page.evaluate(() => DATA.weeks.find(week => week.tasks.some(task => task.track === 'review')).week);
  await f.page.evaluate(week => localStorage.setItem(UI_STORE_KEY, JSON.stringify({ view: 'planner', week, filter: 'all', track: 'review', search: '' })), interviewWeek);
  await f.page.reload();
  await settled(f.page);
  assert.equal(await f.page.locator('#trackFilter').inputValue(), 'review', 'A saved review preference remains valid for interview preparation');
  const interviewIds = await f.page.evaluate(week => DATA.weeks.find(item => item.week === week).tasks.filter(task => task.track === 'review').map(task => task.id), interviewWeek);
  assert.deepEqual(await f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId)), interviewIds);
  const reviewOption = f.page.locator('#trackFilter option[value="review"]');
  assert.equal(await reviewOption.isDisabled(), false);
  assert.equal(await reviewOption.getAttribute('hidden'), null);
  await f.page.locator(`#weekTasks [data-task-id="${interviewIds[0]}"] .task-title`).click();
  assert.match(await f.page.locator('#taskDialogTitle').textContent(), /面试/);
  assert.equal(await f.page.locator('#taskDialog .segment-row').count(), 0, 'Interview work is not a repeat of the Zero Voice video plan');
  assert.ok(await f.page.locator('#taskDialog .detail-steps li').count() > 0);
  await f.page.locator('#closeTaskBtn').click();
  await f.page.locator('#trackFilter').selectOption('ydy');
  const weekdayProject = await f.page.evaluate(week => DATA.weeks.find(item => item.week === week).tasks.find(task => task.track === 'ydy' && task.day === '周三'), interviewWeek);
  assert.ok(weekdayProject, 'Project development starts on weekdays after the last Zero Voice session');
  assert.equal(await f.page.locator(`#weekTasks [data-task-id="${weekdayProject.id}"] .duration-chip`).textContent(), '40 分钟');
  assert.equal(await f.page.locator('#weekTasks .task-card .track.review').count(), 0, 'Project filtering excludes interview work');
  await f.page.locator('#weekSelect').selectOption('7');
  await f.page.locator('#trackFilter').selectOption('ls');
  await f.page.locator('#taskSearch').fill('零声');
  const courseIds = await f.page.evaluate(() => allTasks.filter(task => task.track === 'ls').map(task => task.id));
  const resultIds = () => f.page.locator('#weekTasks .task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId));
  assert.deepEqual(await resultIds(), courseIds, 'A source search must include lessons from the entire plan');
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
  assert.deepEqual(await resultIds(), courseIds.slice(0, -1));
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '7');
  await f.page.locator('#taskSearch').fill('');
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '7', 'Clearing the query returns to the previous week');
  assert.equal(await f.page.locator('#weekTasks > .search-week-group').count(), 0);
  assert.deepEqual(await resultIds(), await f.page.evaluate(() => DATA.weeks[6].tasks.filter(task => task.track === 'ls').map(task => task.id)));

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
  const lastCourseWeek = await f.page.evaluate(id => DATA.weeks.find(week => week.tasks.some(task => task.id === id)), lastCourseId);
  assert.equal(await f.page.locator('#weekSelect').inputValue(), String(lastCourseWeek.week));
  assert.equal(await f.page.locator('#weekTasks .task-card').count(), lastCourseWeek.tasks.length);
  assert.equal(await f.page.locator(`#weekTasks [data-task-id="${lastCourseId}"]`).isVisible(), true);

  for (const [date, track] of [['2027-05-10', 'ls'], ['2027-05-11', 'review'], ['2027-05-12', 'ydy']]) {
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
  const weeks = await f.page.evaluate(() => DATA.weeks.map(week => ({ week: week.week, start: week.start, topics: week.topics, projectTopic: week.projectTopic })));
  const visibleTopics = async weekNumber => {
    const text = await f.page.locator('#weekTopic').textContent();
    for (const topic of weeks[weekNumber - 1].topics) {
      assert.ok(text.includes(topic.label), `Week ${weekNumber} planner omits ${topic.label}`);
      assert.ok(text.includes(topic.title), `Week ${weekNumber} planner omits ${topic.title}`);
    }
  };
  assert.equal(await f.page.locator('#weekSelect option').count(), 34);
  assert.equal(await f.page.locator('.week-chip').count(), 34);
  for (const week of weeks) {
    assert.ok(Array.isArray(week.topics) && week.topics.length >= 2, `Week ${week.week} needs parallel topics`);
    assert.ok(week.topics.every(topic => topic.track && topic.label && topic.title), `Week ${week.week} topics need source labels and titles`);
    assert.ok(typeof week.projectTopic === 'string' && week.projectTopic.trim(), `Week ${week.week} keeps its project topic`);
  }
  assert.deepEqual(new Set(weeks[0].topics.map(topic => topic.track)), new Set(['ls', 'ydy']), 'The first week exposes both course lines');
  assert.deepEqual(new Set(weeks[31].topics.map(topic => topic.track)), new Set(['ls', 'ydy', 'review']), 'Transition week names all three active lines');
  assert.deepEqual(new Set(weeks[34].topics.map(topic => topic.track)), new Set(['ydy', 'review']), 'Project weeks expose both project and interview lines');
  for (const week of weeks.slice(0, 34)) {
    const chipText = await f.page.locator(`.week-chip[data-week="${week.week}"] .week-chip-topic`).textContent();
    for (const topic of week.topics) assert.ok(chipText.includes(topic.title), `Week ${week.week} chip omits ${topic.title}`);
  }
  await visibleTopics(1);
  await f.page.locator('#weekSelect').selectOption('32');
  await visibleTopics(32);
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
  const projectStart = Date.parse(`${weeks[34].start}T00:00:00+08:00`);
  const crossMonthWeek = weeks.find(week => week.start.slice(0, 7) !== week.end.slice(0, 7));
  assert.ok(crossMonthWeek, 'The fixture should exercise a week that crosses a month boundary');
  for (const [instant, expectedWeek] of [
    [startInstant, 1],
    [secondWeekStart - 1, 1],
    [secondWeekStart, 2],
    [Date.parse(`${crossMonthWeek.end}T00:00:00+08:00`), crossMonthWeek.week],
    [projectStart, 35],
    [endInstant, weeks.at(-1).week]
  ]) {
    await setTime(instant);
    assert.equal(await f.page.locator('#jumpTodayBtn').isDisabled(), false);
    const targetPhase = expectedWeek <= 34 ? 'courses' : 'projects';
    const currentPhase = await f.page.evaluate(() => selectedPhase);
    assert.equal(await f.page.locator('#currentWeekHint').isVisible(), currentPhase !== targetPhase);
    await f.page.locator('#jumpTodayBtn').click();
    assert.equal(await f.page.locator('#weekSelect').inputValue(), String(expectedWeek));
    assert.equal(await f.page.locator(`#planPhaseSwitch button[data-phase="${targetPhase}"]`).getAttribute('aria-pressed'), 'true', 'Returning to this week also selects its phase');
    assert.equal(await f.page.locator('#currentWeekHint').isVisible(), false);
    assert.equal(await f.page.locator('.week-chip-title').filter({ hasText: '本周' }).count(), 1);
    assert.match(await f.page.locator(`.week-chip[data-week="${expectedWeek}"] .week-chip-title`).textContent(), /本周/);
  }
  await setTime(endInstant + 1);
  assert.equal(await f.page.locator('#jumpTodayBtn').isDisabled(), true);
  assert.equal(await f.page.locator('#jumpTodayBtn').textContent(), '回到本周');
  assert.equal(await f.page.locator('#currentWeekHint').isVisible(), true);
  assert.match(await f.page.locator('#currentWeekHint').textContent(), /结束/);
  assert.equal(await f.page.locator('.week-chip-title').filter({ hasText: '本周' }).count(), 0);
  await f.page.locator('#jumpFirstBtn').click();
  assert.equal(await f.page.locator('#weekSelect').inputValue(), '35', 'First-week navigation stays within the selected phase');
  assert.equal(await f.page.locator('#weekTitle').textContent(), '深化第 1 周');
  assert.equal(await f.page.locator('#jumpFirstBtn').textContent(), '回到首周');
});

test('Saturday blocks total five hours and show real playback, practice budgets and searchable sections', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { mobile: true });
  await planner(f.page);
  const week = await f.page.evaluate(() => DATA.weeks[0]);
  for (const day of ['周一', '周二', '周三', '周四', '周五']) {
    const assignments = week.tasks.filter(task => task.day === day);
    assert.equal(assignments.length, 1, `${day}: no extra weekday project task`);
    const task = assignments[0];
    assert.equal(task.track, 'ls');
    assert.equal(await f.page.locator(`#weekTasks [data-task-id="${task.id}"] .duration-chip`).textContent(), `${task.durationMinutes} 分钟`);
  }
  const saturday = week.tasks.filter(task => task.day === '周六');
  assert.ok(saturday.length >= 2 && saturday.length <= 3);
  assert.equal(saturday.reduce((sum, task) => sum + task.durationMinutes, 0), 300);
  for (const task of saturday) {
    assert.equal(task.track, 'ydy');
    assert.equal(await f.page.locator(`#weekTasks [data-task-id="${task.id}"]`).isVisible(), true);
  }
  const visibleMinutes = await f.page.locator(`#day-${saturday[0].date} .duration-chip`).allTextContents();
  assert.ok(Math.abs(visibleMinutes.reduce((total, text) => total + displayedMinutes(text), 0) - 300) < 0.02, 'The visible Saturday blocks add up to five hours');
  const practice = saturday.find(task => !task.learningSegments?.length && task.budget.practiceMinutes > 0);
  assert.ok(practice, 'Saturday must distinguish implementation practice from course viewing');
  const practiceCard = f.page.locator(`#weekTasks [data-task-id="${practice.id}"]`);
  assert.ok(Math.abs(displayedMinutes(await practiceCard.locator('.duration-chip').textContent()) - practice.durationMinutes) < 0.01, 'The practice block displays its own duration');
  assert.equal(await practiceCard.locator('.task-desc').textContent(), practice.steps[0], 'The card should identify the first concrete action');
  await practiceCard.locator('.task-title').click();
  assert.ok((await f.page.locator('#taskDialog .detail-meta').textContent()).includes(await practiceCard.locator('.duration-chip').textContent()), 'Original practice total remains available in the metadata');
  assert.equal(await f.page.locator('#taskDialog .detail-budget').count(), 0, 'A single practice budget is already in the task metadata');
  assert.equal(await f.page.locator('#taskDialog .segment-row').count(), 0, 'Hands-on practice must not be presented as a new video assignment');
  assert.deepEqual(await f.page.locator('#taskDialog .practice-step-list label > span').allTextContents(), practice.steps);
  assert.deepEqual(await f.page.locator('#taskDialog .detail-deliverables li').allTextContents(), practice.deliverables);
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(id => document.activeElement?.closest('#weekTasks [data-task-id]')?.dataset.taskId === id, practice.id);

  const task = await f.page.evaluate(() => allTasks.find(item => item.learningSegments?.some(segment => segment.startSecond % 60 || segment.endSecond % 60)));
  assert.ok(task, 'The schedule must exercise real video times with second precision');
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

test('continue learning catches up from the first gap, advances after check-in, and resets its source on weekends', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  assert.equal(await f.page.locator('#continueBox .continue-inline-status').count(), 1, 'The next lesson already shown in Today stays compact');
  assert.equal(await f.page.locator('#continueBox [data-continue-today]').count(), 1, 'The compact notice still links to today’s task');
  await f.page.clock.setFixedTime(new Date('2026-10-20T04:00:00Z'));
  await f.page.evaluate(() => render());
  const lsIds = await f.page.evaluate(() => allTasks.filter(task => task.track === 'ls').map(task => task.id));
  assert.equal(await f.page.locator('#continueBox .continue-task').getAttribute('data-task-id'), lsIds[0]);
  assert.match(await f.page.locator('#continueBox .continue-timing').textContent(), /待补/);
  assert.match(await f.page.locator('#continueBox .continue-meta').textContent(), /原计划/);
  await f.page.locator('#continueBox [data-task-action="toggle"]').click();
  await settled(f.page);
  assert.equal(await f.page.locator('#continueBox .continue-task').getAttribute('data-task-id'), lsIds[1]);
  await f.page.evaluate(id => changeTask(id, true, false), lsIds[5]);
  await settled(f.page);
  assert.equal(await f.page.locator('#continueBox .continue-task').getAttribute('data-task-id'), lsIds[1], 'Finishing a later lesson must preserve the earlier gap');
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
    for (const task of allTasks.filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    localRevision++; saveState(); render(); syncToServer({ silent: true });
  });
  await settled(f.page);
  const expectedPractice = await f.page.evaluate(() => allTasks.find(task => task.track === 'ydy' && ['practice', 'deepening'].includes(task.activity) && !taskDone(task.id)));
  assert.equal(await f.page.locator('#continue-track-ydy').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.page.locator('#continueBox .continue-task').getAttribute('data-task-id'), expectedPractice.id);
  assert.match(await f.page.locator('#continueBox .continue-prerequisite').textContent(), /前置任务尚未打卡.*周六先补前置/);
  await f.page.locator('#continueBox [data-task-action="details"]').first().click();
  const prerequisite = await f.page.locator('#taskDialogBody [data-prerequisite-task-id]').first().getAttribute('data-prerequisite-task-id');
  assert.ok(prerequisite, 'Practice links to its prerequisite lesson task');
  await f.page.locator(`#taskDialogBody [data-prerequisite-task-id="${prerequisite}"]`).click();
  await f.page.locator('#plannerView').waitFor({ state: 'visible' });
  assert.equal(await f.page.locator('#plannerView').isVisible(), true);
  assert.equal(await f.page.locator(`#weekTasks [data-task-id="${prerequisite}"]`).isVisible(), true);
  await f.page.waitForFunction(id => document.activeElement?.closest('#weekTasks [data-task-id]')?.dataset.taskId === id, prerequisite);

  await f.page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => phaseForWeek(task.week).id === 'courses')) state.entries[task.id] = createEntry(true, stamp);
    localRevision++; saveState(); render(); syncToServer({ silent: true });
  });
  await settled(f.page);
  await f.page.locator('.nav-item[data-view="overview"]').click();
  const counts = await f.page.evaluate(() => ({ courses: allTasks.filter(task => phaseForWeek(task.week).id === 'courses').length, all: allTasks.length }));
  assert.equal(await f.page.locator('#progressPct').textContent(), '100%');
  assert.equal(await f.page.locator('#doneDays').textContent(), String(counts.courses));
  assert.equal(await f.page.locator('#totalDays').textContent(), String(counts.courses));
  assert.match(await f.page.locator('#overallProgressSummary').textContent(), new RegExp(`全计划 ${counts.courses} / ${counts.all} 项`));
  await f.page.locator('#progress-phase-projects').click();
  assert.equal(await f.page.locator('#progressPct').textContent(), '0%');
  assert.equal(await f.page.locator('#overallProgressSummary').textContent(), `全计划 ${counts.courses} / ${counts.all} 项 · ${Math.round(counts.courses * 100 / counts.all)}%`);
});

test('project acceptance saves independent evidence, survives reload and exports without inflating task progress', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const projectId = await f.page.evaluate(() => DATA.milestones.find(goal => goal.kind === 'project').id);
  await f.page.locator('.nav-item[data-view="milestones"]').click();
  await f.page.locator(`#milestone-review-${projectId}`).click();
  assert.equal(await f.page.locator('#milestoneReviewDialog').isVisible(), true);
  const evidence = '演示地址：https://example.invalid/demo <script>alert(1)</script>';
  await f.page.locator('#milestoneEvidence').fill(evidence);
  await f.page.locator('#milestoneReviewSaveBtn').click();
  await settled(f.page);
  assert.equal(await f.page.locator(`[data-milestone-id="${projectId}"] .goal-status`).textContent(), '已验收');
  assert.equal(await f.page.locator(`[data-milestone-id="${projectId}"] .goal-meter`).getAttribute('aria-valuenow'), '0');
  assert.equal(await f.page.locator(`[data-milestone-id="${projectId}"] .goal-review p`).textContent(), evidence);
  assert.equal(await f.page.locator('script').count(), 2, 'Evidence text must not create an executable script');
  await f.page.reload();
  await f.page.waitForFunction(() => syncState.reachable !== null);
  await settled(f.page);
  assert.equal(await f.page.locator(`[data-milestone-id="${projectId}"] .goal-status`).textContent(), '已验收');
  await f.page.locator(`#milestone-review-${projectId}`).click();
  assert.equal(await f.page.locator('#milestoneEvidence').inputValue(), evidence);
  await f.page.locator('#closeMilestoneReviewBtn').click();
  await f.page.locator('#openSyncBtn').click();
  const [download] = await Promise.all([f.page.waitForEvent('download'), f.page.locator('#exportBtn').click()]);
  const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(backup.version, 3);
  assert.equal(Object.keys(backup.entries).length, f.tasks.length);
  assert.equal(backup.milestoneReviews[projectId].done, true);
  assert.equal(backup.milestoneReviews[projectId].evidence, evidence);
  await f.page.locator('#closeSyncBtn').click();
  await f.page.locator(`#milestone-review-${projectId}`).click();
  await f.page.locator('#milestoneReviewRevokeBtn').click();
  await settled(f.page);
  assert.notEqual(await f.page.locator(`[data-milestone-id="${projectId}"] .goal-status`).textContent(), '已验收');
  assert.equal(await f.page.evaluate(id => state.entries[`milestone:${id}`].done, projectId), false);
});

test('switching to project deepening clears a track filter that has no project tasks', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await planner(f.page);
  await f.page.locator('#trackFilter').selectOption('ls');
  await f.page.locator('#phase-projects').click();
  assert.equal(await f.page.locator('#trackFilter').inputValue(), 'all');
  assert.ok(await f.page.locator('#weekTasks .task-card').count() > 0);
});

test('an open acceptance draft preserves remote updates until the user resolves the conflict', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.page.locator('.nav-item[data-view="milestones"]').click();
  await f.page.locator('#milestone-review-yibo').click();
  await f.page.locator('#milestoneEvidence').fill('本机尚未保存的草稿');
  const remote = { done: true, updatedAt: '2026-10-01T00:00:00.000Z', evidence: '另一设备的构建和演示记录' };
  f.inject('milestone:yibo', remote);
  await f.page.locator('#milestoneReviewSaveBtn').click();
  await f.page.locator('#milestoneReviewConflict').waitFor({ state: 'visible' });
  assert.equal(await f.page.locator('#milestoneEvidence').inputValue(), '本机尚未保存的草稿');
  assert.equal(f.server()['milestone:yibo'].evidence, remote.evidence, 'Saving an older open draft must not overwrite a newer remote record');
  await f.page.locator('#milestoneReviewReloadBtn').click();
  assert.equal(await f.page.locator('#milestoneEvidence').inputValue(), remote.evidence);
  assert.equal(await f.page.locator('#milestoneReviewConflict').count(), 0);

  await f.page.locator('#milestoneEvidence').fill('明确选择保留的草稿');
  f.inject('milestone:yibo', { ...remote, updatedAt: '2026-10-02T00:00:00.000Z', evidence: '另一设备再次更新' });
  await f.page.evaluate(() => syncToServer({ silent: true }));
  await f.page.locator('#milestoneReviewConflict').waitFor({ state: 'visible' });
  await f.page.locator('#milestoneReviewKeepDraftBtn').click();
  await f.page.locator('#milestoneReviewSaveBtn').click();
  await settled(f.page);
  await f.page.locator('#milestoneReviewDialog').waitFor({ state: 'hidden' });
  assert.equal(f.server()['milestone:yibo'].evidence, '明确选择保留的草稿');
});
