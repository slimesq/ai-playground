'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'study-tracker.html'), 'utf8');
const data = JSON.parse(html.match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
const source = fs.readFileSync(path.join(root, 'tracker-ui.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
const storeKey = 'av_study_tracker_regenerated_v2';
const replaceStoreKey = `${storeKey}:replace_v1`;
const replaceJournalPrefix = `${replaceStoreKey}:entry:`;
const stamp = '2026-09-30T00:00:00.000Z';
const tasks = data.weeks.flatMap(week => week.tasks);
const videoTask = tasks.find(task => task.track === 'ls' && task.activity === 'video' && task.segments.length > 1);
const practiceTask = tasks.find(task => task.track === 'ydy' && task.activity === 'practice');

function harness(seed, marker, beforeStoreSet) {
  const saved = new Map(seed ? [[storeKey, JSON.stringify(seed)]] : []);
  if (marker) saved.set(`${replaceJournalPrefix}${marker.generation ?? 0}:${marker.id}:${marker.revision}:${marker.status}:seed`, JSON.stringify(marker));
  const downloads = [];
  const sandbox = vm.createContext({
    DATA: data,
    console,
    navigator: { onLine: true },
    localStorage: {
      get length() { return saved.size; },
      key: index => [...saved.keys()][index] ?? null,
      getItem: key => saved.get(key) ?? null,
      removeItem: key => saved.delete(key),
      setItem: (key, value) => {
        beforeStoreSet?.(key, String(value), saved);
        saved.set(key, String(value));
      }
    },
    document: { createElement: () => ({ click() {} }) },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: {
      createObjectURL: blob => { downloads.push(JSON.parse(blob.parts.join(''))); return 'blob:backup'; },
      revokeObjectURL() {}
    },
    setTimeout: () => 0
  });
  vm.runInContext(source, sandbox);
  // Exercise real state/backup functions without starting the DOM renderer or a network sync.
  vm.runInContext('render = () => {}; syncToServer = () => {}; showToast = (...args) => { globalThis.lastToastArgs = args; };', sandbox);
  return {
    saved,
    downloads,
    evaluate: expression => vm.runInContext(expression, sandbox),
    json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, sandbox))
  };
}

test('valid partial progress survives normalization; malformed backup progress is rejected', () => {
  const h = harness();
  const video = { kind: 'video', segmentIndex: 1, positionSecond: 300, note: '下次从第二段 05:00 继续' };
  const practice = { kind: 'practice', completedSteps: [0, 2], workedMinutes: 26, note: '编译通过，联调待做' };
  const normalized = h.json(`normalizeState(${JSON.stringify({ entries: {
    [videoTask.id]: { done: false, updatedAt: stamp, progress: video },
    [practiceTask.id]: { done: false, updatedAt: stamp, progress: practice }
  } })})`);
  assert.deepEqual(normalized.entries[videoTask.id].progress, video);
  assert.deepEqual(normalized.entries[practiceTask.id].progress, practice);
  assert.equal(normalized.entries[videoTask.id].done, false);
  assert.equal(normalized.entries[practiceTask.id].done, false);

  const invalid = [
    { kind: 'other' }, { kind: 'video', segmentIndex: -1 }, { kind: 'video', segmentIndex: 1000 },
    { kind: 'video', positionSecond: 864001 }, { kind: 'video', workedMinutes: 18 },
    { kind: 'practice', segmentIndex: 0 }, { kind: 'practice', workedMinutes: -1 },
    { kind: 'practice', workedMinutes: 100001 }, { kind: 'practice', completedSteps: [0, 0] },
    { kind: 'practice', completedSteps: [200] }, { kind: 'practice', completedSteps: Array.from({ length: 201 }, (_, i) => i) },
    { kind: 'video', note: 'x'.repeat(1001) }
  ];
  for (const progress of invalid) {
    const backup = { version: 3, entries: { [videoTask.id]: { done: false, updatedAt: stamp, progress } } };
    const rejected = h.evaluate(`(() => { try { importStateWithReport(${JSON.stringify(backup)}); return false; } catch { return true; } })()`);
    assert.equal(rejected, true, `Invalid progress should reject the backup: ${JSON.stringify(progress).slice(0, 90)}`);
  }
});

test('partial stop survives save, v3 export/import, completion Undo, and reload without counting as done', () => {
  const h = harness();
  const progress = { kind: 'video', segmentIndex: 1, positionSecond: 420, note: '保留停点' };
  h.evaluate(`saveTaskProgress(${JSON.stringify(videoTask.id)}, ${JSON.stringify(progress)})`);
  assert.equal(h.evaluate(`taskDone(${JSON.stringify(videoTask.id)})`), false);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(videoTask.id)})`), progress);
  assert.equal(h.json('allTasks.filter(task => taskDone(task.id)).length'), 0, 'A stop point is not a completed task');
  assert.deepEqual(JSON.parse(h.saved.get(storeKey)).entries[videoTask.id].progress, progress, 'The stop point is cached locally');

  h.evaluate('exportData()');
  const backup = h.downloads.at(-1);
  assert.equal(backup.version, 3);
  assert.equal(backup.entries[videoTask.id].done, false);
  assert.deepEqual(backup.entries[videoTask.id].progress, progress);
  assert.deepEqual(backup.entrySnapshots.find(item => item.taskId === videoTask.id).record.progress, progress);
  const restored = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  assert.equal(restored.entries[videoTask.id].done, false);
  assert.deepEqual(restored.entries[videoTask.id].progress, progress);
  const snapshotOnly = h.json(`importStateWithReport(${JSON.stringify({
    version: 3, entrySnapshots: [backup.entrySnapshots.find(item => item.taskId === videoTask.id)]
  })})`);
  assert.equal(snapshotOnly.matched, 1);
  assert.deepEqual(snapshotOnly.entries[videoTask.id].progress, progress, 'Snapshot fallback also restores the stop');
  const reloaded = harness({ entries: restored.entries });
  assert.deepEqual(reloaded.json(`taskProgress(${JSON.stringify(videoTask.id)})`), progress);
  assert.equal(reloaded.evaluate(`taskDone(${JSON.stringify(videoTask.id)})`), false);

  h.evaluate(`changeTask(${JSON.stringify(videoTask.id)}, true)`);
  assert.equal(h.evaluate(`taskDone(${JSON.stringify(videoTask.id)})`), true);
  h.evaluate('lastToastArgs[1].run()');
  assert.equal(h.evaluate(`taskDone(${JSON.stringify(videoTask.id)})`), false);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(videoTask.id)})`), progress, 'Undo restores the previous video stop');
});

test('partial practice and video entries do not alter the fixed workload or milestone counts', () => {
  assert.equal(data.weeks.length, 52);
  assert.equal(tasks.length, 364);
  assert.equal(tasks.reduce((sum, task) => sum + task.durationMinutes, 0), 26031);
  const lsSessions = tasks.filter(task => task.track === 'ls' && task.activity === 'video');
  assert.equal(lsSessions.length, 156);
  assert.equal(lsSessions.reduce((sum, task) => sum + task.durationMinutes, 0), 6271);
  const edoyunSegments = tasks.flatMap(task => task.learningSegments || []);
  assert.equal(new Set(edoyunSegments.map(segment => segment.sectionId)).size, 165);
  assert.equal(edoyunSegments.reduce((sum, segment) => sum + segment.endSecond - segment.startSecond, 0), 303529);

  const h = harness();
  const baseline = h.json('DATA.weeks');
  h.evaluate(`saveTaskProgress(${JSON.stringify(videoTask.id)}, ${JSON.stringify({ kind: 'video', segmentIndex: 0, positionSecond: 600 })})`);
  h.evaluate(`saveTaskProgress(${JSON.stringify(practiceTask.id)}, ${JSON.stringify({ kind: 'practice', completedSteps: [0], workedMinutes: 15 })})`);
  assert.deepEqual(h.json('DATA.weeks'), baseline, 'Progress writes must not mutate dates, tasks, video intervals, or budgets');
  assert.equal(h.json('allTasks.filter(task => taskDone(task.id)).length'), 0);
  assert.equal(h.json('DATA.milestones.map(goal => milestoneProgress(goal).completed).reduce((a, b) => a + b, 0)'), 0);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(practiceTask.id)})`), { kind: 'practice', completedSteps: [0], workedMinutes: 15 });
});

test('clearing check-ins keeps unfinished stop points, and Undo restores prior completion', async () => {
  const h = harness();
  const video = { kind: 'video', segmentIndex: 0, positionSecond: 600 };
  const practice = { kind: 'practice', completedSteps: [0], workedMinutes: 15, note: '继续联调' };
  h.evaluate(`saveTaskProgress(${JSON.stringify(videoTask.id)}, ${JSON.stringify(video)})`);
  h.evaluate(`saveTaskProgress(${JSON.stringify(practiceTask.id)}, ${JSON.stringify(practice)})`);
  h.evaluate(`changeTask(${JSON.stringify(practiceTask.id)}, true)`);
  h.evaluate('confirmAction = async () => true');
  await h.evaluate('resetAllTasks()');
  assert.equal(h.evaluate(`taskDone(${JSON.stringify(practiceTask.id)})`), false);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(videoTask.id)})`), video);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(practiceTask.id)})`), practice);
  h.evaluate('lastToastArgs[1].run()');
  assert.equal(h.evaluate(`taskDone(${JSON.stringify(practiceTask.id)})`), true);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(videoTask.id)})`), video);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(practiceTask.id)})`), practice);
});

test('a sync response cannot restamp an older remote stop over another tab’s newer local stop', async () => {
  const id = videoTask.id;
  const entry = (positionSecond, updatedAt) => ({
    done: false, updatedAt, progress: { kind: 'video', segmentIndex: 0, positionSecond }
  });
  const old = entry(100, '2030-01-01T00:00:00.000Z');
  const remote = entry(200, '2030-01-01T00:01:00.000Z');
  const otherTab = entry(300, '2030-01-01T00:02:00.000Z');
  const h = harness({ entries: { [id]: old } }, {
    id: 'ack-1', status: 'ack', revision: 1, entries: { [id]: old }
  });
  const serverReply = { state: { entries: { [id]: remote } }, serverTime: '2030-01-01T00:01:01.000Z' };
  // The other tab writes its newer stop while this tab's network request is in flight.
  h.evaluate(`fetchJSON = async () => {
    localStorage.setItem(${JSON.stringify(storeKey)}, ${JSON.stringify(JSON.stringify({ entries: { [id]: otherTab } }))});
    return ${JSON.stringify(serverReply)};
  }`);
  h.evaluate('updateSyncUI = () => {}; syncRequested = true');
  assert.equal(await h.evaluate('runSyncLoop(true)'), true);
  const saved = JSON.parse(h.saved.get(storeKey)).entries[id];
  assert.equal(saved.progress.positionSecond, 300, 'The newer stop from the other tab must win');
  assert.equal(saved.updatedAt, otherTab.updatedAt, 'A remote response must not restamp an older stop');
});

test('replace acknowledgement cannot erase a later pending revision from another tab', async () => {
  const id = videoTask.id;
  const entry = (positionSecond, updatedAt) => ({
    done: false, updatedAt, progress: { kind: 'video', segmentIndex: 0, positionSecond }
  });
  const first = entry(200, '2030-01-01T00:01:00.000Z');
  const later = entry(300, '2030-01-01T00:02:00.000Z');
  const pending = revision => ({ id: 'restore-1', generation: 1, status: 'pending', revision,
    entries: { [id]: revision === 1 ? first : later } });
  let injected = false;
  const h = harness({ entries: { [id]: first }, pendingReplace: true }, pending(1), (key, value, saved) => {
    // A's marker read already saw revision 1. B saves revision 2 just before A publishes ack 1.
    if (key.startsWith(replaceJournalPrefix) && JSON.parse(value).status === 'ack' && !injected) {
      injected = true;
      saved.set(`${replaceJournalPrefix}1:restore-1:2:pending:other-tab`, JSON.stringify(pending(2)));
      saved.set(storeKey, JSON.stringify({ entries: { [id]: later }, pendingReplace: true }));
    }
  });
  const reply = { state: { entries: { [id]: first } }, serverTime: '2030-01-01T00:01:01.000Z' };
  h.evaluate(`fetchJSON = async () => (${JSON.stringify(reply)}); updateSyncUI = () => {}; syncRequested = true`);
  await h.evaluate('runSyncLoop(true)');
  assert.equal(injected, true, 'The interleaving must occur at acknowledgement');
  const stored = JSON.parse(h.saved.get(storeKey));
  const marker = h.json('readReplaceMarker()');
  assert.equal(stored.entries[id].progress.positionSecond, 300, 'The other tab’s saved stop must remain in local storage');
  assert.equal(marker.entries[id].progress.positionSecond, 300, 'The acknowledgement marker must not erase revision 2');
});

test('Undo remains available for memory-only progress when browser persistence fails', () => {
  const id = practiceTask.id;
  const prior = { kind: 'practice', workedMinutes: 15, completedSteps: [0], note: '之前的记录' };
  for (const readable of [true, false]) {
    const h = harness({ entries: { [id]: { done: false, updatedAt: stamp, progress: prior } } });
    h.evaluate(`localStorage.setItem = () => { throw new Error('Storage unavailable'); };`);
    if (!readable) h.evaluate(`localStorage.getItem = () => { throw new Error('Storage unavailable'); };`);
    h.evaluate(`saveTaskProgress(${JSON.stringify(id)}, ${JSON.stringify({ ...prior, workedMinutes: 40 })})`);
    assert.equal(h.evaluate('persistenceError'), true);
    assert.equal(h.evaluate(`taskProgress(${JSON.stringify(id)}).workedMinutes`), 40);
    h.evaluate('lastToastArgs[1].run()');
    assert.deepEqual(h.json(`taskProgress(${JSON.stringify(id)})`), prior,
      'Undo restores the preceding in-memory progress without treating inaccessible storage as a new record');
    assert.match(h.evaluate('lastToastArgs[0]'), /进度已恢复.*浏览器无法保存/);
    assert.equal(h.evaluate('lastToastArgs[2]'), 'error');
  }
});

test('Undo rejects a same-task storage update written between saving and offering the notification', () => {
  const id = practiceTask.id;
  const h = harness();
  const newer = { done: false, updatedAt: '2030-01-01T00:00:00.000Z',
    progress: { kind: 'practice', workedMinutes: 60, completedSteps: [0], note: '另一标签的新记录' } };
  h.evaluate(`render = () => {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    stored.entries[${JSON.stringify(id)}] = ${JSON.stringify(newer)};
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  };`);
  h.evaluate(`changeTask(${JSON.stringify(id)}, true)`);
  const revision = h.evaluate('localRevision');
  const timestamp = h.evaluate('timestampFloor');
  h.evaluate('lastToastArgs[1].run()');
  assert.deepEqual(JSON.parse(h.saved.get(storeKey)).entries[id], newer,
    'An external record appearing before toast creation must never become an allowed Undo baseline');
  assert.equal(h.evaluate('localRevision'), revision);
  assert.equal(h.evaluate('timestampFloor'), timestamp);
  assert.match(h.evaluate('lastToastArgs[0]'), /记录已更新.*未撤销/);
});

test('pending replacement Undo checks only its own records and keeps newer unrelated marker entries', () => {
  const first = practiceTask.id;
  const second = videoTask.id;
  for (const changedTarget of [true, false]) {
    const entries = Object.fromEntries([first, second].map(id => [id, { done: false, updatedAt: stamp }]));
    const h = harness({ entries }, { id: 'undo-pending', generation: 1, revision: 0, status: 'pending', entries });
    h.evaluate(`changeTask(${JSON.stringify(first)}, true)`);
    const marker = h.json('readReplaceMarker()');
    const external = { done: true, updatedAt: '2030-01-01T00:00:00.000Z',
      progress: changedTarget ? { kind: 'practice', workedMinutes: 60 } : { kind: 'video', segmentIndex: 0, positionSecond: 300 } };
    const target = changedTarget ? first : second;
    const nextMarker = { ...marker, revision: marker.revision + 1,
      entries: { ...marker.entries, [target]: external } };
    h.saved.set(`${replaceJournalPrefix}${nextMarker.generation}:${nextMarker.id}:${nextMarker.revision}:pending:external`, JSON.stringify(nextMarker));
    h.evaluate('lastToastArgs[1].run()');
    if (changedTarget) {
      assert.deepEqual(h.json(`readReplaceMarker().entries[${JSON.stringify(first)}]`), external);
      assert.equal(h.evaluate('readReplaceMarker().revision'), nextMarker.revision);
      assert.match(h.evaluate('lastToastArgs[0]'), /记录已更新.*未撤销/);
    } else {
      assert.equal(h.evaluate(`taskDone(${JSON.stringify(first)})`), false);
      assert.deepEqual(h.json(`state.entries[${JSON.stringify(second)}]`), external);
      assert.deepEqual(h.json(`readReplaceMarker().entries[${JSON.stringify(second)}]`), external,
        'The unrelated marker record keeps its exact timestamp and contents after a valid Undo');
      assert.equal(h.evaluate('readReplaceMarker().status'), 'pending');
    }
  }
});
