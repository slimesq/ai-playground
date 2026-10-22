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
const planData = JSON.parse(require('node:fs').readFileSync(path.join(project, 'study-tracker.html'), 'utf8')
  .match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
const recommendation = page => page.locator('#continueBox .continue-task, body:not(:has(#continueBox .continue-task)) #todayBox .task-card[data-task-id]').first();
const planTasks = planData.weeks.flatMap(week => week.tasks);
const dateOffset = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const instantAt = date => `${date}T04:00:00Z`;
const initialWeekday = dateOffset(planData.weeks[0].start, 2);
const firstYiboModule = planTasks.find(task => task.projectId === 'yibo' && task.activity === 'practice');
const coreHandoff = planTasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
const projectWeekday = coreHandoff.workSessions.find(session => { const day = new Date(session.date).getUTCDay(); return day >= 1 && day <= 5; }).date;
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
    args: ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer']
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
  page.setDefaultNavigationTimeout(60_000);
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

test('Today and Continue finish Yibo before Cloud Teaching despite calendar drift or a prematurely completed final gate', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(planData.weeks[0].end), 320);
  const target = await page.evaluate(() => {
    const stamp = freshTimestamp();
    const video = allTasks.find(task => task.projectId === 'yibo' && task.activity === 'video');
    const practice = allTasks.find(task => task.projectId === 'yibo' && task.activity === 'practice');
    for (const task of allTasks.filter(task => task.id !== video.id && task.id !== practice.id
      && !(task.track === 'ydy' && task.projectId !== 'yibo' && task.activity !== 'video'))) {
      state.entries[task.id] = createEntry(true, stamp);
    }
    saveState();
    const weekday = allTasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff').workSessions
      .find(session => { const day = new Date(session.date).getUTCDay(); return day >= 1 && day <= 5; });
    return { video: video.id, practice: practice.id, originalDate: formatDate(video.date, true),
      cloudDate: allTasks.find(task => task.projectId === 'yunzhujiao').date, weekday: weekday.date };
  });
  await page.clock.setFixedTime(new Date(`${target.cloudDate}T04:00:00Z`));
  await page.evaluate(() => render());
  const todayTasks = await page.locator('#todayBox [data-task-id]').evaluateAll(nodes => nodes.map(node => node.dataset.taskId));
  assert.deepEqual(todayTasks, [target.video, target.practice], 'Cloud calendar dates must show remaining Yibo work instead');
  assert.match(await page.locator('#todayHint').textContent(), /先完成易播，再进入云助教/);
  assert.match(await page.locator('#pageSubtitle').textContent(), /工作日项目练习.*周六继续易播课程与项目/);
  assert.doesNotMatch(await page.locator('#pageSubtitle').textContent(), /周六易道云视频 4 小时/,
    'The header must not mix the blocked Cloud calendar workload into resumed Yibo work');
  assert.ok((await page.locator('#todayHint').textContent()).includes(target.originalDate), 'Resumed work shows its original date');
  assert.doesNotMatch(await page.locator('#todayHint').textContent(), /今日合计/);
  assert.equal(await page.locator('#continueBox [data-continue-today]').getAttribute('data-continue-today'), target.video,
    'Weekend Continue points to the same active-project work rather than a later ready project');

  await page.clock.setFixedTime(new Date(instantAt(initialWeekday)));
  await page.evaluate(() => render());
  assert.equal(await recommendation(page).getAttribute('data-task-id'), target.practice,
    'Weekday Continue resumes Yibo practice without jumping to Cloud Teaching');

  await page.evaluate(id => { state.entries[id] = createEntry(true, freshTimestamp()); saveState(); }, target.practice);
  await page.clock.setFixedTime(new Date(`${target.weekday}T04:00:00Z`));
  await page.evaluate(() => render());
  assert.match(await page.locator('#todayBox').textContent(), /待补课程留到周六/);
  assert.match(await page.locator('#todayHint').textContent(), /先完成易播，再进入云助教/,
    'Even on a Studio calendar date, the notice preserves the intermediate Cloud Teaching project');
  assert.equal(await page.locator('#todayBox [data-task-id]').count(), 0, 'Earlier videos remain Saturday work');
  assert.match(await page.locator('#continueBox').textContent(), /待补课程留到周六/);
  assert.equal(await page.locator('#continueBox .continue-task').count(), 0,
    'An unfinished earlier video cannot expose a later project as the next practice');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await page.evaluate(id => { state.entries[id] = createEntry(true, freshTimestamp()); saveState(); render(); }, target.video);
  assert.equal(await page.evaluate(() => activeProjectLearningGroup()), 'yunzhujiao');
  assert.ok(await page.locator('#todayBox [data-task-id]').count(), 'Completing every Yibo task opens Cloud Teaching practice');
  assert.equal(await page.locator('#todayBox [data-task-id]').first().evaluate(node => projectLearningGroup(taskById.get(node.dataset.taskId))), 'yunzhujiao');
});

test('weekday project work records actual minutes and cancellation without completing the original Saturday task', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(initialWeekday), 320);
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  const taskId = 'edoyun-module-v1-yibo-environment-ipc';
  assert.equal(await recommendation(page).getAttribute('data-task-id'), taskId);
  assert.match(await recommendation(page).locator('.continue-prerequisite').textContent(), /先.*前置|前置.*先|补.*前置/,
    'With no ready course practice, keep the earliest one visible and explain that its missing video should be learned first');
  assert.equal(await page.locator('#continueBox .continue-session-badge').count(), 0);
  assert.ok((await page.locator('#todayHint').textContent()).includes(await page.evaluate(id => taskPlanDateLabel(taskById.get(id)), taskId)));
  assert.match(await recommendation(page).locator('.duration-chip, .continue-meta').textContent(), /本次 40 分钟.*模块预计总 2 小时/);
  assert.match(await recommendation(page).locator('[data-progress-action="record-session"]').textContent(), /记录本次 40 分钟/);
  await page.locator('#continue-track-ydy').click();
  assert.equal(await recommendation(page).getAttribute('data-task-id'), taskId, 'Clicking the selected source must not switch to the video');
  await recommendation(page).locator('[data-progress-action="record-session"]').click();
  assert.equal(await page.locator('#practiceSessionDialog').isVisible(), true);
  assert.equal(await page.locator('#practiceSessionInput').inputValue(), '40');
  await page.locator('#practiceSessionInput').fill('10');
  await page.locator('#cancelPracticeSessionBtn').click();
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  await page.locator('#confirmAcceptBtn').click();
  assert.equal(await page.locator('#practiceSessionDialog').isVisible(), false);
  assert.equal(await page.evaluate(id => taskProgress(id), taskId), null);
  for (const [actual, expected] of [[20, 20], [40, 60], [40, 100]]) {
    await recommendation(page).locator('[data-progress-action="record-session"]').click();
    await page.locator('#practiceSessionInput').fill(String(actual));
    await page.locator('#savePracticeSessionBtn').click();
    await page.waitForFunction(([id, minutes]) => taskProgress(id)?.workedMinutes === minutes, [taskId, expected]);
    assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, taskId), expected);
    assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  }
  assert.match(await recommendation(page).locator('[data-progress-action="record-session"]').textContent(), /记录本次 20 分钟/);
  await recommendation(page).locator('[data-progress-action="record-session"]').click();
  assert.equal(await page.locator('#practiceSessionInput').inputValue(), '20');
  await page.locator('#practiceSessionInput').fill('25');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 125, taskId);
  assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, taskId), 125);
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false, 'Logged time cannot auto-check the whole task');
  assert.equal(await recommendation(page).locator('[data-progress-action="record-session"]').count(), 1, 'A used-up planned budget cannot block further actual-time records');
  const verifyButton = recommendation(page).locator('[data-task-action="details"][data-detail-section="deliverables"], .continue-actions [data-task-action="details"]');
  assert.match(await verifyButton.textContent(), /核对成果/);
  assert.equal(await recommendation(page).locator('[data-task-action="toggle"]').count(), 0, 'The continue shortcut must not mark the task complete');
  await verifyButton.click();
  assert.equal(await page.locator('#taskDialog').isVisible(), true);
  assert.equal(await page.locator('#taskDialog .detail-deliverables').evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight;
  }), true, 'Reviewing outputs opens their delivery checklist directly');
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  await page.locator('#closeTaskBtn').click();
  await recommendation(page).locator('[data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('10');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 135, taskId);
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  await page.reload();
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy);
  assert.equal(await page.evaluate(id => taskProgress(id).workedMinutes, taskId), 135);
  assert.match(await recommendation(page).locator('.continue-session-note, .task-progress-note').textContent(), /已(?:累计|投入).*2 小时 15 分钟/);
  assert.equal(await recommendation(page).locator('[data-progress-action="record-session"]').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '320px layout must not overflow');
});

test('weekday practice follows completed prerequisites while Saturday still offers the earliest unfinished video', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(initialWeekday));
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    const later = taskById.get('edoyun-module-v1-yibo-logging');
    for (const prerequisite of unfinishedPrerequisites(later)) state.entries[prerequisite.id] = createEntry(true, stamp);
    saveState(); render();
  });
  assert.equal(await page.evaluate(id => taskDone(id), 'ydy5h-v1-w01-yibo'), true);
  assert.equal(await recommendation(page).getAttribute('data-task-id'), 'edoyun-module-v1-yibo-logging',
    'The later practice is ready after the complete prerequisite chain has been checked in');
  assert.equal(await recommendation(page).locator('.continue-prerequisite').count(), 0);
  assert.equal(await page.evaluate(() => taskById.get('edoyun-module-v1-yibo-logging').date > todayISO()), true);
  await page.evaluate(() => {
    // Isolate the weekend video case after completing the available module work.
    for (const task of requiredLearningTasks().filter(task => task.projectId === 'yibo' && task.activity !== 'video')) {
      state.entries[task.id] = createEntry(true, freshTimestamp());
    }
    saveState();
  });
  await page.clock.setFixedTime(new Date(instantAt(dateOffset(firstYiboModule.date, 7))));
  await page.evaluate(() => render());
  const nextVideo = await page.evaluate(() => allTasks.find(task => task.track === 'ydy' && task.activity === 'video' && !taskDone(task.id)).id);
  assert.equal(await recommendation(page).getAttribute('data-task-id'), nextVideo,
    'Weekend study still offers the earliest unfinished video in normal order');
});

test('a remotely completed practice keeps its open session draft without saving it onto the next recommendation', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(initialWeekday));
  const firstPractice = 'edoyun-module-v1-yibo-environment-ipc';
  const secondWatch = 'ydy5h-v1-w02-yibo';
  const laterPrerequisites = await page.evaluate(() => unfinishedPrerequisites(taskById.get('edoyun-module-v1-yibo-logging')).map(task => task.id));
  const laterPractice = 'edoyun-module-v1-yibo-logging';
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  await page.waitForFunction(() => !activeSyncPromise && !syncState.busy);
  assert.equal(await recommendation(page).getAttribute('data-task-id'), firstPractice);
  await recommendation(page).locator('[data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('35');
  assert.equal(await page.evaluate(() => practiceSessionTaskId), firstPractice);

  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { state: { entries: { ...body.state.entries,
      ...Object.fromEntries(laterPrerequisites.map(id => [id, { ...body.state.entries[id], done: true, updatedAt: '2030-01-01T00:00:00.000Z' }])) } }, serverTime: new Date().toISOString() } });
  });
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(([first, watch]) => taskDone(first) && taskDone(watch), [firstPractice, secondWatch]);
  await page.waitForFunction(() => !document.getElementById('savePracticeSessionBtn').disabled);
  assert.equal(await page.locator('#practiceSessionDialog').isVisible(), true);
  assert.equal(await page.locator('#practiceSessionInput').inputValue(), '35', 'A changed recommendation must preserve the unsaved draft');
  assert.match(await page.locator('#practiceSessionHint').textContent(), /安排已更新.*尚未丢失/);
  assert.equal(await recommendation(page).getAttribute('data-task-id'), laterPractice);
  assert.equal(await page.evaluate(id => taskProgress(id), laterPractice), null, 'The open W1 draft must not be written onto newly recommended W3');
  assert.equal(await page.evaluate(id => taskProgress(id), firstPractice), null, 'A completed task must not silently receive the unsaved minutes');
  assert.equal(await page.evaluate(id => taskDone(id), firstPractice), true, 'The remote completion remains authoritative');
  assert.equal(await page.evaluate(id => taskDone(id), laterPractice), false);
});

test('weekday unwatched videos stay in Saturday reminders with links to their original weeks', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(planData.planRhythm.weekdayTransitionDate));
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredTasks().filter(task => task.track === 'ls'
      || task.track === 'ydy' && task.activity !== 'video')) {
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
  assert.equal(await page.locator('#weekTasks [data-task-id="ydy5h-v1-w01-yibo"]').count(), 1);
  assert.equal(await page.evaluate(() => taskDone('ydy5h-v1-w01-yibo')), false);
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ydy' && task.activity === 'video')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); activateView('overview');
  });
  assert.equal(await page.locator('#continueBox .continue-task').count(), 0);
  assert.equal(await page.locator('#continue-track-review').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#todayBox .track.review').count(), 1, 'Finishing every learning task opens unified career preparation');
});

test('weekday recommendations finish the original course handoff then enter career directly', { timeout: 90_000 }, async t => {
  const page = await pageAt(t, instantAt(projectWeekday));
  const target = await page.evaluate(() => {
    const handoff = allTasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.id !== handoff.id
      && (task.track === 'ls' || phaseForWeek(task.week).id === 'courses'))) {
      state.entries[task.id] = createEntry(true, stamp);
    }
    saveState(); render();
    return { handoff: handoff.id, career: DATA.careerWorkflow.projectPreparationTaskIds[0],
      steps: handoff.steps, deliverables: handoff.deliverables };
  });
  assert.equal(await page.locator('#continue-track-ydy').getAttribute('aria-pressed'), 'true');
  assert.equal(await recommendation(page).getAttribute('data-task-id'), target.handoff);
  assert.equal(await page.locator('#continueBox [data-continue-today]').getAttribute('data-continue-today'), target.handoff);
  assert.equal(await recommendation(page).locator('.continue-prerequisite').count(), 0);
  assert.match(await recommendation(page).locator('[data-progress-action="record-session"]').textContent(), /40 分钟/);
  assert.equal(await recommendation(page).locator('[data-task-action="toggle"]').count(), 0,
    'The whole-course self-test is one module with multiple sessions, so the primary shortcut cannot complete it');
  await recommendation(page).locator('[data-progress-action="record-session"]').click();
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 40, target.handoff);
  assert.equal(await page.evaluate(id => taskDone(id), target.handoff), false);
  await recommendation(page).locator('[data-task-action="details"][data-detail-section="deliverables"]').click();
  assert.equal(await page.evaluate(() => detailTaskId), target.handoff);
  assert.match(await page.locator('#taskDialogBody').textContent(), /预计用时依据/);
  assert.deepEqual(await page.locator('#taskDialogBody .practice-step-list li label > span').allTextContents(), target.steps,
    'The final self-test exposes every actual verification step before explicit completion');
  assert.deepEqual(await page.locator('#taskDialogBody .detail-deliverables li').allTextContents(), target.deliverables,
    'The original project outputs remain available for the final completion decision');
  assert.match(await page.locator('#taskDialogBody details > summary').allTextContents().then(items => items.join(' ')), /模块学习安排.*相关课程/);
  await page.locator('#detailToggleBtn').click();
  await page.waitForFunction(id => taskDone(id), target.handoff);
  await page.locator('#closeTaskBtn').click();
  assert.equal(await recommendation(page).getAttribute('data-task-id'), target.career);
  assert.equal(await page.locator('#continue-track-review').getAttribute('aria-pressed'), 'true');
  assert.equal(await recommendation(page).locator('.continue-prerequisite').count(), 0);
});

test('on-demand repairs stay outside fixed sessions and mandatory progress while retaining their own records', { timeout: 90_000 }, async t => {
  const page = await pageAt(t, instantAt(planData.careerWorkflow.preparationStartDate), 320);
  const target = await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks()) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
    const pool = allTasks.find(task => task.onDemand && !isRequiredTask(task)
      && task.phaseId === 'courses' && supportsPracticeProgress(task));
    return { pool: pool.id, week: pool.week, required: requiredTasks().length,
      career: DATA.careerWorkflow.projectPreparationTaskIds[0] };
  });
  assert.equal(await page.evaluate(() => allLearningComplete()), true);
  assert.equal(await page.locator('#todayBox [data-task-id]').getAttribute('data-task-id'), target.career);
  assert.equal(await page.evaluate(() => allTasks.filter(task => task.optional).some(task => taskDone(task.id))), false,
    'No fake completion is needed when there is no actual repair gap');
  assert.match(await page.locator('#overallProgressSummary').textContent(), new RegExp(`必修.* / ${target.required} 项.*按需补漏`));
  await page.evaluate(week => selectWeek(week), target.week);
  const pool = page.locator(`#weekTasks [data-on-demand-tasks] [data-task-id="${target.pool}"]`);
  assert.equal(await pool.count(), 1);
  assert.equal(await page.locator(`#weekTasks .day-group [data-task-id="${target.pool}"]`).count(), 0,
    'An on-demand suggestion cannot be counted as a fixed calendar session');
  assert.match(await page.locator('#weekTasks [data-on-demand-tasks]').textContent(), /没有缺口可不打卡/);
  await pool.locator('[data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('20');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 20, target.pool);
  assert.equal(await page.evaluate(id => taskDone(id), target.pool), false);
  assert.equal(await page.evaluate(() => allLearningComplete()), true);
  assert.match(await pool.locator('.task-progress-note').textContent(), /20 分钟/);
  assert.equal(await page.evaluate(id => scheduledTasksForWeek(selectedWeekData()).some(task => task.id === id), target.pool), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('Today keeps unfinished Zero Voice before calendar résumé preparation', { timeout: 90_000 }, async t => {
  const page = await pageAt(t, `${planData.careerWorkflow.preparationStartDate}T04:00:00Z`);
  const expected = await page.evaluate(() => allTasks.find(task => task.track === 'ls' && !taskDone(task.id)).id);
  assert.equal(await page.locator('#todayBox [data-task-id]').getAttribute('data-task-id'), expected);
  assert.equal(await page.locator('#continue-track-ls').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#continueBox [data-continue-today]').getAttribute('data-continue-today'), expected);
  assert.match(await page.locator('#todayHint').textContent(), /先完成零声课程/);
  assert.equal(await page.locator('#todayBox .track.review').count(), 0, 'The calendar cannot promote interview tasks past unfinished coursework');
  await page.locator('#continue-track-ydy').click();
  assert.equal(await page.locator('#continueBox .continue-task').evaluate(node => taskById.get(node.dataset.taskId).activity), 'practice',
    'Manual project selection still keeps weekday videos out of the recommendation');
  assert.match(await recommendation(page).locator('.continue-prerequisite').textContent(), /前置任务尚未打卡.*周六先补前置课节.*平台课程有效至/);
});

test('résumé preparation waits for learning and teacher confirmation gates applications and relative reviews', { timeout: 90_000 }, async t => {
  const page = await pageAt(t, instantAt(planData.careerWorkflow.preparationStartDate), 320);
  const target = await page.evaluate(() => {
    const final = allTasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
    const preparation = DATA.careerWorkflow.preparationTaskIds;
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.id !== final.id)) state.entries[task.id] = createEntry(true, stamp);
    state.entries[preparation[0]] = createEntry(true, stamp, '已有准备记录');
    saveState(); render();
    return { final: final.id, priorCareer: preparation[0], nextCareer: DATA.careerWorkflow.projectPreparationTaskIds[1], preparation,
      earlyDate: final.endDate, teacher: DATA.careerWorkflow.teacherTaskId,
      firstReview: DATA.careerWorkflow.interviewTaskIds[0] };
  });
  assert.equal(await page.locator('#todayBox [data-task-id]').getAttribute('data-task-id'), target.final);
  assert.equal(await page.locator('#continue-track-ydy').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#pageSubtitle').textContent(), /全部学习完成后/);
  await page.locator('#continue-track-review').click();
  assert.equal(await page.locator('#continueBox .continue-task').count(), 0);
  assert.match(await page.locator('#continueBox').textContent(), /全部学习完成后/);
  assert.equal(await page.locator('#continueBox [data-continue-records="review"]').count(), 1);
  await page.clock.setFixedTime(new Date(instantAt(target.earlyDate)));
  await page.evaluate(id => { state.entries[id] = createEntry(true, freshTimestamp()); saveState(); render(); }, target.final);
  assert.equal(await page.locator('#continue-track-review').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#todayBox [data-task-id]').getAttribute('data-task-id'), target.nextCareer,
    'Actual early learning completion opens résumé preparation before its suggested date');
  assert.match(await page.locator('#pageSubtitle').textContent(), /简历|老师/);
  assert.match(await page.locator('#todayBox .duration-chip').textContent(), /本次 40 分钟.*模块预计总 1 小时 20 分钟/);
  await page.locator('#todayBox [data-progress-action="record-session"]').click();
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 40, target.nextCareer);
  assert.equal(await page.evaluate(id => taskDone(id), target.nextCareer), false,
    'One 40-minute session cannot complete the 80-minute Yibo materials module');
  assert.equal(await page.evaluate(() => applicationReadiness().ready), false);

  await page.evaluate(ids => {
    for (const id of ids) {
      const previous = taskEntry(id);
      state.entries[id] = createEntry(true, freshTimestamp(), previous?.evidence, previous?.progress);
    }
    saveState(); render();
  }, target.preparation);
  assert.equal(await recommendation(page).getAttribute('data-task-id'), target.teacher,
    'All seven project and skill preparation modules lead to the teacher appointment before any technical review');
  assert.equal(await page.evaluate(() => applicationReadiness().ready), false,
    'A completed résumé checklist does not substitute for teacher confirmation');
  assert.equal(await recommendation(page).locator('[data-progress-action="record-session"]').count(), 0,
    'The externally scheduled teacher appointment has no artificial study-time session');
  assert.match(await recommendation(page).textContent(), /外部协作.*不估算等待时长/);
  assert.doesNotMatch(await recommendation(page).textContent(), /(?:^|[^0-9])0 分钟/);
  await recommendation(page).locator('.primary[data-task-action="details"]').click();
  assert.equal(await page.evaluate(() => detailTaskId), target.teacher);
  assert.equal(await page.locator('#taskProgressNote').count(), 1);
  assert.equal(await page.locator('#practiceWorkedTotal, #practiceSessionMinutes').count(), 0,
    'Teacher outcomes are recorded as notes without a minutes budget');
  const note = '老师已确认简历可投递，重点补充项目技术追问';
  await page.locator('#taskProgressNote').fill(note);
  await page.locator('#taskDialog [data-progress-action="save-practice"]').click();
  await page.waitForFunction(([id, value]) => taskProgress(id)?.note === value, [target.teacher, note]);
  assert.deepEqual(await page.evaluate(id => taskProgress(id), target.teacher), { kind: 'practice', note });
  assert.equal(await page.evaluate(() => applicationReadiness().ready), false,
    'Saving an appointment note is separate from confirming the teacher task');
  await page.locator('#detailToggleBtn').click();
  await page.waitForFunction(id => taskDone(id), target.teacher);
  await page.locator('#closeTaskBtn').click();
  assert.equal(await page.evaluate(() => applicationReadiness().ready), true);
  assert.equal(await recommendation(page).getAttribute('data-task-id'), target.firstReview,
    'Teacher confirmation starts relative technical review from the first unfinished topic');
  assert.equal(await page.evaluate(() => DATA.careerWorkflow.interviewTaskIds.every(id => !taskDone(id))), true);
  await page.evaluate(() => activateView('milestones'));
  assert.match(await page.locator('#applicationMilestone .application-status').textContent(), /可开始投递/);
  assert.match(await page.locator('#applicationMilestone').textContent(), /老师|确认/);
  assert.equal(await page.evaluate(id => taskDone(id), target.priorCareer), true);
  assert.equal(await page.evaluate(id => taskEntry(id).evidence, target.priorCareer), '已有准备记录');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('career weeks use day cards and session check-ins before explicit module completion', { timeout: 90_000 }, async t => {
  const page = await pageAt(t, instantAt(planData.careerWorkflow.preparationStartDate), 320);
  const target = await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks()) state.entries[task.id] = createEntry(true, stamp);
    localRevision++; saveState();
    activateView('planner'); selectPhase('career');
    const task = taskById.get(DATA.careerWorkflow.projectPreparationTaskIds[0]);
    const week = selectedWeekData();
    return { id: task.id, date: task.workSessions[0].date, week: week.week, range: week.range,
      start: week.start, end: week.end, teacher: DATA.careerWorkflow.teacherTaskId,
      interviews: DATA.careerWorkflow.interviewTaskIds };
  });
  assert.match(await page.locator('#plannerView').getAttribute('class'), /\bis-career-plan\b/);
  assert.equal(await page.locator('#weekTasks [data-career-board]').count(), 0);
  assert.equal(await page.locator('#weekSelect').inputValue(), String(target.week));
  assert.equal(await page.locator('#weekTopic').textContent(), target.range);
  for (const selector of ['.planner-topbar', '.week-navigation', '#weekMeta', '#allWeeksDetails']) {
    assert.equal(await page.locator(selector).isVisible(), true, `${selector} remains available for the selected career week`);
  }
  assert.equal(await page.locator('#planPhaseCaption').isVisible(), false);
  assert.equal(await page.locator('#trackFilter').isVisible(), false);
  assert.equal(await page.locator('#taskSearch').isVisible(), true);
  assert.equal(await page.locator('#taskFilter').isVisible(), true);
  const order = items => items.sort((a, b) => `${a.date}:${a.id}`.localeCompare(`${b.date}:${b.id}`));
  const expectedSessions = planTasks.filter(task => task.track === 'review' && task.optional !== true)
    .flatMap(task => (task.workSessions || []).filter(session => target.start <= session.date && session.date <= target.end)
      .map(session => ({ id: task.id, date: session.date })));
  const shownSessions = await page.locator('#weekTasks > .day-group .task-card[data-task-id]').evaluateAll(cards => cards.map(card => ({
    id: card.dataset.taskId, date: card.closest('.day-group').id.slice(4)
  })));
  assert.deepEqual(order(shownSessions), order(expectedSessions), 'The selected week shows each scheduled session on its own day');
  const moduleCards = page.locator(`#weekTasks > .day-group .task-card[data-task-id="${target.id}"]`);
  assert.equal(await moduleCards.count(), 4, 'The remote-control materials module shares one record across four weekday sessions');
  const card = page.locator(`#day-${target.date} .task-card[data-task-id="${target.id}"]`);
  assert.match(await card.locator('.duration-chip').textContent(), /本次 40 分钟.*模块预计总 2 小时 40 分钟/);
  assert.equal(await card.locator('[data-task-action="toggle"]').count(), 0);
  const teacher = page.locator('#weekTasks details[data-career-section="teacher"]');
  const interviews = page.locator('#weekTasks details[data-career-section="interviews"]');
  assert.equal(await teacher.evaluate(section => section.open), false);
  assert.equal(await interviews.evaluate(section => section.open), false);
  assert.equal(await teacher.locator(`.task-card[data-task-id="${target.teacher}"]`).count(), 1);
  assert.deepEqual(await interviews.locator('.task-card[data-task-id]').evaluateAll(cards => cards.map(card => card.dataset.taskId)), target.interviews);

  for (const minutes of [40, 80, 120, 160]) {
    await card.locator('.check[data-progress-action="record-session"]').click();
    assert.equal(await page.locator('#practiceSessionInput').inputValue(), '40');
    await page.locator('#savePracticeSessionBtn').click();
    await page.waitForFunction(([id, worked]) => taskProgress(id)?.workedMinutes === worked, [target.id, minutes]);
    await page.locator('#practiceSessionDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(id => taskDone(id), target.id), false,
      'Session records must not automatically complete the full materials module');
    if (minutes === 40) {
      const notes = await moduleCards.locator('.task-progress-note').allTextContents();
      assert.equal(notes.length, 4);
      assert.ok(notes.every(note => /40 分钟/.test(note)), 'All dated sessions show the same saved module progress');
    }
  }
  const review = card.locator('.check[data-task-action="details"]');
  assert.match(await review.getAttribute('aria-label'), /核对模块成果/);
  await review.click();
  assert.equal(await page.evaluate(() => detailTaskId), target.id);
  assert.equal(await page.locator('#taskDialog .detail-deliverables').count(), 1);
  assert.equal(await page.locator('#detailToggleBtn').isEnabled(), true);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), false,
    'The review shortcut opens deliverables for an explicit completion decision');
  await page.locator('#closeTaskBtn').click();
  assert.equal(await teacher.evaluate(section => section.open), false);
  assert.equal(await interviews.evaluate(section => section.open), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('resumed Yibo practice keeps a 40-minute record action in Today after Continue deduplication', { timeout: 90_000 }, async t => {
  const page = await pageAt(t, instantAt(projectWeekday), 320);
  const target = await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of allTasks.filter(task => task.track === 'ls'
      || task.projectId === 'yibo' && task.activity === 'video')) {
      state.entries[task.id] = createEntry(true, stamp);
    }
    saveState(); render();
    const task = allTasks.find(task => task.projectId === 'yibo' && task.activity === 'practice');
    return { id: task.id, duration: taskDuration(recommendedSessionTask(task, todayISO())) };
  });
  assert.equal(await page.locator('#todayBox [data-task-id]').getAttribute('data-task-id'), target.id);
  assert.equal(await page.locator('#continueBox [data-continue-today]').getAttribute('data-continue-today'), target.id);
  assert.equal(await page.locator('#continueBox .continue-task').count(), 0);
  assert.equal(await page.locator('#todayBox .duration-chip').textContent(), target.duration);
  assert.match(await page.locator('#todayHint').textContent(), /先完成易播，再进入云助教/);
  assert.equal(await page.locator('#todayBox [data-task-action="toggle"]').count(), 0,
    'The weekday shortcut must record a session rather than complete the original multi-hour task');
  await page.locator('#todayBox [data-progress-action="record-session"]').click();
  assert.equal(await page.locator('#practiceSessionInput').inputValue(), '40');
  await page.locator('#practiceSessionInput').fill('35');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 35, target.id);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), false);
  assert.match(await page.locator('#todayBox .task-progress-note').textContent(), /35 分钟/);
  await page.waitForFunction(id => document.activeElement?.dataset.progressAction === 'record-session'
    && document.activeElement.closest('[data-task-id]')?.dataset.taskId === id, target.id);
  await page.reload();
  await page.waitForFunction(() => syncState.reachable !== null && !syncState.busy);
  assert.equal(await page.evaluate(id => taskProgress(id)?.workedMinutes, target.id), 35);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), false);
  assert.match(await page.locator('#todayBox [data-progress-action="record-session"]').textContent(), /40 分钟/);
  await page.locator('#todayBox [data-task-action="details"][data-detail-section="deliverables"]').click();
  assert.equal(await page.locator('#taskDialog .detail-deliverables').evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight;
  }), true, 'The separate output action still lets the user verify and finish the original task deliberately');
  await page.locator('#closeTaskBtn').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('project session adds actual input to newer remote progress without losing its notes or steps', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(initialWeekday));
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  const taskId = 'edoyun-module-v1-yibo-environment-ipc';
  assert.equal(await recommendation(page).getAttribute('data-task-id'), taskId);
  let remoteRecord = { done: false, updatedAt: '2030-01-01T00:00:00.000Z',
    progress: { kind: 'practice', workedMinutes: 120, completedSteps: [0], note: '远端已做' } };
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    const submitted = body.state.entries[taskId];
    if (submitted?.updatedAt > remoteRecord.updatedAt) remoteRecord = submitted;
    return route.fulfill({ json: { state: { entries: { ...body.state.entries, [taskId]: remoteRecord } }, serverTime: new Date().toISOString() } });
  });
  await recommendation(page).locator('[data-progress-action="record-session"]').click();
  await page.locator('#practiceSessionInput').fill('40');
  await page.locator('#savePracticeSessionBtn').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 160, taskId);
  await page.locator('#practiceSessionDialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(id => taskProgress(id), taskId),
    { kind: 'practice', workedMinutes: 160, completedSteps: [0], note: '远端已做' });
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false);
  assert.equal(await recommendation(page).locator('[data-progress-action="record-session"]').count(), 1);
});

test('a remote total near the storage ceiling keeps an overflowing draft for correction', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(initialWeekday));
  await page.evaluate(() => {
    const stamp = freshTimestamp();
    for (const task of requiredLearningTasks().filter(task => task.track === 'ls')) state.entries[task.id] = createEntry(true, stamp);
    saveState(); render();
  });
  const taskId = 'edoyun-module-v1-yibo-environment-ipc';
  let remoteRecord = { done: false, updatedAt: '2030-01-01T00:00:00.000Z',
    progress: { kind: 'practice', workedMinutes: 99990, completedSteps: [0], note: '远端极限记录' } };
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => {
    const body = route.request().postDataJSON();
    const submitted = body.state.entries[taskId];
    if (submitted?.updatedAt > remoteRecord.updatedAt) remoteRecord = submitted;
    return route.fulfill({ json: { state: { entries: { ...body.state.entries, [taskId]: remoteRecord } }, serverTime: new Date().toISOString() } });
  });
  await recommendation(page).locator('[data-progress-action="record-session"]').click();
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
  const page = await pageAt(t, instantAt(firstYiboModule.date));
  const taskId = 'edoyun-module-v1-yibo-environment-ipc';
  await page.evaluate(id => openTaskDetails(id), taskId);
  assert.match(await page.locator('#practiceSessionLimitHint').textContent(), /2 小时/, 'The Saturday suggestion uses the remaining planned task time, below 300 minutes');
  await page.locator('#practiceSessionMinutes').fill('1.5');
  await page.locator('[data-progress-action="save-practice"]').click();
  assert.equal(await page.evaluate(id => taskProgress(id), taskId), null, 'Fractional actual minutes must not be stored');
  await page.locator('#practiceSessionMinutes').fill('300');
  await page.locator('[data-progress-action="save-practice"]').click();
  await page.waitForFunction(id => taskProgress(id)?.workedMinutes === 300, taskId);
  assert.equal(await page.evaluate(id => taskDone(id), taskId), false, 'Exceeding the task budget does not complete its deliverables');
});

test('project selftest completion controls status while old acceptance remains read-only history', { timeout: 90_000 }, async t => {
  const page = await pageAt(t, instantAt(initialWeekday));
  const target = await page.evaluate(() => {
    const milestone = DATA.milestones.find(item => item.id === 'yibo');
    const oldKey = milestone.historicalReviewKeys[0];
    const stamp = `${DATA.weeks[0].start}T00:00:00.000Z`;
    state.entries[oldKey] = createEntry(true, stamp, '旧范围的验收证据');
    saveState(); activateView('milestones');
    return { id: milestone.id, current: milestoneReviewKey(milestone), oldKey, stamp };
  });
  const card = page.locator(`[data-milestone-id="${target.id}"]`);
  assert.notEqual(await card.locator('.goal-status').textContent(), '已完成');
  const historical = card.locator(`[data-historical-review-key="${target.oldKey}"]`);
  const history = historical.locator('xpath=ancestor::details[1]');
  assert.equal(await history.evaluate(element => element.open), false);
  await history.locator(':scope > summary').click();
  assert.equal(await historical.isVisible(), true);
  assert.match(await historical.textContent(), /旧范围的验收证据/);
  assert.equal(await historical.locator('time').getAttribute('datetime'), target.stamp);
  assert.equal(await historical.locator('input, textarea, button').count(), 0);
  assert.equal(await page.evaluate(key => state.entries[key] || null, target.current), null);
  assert.equal(await card.locator('[data-milestone-review]').count(), 0);
  await page.evaluate(id => {
    for (const task of milestoneTasks(DATA.milestones.find(item => item.id === id))) state.entries[task.id] = createEntry(true, freshTimestamp());
    saveState(); render();
  }, target.id);
  assert.equal(await card.locator('.goal-status').textContent(), '已完成');
  assert.equal(await page.evaluate(() => activeProjectLearningGroup()), 'yunzhujiao');
  assert.equal(await page.evaluate(key => state.entries[key] || null, target.current), null,
    'Completing selftest does not manufacture a separate project review');
  assert.deepEqual(await page.evaluate(key => state.entries[key], target.oldKey),
    { done: true, updatedAt: target.stamp, evidence: '旧范围的验收证据' });
  await card.locator('.goal-next-task').click();
  assert.equal(await page.evaluate(() => detailTaskId), 'edoyun-module-v1-yibo-selftest');
  await page.locator('#detailToggleBtn').click();
  await page.locator('#closeTaskBtn').click();
  assert.notEqual(await card.locator('.goal-status').textContent(), '已完成');
  assert.equal(await page.evaluate(() => activeProjectLearningGroup()), 'yibo');
  assert.equal(await page.evaluate(key => state.entries[key] || null, target.current), null);
  assert.equal(await page.evaluate(key => state.entries[key].done, target.oldKey), true);
});

test('unfinished platform videos show their real deadline and expire instead of being deferred to Saturday', { timeout: 90_000 }, async t => {
  const expiry = planData.projectLearningScope.find(scope => scope.projectId === 'studio-course').expiresAt
    || planData.planRhythm.courseAccessDeadline;
  const page = await pageAt(t, instantAt(dateOffset(expiry, -5)));
  const target = await page.evaluate(() => {
    const video = requiredLearningTasks().find(task => task.projectId === 'studio-course' && task.activity === 'video');
    for (const task of requiredLearningTasks().filter(task => task.id !== video.id)) state.entries[task.id] = createEntry(true, freshTimestamp());
    saveState(); render();
    return { id: video.id, week: video.week, expiry: courseAccessState(video).expiresAt };
  });
  const label = await page.evaluate(date => formatDate(date, true), target.expiry);
  assert.match(await page.locator('#todayBox .focus-title').textContent(), /待补课程留到周六/);
  assert.ok((await page.locator('#continueBox').textContent()).includes(label), 'The valid-period reminder includes the concrete deadline');
  await page.clock.setFixedTime(new Date(instantAt(target.expiry)));
  await page.evaluate(() => render());
  assert.match(await page.locator('#continueBox').textContent(), /今天是最后一天/);
  assert.doesNotMatch(await page.locator('#continueBox').textContent(), /待补课程留到周六/,
    'When the next Saturday is beyond the deadline, the reminder cannot imply access will remain available');
  await page.clock.setFixedTime(new Date(instantAt(dateOffset(target.expiry, 2))));
  await page.evaluate(() => render());
  assert.match(await page.locator('#todayBox .focus-title').textContent(), /平台课程已到期/);
  assert.match(await page.locator('#continueBox').textContent(), /如已保存笔记、代码或课程资料/);
  assert.doesNotMatch(await page.locator('#todayBox').textContent(), /留到周六/);
  assert.doesNotMatch(await page.locator('#continueBox').textContent(), /留到周六/);
  assert.equal(await page.evaluate(id => taskDone(id), target.id), false);
  await page.locator(`#continueBox [data-week="${target.week}"]`).click();
  const video = page.locator(`#weekTasks [data-task-id="${target.id}"]`);
  assert.equal(await video.locator('[data-course-access="expired"]').count(), 1);
  assert.ok((await video.locator('[data-course-access="expired"]').textContent()).includes(label));
});

test('video playback position is absolute and a dirty draft survives remote refresh until explicit resolution', { timeout: 30_000 }, async t => {
  const page = await pageAt(t, instantAt(planData.weeks[0].start));
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
  const page = await pageAt(t, instantAt(planData.weeks[0].start));
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
  const page = await pageAt(t, instantAt(planData.weeks[0].start));
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
  const afterPlan = new Date(Date.parse(`${planData.weeks.at(-1).end}T04:00:00Z`) + 86400000).toISOString();
  const page = await pageAt(t, afterPlan);
  assert.equal(await page.locator('#todayBox [data-task-id]').count(), 0);
  assert.match(await page.locator('#todayBox .focus-title').textContent(), /今天没有固定任务/);
  assert.equal(await page.locator('#continueBox .continue-timing').textContent(), '待补');
  assert.ok((await page.locator('#continueBox .continue-meta').textContent()).includes(await page.evaluate(date => formatDate(date, true), planData.weeks[0].start)));
});
