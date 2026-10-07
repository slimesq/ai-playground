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
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'av-resume-ui-'));
  const port = await unusedPort();
  baseURL = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], { cwd: project, env: { ...process.env,
    PORT: String(port), DB_PATH: path.join(directory, 'tracker.db'), BACKUP_DIR: path.join(directory, 'backups'), TRACKER_API_KEY: '', NODE_ENV: 'test' }, stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(`${baseURL}/api/health`)).ok) { ready = true; break; } } catch {}
    await delay(60);
  }
  assert.ok(ready, 'Isolated tracker server should start');
  browser = await chromium.launch({
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
    headless: true,
    args: ['--no-sandbox']
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function pageAt(t, instant, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.clock.setFixedTime(new Date(instant));
  await page.route('**/api/config', route => route.fulfill({ json: { authRequired: false } }));
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { state: { entries: body.state.entries }, serverTime: new Date().toISOString() } });
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy);
  return page;
}

test('weekday project work records actual minutes and cancellation without completing the original Saturday task', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-07T04:00:00Z', 320);
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  const taskId = 'av59-sat5-v1-w01-practice';
  assert.equal(await page.locator('#continueBox .continue-task').getAttribute('data-task-id'), taskId);
  assert.match(await page.locator('#continueBox .continue-prerequisite').textContent(), /先.*前置|前置.*先|补.*前置/,
    'With no ready course practice, keep the earliest one visible and explain that its missing video should be learned first');
  assert.equal(await page.locator('#continueBox .continue-session-badge').count(), 0);
  assert.match(await page.locator('#continueBox .continue-meta').textContent(), /2026年10月10日.*原任务总量 2 小时 22 分钟 44 秒/);
  assert.match(await page.locator('#continueBox [data-progress-action="record-session"]').textContent(), /记录本次 40 分钟/);
  await page.locator('#continue-track-ydy').click();
  assert.equal(await page.locator('#continueBox .continue-task').getAttribute('data-task-id'), taskId, 'Clicking the selected source must not switch to the video');
  await page.locator('#continueBox [data-progress-action="record-session"]').click();
  assert.equal(await page.locator('#practiceSessionDialog').isVisible(), true);
  assert.equal(await page.locator('#practiceSessionInput').inputValue(), '40');
  await page.locator('#practiceSessionInput').fill('10');
  await page.locator('#cancelPracticeSessionBtn').click();
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  await page.locator('#confirmAcceptBtn').click();
  assert.equal(await page.locator('#practiceSessionDialog').isVisible(), false);
  assert.equal(await page.evaluate(id => taskProgress(id), taskId), null);
  for (const [actual, expected] of [[20, 20], [40, 60], [40, 100], [40, 140]]) {
    await page.locator('#continueBox [data-progress-action="record-session"]').click();
    await page.locator('#practiceSessionInput').fill(String(actual));
    await page.locator('#savePracticeSessionBtn').click();
    await page.waitForFunction(([id, minutes]) => taskProgress(id)?.workedMinutes === minutes, [taskId, expected]);
    assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, taskId), expected);
    assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  }
  assert.match(await page.locator('#continueBox [data-progress-action="record-session"]').textContent(), /记录本次 3 分钟/);
  await page.locator('#continueBox [data-progress-action="record-session"]').click();
  assert.equal(await page.locator('#practiceSessionInput').inputValue(), '3');
  await page.locator('#practiceSessionInput').fill('25');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 165, taskId);
  assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, taskId), 165);
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false, 'Logged time cannot auto-check the whole task');
  assert.equal(await page.locator('#continueBox [data-progress-action="record-session"]').count(), 1, 'A used-up planned budget cannot block further actual-time records');
  const verifyButton = page.locator('#continueBox [data-task-action="details"]');
  assert.match(await verifyButton.textContent(), /核对成果/);
  assert.equal(await page.locator('#continueBox [data-task-action="toggle"]').count(), 0, 'The continue shortcut must not mark the task complete');
  await verifyButton.click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  assert.equal(await page.locator('#taskDialog .detail-deliverables').evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight;
  }), true, 'Reviewing outputs opens their delivery checklist directly');
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  await page.locator('#closeTaskBtn').click();
  await page.locator('#continueBox [data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('10');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 175, taskId);
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  await page.reload();
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy);
  assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, taskId), 175);
  assert.match(await page.locator('#continueBox .continue-session-note').textContent(), /已累计.*2 小时 55 分钟/);
  assert.equal(await page.locator('#continueBox [data-progress-action="record-session"]').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '320px layout must not overflow');
});

test('weekday practice prefers a ready later course task while Saturday still follows the original video order', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-07T04:00:00Z');
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    state.entries['av59-sat5-v1-w02-watch'] = createEntry(true, stamp);
    saveState(); render();
  });
  assert.equal(await page.evaluate(id => taskDone(id), 'av59-sat5-v1-w01-watch'), false);
  assert.equal(await page.locator('#continueBox .continue-task').getAttribute('data-task-id'), 'av59-sat5-v1-w02-practice',
    'A watched week 2 should be usable before an unwatched week 1 without jumping into the later deepening phase');
  assert.equal(await page.locator('#continueBox .continue-prerequisite').count(), 0);
  assert.match(await page.locator('#continueBox .continue-timing').textContent(), /可提前/);
  await page.clock.setFixedTime(new Date('2026-10-17T04:00:00Z'));
  await page.evaluate(() => render());
  assert.equal(await page.locator('#continueBox .continue-task').getAttribute('data-task-id'), 'av59-sat5-v1-w01-watch',
    'Weekend study still offers the earliest unfinished video in normal order');
});

test('an open practice session saves to its original task after sync recommends a different ready practice', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-07T04:00:00Z');
  const firstPractice = 'av59-sat5-v1-w01-practice';
  const secondWatch = 'av59-sat5-v1-w02-watch';
  const secondPractice = 'av59-sat5-v1-w02-practice';
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  await page.waitForFunction(() => !activeSyncPromise && !syncState.busy);
  assert.equal(await page.locator('#continueBox .continue-task').getAttribute('data-task-id'), firstPractice);
  await page.locator('#continueBox [data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('35');
  assert.equal(await page.evaluate(() => practiceSessionTaskId), firstPractice);

  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { state: { entries: { ...body.state.entries,
      [secondWatch]: { done: true, updatedAt: '2030-01-01T00:00:00.000Z' } } }, serverTime: new Date().toISOString() } });
  });
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(([first, watch]) => taskProgress(first)?.workedMinutes === 35 && taskDone(watch), [firstPractice, secondWatch]);
  await page.locator('#practiceSessionDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#continueBox .continue-task').getAttribute('data-task-id'), secondPractice);
  assert.equal(await page.evaluate(id => taskProgress(id), secondPractice), null, 'The open W1 draft must not be written onto newly recommended W2');
  assert.equal(await page.evaluate(id => taskDone(id), firstPractice), false);
  assert.equal(await page.evaluate(id => taskDone(id), secondPractice), false);
});

test('weekday videos and course catch-up stay in Saturday reminders with links to their original weeks', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2027-05-12T04:00:00Z');
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls'
      || task.track === 'ydy' && task.activity !== 'video' && !(task.activity === 'buffer' && phaseForWeek(task.week).id === 'courses'))) {
      state.entries[task.id] = createEntry(true, stamp);
    }
    saveState(); render();
  });
  assert.equal(await page.locator('#continue-track-ydy').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#continueBox .continue-task').count(), 0, 'Weekday project time must not automatically become an unwatched video assignment');
  assert.match(await page.locator('#continueBox').textContent(), /周六/);
  const courseWeekEntry = page.locator('#continueBox [data-week="1"][data-track="ydy"]');
  assert.equal(await courseWeekEntry.count(), 1, 'The reminder should link to the original week for manual video review');
  await courseWeekEntry.click();
  assert.equal(await page.locator('#plannerView').isVisible(), true);
  assert.equal(await page.locator('#weekSelect').inputValue(), '1');
  assert.equal(await page.locator('#weekTasks [data-task-id="av59-sat5-v1-w01-watch"]').count(), 1);
  assert.equal(await page.evaluate(() => taskDone('av59-sat5-v1-w01-watch')), false);
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ydy' && task.activity === 'video')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); activateView('overview');
  });
  assert.equal(await page.locator('#continueBox .continue-task').count(), 0, 'Course catch-up buffers also remain Saturday work');
  assert.match(await page.locator('#continueBox').textContent(), /周六/);
  assert.equal(await page.locator('#continueBox [data-week="34"][data-track="ydy"]').count(), 1);
});

test('project session adds actual input to newer remote progress without losing its notes or steps', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-07T04:00:00Z');
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  const taskId = 'av59-sat5-v1-w01-practice';
  assert.equal(await page.locator('#continueBox .continue-task').getAttribute('data-task-id'), taskId);
  let remoteRecord = { done: false, updatedAt: '2030-01-01T00:00:00.000Z',
    progress: { kind: 'practice', workedMinutes: 120, completedSteps: [0], note: '远端已做' } };
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    const submitted = body.state.entries[taskId];
    if (submitted?.updatedAt > remoteRecord.updatedAt) remoteRecord = submitted;
    return route.fulfill({ json: { state: { entries: { ...body.state.entries, [taskId]: remoteRecord } }, serverTime: new Date().toISOString() } });
  });
  await page.locator('#continueBox [data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('40');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 160, taskId);
  await page.locator('#practiceSessionDialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(id => taskProgress(id), taskId),
    { kind: 'practice', workedMinutes: 160, completedSteps: [0], note: '远端已做' });
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  assert.equal(await page.locator('#continueBox [data-progress-action="record-session"]').count(), 1);
});

test('a remote total near the storage ceiling keeps an overflowing draft for correction', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-07T04:00:00Z');
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  const taskId = 'av59-sat5-v1-w01-practice';
  let remoteRecord = { done: false, updatedAt: '2030-01-01T00:00:00.000Z',
    progress: { kind: 'practice', workedMinutes: 99990, completedSteps: [0], note: '远端极限记录' } };
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    const submitted = body.state.entries[taskId];
    if (submitted?.updatedAt > remoteRecord.updatedAt) remoteRecord = submitted;
    return route.fulfill({ json: { state: { entries: { ...body.state.entries, [taskId]: remoteRecord } }, serverTime: new Date().toISOString() } });
  });
  await page.locator('#continueBox [data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('20');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 99990, taskId);
  await page.waitForFunction(() => !document.getElementById('savePracticeSessionBtn').disabled);
  assert.equal(await page.locator('#practiceSessionDialog').isVisible(), true);
  assert.equal(await page.locator('#practiceSessionInput').inputValue(), '20', 'Overflow must not discard the typed actual minutes');
  assert.match(await page.locator('#practiceSessionHint').textContent(), /100000|10\s*分钟|调整/);
  await page.locator('#practiceSessionInput').fill('10');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 100000, taskId);
  assert.deepEqual(await page.evaluate(id => taskProgress(id), taskId),
    { kind: 'practice', workedMinutes: 100000, completedSteps: [0], note: '远端极限记录' });
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
});

test('Saturday practice recommends its remaining plan but accepts a larger integer actual time', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-10T04:00:00Z');
  const taskId = 'av59-sat5-v1-w01-practice';
  await page.evaluate(id => openTaskDetails(id), taskId);
  assert.match(await page.locator('#practiceSessionLimitHint').textContent(), /2 小时 23 分钟/, 'The Saturday suggestion uses the remaining planned task time, below 300 minutes');
  await page.locator('#practiceSessionMinutes').fill('1.5');
  await page.locator('[data-progress-action="save-practice"]').click();
  assert.equal(await page.evaluate(id => taskProgress(id), taskId), null, 'Fractional actual minutes must not be stored');
  await page.locator('#practiceSessionMinutes').fill('300');
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 300, taskId);
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false, 'Exceeding the task budget does not complete its deliverables');
});

test('video playback position is absolute and a dirty draft survives remote refresh until explicit resolution', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-05T04:00:00Z');
  const target = await page.evaluate(() => {
    const task = allTasks.find(item => item.activity === 'video' && taskLearningSegments(item).length > 1);
    const segment = taskLearningSegments(task)[1];
    return { id: task.id, position: Math.min(segment.endSecond, segment.startSecond + 73), remote: Math.min(segment.endSecond, segment.startSecond + 90) };
  });
  await page.evaluate(id => openTaskDetails(id), target.id);
  await page.locator('#videoSegmentSelect').selectOption('1');
  const positionLabel = await page.evaluate(position => clockSecond(position), target.position);
  await page.locator('#videoPositionText').fill(positionLabel);
  await page.locator('[data-progress-action="save-video"]').click();
  await page.waitForFunction(id => taskProgress(id)?.segmentIndex === 1, target.id);
  assert.deepEqual(await page.evaluate(id => taskProgress(id), target.id), { kind: 'video', segmentIndex: 1, positionSecond: target.position });
  assert.equal(await page.evaluate(id => taskDone(id), target.id), false);
  await page.locator('#closeTaskBtn').click();
  await page.reload();
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy);
  await page.evaluate(id => openTaskDetails(id), target.id);
  assert.equal(await page.locator('#videoSegmentSelect').inputValue(), '1');
  assert.equal(await page.locator('#videoPositionText').inputValue(), positionLabel);
  await page.locator('#videoPositionText').fill(await page.evaluate(position => clockSecond(position), target.position + 5));
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { state: { entries: { ...body.state.entries,
      [target.id]: { done: false, updatedAt: '2030-01-01T00:00:00.000Z', progress: { kind: 'video', segmentIndex: 1, positionSecond: target.remote } } } }, serverTime: new Date().toISOString() } });
  });
  await page.locator('[data-progress-action="save-video"]').click();
  await page.locator('#taskProgressConflict').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#videoPositionText').inputValue(), await page.evaluate(position => clockSecond(position), target.position + 5), 'Draft must remain visible');
  assert.equal(await page.evaluate(id => taskProgress(id).positionSecond, target.id), target.remote, 'Ordinary save cannot silently overwrite remote progress');
  await page.locator('[data-progress-action="reload"]').click();
  assert.equal(await page.locator('#videoPositionText').inputValue(), await page.evaluate(position => clockSecond(position), target.remote));
  await page.locator('#videoPositionText').fill(await page.evaluate(position => clockSecond(position), target.remote + 1));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#confirmDialog').isVisible(), true, 'Escape asks before discarding actual edits');
  await page.locator('#confirmCancelBtn').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  await page.locator('#closeTaskBtn').click();
  await page.locator('#confirmAcceptBtn').click();
  assert.equal(await page.locator('#taskDialog').isVisible(), false);
});

test('a completed video shows its saved stop read-only until edited, then preserves the check-in', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-05T04:00:00Z');
  const target = await page.evaluate(() => {
    const task = allTasks.find(item => item.activity === 'video' && taskLearningSegments(item).length > 1);
    const segment = taskLearningSegments(task)[1];
    const position = Math.min(segment.endSecond - 1, segment.startSecond + 73);
    const id = task.id;
    state.entries[id] = createEntry(true, freshTimestamp(), undefined,
      { kind: 'video', segmentIndex: 1, positionSecond: position });
    localRevision++; saveState(); render(); openTaskDetails(id);
    return { id, position, nextPosition: position + 1, label: clockSecond(position), nextLabel: clockSecond(position + 1) };
  });
  assert.equal(await page.locator('#taskDialog .progress-readonly').count(), 1);
  assert.equal(await page.locator('#taskDialog [data-progress-kind], #taskDialog input, #taskDialog select, #taskDialog textarea').count(), 0);
  assert.ok((await page.locator('#taskDialog .progress-readonly-value').textContent()).includes(target.label));
  await page.locator('#editTaskProgressBtn').focus();
  await page.evaluate(() => render());
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'editTaskProgressBtn', 'Background refresh must retain the edit control’s keyboard focus');
  await page.locator('#taskDialog [data-progress-action="edit"]').click();
  assert.equal(await page.locator('#taskDialog [data-progress-kind="video"]').count(), 1);
  assert.equal(await page.locator('[data-progress-action="save-video"]').isDisabled(), true);
  await page.locator('[data-progress-action="cancel-edit"]').click();
  assert.equal(await page.locator('#taskDialog .progress-readonly').count(), 1, 'Unchanged editing can collapse without leaving the task');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'editTaskProgressBtn', 'Focus returns to the edit control after collapsing');
  await page.locator('#taskDialog [data-progress-action="edit"]').click();
  assert.equal(await page.locator('#videoSegmentSelect').inputValue(), '1');
  assert.equal(await page.locator('#videoPositionText').inputValue(), target.label);
  await page.locator('#videoPositionText').fill(target.nextLabel);
  assert.equal(await page.locator('[data-progress-action="save-video"]').isEnabled(), true);
  await page.locator('[data-progress-action="cancel-edit"]').click();
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  await page.locator('#confirmCancelBtn').click();
  assert.equal(await page.locator('#videoPositionText').inputValue(), target.nextLabel, 'Declining discard keeps the draft');
  await page.locator('[data-progress-action="cancel-edit"]').click();
  await page.locator('#confirmAcceptBtn').click();
  assert.equal(await page.locator('#taskDialog .progress-readonly').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'editTaskProgressBtn', 'Discarding a draft restores the read-only edit control');
  await page.locator('#taskDialog [data-progress-action="edit"]').click();
  await page.locator('#videoPositionText').fill(target.nextLabel);
  await page.locator('[data-progress-action="save-video"]').click();
  await page.waitForFunction(([id, position]) => taskProgress(id)?.positionSecond === position, [target.id, target.nextPosition]);
  await page.locator('#taskDialog .progress-readonly').waitFor();
  assert.equal(await page.locator('#taskDialog [data-progress-kind]').count(), 0);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), true);
  await page.waitForFunction(() => !activeSyncPromise && !syncState.busy);
  await page.reload();
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy);
  await page.evaluate(id => openTaskDetails(id), target.id);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), true);
  assert.ok((await page.locator('#taskDialog .progress-readonly-value').textContent()).includes(target.nextLabel));
});

test('a completed practice keeps every step visible while a later edit accumulates time without removing completion', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2026-10-05T04:00:00Z');
  const target = await page.evaluate(() => {
    const task = allTasks.find(item => item.track === 'ydy' && item.activity === 'practice' && item.steps?.length >= 2);
    state.entries[task.id] = createEntry(true, freshTimestamp(), undefined,
      { kind: 'practice', workedMinutes: 40, completedSteps: [0], note: '首次验证通过' });
    localRevision++; saveState(); render(); openTaskDetails(task.id);
    return { id: task.id, steps: task.steps };
  });
  assert.equal(await page.locator('#taskDialog .progress-readonly').count(), 1);
  assert.equal(await page.locator('#taskDialog [data-progress-kind], #taskDialog input, #taskDialog select, #taskDialog textarea').count(), 0);
  assert.match(await page.locator('#taskDialog .progress-readonly-value').textContent(), /40 分钟/);
  assert.deepEqual(await page.locator('#taskDialog .progress-readonly-steps li > span:last-child').allTextContents(), target.steps);
  assert.deepEqual(await page.locator('#taskDialog .progress-readonly-steps .progress-step-status').allTextContents(), ['已记录', ...target.steps.slice(1).map(() => '未记录')]);
  await page.locator('#taskDialog [data-progress-action="edit"]').click();
  assert.equal(await page.locator('#taskDialog [data-progress-kind="practice"]').count(), 1);
  assert.equal(await page.locator('[data-progress-action="save-practice"]').isDisabled(), true);
  assert.equal(await page.locator('#taskDialog [data-progress-step="0"]').isChecked(), true);
  await page.locator('#practiceWorkedTotal').fill('30');
  await page.locator('#practiceSessionMinutes').fill('20');
  await page.locator('#taskDialog [data-progress-step="1"]').check();
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 50, target.id);
  await page.locator('#taskDialog .progress-readonly').waitFor();
  assert.deepEqual(await page.evaluate(id => taskProgress(id).completedSteps, target.id), [0, 1]);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), true);
  assert.equal(await page.locator('#taskDialog .progress-readonly-steps li.is-recorded').count(), 2);
  await page.waitForFunction(() => !activeSyncPromise && !syncState.busy);
  await page.reload();
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy);
  await page.evaluate(id => openTaskDetails(id), target.id);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), true);
  assert.match(await page.locator('#taskDialog .progress-readonly-value').textContent(), /50 分钟/);
  assert.equal(await page.locator('#taskDialog .progress-readonly-steps li.is-recorded').count(), 2);
  await page.evaluate(id => {
    state.entries[id] = createEntry(true, freshTimestamp());
    localRevision++; saveState(); render();
  }, target.id);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), true);
  assert.match(await page.locator('#taskDialog .progress-readonly-value').textContent(), /未保存分次记录/);
  assert.equal(await page.locator('#taskDialog .progress-step-status').count(), 0, 'An absent partial record must not imply unfinished steps');
  assert.deepEqual(await page.locator('#taskDialog .progress-readonly-steps li > span:last-child').allTextContents(), target.steps, 'Task steps remain available even without a partial record');
});

test('after the plan ends, old lessons appear as dated backlog instead of today assignments', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, '2027-10-11T04:00:00Z');
  assert.equal(await page.locator('#todayBox [data-task-id]').count(), 0);
  assert.match(await page.locator('#todayBox .focus-title').textContent(), /今天没有固定任务/);
  assert.equal(await page.locator('#continueBox .continue-timing').textContent(), '待补');
  assert.match(await page.locator('#continueBox .continue-meta').textContent(), /原计划 2026年10月5日/);
});
