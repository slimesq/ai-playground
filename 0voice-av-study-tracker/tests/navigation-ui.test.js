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
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'av-navigation-ui-'));
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

async function planner(page) { await page.locator('.nav-item[data-view="planner"]').click(); }

async function clickVisibleHistory(page, id) {
  await page.waitForFunction(buttonId => !document.getElementById(buttonId)?.disabled, id);
  const rect = await page.locator(`#${id}`).boundingBox();
  assert.ok(rect && rect.y >= 0, `${id} should be visible in the sticky mobile header`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

test('back and forward restore view, week, search filters and scroll; a new jump cuts off forward history', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await planner(page);
  await page.locator('#weekSelect').selectOption('7');
  await page.locator('#trackFilter').selectOption('ls');
  await page.locator('#taskSearch').fill('零声');
  assert.equal(await page.locator('#weekTasks .search-week-group').count() > 5, true);
  await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' }));
  const beforeY = await page.evaluate(() => scrollY);
  assert.ok(beforeY > 400, 'Search results should offer a meaningful scroll position');
  await page.locator('.nav-item[data-view="milestones"]').click();
  assert.equal(await page.locator('#milestonesView').isVisible(), true);
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#plannerView').isVisible(), true);
  assert.equal(await page.locator('#weekSelect').inputValue(), '7');
  assert.equal(await page.locator('#taskSearch').inputValue(), '零声');
  assert.equal(await page.locator('#trackFilter').inputValue(), 'ls');
  await page.waitForFunction(y => Math.abs(scrollY - y) <= 30, beforeY);
  await page.keyboard.press('Alt+ArrowRight');
  assert.equal(await page.locator('#milestonesView').isVisible(), true);
  await page.keyboard.press('Alt+ArrowLeft');
  assert.equal(await page.locator('#taskSearch').inputValue(), '零声');
  await page.locator('#taskSearch').fill('易道云');
  assert.equal(await page.locator('#navigationForwardBtn').isDisabled(), true, 'A new navigation choice replaces the forward branch');
});

test('rapid Back and Forward are processed in order while a location is restoring', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await planner(page);
  await page.locator('#weekSelect').selectOption('7');
  await page.locator('.nav-item[data-view="milestones"]').click();
  const before = await page.evaluate(() => ({ index: positionHistoryIndex, length: positionHistory.length }));
  await page.evaluate(async () => {
    await Promise.all([navigatePositionHistory(-1), navigatePositionHistory(1)]);
  });
  assert.equal(await page.locator('#milestonesView').isVisible(), true, 'The second navigation must not be lost');
  assert.deepEqual(await page.evaluate(() => ({ index: positionHistoryIndex, length: positionHistory.length })), before);
  assert.equal(await page.evaluate(() => locationNavigationBusy || restoringLocation), false);
});

test('queued navigation stops if the restored task receives a new unsaved edit', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await planner(page);
  const id = await page.locator('#weekTasks [data-task-id]').first().getAttribute('data-task-id');
  await page.locator(`#weekTasks [data-task-id="${id}"] .task-title`).click();
  await page.locator('#closeTaskBtn').click();
  await page.locator('#weekSelect').selectOption('8');
  await page.evaluate(async () => {
    const original = window.requestAnimationFrame;
    let edited = false;
    window.requestAnimationFrame = callback => original.call(window, time => {
      if (restoringLocation && $('taskDialog').open && !edited) {
        edited = true;
        const input = $('videoPositionInput');
        input.value = String(Number(input.min) + 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      callback(time);
    });
    try { await Promise.all([navigatePositionHistory(-1), navigatePositionHistory(1)]); }
    finally { window.requestAnimationFrame = original; }
  });
  assert.equal(await page.locator('#taskDialog').isVisible(), true, 'Queued movement must keep the edited task open');
  assert.equal(await page.evaluate(() => detailTaskId), id);
  assert.equal(await page.evaluate(() => detailProgressDirty), true);
  assert.equal(await page.evaluate(() => queuedLocationDirections.length), 0);
  await page.locator('#closeTaskBtn').click();
  assert.equal(await page.locator('#confirmDialog').isVisible(), true, 'The retained draft still requires an explicit discard');
  await page.locator('#confirmCancelBtn').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
});

test('prerequisite navigation returns to its task dialog and exact background search, while a new task opens at the top', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const target = await page.evaluate(() => {
    const task = allTasks.find(item => item.week === 32 && item.prerequisiteTaskIds?.some(id => taskById.get(id)?.week === 31));
    const prerequisiteId = task.prerequisiteTaskIds.find(id => taskById.get(id)?.week === 31);
    return { id: task.id, prerequisiteId, week: task.week };
  });
  await planner(page);
  await page.locator('#weekSelect').selectOption('7');
  await page.locator('#trackFilter').selectOption('ydy');
  await page.locator('#taskSearch').fill('Course Studio');
  const card = page.locator(`#weekTasks [data-task-id="${target.id}"]`);
  await card.scrollIntoViewIfNeeded();
  const beforeY = await page.evaluate(() => scrollY);
  assert.ok(beforeY > 300);
  await card.locator('.task-title').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  await page.locator(`#taskDialogBody [data-prerequisite-task-id="${target.prerequisiteId}"]`).click();
  await page.waitForFunction(() => document.querySelector('#weekSelect')?.value === '31');
  assert.equal(await page.locator('#taskDialog').isVisible(), false);
  assert.equal(await page.locator('#plannerView').isVisible(), true);
  assert.equal(await page.locator('#weekSelect').inputValue(), '31');
  assert.equal(await page.locator(`#weekTasks [data-task-id="${target.prerequisiteId}"]`).isVisible(), true);
  await page.locator('#navigationBackBtn').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  assert.equal(await page.evaluate(() => detailTaskId), target.id);
  assert.equal(await page.locator('#taskSearch').inputValue(), 'Course Studio');
  assert.equal(await page.locator('#trackFilter').inputValue(), 'ydy');
  assert.equal(await page.locator('#weekSelect').inputValue(), '7');
  await page.waitForFunction(y => Math.abs(scrollY - y) <= 30, beforeY);
  await page.locator('#taskHistoryForwardBtn').click();
  await page.waitForFunction(() => document.querySelector('#weekSelect')?.value === '31');
  assert.equal(await page.locator('#taskDialog').isVisible(), false);
  assert.equal(await page.locator('#weekSelect').inputValue(), '31');

  await page.locator(`#weekTasks [data-task-id="${target.prerequisiteId}"] .task-title`).click();
  await page.locator('#taskDialog').evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert.ok(await page.locator('#taskDialog').evaluate(element => element.scrollTop) > 0,
    'The previously opened task must have a real dialog scroll position');
  await page.locator('#closeTaskBtn').click();
  await page.locator(`#weekTasks .task-card:not([data-task-id="${target.prerequisiteId}"]) .task-title`).first().click();
  assert.equal(await page.locator('#taskDialog').evaluate(element => element.scrollTop), 0);
});

test('project acceptance Back and Forward restore the review, while canceling a dirty draft keeps it open', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const projectId = await page.evaluate(() => DATA.milestones.find(goal => goal.kind === 'project').id);
  await page.locator('.nav-item[data-view="milestones"]').click();
  await page.locator(`#milestone-review-${projectId}`).click();
  assert.equal(await page.locator('#milestoneReviewDialog').isVisible(), true);
  await page.locator('#milestoneEvidence').fill('尚未保存的演示地址');
  await page.locator('#reviewHistoryBackBtn').click();
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  await page.locator('#confirmCancelBtn').click();
  assert.equal(await page.locator('#milestoneReviewDialog').isVisible(), true);
  assert.equal(await page.locator('#milestoneEvidence').inputValue(), '尚未保存的演示地址');
  assert.equal(await page.evaluate(id => state.entries[`milestone:${id}`], projectId), undefined);

  await page.locator('#reviewHistoryBackBtn').click();
  await page.locator('#confirmAcceptBtn').click();
  await page.locator('#milestoneReviewDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#milestonesView').isVisible(), true);
  await page.locator('#navigationForwardBtn').click();
  await page.locator('#milestoneReviewDialog').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => reviewMilestoneId), projectId);
  assert.equal(await page.locator('#milestoneEvidence').inputValue(), '');
  assert.equal(await page.evaluate(id => state.entries[`milestone:${id}`], projectId), undefined);
});

test('mobile overview and milestone section jumps have reversible scroll and focus', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, 390);
  assert.equal(await page.locator('#todayProgressSummary [data-overview-jump="progress"]').isVisible(), true);
  await page.locator('#todayProgressSummary [data-overview-jump="progress"]').click();
  const progressY = await page.evaluate(() => scrollY);
  assert.ok(progressY > 200, 'The mobile progress section must be below the first viewport');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'progressHeading');
  await clickVisibleHistory(page, 'navigationBackBtn');
  await page.waitForFunction(() => scrollY <= 30);
  assert.equal(await page.locator('#overviewView').isVisible(), true);
  await clickVisibleHistory(page, 'navigationForwardBtn');
  await page.waitForFunction(y => Math.abs(scrollY - y) <= 30, progressY);
  await page.waitForFunction(() => document.activeElement?.id === 'progressHeading');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'progressHeading');

  await page.locator('.nav-item[data-view="milestones"]').click();
  await page.locator('[data-milestone-anchor="application"]').click();
  const applicationY = await page.evaluate(() => scrollY);
  assert.ok(applicationY > 500, 'The application milestone must require a real mobile scroll');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'applicationMilestone');
  await clickVisibleHistory(page, 'navigationBackBtn');
  await page.waitForFunction(() => scrollY <= 30);
  assert.equal(await page.locator('#milestonesView').isVisible(), true);
  await clickVisibleHistory(page, 'navigationForwardBtn');
  await page.waitForFunction(y => Math.abs(scrollY - y) <= 30, applicationY);
  await page.waitForFunction(() => document.activeElement?.id === 'applicationMilestone');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'applicationMilestone');
});

test('dirty task draft asks before history navigation and cancel keeps the edit in place', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await planner(page);
  const task = await page.evaluate(() => allTasks.find(item => item.track === 'ydy' && item.activity === 'video' && taskLearningSegments(item).length).id);
  await page.locator(`#weekTasks [data-task-id="${task}"] .task-title`).click();
  const input = page.locator('#videoPositionText');
  const changed = await page.evaluate(id => {
    const task = taskById.get(id);
    const segment = taskLearningSegments(task)[0];
    return clockSecond(Math.min(segment.endSecond, segment.startSecond + 10));
  }, task);
  await input.fill(changed);
  await page.locator('#taskHistoryBackBtn').click();
  assert.equal(await page.locator('#confirmDialog').isVisible(), true);
  await page.locator('#confirmCancelBtn').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  assert.equal(await input.inputValue(), changed);
  assert.equal(await page.evaluate(id => state.entries[id]?.progress, task), undefined);
  await page.locator('#taskHistoryBackBtn').click();
  await page.locator('#confirmAcceptBtn').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), false);
  assert.equal(await page.locator('#plannerView').isVisible(), true);
  assert.equal(await page.evaluate(id => state.entries[id]?.progress, task), undefined);
});

test('a completed task returns from a discarded edit in read-only mode', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await planner(page);
  const task = await page.evaluate(() => allTasks.find(item => item.track === 'ydy' && item.activity === 'video' && taskLearningSegments(item).length).id);
  await page.evaluate(id => {
    state.entries[id] = createEntry(true, freshTimestamp());
    localRevision++;
    saveState(); render();
  }, task);
  await page.locator(`#weekTasks [data-task-id="${task}"] .task-title`).click();
  assert.equal(await page.locator('#editTaskProgressBtn').isVisible(), true);
  await page.locator('#editTaskProgressBtn').click();
  const input = page.locator('#videoPositionText');
  await input.fill('00:00:10');
  await page.locator('#taskHistoryBackBtn').click();
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  await page.locator('#confirmAcceptBtn').click();
  await page.locator('#taskDialog').waitFor({ state: 'hidden' });
  await page.locator('#navigationForwardBtn').click();
  await page.locator('#taskDialog').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => detailTaskId), task);
  assert.equal(await page.locator('#videoPositionText').count(), 0);
  assert.equal(await page.locator('#editTaskProgressBtn').isVisible(), true);
  assert.equal(await page.evaluate(() => detailProgressEditing), false);
});

test('an in-flight practice save blocks Back and Escape until the default session is recorded', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(item => item.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    localRevision++;
    saveState(); render();
  });
  await page.locator('#continue-track-ydy').click();
  const record = page.locator('#continueBox [data-progress-action="record-session"]');
  const taskId = await record.locator('xpath=ancestor::*[@data-task-id][1]').getAttribute('data-task-id');
  assert.ok(taskId);
  await record.click();
  assert.equal(await page.locator('#practiceSessionDialog').isVisible(), true);
  const minutes = Number(await page.locator('#practiceSessionInput').inputValue());
  assert.ok(minutes > 0);
  const historyIndex = await page.evaluate(() => positionHistoryIndex);
  let releaseResponse, announceRequest;
  const requestStarted = new Promise(resolve => { announceRequest = resolve; });
  const heldResponse = new Promise(resolve => { releaseResponse = resolve; });
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', async route => {
    announceRequest();
    await heldResponse;
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { state: { entries: body.state.entries }, serverTime: new Date().toISOString() } });
  });
  try {
    await page.locator('#savePracticeSessionBtn').click();
    await requestStarted;
    assert.equal(await page.locator('#practiceSessionDialog').isVisible(), true);
    assert.equal(await page.locator('#closePracticeSessionBtn').isDisabled(), true);
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#practiceSessionDialog').isVisible(), true);
    assert.equal(await page.evaluate(() => positionHistoryIndex), historyIndex);
    assert.equal(await page.evaluate(id => taskProgress(id), taskId), null);
  } finally { releaseResponse(); }
  await page.waitForFunction(([id, expected]) => taskProgress(id)?.workedMinutes === expected, [taskId, minutes]);
  await page.locator('#practiceSessionDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => positionHistoryIndex), historyIndex);
});

test('search names the matching 易道云 lesson, hides week controls, and keeps the original video interval in details', { timeout: 30_000 }, async t => {
  const page = await pageAt(t);
  const match = await page.evaluate(() => {
    const task = allTasks.find(item => item.track === 'ydy' && item.activity === 'video'
      && item.learningSegments?.some(segment => segment.title.includes('项目的创建') && !item.title.includes('项目的创建')));
    const segment = task.learningSegments.find(item => item.title.includes('项目的创建'));
    return { id: task.id, query: '项目的创建', title: segment.title,
      interval: `${clockSecond(segment.startSecond)} – ${clockSecond(segment.endSecond)}`,
      segmentCount: task.learningSegments.length };
  });
  await planner(page);
  await page.locator('#taskSearch').fill(match.query);
  const card = page.locator(`#weekTasks [data-task-id="${match.id}"]`);
  assert.equal(await card.isVisible(), true);
  const marked = await card.locator('.search-match-context mark.search-hit').allTextContents();
  assert.ok(marked.some(text => text.includes(match.query)), 'The result should explain which original lesson matched');
  assert.equal(await page.locator('#planPhaseSwitch').isVisible(), false);
  assert.equal(await page.locator('.week-navigation').isVisible(), false);
  await card.locator('.task-title').click();
  assert.equal(await page.locator('#taskDialog .segment-row').count(), match.segmentCount);
  const rows = await page.locator('#taskDialog .segment-row').allTextContents();
  assert.ok(rows.some(text => text.includes(match.title) && text.includes(match.interval)));
  await page.locator('#closeTaskBtn').click();
  await page.locator('#taskSearch').fill('');
  assert.equal(await page.locator('#planPhaseSwitch').isVisible(), true);
  assert.equal(await page.locator('.week-navigation').isVisible(), true);
});
