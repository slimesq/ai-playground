'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'tracker-ui.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
const storeKey = 'av_study_tracker_regenerated_v2';
const stamp = '2026-10-05T01:02:03.000Z';
const later = '2026-10-06T02:03:04.000Z';
const entry = (done = true, updatedAt = stamp, extras = {}) => ({ done, updatedAt, ...extras });
const segment = (sectionId, startSecond, endSecond) => ({ sectionId, startSecond, endSecond, totalSeconds: 4795, title: sectionId });
const oldTasks = [
  { id: 'old-upper', title: '55-解复用(上)', date: '2026-10-05', track: 'ls', activity: 'video',
    segments: [{ lessonId: 'old-lesson-upper', startMinute: 0, endMinute: 40 }] },
  { id: 'old-lower', title: '55-解复用(下)', date: '2026-10-06', track: 'ls', activity: 'video',
    segments: [{ lessonId: 'old-lesson-lower', startMinute: 0, endMinute: 40 }] },
  { id: 'old-mixed', title: '跨视频的原课程', date: '2026-10-07', track: 'ls', activity: 'video',
    segments: [{ lessonId: 'old-lesson-second', startMinute: 0, endMinute: 1 },
      { lessonId: 'old-lesson-third', startMinute: 2, endMinute: 3 }] }
];
const currentTasks = [
  { id: 'new-first', title: '原视频第一段', learningSegments: [segment('source-55', 0, 2400)] },
  { id: 'new-tail', title: '原视频尾段', learningSegments: [segment('source-55', 2400, 4795)] },
  { id: 'new-cross', title: '跨旧上下边界', learningSegments: [segment('source-55', 2300, 2500)] },
  { id: 'new-second', title: '另一原视频', learningSegments: [segment('source-second', 0, 60)] },
  { id: 'new-third', title: '第三原视频', learningSegments: [segment('source-third', 120, 180)] },
  { id: 'new-version', title: 'FFmpeg6.0', learningSegments: [segment('source-66-6', 0, 100)], historicalTaskIds: ['old-version'] }
].map(task => ({ ...task, date: '2026-10-22', day: '周四', week: 1, track: 'ls', activity: 'video' }));
const data = {
  weeks: [{ week: 1, start: '2026-10-19', end: '2026-10-25', tasks: currentTasks }],
  legacyVideoTasks: oldTasks,
  legacyReferenceTasks: [{ id: 'old-version', title: 'FFmpeg4.2', date: '2026-10-08', track: 'ls', activity: 'video' }],
  legacyCourseCatalog: [
    { id: 'old-lesson-upper', title: '55-解复用(上)', minutes: 40 },
    { id: 'old-lesson-lower', title: '55-解复用(下)', minutes: 40 },
    { id: 'old-lesson-second', title: '另一原视频', minutes: 1 },
    { id: 'old-lesson-third', title: '第三原视频', minutes: 3 }
  ],
  legacyZeroVoiceVideoRanges: {
    'old-upper': [{ sectionId: 'source-55', startSecond: 0, endSecond: 2400, sourceStartSecond: 0, sourceEndSecond: 2400 }],
    'old-lower': [{ sectionId: 'source-55', startSecond: 2400, endSecond: 4795, sourceStartSecond: 0, sourceEndSecond: 2400 }],
    'old-mixed': [
      { sectionId: 'source-second', startSecond: 0, endSecond: 60, sourceStartSecond: 0, sourceEndSecond: 60 },
      { sectionId: 'source-third', startSecond: 120, endSecond: 180, sourceStartSecond: 120, sourceEndSecond: 180 }
    ]
  }
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
    URL: { createObjectURL: blob => { downloads.push(JSON.parse(blob.parts.join(''))); return 'blob:backup'; }, revokeObjectURL() {} },
    setTimeout: () => 0
  });
  vm.runInContext(source, context);
  vm.runInContext(`render = () => {}; syncToServer = () => {}; showToast = (...args) => { globalThis.lastToastArgs = args; };
    focusSnapshot = () => null; captureToastFocus = () => null; confirmAction = async () => true;`, context);
  return { saved, downloads, run: expression => vm.runInContext(expression, context),
    json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}

test('canonical source ranges preserve real legacy stop positions without writing new check-ins', () => {
  const records = {
    'old-upper': entry(),
    'old-lower': entry(false, later, { evidence: 'https://example.test/original',
      progress: { kind: 'video', segmentIndex: 0, positionSecond: 100, note: '原下半节继续' } })
  };
  const h = harness({ entries: records });
  assert.equal(h.run(`taskDone('new-first')`), true);
  assert.equal(h.run(`taskDone('new-tail')`), false);
  assert.equal(h.run(`taskProgress('new-tail').positionSecond`), 2500,
    'A rounded tail must not proportionally move the user’s actual second');
  assert.equal(h.run(`taskEntry('new-tail').updatedAt`), later);
  assert.match(h.run(`taskEntry('new-tail').evidence`), /https:\/\/example.test\/original/);
  assert.match(h.run(`taskProgress('new-tail').note`), /原下半节继续/);
  assert.deepEqual(h.json('state.entries'), records);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'new-tail')`), false);
});

test('new completion requires explicit completed coverage across every old split, not just a saved end stop', () => {
  const h = harness({ entries: { 'old-upper': entry(),
    'old-lower': entry(false, later, { progress: { kind: 'video', segmentIndex: 0, positionSecond: 2400 } }) } });
  assert.equal(h.run(`taskDone('new-cross')`), false);
  assert.equal(h.run(`taskProgress('new-cross').positionSecond`), 2500);
  assert.equal(h.run(`taskProgress('new-tail').positionSecond`), 4795, 'Rounded tail stops clamp to the real source end');
  assert.equal(h.run(`taskDone('new-tail')`), false);
  h.run(`state.entries['old-lower'].done = true`);
  assert.equal(h.run(`taskDone('new-cross')`), true);
  assert.equal(h.run(`taskDone('new-tail')`), true);
  assert.equal(h.run(`taskDone('new-second')`), false);
});

test('rounding a legacy lesson down leaves the unseen true-video tail unfinished', () => {
  const short = JSON.parse(JSON.stringify(data));
  short.weeks[0].tasks.find(task => task.id === 'new-first').learningSegments[0].endSecond = 2415;
  const original = entry(true, stamp, { evidence: 'https://example.test/rounded-short' });
  const h = harness({ entries: { 'old-upper': original } }, short);
  assert.equal(h.run(`taskDone('new-first')`), false);
  assert.equal(h.run(`taskProgress('new-first').positionSecond`), 2400,
    'An old completed forty-minute interval cannot cover fifteen never-mapped seconds');
  assert.deepEqual(h.json(`state.entries['old-upper']`), original);
  assert.equal(h.run(`Object.hasOwn(state.entries, 'new-first')`), false);
});

test('split source mapping retains old segment indexes and never jumps an earlier gap', () => {
  const h = harness({ entries: { 'old-lower': entry() } });
  assert.equal(h.run(`taskProgress('new-cross').positionSecond`), 2300);
  h.run(`state.entries['old-mixed'] = ${JSON.stringify(entry(false, later,
    { progress: { kind: 'video', segmentIndex: 1, positionSecond: 150 } }))}`);
  assert.equal(h.run(`taskProgress('new-second').positionSecond`), 60);
  assert.equal(h.run(`taskDone('new-second')`), false, 'Passing a segment in a partial record is watched, not explicitly completed');
  assert.equal(h.run(`taskProgress('new-third').positionSecond`), 150);
  assert.equal(h.run(`taskDone('new-third')`), false);
});

test('invalid local positions and malformed migration ranges cannot manufacture coverage', () => {
  for (const positionSecond of [-1, 2401]) {
    const h = harness({ entries: { 'old-lower': entry(false, later,
      { progress: { kind: 'video', segmentIndex: 0, positionSecond } }) } });
    assert.equal(h.run(`taskDone('new-tail')`), false);
    assert.equal(h.run(`taskProgress('new-tail')`), null);
  }
  for (const change of [
    item => { item.sourceStartSecond = 1; },
    item => { item.sourceEndSecond = 2401; },
    item => { item.endSecond = item.startSecond; },
    item => { item.endSecond = item.startSecond + 2401; },
    item => { item.sectionId = ''; }
  ]) {
    const malformed = JSON.parse(JSON.stringify(data));
    change(malformed.legacyZeroVoiceVideoRanges['old-lower'][0]);
    const h = harness({ entries: { 'old-lower': entry() } }, malformed);
    assert.equal(h.run(`taskDone('new-tail')`), false);
    assert.equal(h.run(`taskProgress('new-tail')`), null);
  }
});

test('explicit new cancellation and edited stop override legacy completion after synchronization', () => {
  const h = harness({ entries: { 'old-upper': entry(), 'old-lower': entry() } });
  assert.equal(h.run(`taskDone('new-tail')`), true);
  h.run(`changeTask('new-tail', false)`);
  assert.equal(h.run(`taskDone('new-tail')`), false);
  const progress = { kind: 'video', segmentIndex: 0, positionSecond: 2510, note: '新主线重新观看' };
  h.run(`saveTaskProgress('new-tail', ${JSON.stringify(progress)})`);
  h.run(`state.entries = mergeEntryMaps(state.entries, {'old-lower': ${JSON.stringify(entry(true, '2030-01-01T00:00:00.000Z'))}})`);
  assert.equal(h.run(`taskDone('new-tail')`), false);
  assert.deepEqual(h.json(`taskProgress('new-tail')`), progress);
  assert.equal(h.run(`taskDone('new-first')`), true);
});

test('old FFmpeg version stays reference-only and cannot transfer progress to the retained version', () => {
  const old = entry(true, stamp, { evidence: 'https://example.test/ffmpeg42',
    progress: { kind: 'video', segmentIndex: 0, positionSecond: 100, note: '旧版原笔记' } });
  const h = harness({ entries: { 'old-version': old } });
  assert.equal(h.run(`taskDone('new-version')`), false);
  assert.equal(h.run(`taskProgress('new-version')`), null);
  assert.equal(h.run(`legacyTaskRecords('new-version')[0].referenceOnly`), true);
  assert.deepEqual(h.json(`legacyTaskRecords('new-version')[0].record`), old);
});

test('backup round trip retains exact historical task dates, timestamps, evidence and local stop coordinates', async () => {
  const records = { 'old-upper': entry(), 'old-lower': entry(false, later,
    { evidence: 'https://example.test/code', progress: { kind: 'video', segmentIndex: 0, positionSecond: 100, note: '原记录不能改写' } }) };
  const h = harness({ entries: records });
  const originalDefinitions = h.json('DATA.legacyVideoTasks');
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  assert.deepEqual(backup.archivedEntries, records);
  assert.equal(Object.hasOwn(backup.entries, 'new-tail'), false);
  assert.deepEqual(h.json('DATA.legacyVideoTasks'), originalDefinitions);
  const markup = h.run(`legacyTaskRecordMarkup(taskById.get('new-tail'))`);
  for (const text of ['55-解复用(下)', later, '原记录不能改写', '01:40', 'https://example.test/code']) assert.ok(markup.includes(text), text);
  const restored = harness();
  await restored.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.deepEqual(restored.json(`state.entries['old-lower']`), records['old-lower']);
  assert.equal(restored.run(`taskProgress('new-tail').positionSecond`), 2500);
  assert.equal(restored.run(`taskDone('new-tail')`), false);
  const reloaded = harness(JSON.parse(restored.saved.get(storeKey)));
  assert.deepEqual(reloaded.json(`taskProgress('new-tail')`), restored.json(`taskProgress('new-tail')`));
});

test('historical snapshot-only import recognizes old daily IDs and Undo removes only the imported history', async () => {
  const current = entry(false, later, { progress: { kind: 'video', segmentIndex: 0, positionSecond: 2475 } });
  const h = harness({ entries: { 'new-tail': current } });
  const record = entry(true, stamp, { evidence: 'https://example.test/previous' });
  const backup = { version: 3, entrySnapshots: [{ task: oldTasks[1], record }] };
  assert.equal(h.run(`importStateWithReport(${JSON.stringify(backup)}).historyMatched`), 1);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify(backup))} })`);
  assert.deepEqual(h.json(`state.entries['new-tail']`), current);
  assert.deepEqual(h.json(`state.entries['old-lower']`), record);
  h.run('lastToastArgs[1].run()');
  assert.equal(h.run(`Object.hasOwn(state.entries, 'old-lower')`), false);
  assert.deepEqual(h.json(`state.entries['new-tail']`), current);
});

const canonicalDailyTask = {
  id: 'ls-server-v1-fixture', title: '重排前的精确秒日课', date: '2026-10-12',
  track: 'ls', activity: 'video', learningSegments: [segment('source-55', 2300, 2500), segment('source-second', 0, 60)]
};
const generationsData = {
  ...data,
  legacyVideoTasks: [...oldTasks, canonicalDailyTask],
  legacyZeroVoiceVideoGenerations: { [canonicalDailyTask.id]: 2 }
};
const earliestCompleted = Object.fromEntries(oldTasks.map(task => [task.id, entry(true, '2030-01-01T00:00:00.000Z')]));

test('a canceled canonical daily task masks only its own ranges across earlier split-lesson completion', () => {
  const original = entry(false, later, { evidence: 'https://example.test/canonical-cancel',
    progress: { kind: 'video', segmentIndex: 0, positionSecond: 2300, note: '取消了这一天的误打卡' } });
  const h = harness({ entries: { ...earliestCompleted, [canonicalDailyTask.id]: original } }, generationsData);
  assert.equal(h.run(`taskDone('new-cross')`), false, 'A later generation cancellation owns its ranges even when older timestamps are later');
  assert.equal(h.run(`taskProgress('new-cross').positionSecond`), 2300);
  assert.equal(h.run(`taskProgress('new-first').positionSecond`), 2300);
  assert.equal(h.run(`taskProgress('new-tail').positionSecond`), 2400);
  assert.equal(h.run(`taskDone('new-second')`), false);
  assert.equal(h.run(`taskDone('new-third')`), true, 'Unrelated canonical video coverage stays valid');
  assert.deepEqual(h.json(`state.entries[${JSON.stringify(canonicalDailyTask.id)}]`), original);
  assert.deepEqual(h.json(`legacyVideoTaskById.get(${JSON.stringify(canonicalDailyTask.id)})`), canonicalDailyTask,
    'Generation metadata must not be added to the original archived task');
});

test('canonical daily partial stops keep exact seconds and segment indexes without reviving earlier completed suffixes', () => {
  const record = entry(false, later, { progress: { kind: 'video', segmentIndex: 0, positionSecond: 2357 } });
  const h = harness({ entries: { ...earliestCompleted, [canonicalDailyTask.id]: record } }, generationsData);
  assert.equal(h.run(`taskProgress('new-cross').positionSecond`), 2357);
  assert.equal(h.run(`taskDone('new-cross')`), false);
  assert.equal(h.run(`taskProgress('new-tail').positionSecond`), 2400, 'The unfinished suffix cannot be filled by older completion');
  h.run(`state.entries[${JSON.stringify(canonicalDailyTask.id)}].progress = {kind:'video',segmentIndex:1,positionSecond:31}`);
  assert.equal(h.run(`taskProgress('new-cross').positionSecond`), 2500);
  assert.equal(h.run(`taskDone('new-cross')`), false, 'A watched prefix is not an explicit completion');
  assert.equal(h.run(`taskProgress('new-second').positionSecond`), 31);
  h.run(`state.entries[${JSON.stringify(canonicalDailyTask.id)}].done = true`);
  assert.equal(h.run(`taskDone('new-cross')`), true);
  assert.equal(h.run(`taskDone('new-second')`), true);
});

test('reordered task explicit edits override both historical generations and preserve their raw records through backup restore', async () => {
  const canonical = entry(true, later, { evidence: 'https://example.test/canonical',
    progress: { kind: 'video', segmentIndex: 1, positionSecond: 49, note: '精确秒旧记录' } });
  const archives = { ...earliestCompleted, [canonicalDailyTask.id]: canonical };
  const h = harness({ entries: archives }, generationsData);
  assert.equal(h.run(`taskDone('new-cross')`), true);
  h.run(`changeTask('new-cross', false)`);
  const progress = { kind: 'video', segmentIndex: 0, positionSecond: 2321, note: '新重排中重新观看' };
  h.run(`saveTaskProgress('new-cross', ${JSON.stringify(progress)})`);
  const newerCanonical = { ...canonical, updatedAt: '2031-01-01T00:00:00.000Z' };
  h.run(`state.entries = mergeEntryMaps(state.entries, {${JSON.stringify(canonicalDailyTask.id)}:${JSON.stringify(newerCanonical)}})`);
  assert.equal(h.run(`taskDone('new-cross')`), false);
  assert.deepEqual(h.json(`taskProgress('new-cross')`), progress);
  h.run('exportData()');
  const backup = h.downloads.at(-1);
  assert.equal(Object.hasOwn(backup.entries, 'new-tail'), false, 'Exporting inherited completion must not invent a current check-in');
  assert.deepEqual(backup.archivedEntries['old-upper'], earliestCompleted['old-upper']);
  assert.deepEqual(backup.archivedEntries[canonicalDailyTask.id], newerCanonical);
  const restored = harness(undefined, generationsData);
  await restored.run(`importData({text:async()=>${JSON.stringify(JSON.stringify(backup))}})`);
  assert.equal(restored.run(`taskDone('new-cross')`), false);
  assert.deepEqual(restored.json(`taskProgress('new-cross')`), progress);
  assert.deepEqual(restored.json(`state.entries[${JSON.stringify(canonicalDailyTask.id)}]`), backup.archivedEntries[canonicalDailyTask.id]);
  assert.deepEqual(restored.json(`state.entries['old-upper']`), earliestCompleted['old-upper']);
});

test('restoring a complete earliest backup removes an absent intermediate cancellation and Undo restores that exact cancellation', async () => {
  const canceled = entry(false, later, { progress: { kind: 'video', segmentIndex: 0, positionSecond: 2341, note: '第二代停点' } });
  const h = harness({ entries: { ...earliestCompleted, [canonicalDailyTask.id]: canceled } }, generationsData);
  assert.equal(h.run(`taskDone('new-cross')`), false);
  const backup = { version: 3, entries: { ...earliestCompleted, 'new-version': entry() } };
  assert.equal(h.run(`importStateWithReport(${JSON.stringify(backup)}).activeMatched`), currentTasks.length);
  await h.run(`importData({text:async()=>${JSON.stringify(JSON.stringify(backup))}})`);
  assert.equal(h.run(`Object.hasOwn(state.entries, ${JSON.stringify(canonicalDailyTask.id)})`), false);
  assert.equal(h.run(`taskDone('new-cross')`), true);
  h.run('lastToastArgs[1].run()');
  assert.deepEqual(h.json(`state.entries[${JSON.stringify(canonicalDailyTask.id)}]`), canceled);
  assert.equal(h.run(`taskDone('new-cross')`), false);
  assert.equal(h.run(`taskProgress('new-cross').positionSecond`), 2341);
});
