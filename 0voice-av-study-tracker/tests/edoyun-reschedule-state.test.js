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
const segment = (sectionId, startSecond, endSecond) => ({ sectionId, startSecond, endSecond, totalSeconds: 100, title: sectionId });
const legacyVideoTasks = [
  { id: 'old-first', title: '原第一课', learningSegments: [segment('A', 0, 40)] },
  { id: 'old-second', title: '原第二课', learningSegments: [segment('A', 40, 100), segment('B', 0, 40)] },
  { id: 'old-third', title: '原第三课', learningSegments: [segment('B', 40, 100)] },
  { id: 'old-later', title: '原第四课', learningSegments: [segment('C', 0, 100)] }
];
const tasks = [
  { id: 'new-main', title: '五小时课程', track: 'ydy', activity: 'video', learningSegments: [segment('A', 0, 100), segment('B', 0, 100)] },
  { id: 'new-later', title: '下一次课程', track: 'ydy', activity: 'video', learningSegments: [segment('C', 0, 100)] },
  { id: 'practice', title: '代码复现', track: 'ydy', activity: 'practice', steps: ['复现功能'], durationMinutes: 60 }
].map(task => ({ ...task, date: '2026-10-17', day: '周六', week: 1 }));
const data = { weeks: [{ week: 1, start: '2026-10-12', end: '2026-10-18', tasks }], legacyVideoTasks };
const entry = (done = true, updatedAt = stamp, extras = {}) => ({ done, updatedAt, ...extras });
const legacyPracticeTasks = [
  { id: 'old-practice-first', title: '原云助教复现', durationMinutes: 9, steps: ['启动服务', '测试上传', '保存演示'] },
  { id: 'old-practice-second', title: '原云助教验证', durationMinutes: 4, steps: ['异常重试', '保存测试报告'] }
];
const practicePart = (sourceTaskId, sourceStepIndex, startSecond, endSecond) => ({ sourceTaskId, sourceStepIndex, startSecond, endSecond });
const splitPracticeTasks = [
  { id: 'new-practice-first', title: '云助教第一周复现', steps: ['启动服务', '测试上传'], practiceParts: [
    practicePart('old-practice-first', 0, 0, 180), practicePart('old-practice-first', 1, 180, 360)
  ] },
  { id: 'new-practice-second', title: '云助教第二周复现', steps: ['保存演示', '异常重试'], practiceParts: [
    practicePart('old-practice-first', 2, 360, 540), practicePart('old-practice-second', 0, 0, 120)
  ] },
  { id: 'new-practice-third', title: '云助教第三周复现', steps: ['保存测试报告'], practiceParts: [
    practicePart('old-practice-second', 1, 120, 240)
  ] }
].map((task, index) => ({ ...task, track: 'ydy', activity: 'practice', projectId: 'assistant',
  date: `2026-10-${17 + index}`, day: '周六', week: index + 1, durationMinutes: task.practiceParts.reduce((total, part) => total + part.endSecond - part.startSecond, 0) / 60 }));
const practiceData = { ...data, legacyPracticeTasks, weeks: [
  { ...data.weeks[0], tasks: [...tasks, splitPracticeTasks[0]] },
  { week: 2, start: '2026-10-19', end: '2026-10-25', tasks: [splitPracticeTasks[1]] },
  { week: 3, start: '2026-10-26', end: '2026-11-01', tasks: [splitPracticeTasks[2]] }
] };
const practiceRecords = {
  'old-practice-first': entry(true, stamp, { evidence: 'https://example.test/original-demo',
    progress: { kind: 'practice', workedMinutes: 14, completedSteps: [0], note: '原始完成笔记' } }),
  'old-practice-second': entry(false, later, { evidence: '原始验证记录 https://example.test/retry',
    progress: { kind: 'practice', workedMinutes: 3, completedSteps: [0], note: '还需要保存测试报告' } })
};
const generationData = {
  ...data, legacyVideoTasks: [...legacyVideoTasks, {
    id: 'five-hour-middle', title: '五小时版中段课程', generation: 2,
    learningSegments: [segment('A', 20, 80), segment('B', 20, 80)]
  }]
};

function shippedData() {
  const html = fs.readFileSync(path.join(root, 'study-tracker.html'), 'utf8');
  return JSON.parse(html.match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
}

function archivedPracticeSplitData() {
  const plan = shippedData();
  // These equivalent split generations remain supported by the migration
  // reader. Current functional modules intentionally reference them only as
  // history, so exercise the archived definitions in an isolated old plan.
  const practices = plan.legacyReferenceTasks.filter(task => task.practiceParts?.length);
  return { ...plan, weeks: plan.weeks.map(week => ({ ...week,
    tasks: [...week.tasks.filter(task => task.activity === 'video'), ...practices.filter(task => task.week === week.week)] })) };
}

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
    URL: { createObjectURL: blob => { downloads.push(JSON.parse(blob.parts.join(''))); return 'blob:backup'; }, revokeObjectURL() {} },
    setTimeout: () => 0
  });
  vm.runInContext(source, context);
  vm.runInContext(`render = () => {}; syncToServer = () => {}; showToast = (...args) => { globalThis.lastToastArgs = args; };
    focusSnapshot = () => null; captureToastFocus = () => null; confirmAction = async () => true;`, context);
  return { saved, downloads, run: expression => vm.runInContext(expression, context),
    json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}

test('old completed intervals count a new task only when every second is covered', () => {
  const h = harness({ entries: { 'old-first': entry(), 'old-second': entry(true, later, { evidence: 'https://example.test/demo' }) } });
  assert.equal(h.run(`taskDone('new-main')`), false);
  assert.deepEqual(h.json(`taskProgress('new-main')`), { kind: 'video', segmentIndex: 1, positionSecond: 40 });
  assert.equal(h.run(`Object.hasOwn(state.entries, 'new-main')`), false, 'Reading completion must not write a synthetic check-in');
  h.run(`state.entries['old-third'] = ${JSON.stringify(entry())}`);
  assert.equal(h.run(`taskDone('new-main')`), true);
  assert.equal(h.run(`taskEntry('new-main').updatedAt`), later, 'Derived display retains a real source timestamp');
  assert.match(h.run(`taskEntry('new-main').evidence`), /https:\/\/example.test\/demo/);
  assert.equal(h.run(`taskDone('new-later')`), false, 'Completing one course cannot cover an unrelated section');
});

test('a later completed interval or a later partial stop never jumps an earlier gap', () => {
  const h = harness({ entries: { 'old-first': entry(), 'old-third': entry() } });
  assert.deepEqual(h.json(`taskProgress('new-main')`), { kind: 'video', segmentIndex: 0, positionSecond: 40 });
  const progress = { kind: 'video', segmentIndex: 1, positionSecond: 25, note: '下次继续联调示例' };
  h.run(`state.entries['old-second'] = ${JSON.stringify(entry(false, later, { progress }))}`);
  assert.deepEqual(h.json(`taskProgress('new-main')`), { kind: 'video', segmentIndex: 1, positionSecond: 25, note: '原第二课：下次继续联调示例' });
  assert.equal(h.run(`taskDone('new-main')`), false, 'A stop point does not imply completion');
  h.run(`delete state.entries['old-first']`);
  assert.equal(h.run(`taskProgress('new-main').segmentIndex`), 0);
  assert.equal(h.run(`taskProgress('new-main').positionSecond`), 0, 'Earlier missing coverage takes precedence over a later valid stop');
});

test('an end stop remains unfinished and an invalid legacy stop cannot manufacture coverage', () => {
  const h = harness({ entries: { 'old-first': entry(), 'old-second': entry(),
    'old-third': entry(false, later, { progress: { kind: 'video', segmentIndex: 0, positionSecond: 100 } }) } });
  assert.equal(h.run(`taskDone('new-main')`), false);
  assert.deepEqual(h.json(`taskProgress('new-main')`), { kind: 'video', segmentIndex: 1, positionSecond: 100 });
  h.run(`state.entries['old-third'].progress.positionSecond = 101`);
  assert.equal(h.run(`taskProgress('new-main').positionSecond`), 40);
  assert.equal(h.run(`taskDone('new-main')`), false);
});

test('new-task cancellation, partial editing and remote legacy updates respect the explicit new entry', () => {
  const h = harness({ entries: Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()])) });
  assert.equal(h.run(`taskDone('new-main')`), true);
  h.run(`changeTask('new-main', false)`);
  assert.equal(h.run(`taskDone('new-main')`), false);
  h.run(`state.entries = mergeEntryMaps(state.entries, { 'old-first': ${JSON.stringify(entry(true, '2030-01-01T00:00:00.000Z'))} })`);
  assert.equal(h.run(`taskDone('new-main')`), false);
  const progress = { kind: 'video', segmentIndex: 0, positionSecond: 30, note: '重新观看' };
  h.run(`saveTaskProgress('new-main', ${JSON.stringify(progress)})`);
  assert.deepEqual(h.json(`taskProgress('new-main')`), progress);
  assert.equal(h.run(`taskDone('new-main')`), false);
  assert.equal(h.run(`taskDone('new-later')`), true);
  assert.equal(h.run(`state.entries['old-second'].updatedAt`), stamp);
});

test('v3 export/import preserves retired records and stop provenance without creating blank overrides', async () => {
  const old = { 'old-first': entry(), 'old-second': entry(false, later, { evidence: '旧演示链接 https://example.test/code',
    progress: { kind: 'video', segmentIndex: 1, positionSecond: 25, note: '保留原始笔记' } }) };
  const h = harness({ archivedEntries: old });
  assert.equal(h.run(`taskProgress('new-main').positionSecond`), 25);
  const markup = h.run(`legacyTaskRecordMarkup(taskById.get('new-main'))`);
  assert.match(markup, /原第二课/);
  assert.match(markup, /保留原始笔记/);
  assert.match(markup, /2026-10-11T02:03:04.000Z/);
  assert.match(markup, /https:\/\/example.test\/code/);
  h.run(`exportData()`);
  const backup = h.downloads.at(-1);
  assert.equal(backup.version, 3);
  assert.equal(Object.hasOwn(backup.entries, 'new-main'), false, 'A blank export record must not hide the archived partial stop');
  assert.equal(backup.entrySnapshots.some(item => item.taskId === 'new-main'), false);
  assert.deepEqual(backup.archivedEntries, old);
  const restored = harness();
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(restored.run(`taskProgress('new-main').positionSecond`), 25);
  assert.equal(restored.run(`state.entries['old-second'].updatedAt`), later);
  assert.equal(restored.run(`taskDone('new-main')`), false);
  assert.equal(restored.run(`Object.hasOwn(state.entries, 'new-main')`), false);
  const reloaded = harness(JSON.parse(restored.saved.get(storeKey)));
  assert.deepEqual(reloaded.json(`taskProgress('new-main')`), restored.json(`taskProgress('new-main')`));
});

test('explicit false survives backup restore; clear and Undo preserve derived state and original archives', async () => {
  const old = Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()]));
  const h = harness({ entries: old });
  await h.run(`resetAllTasks()`);
  assert.equal(h.run(`taskDone('new-main')`), false);
  assert.equal(h.run(`taskDone('new-later')`), false);
  for (const [id, record] of Object.entries(old)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
  h.run(`lastToastArgs[1].run()`);
  assert.equal(h.run(`taskDone('new-main')`), true);
  assert.equal(h.run(`taskDone('new-later')`), true);
  h.run(`changeTask('new-main', false); exportData()`);
  const backup = h.downloads.at(-1);
  const restored = harness();
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(restored.run(`taskDone('new-main')`), false);
  assert.equal(restored.run(`taskDone('new-later')`), true);
  assert.deepEqual(restored.json(`state.entries['old-first']`), old['old-first']);
});

test('old snapshots and archived-only backups restore recognized sources, and partial import Undo removes their effect', async () => {
  const h = harness();
  const backup = { version: 3, archivedEntries: { 'old-first': entry() }, entrySnapshots: [
    { task: { id: 'old-second' }, record: entry() }, { taskId: 'old-third', record: entry() }
  ] };
  const report = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  assert.equal(report.matched, 1);
  assert.equal(report.unmatched, 0);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(h.run(`taskDone('new-main')`), true);
  h.run(`lastToastArgs[1].run()`);
  assert.equal(h.run(`taskDone('new-main')`), false, 'Undo must include imported retired IDs, not only active IDs');
  assert.equal(h.run(`taskProgress('new-main')`), null);
});

test('Undo of a complete old backup restores removed new-task cancellations and saved stops', async () => {
  const prior = {
    'new-main': entry(false, later, { progress: { kind: 'video', segmentIndex: 0, positionSecond: 30, note: '新排期重新观看' } }),
    'new-later': entry(true, later, { evidence: '新排期已完成的验证', progress: { kind: 'video', segmentIndex: 0, positionSecond: 100 } })
  };
  const backup = { version: 3, entries: { practice: entry(false), ...Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()])) } };
  const h = harness({ entries: prior });
  assert.equal(h.run(`importStateWithReport(${JSON.stringify(backup)}).matched`), tasks.length);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'new-main')`), false, 'The old full backup restores raw source records without inventing new IDs');
  assert.equal(h.run(`taskDone('new-main')`), true);
  h.run(`lastToastArgs[1].run()`);
  for (const [id, record] of Object.entries(prior)) {
    assert.equal(h.run(`taskDone(${JSON.stringify(id)})`), record.done);
    assert.deepEqual(h.json(`taskProgress(${JSON.stringify(id)})`), record.progress);
    assert.equal(h.run(`taskEntry(${JSON.stringify(id)}).evidence || ''`), record.evidence || '');
  }
  assert.equal(h.run(`taskDone('new-main')`), false, 'Older archived completion cannot revive the cancellation after Undo');
});

test('split practice inherits source steps and apportions actual minutes without duplicating work', () => {
  const h = harness({ entries: practiceRecords }, practiceData);
  assert.equal(h.run(`taskDone('new-practice-first')`), true);
  assert.deepEqual(h.json(`taskProgress('new-practice-first')`), {
    kind: 'practice', workedMinutes: 6, completedSteps: [0, 1], note: '原云助教复现：原始完成笔记'
  });
  assert.deepEqual(h.json(`taskProgress('new-practice-second')`), {
    kind: 'practice', workedMinutes: 10, completedSteps: [0, 1], note: '原云助教复现：原始完成笔记\n原云助教验证：还需要保存测试报告'
  });
  assert.equal(h.run(`taskDone('new-practice-second')`), false, 'Completing all mapped steps does not manufacture a check-in for an unfinished source');
  assert.equal(h.run(`taskProgress('new-practice-third').workedMinutes`), 1, 'Rounded cumulative allocation preserves the final remainder');
  assert.equal(h.run(`allTasks.filter(task => task.practiceParts).reduce((sum, task) => sum + taskProgress(task.id).workedMinutes, 0)`), 17);
  assert.equal(h.run(`taskEntry('new-practice-first').updatedAt`), stamp);
  assert.equal(h.run(`taskEntry('new-practice-second').updatedAt`), later);
  assert.match(h.run(`taskEntry('new-practice-second').evidence`), /https:\/\/example.test\/original-demo/);
  assert.match(h.run(`taskEntry('new-practice-second').evidence`), /https:\/\/example.test\/retry/);
  assert.deepEqual(h.json('state.entries'), practiceRecords, 'Derived reads must leave only the raw original records in storage');
  const markup = h.run(`legacyTaskRecordMarkup(taskById.get('new-practice-second'))`);
  for (const text of ['原云助教复现', '原累计投入 14 分钟', '保存演示', '原云助教验证', '还需要保存测试报告', stamp, later, 'https://example.test/retry']) {
    assert.ok(markup.includes(text), text);
  }
});

test('practice time and checked steps alone never imply done; malformed or missing sources cannot complete a task', () => {
  const h = harness({ entries: practiceRecords }, practiceData);
  h.run(`state.entries['old-practice-first'].done = false; state.entries['old-practice-first'].progress.completedSteps = [0, 1, 2]`);
  assert.deepEqual(h.json(`taskProgress('new-practice-first').completedSteps`), [0, 1]);
  assert.equal(h.run(`taskDone('new-practice-first')`), false);
  h.run(`state.entries['old-practice-first'].done = true; delete state.entries['old-practice-second']`);
  assert.equal(h.run(`taskDone('new-practice-second')`), false);
  assert.deepEqual(h.json(`taskProgress('new-practice-second').completedSteps`), [0]);
  h.run(`taskById.get('new-practice-first').practiceParts[0].endSecond = 10000`);
  assert.equal(h.run(`taskEntry('new-practice-first')`), null, 'Out-of-source ranges cannot derive completion or actual time');
});

test('explicit new practice cancellation and progress override old completion even after remote merges', () => {
  const complete = Object.fromEntries(legacyPracticeTasks.map(task => [task.id, entry()]));
  const h = harness({ entries: complete }, practiceData);
  h.run(`changeTask('new-practice-first', false)`);
  assert.equal(h.run(`taskDone('new-practice-first')`), false);
  h.run(`state.entries = mergeEntryMaps(state.entries, { 'old-practice-first': ${JSON.stringify(entry(true, '2030-01-01T00:00:00.000Z'))} })`);
  assert.equal(h.run(`taskDone('new-practice-first')`), false);
  assert.equal(h.run(`taskDone('new-practice-second')`), true, 'Other new tasks still inherit their own source records');
  const progress = { kind: 'practice', workedMinutes: 1, completedSteps: [], note: '取消误打卡后重新复现' };
  h.run(`saveTaskProgress('new-practice-first', ${JSON.stringify(progress)})`);
  assert.deepEqual(h.json(`taskProgress('new-practice-first')`), progress);
  h.run(`state.entries = mergeEntryMaps(state.entries, { 'new-practice-first': ${JSON.stringify(entry(true, stamp))} })`);
  assert.equal(h.run(`taskDone('new-practice-first')`), false, 'An older remote explicit entry cannot replace the local cancellation');
  assert.deepEqual(h.json(`taskProgress('new-practice-first')`), progress);
});

test('practice clear and Undo preserve inherited progress and every original raw source', async () => {
  const h = harness({ entries: practiceRecords }, practiceData);
  const inherited = h.json(`taskProgress('new-practice-first')`);
  await h.run('resetAllTasks()');
  assert.equal(h.run(`taskDone('new-practice-first')`), false);
  assert.deepEqual(h.json(`taskProgress('new-practice-first')`), inherited);
  for (const [id, record] of Object.entries(practiceRecords)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
  h.run(`lastToastArgs[1].run()`);
  assert.equal(h.run(`taskDone('new-practice-first')`), true);
  assert.equal(h.run(`taskDone('new-practice-second')`), false);
  assert.deepEqual(h.json(`taskProgress('new-practice-first')`), inherited);
  for (const [id, record] of Object.entries(practiceRecords)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
});

test('practice v3 export and full restore retain raw source dates without blank new overrides', async () => {
  const h = harness({ archivedEntries: practiceRecords }, practiceData);
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  assert.deepEqual(backup.archivedEntries, practiceRecords);
  for (const task of splitPracticeTasks) {
    assert.equal(Object.hasOwn(backup.entries, task.id), false);
    assert.equal(backup.entrySnapshots.some(item => item.taskId === task.id), false);
  }
  const restored = harness(undefined, practiceData);
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const task of splitPracticeTasks) {
    assert.deepEqual(restored.json(`taskEntry(${JSON.stringify(task.id)})`), h.json(`taskEntry(${JSON.stringify(task.id)})`));
    assert.equal(restored.run(`Object.hasOwn(state.entries, ${JSON.stringify(task.id)})`), false);
  }
  for (const [id, record] of Object.entries(practiceRecords)) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(id)}]`), record);
  const reloaded = harness(JSON.parse(restored.saved.get(storeKey)), practiceData);
  assert.deepEqual(reloaded.json(`taskProgress('new-practice-second')`), h.json(`taskProgress('new-practice-second')`));
});

test('archived and snapshot practice sources import together; partial Undo removes their inherited effect', async () => {
  const backup = { version: 3, archivedEntries: { 'old-practice-first': practiceRecords['old-practice-first'] },
    entrySnapshots: [{ taskId: 'old-practice-second', record: practiceRecords['old-practice-second'] }] };
  const h = harness(undefined, practiceData);
  const report = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  assert.equal(report.matched, 3);
  assert.equal(report.unmatched, 0);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(h.run(`taskDone('new-practice-first')`), true);
  assert.deepEqual(h.json(`taskProgress('new-practice-second').completedSteps`), [0, 1]);
  h.run(`lastToastArgs[1].run()`);
  assert.equal(h.run(`taskDone('new-practice-first')`), false);
  assert.equal(h.run(`taskProgress('new-practice-second')`), null);
});

test('a full old practice backup and its Undo restore active explicit false and partial edits', async () => {
  const old = { ...Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()])),
    ...Object.fromEntries(legacyPracticeTasks.map(task => [task.id, entry()])), practice: entry(false) };
  const prior = {
    'new-practice-first': entry(false, later, { evidence: '误打卡已取消', progress: { kind: 'practice', completedSteps: [0], workedMinutes: 1, note: '重新验证' } }),
    'new-practice-second': entry(true, later, { evidence: '新版运行证明' })
  };
  const backup = { version: 3, entries: old };
  const h = harness({ entries: prior }, practiceData);
  assert.equal(h.run(`importStateWithReport(${JSON.stringify(backup)}).matched`), 6);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'new-practice-first')`), false);
  assert.equal(h.run(`taskDone('new-practice-first')`), true);
  h.run(`lastToastArgs[1].run()`);
  for (const [id, record] of Object.entries(prior)) {
    assert.equal(h.run(`taskDone(${JSON.stringify(id)})`), record.done);
    assert.deepEqual(h.json(`taskProgress(${JSON.stringify(id)})`), record.progress || null);
    assert.equal(h.run(`taskEntry(${JSON.stringify(id)}).evidence`), record.evidence);
  }
});

test('the shipped old-video metadata can recover exact completed coverage across new weekly splits', () => {
  const current = shippedData();
  assert.equal(current.legacyVideoTasks.filter(task => task.track !== 'ls').length, 46);
  assert.equal(current.legacyVideoTasks.filter(task => task.generation === 2).length, 13);
  const videos = current.weeks.flatMap(week => week.tasks).filter(task => task.track === 'ydy' && task.activity === 'video');
  assert.equal(videos.length, 27);
  const records = Object.fromEntries(current.legacyVideoTasks.filter(task => task.track !== 'ls' && !task.generation).map(task => [task.id, entry()]));
  const h = harness({ entries: records }, current);
  for (const task of videos) {
    assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), true, task.id);
    assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(task.id)})`), false);
  }
  assert.equal(h.run(`allTasks.filter(task => taskDone(task.id)).length`), videos.length);
});

test('the archived equivalent practice migration preserves every source step and conserves actual minutes', () => {
  const current = archivedPracticeSplitData();
  assert.equal(current.legacyPracticeTasks.length, 39);
  const practices = current.weeks.flatMap(week => week.tasks).filter(task => task.practiceParts?.length);
  assert.equal(practices.length, 29);
  const originals = Object.fromEntries(current.legacyPracticeTasks.filter(task => !task.practiceParts).map((task, index) => [task.id, entry(true, stamp, {
    progress: { kind: 'practice', completedSteps: [], workedMinutes: Math.ceil(task.durationMinutes) + index + 1, note: `源记录 ${index + 1}` }
  })]));
  const h = harness({ archivedEntries: originals }, current);
  for (const task of practices) {
    assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), true, task.id);
    assert.deepEqual(h.json(`taskProgress(${JSON.stringify(task.id)}).completedSteps`), task.steps.map((_, index) => index));
    assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(task.id)})`), false, 'Inherited completion remains a read-time view');
  }
  const expectedMinutes = Object.values(originals).reduce((sum, record) => sum + record.progress.workedMinutes, 0);
  assert.equal(h.run(`allTasks.filter(task => task.practiceParts?.length).reduce((sum, task) => sum + taskProgress(task.id).workedMinutes, 0)`), expectedMinutes);
  assert.equal(h.run(`allTasks.filter(task => taskDone(task.id)).length`), practices.length);
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  assert.deepEqual(backup.archivedEntries, originals);
  for (const task of practices) assert.equal(Object.hasOwn(backup.entries, task.id), false);
});

test('a newer video cancellation masks only its original section intervals, regardless of older timestamps', () => {
  const records = Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry(true, '2030-01-01T00:00:00.000Z')]));
  const h = harness({ entries: { ...records, 'five-hour-middle': entry(false, later) } }, generationData);
  assert.equal(h.run(`taskDone('new-main')`), false);
  assert.deepEqual(h.json(`taskProgress('new-main')`), { kind: 'video', segmentIndex: 0, positionSecond: 20 });
  assert.equal(h.run(`taskDone('new-later')`), true, 'The cancellation cannot hide a different section');
  h.run(`state.entries['five-hour-middle'].done = true`);
  assert.equal(h.run(`taskDone('new-main')`), true, 'Equal-generation coverage may fill the remaining section ranges');
  h.run(`changeTask('new-main', false)`);
  assert.equal(h.run(`taskDone('new-main')`), false, 'An explicit current entry outranks both historical generations');
});

test('a newer partial video supplies its valid prefix while its unfinished suffix blocks older coverage', () => {
  const records = Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()]));
  const progress = { kind: 'video', segmentIndex: 1, positionSecond: 40, note: '新版停在B40秒' };
  const h = harness({ entries: { ...records, 'five-hour-middle': entry(false, later, { progress, evidence: 'https://example.test/second-generation' }) } }, generationData);
  assert.equal(h.run(`taskDone('new-main')`), false);
  assert.deepEqual(h.json(`taskProgress('new-main')`), {
    kind: 'video', segmentIndex: 1, positionSecond: 40, note: '五小时版中段课程：新版停在B40秒'
  });
  h.run(`delete state.entries['old-first']`);
  assert.equal(h.run(`taskProgress('new-main').segmentIndex`), 0);
  assert.equal(h.run(`taskProgress('new-main').positionSecond`), 0, 'A valid newer stop cannot jump an earlier unrecorded gap');
  h.run(`state.entries['five-hour-middle'].progress.positionSecond = 100`);
  assert.equal(h.run(`taskProgress('new-main').positionSecond`), 0, 'An invalid stop supplies no implied prefix');
  const markup = h.run(`legacyTaskRecordMarkup(taskById.get('new-main'))`);
  for (const value of ['五小时版中段课程', later, '新版停在B40秒', 'https://example.test/second-generation']) assert.ok(markup.includes(value), value);
});

test('intermediate cancellations restore, export and Undo without leaving a masking false placeholder', async () => {
  const originals = Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()]));
  const h = harness({ entries: originals }, generationData);
  const backup = { version: 3, entries: { practice: entry(false) }, archivedEntries: {
    ...originals, 'five-hour-middle': entry(false, later, { evidence: '取消五小时误打卡' })
  } };
  assert.equal(h.run(`importStateWithReport(${JSON.stringify(backup)}).matched`), tasks.length);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(h.run(`taskDone('new-main')`), false);
  h.run('globalThis.importUndo = lastToastArgs[1]');
  h.run('exportData()');
  assert.deepEqual(h.downloads.at(-1).archivedEntries['five-hour-middle'], backup.archivedEntries['five-hour-middle']);
  h.run('importUndo.run()');
  assert.equal(h.run(`Object.hasOwn(state.entries, 'five-hour-middle')`), false);
  assert.equal(h.run(`taskDone('new-main')`), true);
  for (const [id, record] of Object.entries(originals)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
  const reloaded = harness(JSON.parse(h.saved.get(storeKey)), generationData);
  assert.equal(reloaded.run(`taskDone('new-main')`), true);
});

test('a full earliest-generation backup removes an absent intermediate cancellation and Undo restores it', async () => {
  const originals = Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()]));
  const cancelled = entry(false, later, { progress: { kind: 'video', segmentIndex: 0, positionSecond: 30, note: '中间版重新观看' } });
  const h = harness({ entries: { ...originals, 'five-hour-middle': cancelled } }, generationData);
  const backup = { version: 3, entries: { ...originals, practice: entry(false) } };
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'five-hour-middle')`), false);
  assert.equal(h.run(`taskDone('new-main')`), true);
  h.run('lastToastArgs[1].run()');
  assert.deepEqual(h.json(`state.entries['five-hour-middle']`), cancelled);
  assert.equal(h.run(`taskDone('new-main')`), false);
  assert.equal(h.run(`taskProgress('new-main').positionSecond`), 30);
});

test('historical import Undo preserves unrelated concurrent tab edits and ordinary task Undo stays a merge', async () => {
  const originals = Object.fromEntries(legacyVideoTasks.map(task => [task.id, entry()]));
  const h = harness({ entries: originals }, generationData);
  const backup = { version: 3, archivedEntries: { 'five-hour-middle': entry(false, later) } };
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  const newer = entry(true, '2030-01-01T00:00:00.000Z', { evidence: '其他标签页的新实践记录',
    progress: { kind: 'practice', workedMinutes: 9, completedSteps: [0], note: '不能在撤销导入时丢失' } });
  const stored = JSON.parse(h.saved.get(storeKey));
  stored.entries.practice = newer;
  h.saved.set(storeKey, JSON.stringify(stored));
  h.run('lastToastArgs[1].run()');
  assert.equal(h.run(`taskDone('new-main')`), true);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'five-hour-middle')`), false);
  assert.deepEqual(h.json('state.entries.practice'), newer);
  assert.deepEqual(JSON.parse(h.saved.get(storeKey)).entries.practice, newer);
  assert.equal(h.run('state.pendingReplace'), true, 'Raw legacy removal uses the already-supported replacement path');
  const normal = harness();
  normal.run(`changeTask('practice', true); lastToastArgs[1].run()`);
  assert.equal(normal.run('state.pendingReplace'), false, 'A normal current-task Undo never starts full replacement');
  assert.equal(normal.run('replaceRequested'), false);
});

test('shipped five-hour records map exact stopping positions into two-hour tasks and mask old completion', () => {
  const current = shippedData();
  const original = Object.fromEntries(current.legacyVideoTasks.filter(task => task.track !== 'ls' && !task.generation).map(task => [task.id, entry()]));
  const fiveHour = current.legacyVideoTasks.filter(task => task.generation === 2 && task.projectId === 'studio-course');
  const oldTask = fiveHour[1];
  const segmentIndex = 3;
  const stopped = oldTask.learningSegments[segmentIndex];
  const positionSecond = stopped.startSecond + Math.floor((stopped.endSecond - stopped.startSecond) / 2);
  const target = current.weeks.flatMap(week => week.tasks).find(task => task.id.startsWith('ydy2h-')
    && task.learningSegments.some(part => part.sectionId === stopped.sectionId && part.startSecond <= positionSecond && positionSecond < part.endSecond));
  const targetIndex = target.learningSegments.findIndex(part => part.sectionId === stopped.sectionId && part.startSecond <= positionSecond && positionSecond < part.endSecond);
  const raw = entry(false, later, { progress: { kind: 'video', segmentIndex, positionSecond, note: '旧五小时课程停点' }, evidence: 'https://example.test/studio-stop' });
  const h = harness({ entries: { ...original, [oldTask.id]: raw } }, current);
  assert.equal(h.run(`taskDone(${JSON.stringify(target.id)})`), false);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(target.id)})`), {
    kind: 'video', segmentIndex: targetIndex, positionSecond, note: `${oldTask.title}：旧五小时课程停点`
  });
  const following = current.weeks.flatMap(week => week.tasks).find(task => task.id.startsWith('ydy2h-') && task.week > target.week
    && task.learningSegments.some(part => oldTask.learningSegments.some(old => old.sectionId === part.sectionId && old.startSecond < part.endSecond && part.startSecond < old.endSecond)));
  assert.ok(following);
  assert.equal(h.run(`taskDone(${JSON.stringify(following.id)})`), false);
  assert.equal(h.run(`taskProgress(${JSON.stringify(following.id)}).positionSecond`), following.learningSegments[0].startSecond);
  assert.deepEqual(h.json(`state.entries[${JSON.stringify(oldTask.id)}]`), raw);
  assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(target.id)})`), false);
});

test('shipped cloud five-hour records recover every four-hour interval without writing replacement check-ins', () => {
  const current = shippedData();
  const previous = current.legacyVideoTasks.filter(task => task.generation === 2 && task.projectId === 'yunzhujiao');
  const cloudVideos = current.weeks.flatMap(week => week.tasks).filter(task => task.id.startsWith('ydy4h-') && task.projectId === 'yunzhujiao');
  assert.equal(previous.length, 8);
  assert.equal(cloudVideos.length, 9);
  const records = Object.fromEntries(previous.map(task => [task.id, entry()]));
  const h = harness({ entries: records }, current);
  for (const task of cloudVideos) {
    assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), true, task.id);
    assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(task.id)})`), false);
  }
  assert.equal(h.run(`allTasks.filter(task => taskDone(task.id)).length`), cloudVideos.length,
    'Cloud completion cannot mark Yibo, Studio or project practice complete');
});

test('shipped cloud cancellation masks only its own ranges and a partial stop retains the earliest missing point', () => {
  const current = shippedData();
  const previous = current.legacyVideoTasks.filter(task => task.generation === 2 && task.projectId === 'yunzhujiao');
  const cloudVideos = current.weeks.flatMap(week => week.tasks).filter(task => task.id.startsWith('ydy4h-') && task.projectId === 'yunzhujiao');
  const original = Object.fromEntries(current.legacyVideoTasks.filter(task => task.track !== 'ls' && !task.generation)
    .map(task => [task.id, entry(true, '2030-01-01T00:00:00.000Z')]));
  const oldTask = previous[1];
  assert.ok(oldTask);
  const raw = entry(false, later, { evidence: 'https://example.test/cloud-cancel',
    progress: { kind: 'video', segmentIndex: 0, positionSecond: oldTask.learningSegments[0].startSecond, note: '取消旧版误打卡' } });
  const h = harness({ entries: { ...original, [oldTask.id]: raw } }, current);
  for (const task of cloudVideos) {
    const firstOverlap = task.learningSegments.map((part, segmentIndex) => {
      const old = oldTask.learningSegments.find(sourcePart => sourcePart.sectionId === part.sectionId
        && sourcePart.startSecond < part.endSecond && part.startSecond < sourcePart.endSecond);
      return old ? { segmentIndex, positionSecond: Math.max(part.startSecond, old.startSecond) } : null;
    }).find(Boolean);
    assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), !firstOverlap, task.id);
    if (firstOverlap) {
      const progress = h.json(`taskProgress(${JSON.stringify(task.id)})`);
      assert.equal(progress.segmentIndex, firstOverlap.segmentIndex, task.id);
      assert.equal(progress.positionSecond, firstOverlap.positionSecond, task.id);
    }
  }
  const segmentIndex = 0;
  const stopped = oldTask.learningSegments[segmentIndex];
  const positionSecond = stopped.startSecond + Math.floor((stopped.endSecond - stopped.startSecond) / 2);
  const target = cloudVideos.find(task => task.learningSegments.some(part => part.sectionId === stopped.sectionId
    && part.startSecond <= positionSecond && positionSecond < part.endSecond));
  assert.ok(target);
  const targetIndex = target.learningSegments.findIndex(part => part.sectionId === stopped.sectionId
    && part.startSecond <= positionSecond && positionSecond < part.endSecond);
  const partial = entry(false, later, { evidence: 'https://example.test/cloud-stop',
    progress: { kind: 'video', segmentIndex, positionSecond, note: '云助教五小时版停点' } });
  h.run(`state.entries[${JSON.stringify(oldTask.id)}] = ${JSON.stringify(partial)}`);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(target.id)})`), {
    kind: 'video', segmentIndex: targetIndex, positionSecond, note: `${oldTask.title}：云助教五小时版停点`
  });
  assert.equal(h.run(`taskDone(${JSON.stringify(target.id)})`), false);
  const firstPart = target.learningSegments[0];
  assert.ok(firstPart.sectionId !== stopped.sectionId || firstPart.startSecond < stopped.startSecond,
    'The shipped new split must include an earlier prefix outside this intermediate record');
  const prefixSources = current.legacyVideoTasks.filter(task => task.track !== 'ls' && !task.generation && task.learningSegments.some(part => part.sectionId === firstPart.sectionId
    && part.startSecond <= firstPart.startSecond && firstPart.startSecond < part.endSecond));
  assert.ok(prefixSources.length);
  for (const task of prefixSources) h.run(`delete state.entries[${JSON.stringify(task.id)}]`);
  const earliest = h.json(`taskProgress(${JSON.stringify(target.id)})`);
  assert.equal(earliest.segmentIndex, 0);
  assert.equal(earliest.positionSecond, firstPart.startSecond,
    'A valid later cloud stop cannot hide an earlier missing legacy interval');
  assert.deepEqual(h.json(`state.entries[${JSON.stringify(oldTask.id)}]`), partial);
});

test('shipped cloud five-hour history preserves raw notes, evidence and timestamps through export and import', async () => {
  const current = shippedData();
  const previous = current.legacyVideoTasks.filter(task => task.generation === 2 && task.projectId === 'yunzhujiao');
  const cloudVideos = current.weeks.flatMap(week => week.tasks).filter(task => task.id.startsWith('ydy4h-') && task.projectId === 'yunzhujiao');
  const records = Object.fromEntries(previous.map((task, index) => [task.id, entry(index !== 1, index ? later : stamp, {
    evidence: `https://example.test/cloud-five-hour-${index}`,
    progress: { kind: 'video', segmentIndex: 0, positionSecond: task.learningSegments[0].startSecond,
      note: `云助教原始学习记录 ${index}` }
  })]));
  const h = harness({ archivedEntries: records }, current);
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  assert.deepEqual(backup.archivedEntries, records);
  for (const task of cloudVideos) assert.equal(Object.hasOwn(backup.entries, task.id), false);
  const restored = harness(undefined, current);
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const [id, record] of Object.entries(records)) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(id)}]`), record);
  for (const task of cloudVideos) assert.deepEqual(restored.json(`taskEntry(${JSON.stringify(task.id)})`), h.json(`taskEntry(${JSON.stringify(task.id)})`));
  const partialTask = cloudVideos.find(task => task.learningSegments.some(part => previous[1].learningSegments.some(old => old.sectionId === part.sectionId
    && old.startSecond < part.endSecond && part.startSecond < old.endSecond)));
  const markup = restored.run(`legacyTaskRecordMarkup(taskById.get(${JSON.stringify(partialTask.id)}))`);
  for (const value of [later, '云助教原始学习记录 1', 'https://example.test/cloud-five-hour-1']) assert.ok(markup.includes(value), value);
});

test('archived Studio weekly practice splits retain direct previous steps, actual time and original learning records', async () => {
  const current = archivedPracticeSplitData();
  const previous = current.legacyPracticeTasks.filter(task => /^ydy-practice-v2-w(?:18|19|20|21)-studio-course$/.test(task.id));
  const practices = current.weeks.flatMap(week => week.tasks).filter(task => task.id.startsWith('ydy-practice-v4-'));
  assert.equal(previous.length, 4);
  assert.equal(practices.length, 7);
  const records = Object.fromEntries(previous.map((task, index) => [task.id, entry(false, index ? later : stamp, {
    evidence: `https://example.test/studio-practice-v2-${index}`,
    progress: { kind: 'practice', workedMinutes: 123 + index * 7,
      completedSteps: task.steps.map((_, stepIndex) => stepIndex).filter(stepIndex => stepIndex % 2 === 0),
      note: `Studio 拆分前学习笔记 ${index}` }
  })]));
  const previousById = new Map(previous.map(task => [task.id, task]));
  const h = harness({ entries: records }, current);
  for (const task of practices) {
    const expectedSteps = [];
    const related = new Set();
    for (const [stepIndex, part] of task.practiceParts.entries()) {
      const source = previousById.get(part.previousTaskId);
      assert.ok(source, `${task.id}: history should point directly at an archived v2 aggregate`);
      const oldPart = source.practiceParts[part.previousStepIndex];
      for (const key of ['sourceTaskId', 'sourceStepIndex', 'startSecond', 'endSecond']) assert.equal(part[key], oldPart[key], `${task.id}: ${key}`);
      related.add(source.id);
      if (records[source.id].progress.completedSteps.includes(part.previousStepIndex)) expectedSteps.push(stepIndex);
    }
    assert.deepEqual(h.json(`taskProgress(${JSON.stringify(task.id)}).completedSteps`), expectedSteps, task.id);
    assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), false, 'Partial source steps remain distinct from finishing the source record');
    assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(task.id)})`), false);
    const markup = h.run(`legacyTaskRecordMarkup(taskById.get(${JSON.stringify(task.id)}))`);
    for (const id of related) {
      for (const value of [records[id].updatedAt, records[id].progress.note, records[id].evidence]) assert.ok(markup.includes(value), `${task.id}: ${value}`);
    }
  }
  assert.equal(practices.reduce((sum, task) => sum + h.run(`taskProgress(${JSON.stringify(task.id)}).workedMinutes`), 0),
    Object.values(records).reduce((sum, record) => sum + record.progress.workedMinutes, 0));
  const originals = Object.fromEntries(current.legacyPracticeTasks.filter(task => !task.practiceParts).map(task => [task.id, entry(true, later, {
    progress: { kind: 'practice', workedMinutes: 999, completedSteps: [], note: '更早的全部完成记录' }
  })]));
  const before = practices.map(task => h.json(`taskProgress(${JSON.stringify(task.id)})`));
  h.run(`state.entries = { ...${JSON.stringify(originals)}, ...state.entries }`);
  for (const [index, task] of practices.entries()) assert.deepEqual(h.json(`taskProgress(${JSON.stringify(task.id)})`), before[index], task.id);
  const cancelled = previous[1];
  h.run(`state.entries[${JSON.stringify(cancelled.id)}] = ${JSON.stringify(entry(false, later, { evidence: '撤销旧版复现误打卡' }))}`);
  for (const task of practices) {
    if (task.practiceParts.every(part => part.previousTaskId === cancelled.id)) {
      assert.equal(h.run(`taskProgress(${JSON.stringify(task.id)})`), null, 'An explicit v2 cancellation masks original completion and time');
      assert.equal(h.run(`taskDone(${JSON.stringify(task.id)})`), false);
    }
  }
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  const restored = harness(undefined, current);
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const task of practices) assert.deepEqual(restored.json(`taskEntry(${JSON.stringify(task.id)})`), h.json(`taskEntry(${JSON.stringify(task.id)})`));
  for (const task of previous) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(task.id)}]`), h.json(`state.entries[${JSON.stringify(task.id)}]`));
});

test('archived intermediate practice steps override earliest completion and conserve both source actual times', () => {
  const current = archivedPracticeSplitData();
  const previous = current.legacyPracticeTasks.filter(task => /^ydy-practice-v2-w(?:22|23)-studio-course$/.test(task.id));
  const practices = current.weeks.flatMap(week => week.tasks).filter(task => task.id.startsWith('ydy-practice-v3-'));
  assert.equal(practices.length, 3);
  const records = {
    [previous[0].id]: entry(false, stamp, { evidence: 'https://example.test/v2-six-steps',
      progress: { kind: 'practice', workedMinutes: 407, completedSteps: [0, 2, 5], note: '五小时版前六步记录' } }),
    [previous[1].id]: entry(true, later, { evidence: 'https://example.test/v2-two-steps',
      progress: { kind: 'practice', workedMinutes: 121, completedSteps: [], note: '五小时版末两步记录' } })
  };
  const h = harness({ entries: records }, current);
  for (const [index, completed] of [[0, [0]], [1, [0]], [2, [0, 1, 2]]]) {
    assert.deepEqual(h.json(`taskProgress(${JSON.stringify(practices[index].id)}).completedSteps`), completed);
    assert.equal(h.run(`taskDone(${JSON.stringify(practices[index].id)})`), false, 'A checked step is not a completed original aggregate');
  }
  assert.equal(practices.reduce((sum, task) => sum + h.run(`taskProgress(${JSON.stringify(task.id)}).workedMinutes`), 0), 528);
  assert.match(h.run(`taskEntry(${JSON.stringify(practices[2].id)}).evidence`), /v2-six-steps/);
  assert.match(h.run(`taskEntry(${JSON.stringify(practices[2].id)}).evidence`), /v2-two-steps/);
  assert.equal(h.run(`taskEntry(${JSON.stringify(practices[2].id)}).updatedAt`), later);
  const timeOnly = practices.map(task => h.run(`taskProgress(${JSON.stringify(task.id)}).workedMinutes`));
  const oldest = Object.fromEntries(current.legacyPracticeTasks.filter(task => !task.practiceParts).map(task => [task.id, entry(true, later, {
    evidence: 'https://example.test/earliest-source', progress: { kind: 'practice', workedMinutes: 999, completedSteps: [], note: '最早版记录' }
  })]));
  h.run(`state.entries = { ...${JSON.stringify(oldest)}, ...state.entries }`);
  assert.deepEqual(practices.map(task => h.run(`taskProgress(${JSON.stringify(task.id)}).workedMinutes`)), timeOnly);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(practices[0].id)}).completedSteps`), [0]);
  const markup = h.run(`legacyTaskRecordMarkup(taskById.get(${JSON.stringify(practices[2].id)}))`);
  for (const text of [stamp, later, '五小时版前六步记录', '五小时版末两步记录', '最早版记录', 'https://example.test/earliest-source']) assert.ok(markup.includes(text), text);
  h.run(`state.entries[${JSON.stringify(previous[0].id)}] = ${JSON.stringify(entry(false, later))}`);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(practices[0].id)})`), null, 'An explicit prior cancellation hides the earlier completed source');
  h.run(`changeTask(${JSON.stringify(practices[2].id)}, false)`);
  assert.equal(h.run(`taskDone(${JSON.stringify(practices[2].id)})`), false);
  const progress = { kind: 'practice', workedMinutes: 2, completedSteps: [1], note: '二小时版独立记录' };
  h.run(`saveTaskProgress(${JSON.stringify(practices[2].id)}, ${JSON.stringify(progress)})`);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(practices[2].id)})`), progress);
});

test('shipped intermediate practice archives survive backup restore and Undo retains original notes and timestamps', async () => {
  const current = shippedData();
  const previous = current.legacyPracticeTasks.filter(task => /^ydy-practice-v2-w(?:22|23)-studio-course$/.test(task.id));
  const practices = current.weeks.flatMap(week => week.tasks).filter(task => task.id.startsWith('ydy-practice-v3-'));
  const records = Object.fromEntries(previous.map((task, index) => [task.id, entry(index === 1, index ? later : stamp, {
    evidence: `https://example.test/v2-${index}`, progress: { kind: 'practice', workedMinutes: index ? 37 : 145, completedSteps: [0], note: `旧复现记录 ${index}` }
  })]));
  const h = harness({ archivedEntries: records }, current);
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  assert.deepEqual(backup.archivedEntries, records);
  for (const task of practices) assert.equal(Object.hasOwn(backup.entries, task.id), false);
  const restored = harness(undefined, current);
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  for (const task of practices) assert.deepEqual(restored.json(`taskEntry(${JSON.stringify(task.id)})`), h.json(`taskEntry(${JSON.stringify(task.id)})`));
  for (const [id, record] of Object.entries(records)) assert.deepEqual(restored.json(`state.entries[${JSON.stringify(id)}]`), record);
  restored.run('lastToastArgs[1].run()');
  for (const task of previous) assert.equal(restored.run(`Object.hasOwn(state.entries, ${JSON.stringify(task.id)})`), false);
  for (const task of practices) assert.equal(restored.run(`taskProgress(${JSON.stringify(task.id)})`), null);
});
