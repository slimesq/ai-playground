'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'tracker-ui.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
const stamp = '2027-04-26T00:00:00.000Z';
const dateAt = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const task = (id, date, track, activity, minutes, fields = {}) => ({ id, date, track, activity,
  week: Math.floor((Date.parse(date) - Date.parse('2027-04-26')) / 604800000) + 1,
  day: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(date).getUTCDay()],
  title: id, durationMinutes: minutes, steps: ['运行并核对结果'], deliverables: ['真实运行证据'],
  budget: { videoMinutes: activity === 'video' ? minutes : 0, practiceMinutes: activity === 'video' ? 0 : minutes, bufferMinutes: 0 }, ...fields });

function fixture() {
  const tasks = [
    task('ls', '2027-04-26', 'ls', 'video', 40),
    task('yibo-video', '2027-05-01', 'ydy', 'video', 120, { projectId: 'yibo' }),
    task('yibo-module', '2027-05-01', 'ydy', 'practice', 180, { projectId: 'yibo', endDate: '2027-05-04',
      workSessions: [{ date: '2027-05-01', minutes: 100 }, { date: '2027-05-03', minutes: 40 }, { date: '2027-05-04', minutes: 40 }],
      prerequisiteTaskIds: ['yibo-video'], estimateBasis: '先实现、联调，再单独验收；3小时为初估',
      completionCriteria: ['能演示输入、输出及失败边界'],
      sourceSections: [{ sectionId: 'source-one', title: '进程与消息', chapterTitle: '服务基础', videoTaskId: 'yibo-video', videoCompletionDate: '2027-05-01' }] }),
    task('yibo-repair', '2027-05-05', 'ydy', 'buffer', 40, { projectId: 'yibo', optional: true, onDemand: true, phaseId: 'courses', workSessions: [] }),
    task('cloud-video', '2027-05-08', 'ydy', 'video', 120, { projectId: 'yunzhujiao', prerequisiteTaskIds: ['yibo-module', 'yibo-repair'] }),
    task('cloud-module', '2027-05-08', 'ydy', 'practice', 120, { projectId: 'yunzhujiao', endDate: '2027-05-10',
      workSessions: [{ date: '2027-05-08', minutes: 80 }, { date: '2027-05-10', minutes: 40 }], prerequisiteTaskIds: ['cloud-video'] }),
    task('studio-video', '2027-05-15', 'ydy', 'video', 120, { projectId: 'studio-course', prerequisiteTaskIds: ['cloud-module'] }),
    task('studio-module', '2027-05-15', 'ydy', 'practice', 200, { projectId: 'studio-course', endDate: '2027-05-15',
      workSessions: [{ date: '2027-05-15', minutes: 200 }], prerequisiteTaskIds: ['studio-video'], historicalTaskIds: ['old-studio', 'old-watch', 'old-exercise', 'old-watch'] }),
    ...['resume', 'demo', 'roles', 'interview'].map((id, index) => task(id, dateAt('2027-05-24', [0, 2, 3, 4][index]), 'review', 'review', id === 'resume' ? 80 : 40,
      { prerequisiteTaskIds: ['studio-module'], endDate: dateAt('2027-05-24', id === 'resume' ? 1 : [0, 2, 3, 4][index]),
        workSessions: id === 'resume' ? [{ date: '2027-05-24', minutes: 40 }, { date: '2027-05-25', minutes: 40 }]
          : [{ date: dateAt('2027-05-24', [0, 2, 3, 4][index]), minutes: 40 }] }))
  ];
  return {
    weeks: Array.from({ length: 5 }, (_, index) => ({ week: index + 1, start: dateAt('2027-04-26', index * 7),
      end: dateAt('2027-04-26', index * 7 + 6), tasks: tasks.filter(item => item.week === index + 1) })),
    planPhases: [{ id: 'courses', label: '课程', startWeek: 1, endWeek: 4, start: '2027-04-26', end: '2027-05-23' },
      { id: 'career', label: '求职', startWeek: 5, endWeek: 5, start: '2027-05-24', end: '2027-05-30' }],
    planRhythm: { weekdayTransitionDate: '2027-05-03', courseAccessDeadline: '2027-06-07' },
    projectLearningScope: [{ projectId: 'yibo', expiresAt: '2027-05-31' }, { projectId: 'yunzhujiao', expiresAt: '2027-06-30' }, { projectId: 'studio-course' }],
    milestones: [{ id: 'yibo', name: '易播', kind: 'project', date: '2027-05-04', taskIds: ['yibo-video', 'yibo-module', 'yibo-repair'],
      reviewKey: 'milestone:modules-v1-yibo', historicalReviewKeys: ['milestone:yibo'] }],
    applicationMilestone: { name: '投递与复盘', start: '2027-05-27', end: '2027-06-10', readinessTaskIds: ['resume', 'demo', 'roles'] },
    legacyReferenceTasks: [task('old-studio', '2027-05-15', 'ydy', 'practice', 40, { steps: ['旧单步练习'] })],
    legacyVideoTasks: [task('old-watch', '2027-05-01', 'ydy', 'video', 120)],
    legacyPracticeTasks: [task('old-exercise', '2027-05-01', 'ydy', 'practice', 40)]
  };
}

function harness(entries = {}, custom = fixture()) {
  const saved = new Map([['av_study_tracker_regenerated_v2', JSON.stringify({ entries })]]);
  const nodes = new Map();
  const downloads = [];
  const element = () => ({ innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {}, options: [],
    focus() {}, select() {}, close() { this.open = false; },
    querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, classList: { toggle() {}, contains: () => false },
    parentElement: { setAttribute() {} } });
  const context = vm.createContext({ DATA: custom, console, navigator: { onLine: true },
    localStorage: { get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null,
      getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      querySelector: () => element(), body: { dataset: {}, classList: { toggle() {} } }, createElement: () => ({ click() {} }) },
    CSS: { escape: value => value }, URL: class extends URL {
      static createObjectURL(blob) { downloads.push(blob); return 'blob:backup'; }
      static revokeObjectURL() {}
    }, Blob, setTimeout: () => 0 });
  vm.runInContext(source, context);
  vm.runInContext('render = () => {}; syncToServer = () => {}; showToast = () => {};', context);
  return { nodes, saved, downloads, run: expression => vm.runInContext(expression, context),
    json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}

function completeLearning(h, except = []) {
  h.run(`for (const task of requiredLearningTasks().filter(task => !${JSON.stringify(except)}.includes(task.id))) state.entries[task.id] = { done: true, updatedAt: ${JSON.stringify(stamp)} };`);
}

function realPlan() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'study-tracker.html'), 'utf8')
    .match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
}

test('multi-session modules remain unique while calendar helpers expose every planned learning session', () => {
  const h = harness();
  const before = h.json('DATA.weeks');
  const result = h.json(`(() => {
    const days = ['2027-05-01', '2027-05-03', '2027-05-04'];
    return { ids: days.map(date => scheduledTasksForDate(date).filter(task => task.id === 'yibo-module').map(task => task.id)),
      weekOne: scheduledTasksForWeek(1).map(task => ({ id: task.id, minutes: task.sessionMinutes ?? taskMinutes(task) })),
      weekTwo: scheduledTasksForWeek(2).filter(task => task.id === 'yibo-module').map(task => ({ date: task.date, week: task.week, minutes: task.sessionMinutes })),
      totalModule: taskMinutes(taskById.get('yibo-module')), firstSession: totalTaskMinutes(scheduledTasksForDate('2027-05-01')),
      rawCount: allTasks.filter(task => task.id === 'yibo-module').length,
      duration: taskDuration(scheduledTasksForDate('2027-05-03').find(task => task.id === 'yibo-module')),
      topics: weekTopicsText(DATA.weeks[1]) };
  })()`);
  assert.deepEqual(result.ids, [['yibo-module'], ['yibo-module'], ['yibo-module']]);
  assert.equal(result.rawCount, 1);
  assert.equal(result.totalModule, 180);
  assert.equal(result.firstSession, 220, 'May 1 contains 120 video minutes plus only this 100-minute module session');
  assert.deepEqual(result.weekTwo, [{ date: '2027-05-03', week: 2, minutes: 40 }, { date: '2027-05-04', week: 2, minutes: 40 }]);
  assert.match(result.duration, /本次 40 分钟.*模块预计总 3 小时/);
  assert.match(result.topics, /yibo-module（续学）/);
  assert.equal(h.run(`taskCompletionLabel(scheduledTasksForWeek(2).filter(task => task.id === 'yibo-module'))`),
    '0 / 1 已完成', 'Repeated calendar sessions count as one module in weekly and monthly completion summaries');
  h.run(`state.entries['yibo-module'] = { done: true, updatedAt: ${JSON.stringify(stamp)} }`);
  assert.equal(h.run(`taskCompletionLabel(scheduledTasksForWeek(2).filter(task => task.id === 'yibo-module'))`), '1 / 1 已完成');
  assert.deepEqual(h.json('DATA.weeks'), before, 'Calendar view clones cannot mutate the unique module definitions');
});

test('Today, Saturday module cards and planner cards record sessions instead of checking the whole module', () => {
  const h = harness({ ls: { done: true, updatedAt: stamp }, 'yibo-video': { done: true, updatedAt: stamp } });
  const weekday = h.json(`(() => { const task = todayLearningSelection('2027-05-03').tasks[0]; return { id: task.id,
    minutes: totalTaskMinutes([task]), html: taskMarkup(task, true, [], { date: '2027-05-03' }) }; })()`);
  assert.equal(weekday.id, 'yibo-module');
  assert.equal(weekday.minutes, 40);
  assert.match(weekday.html, /记录本次 40 分钟/);
  assert.match(weekday.html, /本次 40 分钟.*模块预计总 3 小时/);
  assert.doesNotMatch(weekday.html, /data-task-action="toggle"/);
  const saturday = h.run(`taskMarkup(scheduledTasksForDate('2027-05-01').find(task => task.id === 'yibo-module'), true, [], { date: '2027-05-01' })`);
  assert.match(saturday, /记录本次 1 小时 40 分钟/);
  assert.doesNotMatch(saturday, /data-task-action="toggle"/);
  const planner = h.run(`taskMarkup(scheduledTasksForDate('2027-05-03')[0])`);
  assert.match(planner, /data-progress-action="record-session"/);
  assert.doesNotMatch(planner, /data-task-action="toggle"/);
  h.run(`saveTaskProgress('yibo-module', { kind: 'practice', workedMinutes: 40, completedSteps: [0] })`);
  assert.equal(h.run(`taskDone('yibo-module')`), false);
  assert.equal(h.run(`allTasks.filter(task => task.id === 'yibo-module').length`), 1);
  assert.equal(h.run(`scheduledTasksForDate('2027-05-04')[0].id`), 'yibo-module');
  assert.match(h.run(`taskWorkSessionsMarkup(taskById.get('yibo-module'))`), /2027年5月1日.*2027年5月4日.*3 次/);
});

test('optional repairs cannot block project transitions, mandatory milestones or career readiness and remain independently editable', () => {
  const h = harness({ ls: { done: true, updatedAt: stamp }, 'yibo-video': { done: true, updatedAt: stamp }, 'yibo-module': { done: true, updatedAt: stamp } });
  assert.equal(h.run('activeProjectLearningGroup()'), 'yunzhujiao');
  assert.deepEqual(h.json(`unfinishedPrerequisites(taskById.get('cloud-video')).map(task => task.id)`), []);
  const milestone = h.json(`milestoneProgress(DATA.milestones[0])`);
  assert.equal(milestone.tasks.length, 2);
  assert.equal(milestone.checked, true);
  assert.match(h.run(`milestoneCard(DATA.milestones[0], 0)`), /按需补漏.*yibo-repair/);
  completeLearning(h);
  assert.equal(h.run('allLearningComplete()'), true);
  assert.equal(h.run(`defaultContinueTrack('2027-05-17')`), 'review');
  assert.equal(h.run(`learningRecommendation('ydy', '2027-05-17').next`), undefined);
  assert.equal(h.run(`taskDone('yibo-repair')`), false);
  assert.match(h.run(`taskMarkup(taskById.get('yibo-repair'))`), /按需补漏/);
  h.run(`saveTaskProgress('yibo-repair', { kind: 'practice', workedMinutes: 20, note: '按实际缺口补测' })`);
  assert.equal(h.run(`taskProgress('yibo-repair').workedMinutes`), 20);
  assert.equal(h.run('allLearningComplete()'), true);
  assert.equal(h.run(`taskCompletionLabel([taskById.get('yibo-module'), taskById.get('yibo-repair')])`), '必修 1 / 1 已完成 · 按需 0 / 1');
  assert.deepEqual(h.json(`scheduledTasksForDate('2027-05-05').map(task => task.id)`), [],
    'An on-demand pool date is a suggestion and cannot become a fixed 40-minute assignment');
  assert.deepEqual(h.json(`scheduledTasksForDate('2027-05-23').map(task => task.id)`), [], 'On-demand pools cannot add Sunday work');
  assert.equal(h.run(`scheduledTasksForWeek(2).some(task => task.id === 'yibo-repair')`), false);
  assert.match(h.run(`onDemandTasksMarkup(onDemandTasksForScope({ phase: 'courses', track: 'all', project: '' }))`),
    /data-on-demand-tasks.*按需补漏.*yibo-repair.*data-progress-action="record-session"/s);
});

test('project completion follows every required task and selftest, reverses on cancellation and ignores old review flags', () => {
  const real = realPlan();
  const goal = real.milestones.find(item => item.id === 'yibo');
  const selftest = 'edoyun-module-v1-yibo-selftest';
  const module = 'edoyun-module-v1-yibo-http';
  assert.ok(goal.taskIds.includes(selftest));
  for (const reviewDone of [true, false]) {
    const originalReview = { done: reviewDone, updatedAt: stamp, evidence: '保留的旧项目说明 https://example.test/original-project' };
    const entries = Object.fromEntries(goal.taskIds.filter(id => id !== selftest).map(id => [id, { done: true, updatedAt: stamp }]));
    entries[goal.reviewKey] = originalReview;
    const h = harness(entries, JSON.parse(JSON.stringify(real)));
    h.run('focusSnapshot = () => null; captureToastFocus = () => null;');
    assert.equal(h.run(`milestoneProgress(DATA.milestones.find(item => item.id === 'yibo')).checked`), false);
    assert.equal(h.run('activeProjectLearningGroup()'), 'yibo');
    assert.doesNotMatch(h.run(`milestoneCard(DATA.milestones.find(item => item.id === 'yibo'), 0)`), />已完成</);
    h.run('renderMilestones()');
    assert.match(h.nodes.get('milestoneSummary').innerHTML, /0 \/ 3/);

    h.run(`changeTask(${JSON.stringify(selftest)}, true, false); renderMilestones();`);
    assert.equal(h.run(`milestoneProgress(DATA.milestones.find(item => item.id === 'yibo')).checked`), true);
    assert.equal(h.run('activeProjectLearningGroup()'), 'yunzhujiao');
    assert.match(h.run(`milestoneCard(DATA.milestones.find(item => item.id === 'yibo'), 0)`), />已完成</);
    assert.match(h.nodes.get('milestoneSummary').innerHTML, /1 \/ 3/);
    assert.deepEqual(h.json(`state.entries[${JSON.stringify(goal.reviewKey)}]`), originalReview,
      'Completing a project must not create or rewrite an independent review record');

    h.run(`changeTask(${JSON.stringify(selftest)}, false, false); renderMilestones();`);
    assert.equal(h.run(`milestoneProgress(DATA.milestones.find(item => item.id === 'yibo')).checked`), false);
    assert.equal(h.run('activeProjectLearningGroup()'), 'yibo');
    assert.doesNotMatch(h.run(`milestoneCard(DATA.milestones.find(item => item.id === 'yibo'), 0)`), />已完成</);
    assert.match(h.nodes.get('milestoneSummary').innerHTML, /0 \/ 3/);

    h.run(`changeTask(${JSON.stringify(selftest)}, true, false); changeTask(${JSON.stringify(module)}, false, false);`);
    assert.equal(h.run(`taskDone(${JSON.stringify(selftest)})`), true);
    assert.equal(h.run(`milestoneProgress(DATA.milestones.find(item => item.id === 'yibo')).checked`), false,
      'A finished selftest cannot stand in for a canceled earlier required module');
    assert.equal(h.run('activeProjectLearningGroup()'), 'yibo');
    assert.deepEqual(h.json(`state.entries[${JSON.stringify(goal.reviewKey)}]`), originalReview);
  }
});

test('rewritten modules expose reference records from every legacy archive exactly once without inheriting progress', () => {
  const h = harness({
    'old-studio': { done: true, updatedAt: stamp, evidence: '旧整合证据', progress: { kind: 'practice', workedMinutes: 55, completedSteps: [0], note: '原整合笔记' } },
    'old-watch': { done: true, updatedAt: stamp, evidence: '原视频证据', progress: { kind: 'video', segmentIndex: 0, positionSecond: 600, note: '原观看笔记' } },
    'old-exercise': { done: false, updatedAt: stamp, evidence: '更早练习证据', progress: { kind: 'practice', workedMinutes: 23, note: '更早练习笔记' } }
  });
  const records = h.json(`legacyTaskRecords('studio-module').map(source => ({ id: source.task.id, referenceOnly: source.referenceOnly }))`);
  assert.deepEqual(records, ['old-studio', 'old-watch', 'old-exercise'].map(id => ({ id, referenceOnly: true })));
  assert.equal(h.run(`taskDone('studio-module')`), false);
  assert.equal(h.run(`taskProgress('studio-module')`), null);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'studio-module')`), false);
  const report = h.json(`importStateWithReport({ version: 3, archivedEntries: state.entries })`);
  assert.equal(report.matched, 1, 'History remains importable and discoverable from the rewritten module');
  assert.equal(report.activeMatched, 0, 'References cannot make an old backup a complete current-plan replacement');
  const markup = h.run(`legacyTaskRecordMarkup(taskById.get('studio-module'))`);
  for (const value of ['旧整合证据', '原视频证据', '更早练习证据', '原整合笔记', '原观看笔记', '更早练习笔记',
    '不计入当前任务的进度或完成状态']) assert.ok(markup.includes(value), value);
});

test('module detail specifications explain estimates, completion checks and the corresponding original videos', () => {
  const h = harness();
  const markup = h.run(`taskModuleSpecificationMarkup(taskById.get('yibo-module'))`);
  for (const value of ['预计用时依据', '3小时为初估', '模块完成标准', '能演示输入、输出及失败边界',
    '相关课程 · 1 节', '服务基础 · 进程与消息', 'data-prerequisite-task-id="yibo-video"']) assert.ok(markup.includes(value), value);
});

test('project evidence records retain their original scopes and timestamps through backup parsing', async () => {
  const prior = { done: true, updatedAt: stamp, evidence: '旧范围验收及演示链接' };
  const current = { done: false, updatedAt: stamp, evidence: '新模块还需要完整验证' };
  const h = harness({ 'milestone:yibo': prior, 'milestone:studio-baseline': prior });
  assert.equal(h.run('milestoneReview(DATA.milestones[0])'), null);
  assert.match(h.run('milestoneCard(DATA.milestones[0], 0)'), /已有成果记录.*旧范围验收及演示链接/s);
  assert.doesNotMatch(h.run('milestoneCard(DATA.milestones[0], 0)'), /data-state="accepted"/);
  h.run(`state.entries['milestone:modules-v1-yibo'] = createEntry(false, '1970-01-01T00:00:00.000Z')`);
  assert.doesNotMatch(h.run('milestoneCard(DATA.milestones[0], 0)'), /data-historical-review-key="milestone:modules-v1-yibo"/,
    'Restoring an empty backup placeholder must not create a visible historical project record');
  h.run(`state.entries['milestone:modules-v1-yibo'] = ${JSON.stringify(current)}`);
  assert.equal(h.run('milestoneReview(DATA.milestones[0]).done'), false);
  assert.equal(h.run('milestoneReview(DATA.milestones[0]).evidence'), current.evidence);
  const parsed = h.json(`importStateWithReport(${JSON.stringify({ version: 3, milestoneReviews: {
    yibo: prior, 'studio-baseline': prior, 'modules-v1-yibo': current
  } })})`);
  assert.equal(parsed.reviewsMatched, 3);
  assert.deepEqual(parsed.entries['milestone:yibo'], prior);
  assert.deepEqual(parsed.entries['milestone:studio-baseline'], prior);
  assert.deepEqual(parsed.entries['milestone:modules-v1-yibo'], current);
  const archived = h.json(`Object.fromEntries(Object.entries(state.entries).filter(([id]) => !taskById.has(id) && !isMilestoneEntryId(id)))`);
  assert.ok(archived['milestone:yibo']);
  assert.ok(archived['milestone:studio-baseline']);
  assert.equal(archived['milestone:modules-v1-yibo'], undefined);
  h.run('exportData()');
  const backup = JSON.parse(await h.downloads.at(-1).text());
  assert.deepEqual(backup.milestoneReviews['modules-v1-yibo'], current);
  assert.deepEqual(backup.archivedEntries['milestone:yibo'], prior);
  assert.deepEqual(backup.archivedEntries['milestone:studio-baseline'], prior);
  const restored = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  assert.deepEqual(restored.entries['milestone:yibo'], prior);
  assert.deepEqual(restored.entries['milestone:studio-baseline'], prior);
  assert.deepEqual(restored.entries['milestone:modules-v1-yibo'], current);
});

test('retired baseline acceptance stays readable from the reused course project without approving its new scope', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'study-tracker.html'), 'utf8');
  const real = JSON.parse(html.match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
  const prior = { done: true, updatedAt: stamp, evidence: '旧基线构建、采集与SRS运行证据' };
  const h = harness({ 'milestone:studio-baseline': prior }, real);
  const milestone = real.milestones.find(item => item.id === 'studio-course');
  assert.ok(milestone.historicalReviewKeys.includes('milestone:studio-baseline'));
  assert.equal(h.run(`milestoneReview(DATA.milestones.find(item => item.id === 'studio-course'))`), null);
  const markup = h.run(`milestoneCard(DATA.milestones.find(item => item.id === 'studio-course'), 2)`);
  assert.match(markup, /data-historical-review-key="milestone:studio-baseline"/);
  assert.ok(markup.includes(prior.evidence));
  assert.doesNotMatch(markup, /data-state="accepted"/);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'milestone:modules-v1-studio-course')`), false);
});

test('two-day career modules record a 40-minute session without completing the 80-minute module', () => {
  const h = harness();
  completeLearning(h);
  h.run(`todayISO = () => '2027-05-24'; openAppDialog = dialog => { dialog.open = true; };`);
  const card = h.run(`taskMarkup(todayLearningSelection('2027-05-24').tasks[0], true, [], { date: '2027-05-24' })`);
  assert.match(card, /本次 40 分钟.*模块预计总 1 小时 20 分钟/);
  assert.match(card, /data-progress-action="record-session"/);
  assert.doesNotMatch(card, /data-task-action="toggle"/);
  h.run(`openPracticeSessionDialog('resume')`);
  assert.equal(h.nodes.get('practiceSessionDialog').open, true, 'Career modules share the session recording dialog');
  assert.equal(h.nodes.get('practiceSessionInput').value, '40');
  assert.match(h.run(`taskProgressMarkup(taskById.get('resume'))`), /data-progress-kind="practice"/);
  h.run(`saveTaskProgress('resume', { kind: 'practice', workedMinutes: 40, note: '证据初稿，下次完善' })`);
  assert.equal(h.run(`taskDone('resume')`), false);
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run(`todayLearningSelection('2027-05-25').tasks[0].id`), 'resume');
});

test('the normal planner and week preview render continuing sessions and keep optional pools out of fixed capacity', () => {
  const h = harness();
  h.run(`todayISO = () => '2027-05-03'; selectedWeek = 2; selectedPhase = 'courses'; selectedView = 'planner'; renderPlanner(); renderWeekPreview(); renderWeekList();`);
  const planner = h.nodes.get('weekTasks').innerHTML;
  for (const date of ['2027-05-03', '2027-05-04', '2027-05-08']) assert.ok(planner.includes(`day-${date}`), date);
  assert.ok(planner.includes('data-on-demand-tasks'), 'On-demand pools remain visible in their separate planner region');
  assert.equal(planner.includes('day-2027-05-05'), false, 'Suggested pool dates cannot masquerade as fixed calendar days');
  assert.match(planner, /本次 40 分钟.*模块预计总 3 小时/);
  assert.match(h.nodes.get('weekMeta').textContent, /固定 4 小时 40 分钟/,
    'The second week has two 40-minute sessions, 120 video minutes and an 80-minute session');
  assert.ok(h.nodes.get('overviewWeekPreview').innerHTML.includes('data-preview-day="2027-05-03"'));
  assert.match(h.nodes.get('weekList').innerHTML, /yibo-module（续学）/);
});

test('resume, demonstration and target-role readiness allow applications before remaining interview review ends', () => {
  const h = harness();
  for (const id of ['resume', 'demo', 'roles']) h.run(`state.entries['${id}'] = { done: true, updatedAt: '${stamp}' };`);
  assert.equal(h.run('applicationReadiness().ready'), false, 'Career records cannot bypass unfinished mandatory learning');
  completeLearning(h);
  const result = h.json(`applicationReadiness()`);
  assert.equal(result.ready, true);
  assert.equal(result.completed, 3);
  assert.equal(h.run(`taskDone('interview')`), false, 'Remaining interview review continues alongside applications');
  assert.equal(h.run(`learningRecommendation('review', '2027-05-27').next.id`), 'interview');
  h.run('renderMilestones()');
  assert.match(h.nodes.get('applicationMilestone').innerHTML, /可开始投递/);
  h.run(`DATA.applicationMilestone.readinessTaskIds.push('missing-readiness-task')`);
  assert.equal(h.run('applicationReadiness().ready'), false, 'A missing readiness task must not be silently treated as completed');
});

test('platform deadline notices use each project expiry and never defer inaccessible videos to a future Saturday', () => {
  const h = harness();
  const result = h.json(`(() => {
    const yibo = taskById.get('yibo-video'), cloud = taskById.get('cloud-video'), studio = taskById.get('studio-video');
    return { yibo: courseAccessState(yibo, '2027-05-30'), cloud: courseAccessState(cloud, '2027-06-09'),
      studio: courseAccessState(studio, '2027-06-09'), before: pendingCourseReminder(studio, '2027-06-01'),
      finalDay: pendingCourseReminder(studio, '2027-06-07'), after: pendingCourseReminder(studio, '2027-06-09'),
      warning: prerequisiteWarning(taskById.get('studio-module'), '2027-06-09') };
  })()`);
  assert.equal(result.yibo.expiresAt, '2027-05-31');
  assert.equal(result.cloud.expired, false, 'A later per-project deadline overrides the shared fallback');
  assert.equal(result.studio.expired, true);
  assert.equal(result.before.title, '待补课程留到周六');
  assert.match(result.before.description, /2027年6月7日/);
  assert.match(result.finalDay.title, /即将到期/);
  assert.match(result.finalDay.description, /今天是最后一天.*本周六已超过有效期/);
  assert.match(result.after.title, /平台课程已到期/);
  assert.match(result.after.description, /已于 2027年6月7日 到期.*如已保存笔记、代码或课程资料/);
  assert.doesNotMatch(result.after.description, /留到周六/);
  assert.match(result.warning, /平台课程已于 2027年6月7日 到期/);
  assert.doesNotMatch(result.warning, /建议周六先补/);
  assert.equal(h.run(`taskDone('studio-video')`), false);
  assert.deepEqual(h.json('state.entries'), {}, 'Expiry notices cannot alter check-ins or mark inaccessible lessons as completed');
});

test('real week topics preserve concise Zero Voice themes and lesson sources while showing continued project modules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'study-tracker.html'), 'utf8');
  const real = JSON.parse(html.match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
  const h = harness({}, real);
  const configured = real.weeks[0].topics.filter(topic => topic.track === 'ls');
  assert.ok(configured[0].title.trim());
  assert.deepEqual(configured[0].sourceLessonIds, [...new Set(real.weeks[0].tasks.filter(task => task.track === 'ls')
    .flatMap(task => task.segments.map(segment => segment.lessonId)))]);
  assert.ok(configured[0].sourceLessonIds.length > 0);
  assert.deepEqual(h.json(`weekTopics(DATA.weeks[0]).filter(topic => topic.track === 'ls')`), configured,
    'A practice session must not replace the curated lesson theme or lose its source lesson IDs');
  const continuation = real.weeks[2].tasks.find(task => task.workSessions?.some(session => session.date >= real.weeks[3].start));
  assert.ok(continuation, 'The real plan includes a module continuing from week 3 into week 4');
  assert.ok(h.run(`weekTopicsText(DATA.weeks[3], 'ydy')`).includes(`${continuation.title}（续学）`),
    'Project topics must include continued sessions even when configured topics describe only new modules');
  assert.match(harness().run(`weekTopicsText(DATA.weeks[1], 'ydy')`), /yibo-module（续学）/,
    'The second week must retain the module continuation topic');
});

test('every real plan week renders its sessions, mandatory progress and on-demand pools without duplicating stored modules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'study-tracker.html'), 'utf8');
  const real = JSON.parse(html.match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
  const h = harness({}, real);
  const counts = h.json(`(() => {
    const original = allTasks.length;
    for (const week of DATA.weeks) {
      todayISO = () => dateAt(week.start, 2);
      selectedPhase = phaseForWeek(week).id; selectedProgressPhase = selectedPhase; selectedWeek = week.week; selectedView = 'planner';
      renderPlanner(); renderWeekList(); renderWeekPreview(); renderSummary(); renderToday(); renderContinue(); renderMilestones();
    }
    return { original, after: allTasks.length, entries: Object.keys(state.entries).length,
      required: requiredTasks().length, optional: allTasks.filter(task => !isRequiredTask(task)).length };
  })()`);
  assert.equal(counts.after, counts.original, 'Calendar rendering never materializes duplicate module tasks');
  assert.equal(counts.entries, 0, 'Rendering plans and historical gates never writes fake progress');
  assert.equal(counts.required + counts.optional, counts.original);
  assert.match(h.nodes.get('overallProgressSummary').textContent, /全计划必修.*按需补漏/);
});

test('removed FFmpeg videos retain read-only history and exact backup timestamps while current progress remains independent', async () => {
  const first = 'ls40-00649-00688', second = 'ls40-00688-00726';
  const current = realPlan().weeks.flatMap(week => week.tasks).find(task => task.track === 'ls'
    && task.learningSegments.some(segment => segment.sectionId === 'ls-source-069')).id;
  const records = {
    [first]: { done: true, updatedAt: '2026-10-10T04:00:00.000Z', evidence: '原观看 https://example.com/old-flv',
      progress: { kind: 'video', segmentIndex: 0, positionSecond: 600, note: '4.2原笔记保留' } },
    [second]: { done: false, updatedAt: '2026-10-11T04:00:00.000Z',
      progress: { kind: 'video', segmentIndex: 0, positionSecond: 300, note: '旧下半节停点' } }
  };
  const h = harness(records, realPlan());
  h.run(`renderSummary(); renderPlanner(); renderMilestones(); showToast = (...args) => { globalThis.lastVideoToast = args; };`);
  assert.deepEqual(h.json('state.entries'), records, 'Removing course versions never resets or restamps original records');
  assert.doesNotMatch(h.nodes.get('overallProgressSummary').textContent, /选看课程/);
  const goal = h.run(`milestoneCard(DATA.milestones.find(goal => goal.id === 'courses'), 0)`);
  assert.doesNotMatch(goal, /选看课程|按需补漏/);
  const history = h.run(`legacyTaskRecordMarkup(taskById.get(${JSON.stringify(current)}), { readOnly: true })`);
  for (const text of ['4.2原笔记保留', '旧下半节停点', 'https://example.com/old-flv', '原第 1 节 · 10:00',
    '原第 1 节 · 05:00', records[first].updatedAt, records[second].updatedAt]) assert.ok(history.includes(text), text);
  assert.doesNotMatch(history, /data-task-action|data-progress-action|<button/);
  const oldTask = h.json(`legacyReferenceTaskById.get(${JSON.stringify(first)})`);
  const oldSegments = h.json(`taskLearningSegments(${JSON.stringify(oldTask)})`);
  assert.equal(oldSegments.length, 1);
  assert.match(oldSegments[0].title, /4[.]2/);
  h.run('exportData();');
  const backup = JSON.parse(await h.downloads.at(-1).text());
  assert.equal(Object.hasOwn(backup.entries, first), false);
  assert.equal(Object.hasOwn(backup.entries, second), false);
  assert.deepEqual(backup.archivedEntries[first], records[first]);
  assert.deepEqual(backup.archivedEntries[second], records[second]);
  const restored = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  assert.deepEqual(restored.entries[first], records[first]);
  assert.deepEqual(restored.entries[second], records[second]);
  h.run(`saveTaskProgress(${JSON.stringify(current)}, { kind: 'video', segmentIndex: 1, positionSecond: 900, note: '继续新版接口' });`);
  assert.equal(h.run(`taskDone(${JSON.stringify(current)})`), false);
  h.run('lastVideoToast[1].run();');
  assert.equal(h.run(`taskProgress(${JSON.stringify(current)})`), null);
  h.run(`changeTask(${JSON.stringify(current)}, true);`);
  assert.equal(h.run(`taskDone(${JSON.stringify(current)})`), true);
  h.run('lastVideoToast[1].run();');
  assert.equal(h.run(`taskDone(${JSON.stringify(current)})`), false);
  for (const [id, record] of Object.entries(records)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
  assert.equal(h.run(`requiredTasks().filter(task => taskDone(task.id)).length`), 0);
});

test('retired versions disappear from active search while their former weekdays carry the new forty-minute curriculum', () => {
  const plan = realPlan(), h = harness({}, plan);
  h.run(`searchQuery = '4.2'; taskFilter = 'all'; trackFilter = 'ls'; renderPlanner();`);
  assert.equal(h.run(`allTasks.filter(task => task.track === 'ls' && taskSearchText(task).includes('4.2')).length`), 0);
  assert.match(h.nodes.get('weekCount').textContent, /全计划找到 0 项/);
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /ls40-00649-00688|ls40-00688-00726/);
  assert.equal(h.run(`progressScopeTasks({ phase: 'courses', track: 'ls', project: '' }).length`), 122);
  h.run(`for (const task of allTasks.filter(task => task.track === 'ls' && task.date < '2026-10-28'))
    state.entries[task.id] = { done: true, updatedAt: ${JSON.stringify(stamp)} };`);
  for (const date of ['2026-10-28', '2026-10-29']) {
    const expected = plan.weeks.flatMap(week => week.tasks).find(task => task.track === 'ls' && task.date === date);
    assert.ok(expected);
    assert.equal(expected.durationSeconds, 2400);
    assert.deepEqual(h.json(`scheduledTasksForDate(${JSON.stringify(date)}).map(task => task.id)`), [expected.id]);
    const selection = h.json(`(() => { const value = todayLearningSelection(${JSON.stringify(date)});
      return { ids: value.tasks.map(task => task.id), optional: value.optional }; })()`);
    assert.deepEqual(selection.ids, [expected.id]);
    assert.equal(selection.optional, false);
    assert.equal(h.run(`taskDone(${JSON.stringify(expected.id)})`), false, 'Recommendations never write completion');
    h.run(`state.entries[${JSON.stringify(expected.id)}] = { done: true, updatedAt: ${JSON.stringify(stamp)} };`);
  }
  assert.deepEqual(h.json(`todayLearningSelection('2026-11-01').tasks.map(task => task.id)`), [], 'Sunday remains flexible without a default Zero Voice task');
});
