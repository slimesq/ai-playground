'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'tracker-ui.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
const storeKey = 'av_study_tracker_regenerated_v2';
const stamp = '2026-10-10T01:02:03.000Z';
const later = '2026-10-11T02:03:04.000Z';
const entry = (done = true, updatedAt = stamp, extra = {}) => ({ done, updatedAt, ...extra });
const archived = [
  { id: 'old-sample', title: '原格式转换样例', steps: ['定位转换入口', '运行 <RGB> 样例'], durationMinutes: 40 },
  { id: 'old-test', title: '原网络复测', steps: ['准备网络条件', '记录变化'], durationMinutes: 40 }
];
const active = [
  { id: 'chain', title: '采集到输出的完整链路', historicalTaskIds: ['old-sample'], steps: ['验证同一条链路', '保留端到端证据'] },
  { id: 'abr', title: '实现并验收 ABR', historicalTaskIds: ['old-test'], steps: ['接入码率控制', '验证降档和恢复'] }
].map(task => ({ ...task, track: 'ydy', activity: 'project', week: 1, date: '2026-10-17', day: '周六', durationMinutes: 40 }));
const data = { weeks: [{ week: 1, start: '2026-10-12', end: '2026-10-18', tasks: active }], legacyReferenceTasks: archived };
const oldEntries = {
  'old-sample': entry(true, stamp, { evidence: 'https://example.test/old-conversion',
    progress: { kind: 'practice', workedMinutes: 52, completedSteps: [0], note: '原样例笔记 <保留>' } }),
  'old-test': entry(false, later, { evidence: '旧复测 https://example.test/old-network',
    progress: { kind: 'practice', workedMinutes: 23, completedSteps: [0], note: '尚未完成恢复测试' } })
};

function harness(seed, customData = data) {
  const saved = new Map(seed ? [[storeKey, JSON.stringify(seed)]] : []);
  const downloads = [];
  const context = vm.createContext({
    DATA: JSON.parse(JSON.stringify(customData)), console, navigator: { onLine: true },
    localStorage: {
      get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null,
      getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key)
    },
    document: { createElement: () => ({ click() {} }) },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: class extends URL {
      static createObjectURL(blob) { downloads.push(JSON.parse(blob.parts.join(''))); return 'blob:backup'; }
      static revokeObjectURL() {}
    },
    setTimeout: () => 0
  });
  vm.runInContext(source, context);
  vm.runInContext(`render = () => {}; syncToServer = () => {}; showToast = (...args) => { globalThis.lastToastArgs = args; };
    focusSnapshot = () => null; captureToastFocus = () => null; confirmAction = async () => true;`, context);
  return { saved, downloads, run: expression => vm.runInContext(expression, context),
    json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}

test('old completed and partial samples never fill rewritten tasks or their progress', () => {
  const h = harness({ entries: oldEntries });
  for (const task of active) {
    assert.equal(h.run(`taskDone('${task.id}')`), false);
    assert.equal(h.run(`taskEntry('${task.id}')`), null);
    assert.equal(h.run(`taskProgress('${task.id}')`), null);
    assert.equal(h.run(`Object.hasOwn(state.entries, '${task.id}')`), false);
    assert.equal(h.run(`legacyTaskRecords('${task.id}')[0].referenceOnly`), true);
  }
  assert.deepEqual(h.json('state.entries'), oldEntries);
});

test('historical details show old steps, actual time, notes, evidence and original timestamps with clear status separation', () => {
  const h = harness({ entries: oldEntries });
  const completed = h.run(`legacyTaskRecordMarkup(taskById.get('chain'))`);
  for (const text of ['原任务已完成', '原累计投入 52 分钟', '已完成 · 定位转换入口', '已完成 · 运行 &lt;RGB&gt; 样例',
    '原样例笔记 &lt;保留&gt;', 'href="https://example.test/old-conversion"', stamp,
    '不计入当前任务的进度或完成状态', '请按当前任务重新验收']) assert.ok(completed.includes(text), text);
  const partial = h.run(`legacyTaskRecordMarkup(taskById.get('abr'))`);
  for (const text of ['原任务未完成', '原累计投入 23 分钟', '已完成 · 准备网络条件', '未完成 · 记录变化',
    '尚未完成恢复测试', 'https://example.test/old-network', later]) assert.ok(partial.includes(text), text);
});

test('backup round trip retains historical raw records and never invents rewritten progress', async () => {
  const h = harness({ entries: oldEntries });
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  assert.deepEqual(backup.archivedEntries, oldEntries);
  assert.deepEqual(backup.entries, {});
  const restored = harness();
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const [id, record] of Object.entries(oldEntries)) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(id)}]`), record);
  for (const task of active) {
    assert.equal(restored.run(`taskDone('${task.id}')`), false);
    assert.equal(restored.run(`taskProgress('${task.id}')`), null);
  }
  restored.run('lastToastArgs[1].run()');
  for (const id of Object.keys(oldEntries)) assert.equal(restored.run(`Object.hasOwn(state.entries, '${id}')`), false,
    'Undo removes imported historical records that were originally absent');
  for (const task of active) assert.equal(restored.run(`taskProgress('${task.id}')`), null);
});

test('archived-only and snapshot-only imports recognize history without transferring completion', async () => {
  for (const backup of [
    { version: 3, archivedEntries: { 'old-sample': oldEntries['old-sample'] } },
    { version: 3, entrySnapshots: [{ task: archived[0], record: oldEntries['old-sample'] }] }
  ]) {
    const h = harness();
    const report = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
    assert.equal(report.matched, 1);
    assert.equal(report.unmatched, 0);
    await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
    assert.deepEqual(h.json(`state.entries['old-sample']`), oldEntries['old-sample']);
    assert.equal(h.run(`taskDone('chain')`), false);
    assert.equal(h.run(`taskProgress('chain')`), null);
  }
});

test('new completion, cancellation and Undo never mutate historical evidence or actual time', () => {
  const h = harness({ entries: oldEntries });
  h.run(`changeTask('chain', true)`);
  assert.equal(h.run(`taskDone('chain')`), true);
  assert.equal(h.run(`taskProgress('chain')`), null);
  assert.equal(h.run(`taskEntry('chain').evidence`), undefined);
  h.run(`changeTask('chain', false)`);
  assert.equal(h.run(`taskDone('chain')`), false);
  h.run('lastToastArgs[1].run()');
  assert.equal(h.run(`taskDone('chain')`), true);
  for (const [id, record] of Object.entries(oldEntries)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});

test('reset and Undo preserve separate historical and current records', async () => {
  const current = entry(true, later, { evidence: 'https://example.test/new-chain',
    progress: { kind: 'practice', workedMinutes: 42, completedSteps: [0, 1], note: '新的端到端验证' } });
  const h = harness({ entries: { ...oldEntries, chain: current } });
  await h.run('resetAllTasks()');
  assert.equal(h.run(`taskDone('chain')`), false);
  for (const [id, record] of Object.entries(oldEntries)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
  h.run('lastToastArgs[1].run()');
  assert.equal(h.run(`taskDone('chain')`), true);
  assert.deepEqual(h.json(`taskProgress('chain')`), current.progress);
  assert.equal(h.run(`taskEntry('chain').evidence`), current.evidence);
  for (const [id, record] of Object.entries(oldEntries)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});

test('full restore removes historical records absent from the backup and Undo restores original timestamps', async () => {
  const h = harness({ entries: oldEntries });
  const backup = { version: 3, entries: Object.fromEntries(active.map(task => [task.id, entry(false)])) };
  assert.equal(h.run(`importStateWithReport(${JSON.stringify(backup)}).matched`), active.length);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const id of Object.keys(oldEntries)) assert.equal(h.run(`Object.hasOwn(state.entries, '${id}')`), false);
  assert.equal(h.run(`legacyTaskRecordMarkup(taskById.get('chain'))`), '');
  h.run('lastToastArgs[1].run()');
  for (const [id, record] of Object.entries(oldEntries)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
  assert.equal(h.run(`taskDone('chain')`), false);
});

test('missing or duplicate historical references cannot create phantom records', () => {
  const changed = JSON.parse(JSON.stringify(data));
  changed.weeks[0].tasks[0].historicalTaskIds = ['old-sample', 'old-sample', 'unknown-task'];
  const h = harness({ entries: { ...oldEntries, 'unknown-task': entry() } }, changed);
  assert.equal(h.run(`legacyTaskRecords('chain').length`), 1);
  assert.equal(h.run(`taskDone('chain')`), false);
});

function shippedData() {
  const html = fs.readFileSync(path.join(root, 'study-tracker.html'), 'utf8');
  return JSON.parse(html.match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
}

test('shipped rewritten modules retain full historical evidence without inheriting any old completion or worked minutes', () => {
  const shipped = shippedData();
  const all = shipped.weeks.flatMap(week => week.tasks);
  const rewritten = all.filter(task => task.historicalTaskIds?.length);
  const historySources = [...shipped.legacyPracticeTasks, ...shipped.legacyReferenceTasks];
  const references = new Map(historySources.map(task => [task.id, task]));
  assert.ok(rewritten.length > 0);
  assert.ok(references.size >= 169, 'Every retired current task remains available as a historical snapshot');
  assert.equal(references.size, historySources.length);
  for (const task of rewritten) {
    assert.equal(new Set(task.historicalTaskIds).size, task.historicalTaskIds.length);
    assert.equal(task.practiceParts, undefined, 'Different functional work cannot use equivalent-step inheritance');
    for (const id of task.historicalTaskIds) {
      const previous = references.get(id);
      assert.ok(previous, `${task.id}: full historical task ${id} resolves`);
      assert.ok(previous.title && previous.date && previous.budget);
      assert.ok(previous.activity === 'video' ? previous.segments?.length || previous.learningSegments?.length : previous.steps?.length,
        `${previous.id}: archived video intervals or practice steps remain available`);
      assert.ok(!all.some(item => item.id === id), 'Historical work is not assigned a second time');
    }
  }
  for (const completed of [true, false]) {
    const records = Object.fromEntries(historySources.map((task, index) => [task.id, entry(completed,
      new Date(Date.parse(stamp) + index * 60_000).toISOString(), {
        evidence: `https://example.test/original/${index}`,
        progress: { kind: 'practice', workedMinutes: 13 + index, completedSteps: [0], note: `原始第 ${index + 1} 条笔记` }
      })]));
    const h = harness({ entries: records }, shipped);
    for (const task of rewritten) {
      assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), false, task.id);
      assert.equal(h.run(`taskProgress(${JSON.stringify(task.id)})`), null, task.id);
      assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(task.id)})`), false);
      const history = h.json(`legacyTaskRecords(${JSON.stringify(task.id)})`);
      assert.equal(history.length, task.historicalTaskIds.length);
      for (const reference of history) {
        assert.equal(reference.referenceOnly, true);
        assert.deepEqual(reference.record, records[reference.task.id]);
      }
      const markup = h.run(`legacyTaskRecordMarkup(taskById.get(${JSON.stringify(task.id)}))`);
      for (const reference of history) {
        assert.ok(markup.includes(reference.record.updatedAt));
        assert.ok(markup.includes(reference.record.evidence));
      }
    }
    assert.deepEqual(h.json('state.entries'), records, 'Reading history does not materialize new check-ins');
  }
});

test('old interview check-ins cannot satisfy new readiness, while unused optional pools and later review never block an actual ready applicant', () => {
  const shipped = shippedData();
  const oldCareer = shipped.legacyReferenceTasks.filter(task => task.track === 'review' && task.id.startsWith('av52-may-v1-'));
  assert.equal(oldCareer.length, 39, 'The superseded long interview program remains reference-only history');
  const oldRecords = Object.fromEntries(oldCareer.map((task, index) => [task.id, entry(true,
    new Date(Date.parse(stamp) + index * 60_000).toISOString(), { evidence: `https://example.test/old-career/${index}` })]));
  const h = harness({ entries: oldRecords }, shipped);
  assert.equal(h.run('allLearningComplete()'), false);
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run('applicationReadiness().completed'), 0, 'Old done records cannot imply the new application artifacts exist');
  h.run(`for (const task of requiredLearningTasks()) state.entries[task.id] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('allLearningComplete()'), true);
  assert.equal(h.run('applicationReadiness().ready'), false, 'Finished learning alone does not produce a resume or project evidence');
  const readinessIds = shipped.applicationMilestone.readinessTaskIds;
  assert.deepEqual(readinessIds, [...shipped.careerWorkflow.preparationTaskIds, shipped.careerWorkflow.teacherTaskId]);
  assert.equal(readinessIds.length, 8);
  h.run(`for (const id of DATA.applicationMilestone.readinessTaskIds) state.entries[id] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('applicationReadiness().ready'), true);
  assert.equal(h.run(`allTasks.filter(task => task.optional === true).some(task => taskDone(task.id))`), false);
  assert.equal(h.run(`allTasks.filter(task => task.track === 'review' && !DATA.applicationMilestone.readinessTaskIds.includes(task.id)).some(task => taskDone(task.id))`), false,
    'Unstarted later technical review may accompany applications');
  const final = h.run(`requiredLearningTasks().at(-1).id`);
  h.run(`state.entries[${JSON.stringify(final)}] = ${JSON.stringify(entry(false))}`);
  assert.equal(h.run('allLearningComplete()'), false);
  assert.equal(h.run('applicationReadiness().ready'), false, 'Canceling a real required completion restores the prerequisite');
  for (const [id, record] of Object.entries(oldRecords)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});

test('all shipped historical records survive a backup round trip with UTC timestamps and current modules remaining unfilled', async () => {
  const shipped = shippedData();
  const all = shipped.weeks.flatMap(week => week.tasks);
  const historySources = [...shipped.legacyPracticeTasks, ...shipped.legacyReferenceTasks];
  const records = Object.fromEntries(historySources.map((task, index) => [task.id,
    entry(index % 2 === 0, new Date(Date.parse(later) + index * 60_000).toISOString(), {
      evidence: `原学习证据 https://example.test/previous/${index}`,
      progress: { kind: 'practice', workedMinutes: index + 1, completedSteps: [0], note: `原记录 ${index + 1}` }
    })]));
  const original = harness({ entries: records }, shipped);
  original.run('exportData()');
  const backup = original.downloads.at(-1);
  assert.deepEqual(backup.archivedEntries, records);
  const restored = harness(undefined, shipped);
  assert.equal(restored.run(`importStateWithReport(${JSON.stringify(backup)}).matched`), all.length);
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const [id, record] of Object.entries(records)) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(id)}]`), record);
  for (const task of all.filter(item => item.historicalTaskIds?.length)) {
    assert.equal(restored.run(`taskDone(${JSON.stringify(task.id)})`), false);
    assert.equal(restored.run(`taskProgress(${JSON.stringify(task.id)})`), null);
  }
});

test('old project acceptance remains visible history and cannot approve the redesigned milestone scope', async () => {
  const shipped = shippedData();
  const goals = shipped.milestones.filter(goal => goal.kind === 'project');
  const oldKeys = [...new Set([
    ...['yibo', 'yunzhujiao', 'studio-course', 'studio-baseline', 'studio-rtc', 'studio-validation'].map(id => `milestone:${id}`),
    'milestone:modules-v1-studio-rtc', 'milestone:modules-v1-studio-validation',
    'milestone:portfolio-v1-studio-portfolio',
    ...goals.flatMap(goal => goal.historicalReviewKeys || [])
  ])];
  const oldReviews = Object.fromEntries(oldKeys.map((key, index) => [key, entry(true,
    new Date(Date.parse(stamp) + index * 60_000).toISOString(), { evidence: `https://example.test/old-acceptance/${index}` })]));
  const h = harness({ entries: oldReviews }, shipped);
  for (const goal of goals) {
    assert.ok(goal.reviewKey && goal.reviewKey !== `milestone:${goal.id}`);
    assert.equal(h.run(`milestoneReview(DATA.milestones.find(goal => goal.id === ${JSON.stringify(goal.id)}))`), null);
    const history = h.run(`historicalMilestoneReviewsMarkup(DATA.milestones.find(goal => goal.id === ${JSON.stringify(goal.id)}))`);
    assert.ok(history.includes('仅作历史参考'));
    assert.ok(goal.historicalReviewKeys?.length);
    for (const key of goal.historicalReviewKeys) assert.ok(history.includes(oldReviews[key].evidence));
  }
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  for (const [id, record] of Object.entries(oldReviews)) assert.deepEqual(backup.archivedEntries[id], record);
  const restored = harness(undefined, shipped);
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const [id, record] of Object.entries(oldReviews)) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(id)}]`), record);
  for (const goal of goals)
    assert.notEqual(restored.run(`milestoneReview(DATA.milestones.find(goal => goal.id === ${JSON.stringify(goal.id)}))?.done`), true);
});

test('original course completion directly unlocks career preparation while retired polishing remains unfinished history', () => {
  const shipped = shippedData();
  const retired = shipped.legacyReferenceTasks.filter(task => task.id.startsWith('studio-portfolio-v1-')
    || task.id === 'studio-functional-v1-optional-remediation');
  assert.equal(retired.length, 5);
  const records = Object.fromEntries(retired.map((task, index) => [task.id, entry(false,
    new Date(Date.parse(stamp) + index * 60_000).toISOString(), {
      evidence: `https://example.test/canceled-polishing/${index}`,
      progress: { kind: 'practice', workedMinutes: 20 + index, completedSteps: [0], note: `取消的打磨记录 ${index + 1}` }
    })]));
  const h = harness({ entries: records }, shipped);
  assert.equal(h.run('requiredLearningTasks().length'), 184);
  assert.equal(h.run('allLearningComplete()'), false);
  assert.equal(h.run("learningRecommendation('review').blockedByLearning"), true);
  h.run(`for (const task of requiredLearningTasks()) state.entries[task.id] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('allLearningComplete()'), true);
  assert.equal(h.run("learningRecommendation('review').blockedByLearning"), false);
  const firstCareer = shipped.weeks.flatMap(week => week.tasks).find(task => task.track === 'review');
  assert.equal(h.run("learningRecommendation('review', '2027-05-24').next.id"), firstCareer.id);
  assert.deepEqual(h.json(`unfinishedPrerequisites(taskById.get(${JSON.stringify(firstCareer.id)})).map(task => task.id)`), []);
  assert.equal(h.run('applicationReadiness().ready'), false, 'Applications still require actual resume and project materials');
  h.run(`for (const id of DATA.applicationMilestone.readinessTaskIds) state.entries[id] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('applicationReadiness().ready'), true);
  assert.equal(h.run('allTasks.some(task => task.activity === "portfolio" || task.phaseId === "projects")'), false);
  assert.equal(h.run('allTasks.filter(task => task.optional === true).some(task => taskDone(task.id))'), false);
  for (const [id, record] of Object.entries(records)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});

test('old self-written resume records and advance technical check-ins cannot stand in for teacher collaboration', () => {
  const shipped = shippedData();
  const workflow = shipped.careerWorkflow;
  const ids = new Set(['target', 'evidence', 'resume', 'demo', 'resume-revision'].map(key => `career-focused-v1-${key}`));
  const retired = shipped.legacyReferenceTasks.filter(task => ids.has(task.id));
  assert.equal(retired.length, 5);
  const records = Object.fromEntries(retired.map((task, index) => [task.id, entry(true,
    new Date(Date.parse(stamp) + index * 60_000).toISOString(), {
      evidence: `https://example.test/self-resume/${index}`,
      progress: { kind: 'practice', workedMinutes: 31 + index, completedSteps: [0], note: `原自写简历记录 ${index + 1}` }
    })]));
  const h = harness({ entries: records }, shipped);
  h.run(`for (const task of requiredLearningTasks()) state.entries[task.id] = ${JSON.stringify(entry())}`);
  for (const id of [...workflow.preparationTaskIds, workflow.teacherTaskId, 'career-teacher-v1-feedback']) {
    assert.equal(h.run(`taskDone(${JSON.stringify(id)})`), false);
    assert.equal(h.run(`taskProgress(${JSON.stringify(id)})`), null);
    assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(id)})`), false);
  }
  h.run(`for (const id of DATA.careerWorkflow.interviewTaskIds) state.entries[id] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run("learningRecommendation('review', '2027-05-24').next.id"), workflow.preparationTaskIds[0],
    'Advance technical check-ins cannot skip the new material-preparation stage');
  h.run(`for (const id of DATA.careerWorkflow.preparationTaskIds) state.entries[id] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run("learningRecommendation('review', '2027-05-24').next.id"), workflow.teacherTaskId,
    'Finished material preparation still waits for actual teacher confirmation');
  h.run(`state.entries[DATA.careerWorkflow.teacherTaskId] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('applicationReadiness().ready'), true);
  h.run(`state.entries[DATA.careerWorkflow.teacherTaskId] = ${JSON.stringify(entry(false))}`);
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run('DATA.careerWorkflow.interviewTaskIds.every(id => taskDone(id))'), true,
    'Revoking teacher confirmation restores the gate without deleting advance technical records');
  for (const [id, record] of Object.entries(records)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});

test('teacher confirmation still requires the newly added remote-control material while original learning remains unchanged', () => {
  const shipped = shippedData(), h = harness(undefined, shipped);
  const remote = 'career-materials-v2-remote';
  assert.equal(shipped.careerWorkflow.preparationTaskIds[0], remote);
  assert.equal(h.run('requiredLearningTasks().length'), 184);
  h.run(`for (const task of requiredLearningTasks()) state.entries[task.id] = ${JSON.stringify(entry())}`);
  h.run(`for (const id of [...DATA.careerWorkflow.preparationTaskIds, DATA.careerWorkflow.teacherTaskId,
      ...DATA.careerWorkflow.interviewTaskIds].filter(id => id !== ${JSON.stringify(remote)}))
    state.entries[id] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('allLearningComplete()'), true, 'A completed remote project creates no new course prerequisite');
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run('careerWorkflowState().teacherConfirmed'), false);
  assert.equal(h.run("learningRecommendation('review', '2027-05-24').next.id"), remote,
    'Later records cannot skip the missing remote-control material');
  h.run(`state.entries[${JSON.stringify(remote)}] = ${JSON.stringify(entry())}`);
  assert.equal(h.run('careerWorkflowState().teacherConfirmed'), true);
  assert.equal(h.run('applicationReadiness().ready'), true);
});

test('old forty-minute material completions remain readable history without completing or crediting the longer project and skill modules', () => {
  const shipped = shippedData();
  const ids = new Set(['remote-materials', 'yibo-materials', 'cloud-materials', 'studio-materials', 'skills', 'brief']
    .map(key => `career-teacher-v1-${key}`));
  const old = shipped.legacyReferenceTasks.filter(task => ids.has(task.id));
  assert.equal(old.length, 6);
  const records = Object.fromEntries(old.map((task, index) => [task.id, entry(true,
    new Date(Date.parse(stamp) + index * 60_000).toISOString(), { evidence: `https://example.test/short-materials/${index}`,
      progress: { kind: 'practice', workedMinutes: 40, completedSteps: [0, 1], note: `原40分钟材料记录 ${index + 1}` } })]));
  const h = harness({ entries: records }, shipped);
  h.run(`for (const task of requiredLearningTasks()) state.entries[task.id] = ${JSON.stringify(entry())}`);
  for (const id of shipped.careerWorkflow.preparationTaskIds) {
    const task = shipped.weeks.flatMap(week => week.tasks).find(item => item.id === id);
    assert.equal(h.run(`taskDone(${JSON.stringify(id)})`), false);
    assert.equal(h.run(`taskProgress(${JSON.stringify(id)})`), null);
    assert.equal(h.run(`practiceRemainingMinutes(taskById.get(${JSON.stringify(id)}))`), task.durationMinutes,
      'Old minutes do not silently reduce a re-estimated module budget');
  }
  assert.equal(h.run('careerWorkflowState().preparationComplete'), false);
  assert.equal(h.run('applicationReadiness().ready'), false);
  const linkedHistory = h.json(`[...DATA.careerWorkflow.preparationTaskIds, DATA.careerWorkflow.teacherTaskId]
    .flatMap(id => legacyTaskRecords(id).map(source => ({ id: source.task.id, referenceOnly: source.referenceOnly })))`);
  for (const oldId of ids)
    assert.ok(linkedHistory.some(source => source.id === oldId && source.referenceOnly),
      `${oldId}: the original short note remains discoverable as history`);
  const remote = shipped.careerWorkflow.projectPreparationTaskIds[0];
  h.run(`state.entries[${JSON.stringify(remote)}] = ${JSON.stringify(entry(false, later, {
    progress: { kind: 'practice', workedMinutes: 40, completedSteps: [0], note: '新模块首日进度' }
  }))}`);
  assert.equal(h.run(`practiceRemainingMinutes(taskById.get(${JSON.stringify(remote)}))`), 120);
  assert.equal(h.run(`taskDone(${JSON.stringify(remote)})`), false, 'One daily session does not complete the four-session module');
  const yibo = shipped.careerWorkflow.projectPreparationTaskIds[1];
  assert.equal(h.run(`scheduledTasksForDate('2027-05-28').find(task => task.id === ${JSON.stringify(yibo)}).id`), yibo);
  assert.equal(h.run(`scheduledTasksForDate('2027-05-31').find(task => task.id === ${JSON.stringify(yibo)}).id`), yibo);
  for (const [id, record] of Object.entries(records)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});

test('removed FFmpeg 4.2 lessons become exact historical records and never complete the required 6.0 version', async () => {
  const shipped = shippedData();
  const ids = ['ls40-00649-00688', 'ls40-00688-00726'];
  const currentId = shipped.weeks.flatMap(week => week.tasks).find(task => task.track === 'ls'
    && task.learningSegments.some(segment => segment.sectionId === 'ls-source-069')).id;
  for (const done of [false, true]) {
    const records = Object.fromEntries(ids.map((id, index) => [id, entry(done,
      new Date(Date.parse(stamp) + index * 60_000).toISOString(), { evidence: `https://example.test/ffmpeg42/${index}`,
        progress: { kind: 'video', segmentIndex: 0, positionSecond: 73 + index, note: `原4.2观看记录 ${index + 1}` } })]));
    const h = harness({ entries: records }, shipped);
    assert.equal(h.run('requiredLearningTasks().length'), 184);
    assert.equal(h.run("learningRecommendation('ls').tasks.length"), 122);
    for (const id of ids) {
      assert.equal(h.run(`taskById.has(${JSON.stringify(id)})`), false);
      assert.equal(h.run(`scheduledTasksForDate(${JSON.stringify(id === ids[0] ? '2026-10-28' : '2026-10-29')}).some(task => task.id === ${JSON.stringify(id)})`), false);
    }
    assert.equal(h.run('scheduledTasksForWeek(4).filter(task => task.track === "ls").length'), 5);
    assert.equal(h.run(`taskDone(${JSON.stringify(currentId)})`), false, 'Old-version completion is never completion of the newer lesson');
    assert.equal(h.run(`taskProgress(${JSON.stringify(currentId)})`), null, 'Old notes and stop positions do not become current progress');
    const history = h.json(`legacyTaskRecords(${JSON.stringify(currentId)})`);
    assert.deepEqual(history.map(source => source.task.id), ids);
    for (const source of history) {
      assert.equal(source.referenceOnly, true);
      assert.deepEqual(source.record, records[source.task.id]);
    }
    assert.equal(h.run("milestoneTasks(DATA.milestones.find(goal => goal.id === 'courses')).length"), 122);
    h.run(`for (const task of requiredLearningTasks().filter(task => task.id !== ${JSON.stringify(currentId)})) state.entries[task.id] = ${JSON.stringify(entry())}`);
    assert.equal(h.run('allLearningComplete()'), false, 'The newer lesson remains a real requirement even if old lessons were completed');
    assert.equal(h.run("learningRecommendation('review').blockedByLearning"), true);
    h.run(`state.entries[${JSON.stringify(currentId)}] = ${JSON.stringify(entry())}`);
    assert.equal(h.run('allLearningComplete()'), true, 'Incomplete retired videos never block current learning completion');
    assert.equal(h.run("learningRecommendation('review').blockedByLearning"), false);
    for (const id of ids) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), records[id]);
    h.run('exportData()');
    const backup = h.downloads.at(-1);
    for (const id of ids) {
      assert.equal(Object.hasOwn(backup.entries, id), false);
      assert.deepEqual(backup.archivedEntries[id], records[id], 'Retired lessons export as exact original histories');
    }
    const restored = harness(undefined, shipped);
    await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
    for (const id of ids) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(id)}]`), records[id]);
    assert.equal(restored.run(`taskDone(${JSON.stringify(currentId)})`), true, 'The explicitly completed newer lesson restores independently');
  }
});

test('old-version-only and snapshot-only imports preserve timestamps without deriving or replacing the new-version record', async () => {
  const shipped = shippedData();
  const ids = ['ls40-00649-00688', 'ls40-00688-00726'];
  const currentId = shipped.weeks.flatMap(week => week.tasks).find(task => task.track === 'ls'
    && task.learningSegments.some(segment => segment.sectionId === 'ls-source-069')).id;
  const records = Object.fromEntries(ids.map((id, index) => [id, entry(true,
    new Date(Date.parse(stamp) + index * 60_000).toISOString(), { evidence: `https://example.test/old-only/${index}`,
      progress: { kind: 'video', segmentIndex: 0, positionSecond: 100 + index, note: `历史记录 ${index + 1}` } })]));
  const current = entry(false, later, { evidence: '新版已经开始',
    progress: { kind: 'video', segmentIndex: 1, positionSecond: 180, note: '新版停点独立保留' } });
  const snapshots = ids.map(id => ({ taskId: id, task: shipped.legacyReferenceTasks.find(task => task.id === id), record: records[id] }));
  for (const backup of [{ version: 3, entries: records }, { version: 3, archivedEntries: records }, { version: 3, entrySnapshots: snapshots }]) {
    const h = harness({ entries: { [currentId]: current } }, shipped);
    const report = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
    assert.equal(report.activeMatched, 0);
    assert.equal(report.historyMatched, 2);
    assert.equal(Object.hasOwn(report.entries, currentId), false);
    for (const id of ids) assert.deepEqual(report.entries[id], records[id]);
    await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
    assert.deepEqual(h.json(`state.entries[${JSON.stringify(currentId)}]`), current);
    for (const id of ids) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), records[id]);
    h.run('lastToastArgs[1].run()');
    assert.deepEqual(h.json(`state.entries[${JSON.stringify(currentId)}]`), current);
    for (const id of ids) assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(id)})`), false, 'Undo removes only the newly imported archived histories');
  }
});

test('a history-only import preserves an existing new-module completion instead of treating related old references as a full restore', async () => {
  const shipped = shippedData();
  const task = shipped.weeks.flatMap(week => week.tasks).find(item => item.historicalTaskIds?.length && item.track === 'ydy');
  assert.ok(task);
  const current = entry(true, later, { evidence: 'https://example.test/new-module-proof',
    progress: { kind: 'practice', workedMinutes: 73, completedSteps: [0], note: '新模块实测结果' } });
  const oldRecords = Object.fromEntries(shipped.legacyReferenceTasks.map((item, index) => [item.id,
    entry(true, new Date(Date.parse(stamp) + index * 60_000).toISOString(), { evidence: `https://example.test/history/${index}` })]));
  const h = harness({ entries: { [task.id]: current } }, shipped);
  const backup = { version: 3, archivedEntries: oldRecords };
  const report = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  assert.ok(report.matched > 0, 'Related old evidence remains discoverable');
  assert.equal(report.activeMatched, 0, 'Reference-only history cannot stand in for current task data');
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.deepEqual(h.json(`state.entries[${JSON.stringify(task.id)}]`), current);
  assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), true);
  for (const [id, record] of Object.entries(oldRecords)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});
