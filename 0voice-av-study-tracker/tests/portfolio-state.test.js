'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const project = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(project, 'tracker-ui.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
const data = JSON.parse(fs.readFileSync(path.join(project, 'study-tracker.html'), 'utf8')
  .match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
const stamp = '2027-06-01T12:00:00.000Z';
const tasks = data.weeks.flatMap(week => week.tasks);
const coreFinal = tasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
const cancelledWork = data.legacyReferenceTasks.filter(task => task.id.startsWith('studio-portfolio-v1-') || task.id === 'studio-functional-v1-optional-remediation');
const legacyDeepening = data.legacyReferenceTasks.filter(task => task.id.startsWith('studio-functional-v1-') && !task.optional);

function harness(entries = {}, custom = data, preferences = {}) {
  const saved = new Map([['av_study_tracker_regenerated_v2', JSON.stringify({ entries })],
    ['av_study_tracker_ui_v1', JSON.stringify(preferences)]]);
  const nodes = new Map();
  const downloads = [];
  const element = () => ({ innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {}, options: [],
    focus() {}, select() {}, close() { this.open = false; },
    querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, classList: { toggle() {}, contains: () => false },
    parentElement: { setAttribute() {} } });
  const context = vm.createContext({ DATA: structuredClone(custom), console, navigator: { onLine: true },
    localStorage: { get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null,
      getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      querySelector: () => element(), body: { dataset: {}, classList: { toggle() {} } }, createElement: () => ({ click() {} }) },
    CSS: { escape: value => value }, URL: class extends URL {
      static createObjectURL(blob) { downloads.push(JSON.parse(blob.parts.join(''))); return 'blob:backup'; }
      static revokeObjectURL() {}
    }, Blob: class { constructor(parts) { this.parts = parts; } }, setTimeout: () => 0 });
  vm.runInContext(source, context);
  vm.runInContext('render = () => {}; syncToServer = () => {}; showToast = () => {};', context);
  return { nodes, saved, downloads, run: expression => vm.runInContext(expression, context),
    json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}


function finishLearning(h, except = []) {
  h.run(`for (const task of requiredLearningTasks().filter(task => !${JSON.stringify(except)}.includes(task.id))) state.entries[task.id] = createEntry(true, ${JSON.stringify(stamp)});`);
}

test('the original Studio course handoff opens career preparation directly without any replacement portfolio gate', () => {
  assert.deepEqual(data.planPhases.map(phase => phase.id), ['courses', 'career']);
  assert.equal(tasks.some(task => task.activity === 'portfolio'), false);
  assert.equal(cancelledWork.length, 5);
  const firstCareer = tasks.find(task => task.track === 'review');
  const h = harness();
  finishLearning(h, [coreFinal.id]);
  const before = h.json(`(() => {
    const date = DATA.careerWorkflow.preparationStartDate;
    return { id: learningRecommendation(defaultContinueTrack(date), date).next?.id,
      today: todayLearningSelection(date).tasks.map(task => task.id), blocked: learningRecommendation('review', date).blockedByLearning };
  })()`);
  assert.equal(before.id, coreFinal.id);
  assert.deepEqual(before.today, [coreFinal.id]);
  assert.equal(before.blocked, true, 'Only unfinished original course work delays career preparation');
  h.run(`changeTask(${JSON.stringify(coreFinal.id)}, true)`);
  const after = h.json(`(() => {
    const date = DATA.careerWorkflow.preparationStartDate;
    const next = learningRecommendation(defaultContinueTrack(date), date).next;
    return { complete: allLearningComplete(), next: next?.id, today: todayLearningSelection(date).tasks.map(task => task.id),
      html: taskMarkup(recommendedSessionTask(next, date), true, [], { date }),
      retired: ${JSON.stringify(cancelledWork.map(task => task.id))}.map(taskDone) };
  })()`);
  assert.equal(after.complete, true);
  assert.equal(after.next, firstCareer.id);
  assert.deepEqual(after.today, [firstCareer.id], 'Actual early course completion starts career preparation immediately');
  assert.ok(after.retired.every(done => done === false));
  assert.match(after.html, /记录本次 40 分钟/);
  assert.doesNotMatch(after.html, /data-task-action="toggle"/);
});

test('cancelled portfolio work and optional directions do not enter fixed sessions, required counts or application readiness', () => {
  const h = harness();
  const excluded = data.optionalExtensions.flatMap(extension => [extension.id, ...extension.historicalTaskIds]);
  assert.equal(data.optionalExtensions.length, 3);
  assert.equal(tasks.length, 208);
  assert.equal(h.run('requiredTasks().length'), 207);
  assert.equal(h.run('requiredLearningTasks().length'), 184);
  assert.equal(h.run(`allTasks.some(task => ${JSON.stringify(excluded)}.includes(task.id))`), false);
  assert.equal(h.run(`DATA.weeks.some(week => scheduledTasksForWeek(week).some(task => ${JSON.stringify(excluded)}.includes(task.id)))`), false);
  const markup = h.run('optionalExtensionsMarkup()');
  assert.match(markup, /后续可选方向/);
  assert.match(markup, /录制索引与回放（选做）/);
  assert.doesNotMatch(markup, /data-task-action|data-progress-action|data-task-id=|<button/);
  assert.equal(h.run('Object.keys(state.entries).length'), 0);
  finishLearning(h);
  assert.equal(h.run('allLearningComplete()'), true);
  assert.equal(h.run(`learningRecommendation('review', DATA.careerWorkflow.preparationStartDate).blockedByLearning`), false);
  h.run('for (const id of DATA.applicationMilestone.readinessTaskIds) state.entries[id] = createEntry(true, '+JSON.stringify(stamp)+');');
  assert.equal(h.run('applicationReadiness().ready'), true);
  assert.equal(h.run(`allTasks.some(task => task.track === 'review' && !taskDone(task.id))`), true);
  assert.equal(h.run(`Object.keys(state.entries).some(id => ${JSON.stringify(excluded)}.includes(id))`), false);
  h.run('renderMilestones()');
  const career = h.nodes.get('applicationMilestone').innerHTML;
  assert.match(career, /可开始投递/);
  assert.doesNotMatch(career, /作品打磨|录制索引|回放入口|独立测量/);
});

test('both cancelled portfolio and earlier deepening histories remain readable and preserve their original acceptance evidence', () => {
  assert.equal(legacyDeepening.length, 11);
  const retired = [...cancelledWork, ...legacyDeepening];
  const oldReviews = [...new Set(data.optionalExtensions.flatMap(extension => (extension.historicalReviewKeys || [])))];
  const entries = Object.fromEntries([...retired.map(task => [task.id, { done: true, updatedAt: stamp,
    evidence: `旧成果 ${task.id}`, progress: { kind: 'practice', workedMinutes: task.durationMinutes, completedSteps: [0], note: '原始学习记录' } }]),
    ...oldReviews.map(key => [key, { done: true, updatedAt: stamp, evidence: `旧验收 ${key}` }])]);
  const h = harness(entries);
  assert.equal(h.run('allLearningComplete()'), false);
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run(`DATA.milestones.some(goal => ['studio-portfolio', 'studio-rtc', 'studio-validation'].includes(goal.id))`), false);
  assert.equal(h.run(`DATA.milestones.some(goal => milestoneReview(goal)?.done)`), false);
  const markup = h.run('optionalExtensionsMarkup()');
  for (const task of retired) assert.ok(markup.includes(task.id), `The original ${task.id} evidence must remain readable`);
  for (const key of oldReviews) assert.ok(markup.includes(`data-historical-review-key="${key}"`), `The original ${key} acceptance must remain readable`);
  assert.match(markup, /原始学习记录/);
  assert.match(markup, /原记录仅供追溯，不纳入当前计划的进度或完成门槛/);
  assert.doesNotMatch(markup, /请按当前任务重新验收|<button|data-task-action|data-progress-action/);
  h.run('exportData()');
  const backup = h.downloads[0];
  for (const id of [...retired.map(task => task.id), ...oldReviews]) {
    assert.deepEqual(backup.archivedEntries[id], entries[id], `Export must preserve raw historical record ${id}`);
  }
  const imported = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  for (const id of [...retired.map(task => task.id), ...oldReviews]) assert.deepEqual(imported.entries[id], entries[id]);
  assert.equal(h.json(`importStateWithReport(${JSON.stringify({ archivedEntries: entries })})`).activeMatched, 0,
    'History-only imports cannot replace or derive current task progress');
});

test('history-only cancelled-module imports preserve original timestamps and leave the current course stop untouched', async () => {
  const current = { done: false, updatedAt: '2027-06-02T12:00:00.000Z',
    progress: { kind: 'practice', workedMinutes: 40, completedSteps: [0], note: '当前原课收尾进度' } };
  const archives = Object.fromEntries([...cancelledWork, ...legacyDeepening].map(task => [task.id,
    { done: true, updatedAt: stamp, evidence: `仅历史 ${task.id}` }]));
  const h = harness({ [coreFinal.id]: current });
  h.run(`globalThis.importPrompt = ''; confirmAction = async options => { importPrompt = options.message; return true; };`);
  await h.run(`importData({ text: async () => ${JSON.stringify(JSON.stringify({ version: 3, archivedEntries: archives }))} })`);
  assert.equal(h.json(`importStateWithReport(${JSON.stringify({ archivedEntries: archives })})`).matched, 0,
    'This fixture contains no history linked to a current task');
  assert.ok(h.run('importPrompt').includes(`包含 ${Object.keys(archives).length} 项原始历史记录，按原时间保留`));
  assert.deepEqual(h.json(`state.entries[${JSON.stringify(coreFinal.id)}]`), current);
  for (const [id, record] of Object.entries(archives)) assert.deepEqual(h.json(`state.entries[${JSON.stringify(id)}]`), record);
  assert.equal(h.run('allLearningComplete()'), false);
  assert.equal(h.run('state.pendingReplace'), false);
});

test('optional direction markup stays escaped, folded and separate from course check-ins and search', () => {
  const custom = structuredClone(data);
  const original = custom.optionalExtensions[0];
  original.title = '<img src=x onerror="alert(1)">';
  original.summary = '<script>alert(2)</script>';
  original.topics = ['<svg onload="alert(3)">', 'RTC & TURN'];
  const h = harness({}, custom);
  const markup = h.run('optionalExtensionsMarkup()');
  assert.match(markup, /data-optional-extensions><details><summary>/);
  assert.doesNotMatch(markup, /<details open|<script|<img|<svg onload|<button|data-on-demand-tasks/);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(markup, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(markup, /RTC &amp; TURN/);
  assert.equal(h.run('Object.keys(state.entries).length'), 0);
  h.run(`selectedPhase = 'courses'; selectedWeek = DATA.planPhases[0].endWeek; selectedView = 'planner'; renderPlanner();`);
  assert.match(h.nodes.get('weekTasks').innerHTML, /data-optional-extensions/);
  assert.match(h.nodes.get('weekTasks').innerHTML, /data-on-demand-tasks/);
  for (const track of ['ls', 'review', 'ydy', 'all']) {
    h.run(`trackFilter = '${track}'; renderPlanner();`);
    assert.equal(h.nodes.get('weekTasks').innerHTML.includes('data-optional-extensions'), ['all', 'ydy'].includes(track),
      `Project reference directions must respect the ${track} source filter`);
  }
  h.run(`searchQuery = 'does-not-match'; renderPlanner();`);
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /data-optional-extensions/);
  h.run(`searchQuery = ''; progressListScope = { phase: 'courses', track: 'ydy', project: 'studio-course' }; renderPlanner();`);
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /data-optional-extensions/);
  h.run(`progressListScope = null; selectedPhase = 'career'; selectedWeek = DATA.planPhases.find(phase => phase.id === 'career').startWeek; renderPlanner();`);
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /data-optional-extensions/);
});

test('saved preferences for the removed projects phase and portfolio outline safely fall back to the course plan', () => {
  for (const week of [35, 49]) {
    const h = harness({}, data, { view: 'planner', phase: 'projects', week, progressPhase: 'projects',
      progressScope: { phase: 'projects', track: 'ydy', project: 'studio-portfolio' },
      progressReturn: { week: 34, scroll: 900 }, filter: 'all', track: 'ydy' });
    const selected = h.json(`({ phase: selectedPhase, week: selectedWeek, progressPhase: selectedProgressPhase,
      scope: progressListScope, origin: progressListReturn })`);
    assert.equal(selected.phase, 'courses');
    assert.ok(selected.week >= 1 && selected.week <= 33);
    assert.equal(selected.progressPhase, 'courses');
    assert.equal(selected.scope, null);
    assert.equal(selected.origin, null);
    h.run('renderPlanner(); renderSummary();');
    assert.match(h.nodes.get('weekTasks').innerHTML, /data-optional-extensions/);
    assert.equal((h.nodes.get('planPhaseSwitch').innerHTML.match(/data-phase=/g) || []).length, 2);
    assert.equal((h.nodes.get('progressPhaseSwitch').innerHTML.match(/data-progress-phase=/g) || []).length, 2);
    assert.doesNotMatch(h.nodes.get('planPhaseSwitch').innerHTML, /projects|作品打磨/);
    assert.doesNotMatch(h.nodes.get('planSummary').innerHTML, /项目推进至/,
      'Removing the project phase cannot relabel the career end date as a new project deadline');
    assert.equal(h.run(`normalizeProgressListScope({ phase: 'all', track: 'ydy', project: 'studio-portfolio' })`), null);
  }
});

test('all 36 reference plan weeks render without promoting retired work or changing progress', () => {
  assert.equal(data.weeks.length, 36);
  const h = harness();
  const result = h.json(`(() => {
    const original = allTasks.length;
    for (const week of DATA.weeks) {
      todayISO = () => dateAt(week.start, 2);
      selectedPhase = phaseForWeek(week).id; selectedProgressPhase = selectedPhase; selectedWeek = week.week; selectedView = 'planner';
      renderPlanner(); renderWeekList(); renderWeekPreview(); renderSummary(); renderToday(); renderContinue(); renderMilestones();
      const hasExtensions = $('weekTasks').innerHTML.includes('data-optional-extensions');
      if (hasExtensions !== (phaseForWeek(week).id === 'courses')) throw new Error('Optional direction display escaped its course scope');
    }
    return { original, after: allTasks.length, entries: Object.keys(state.entries).length,
      accepted: DATA.milestones.filter(goal => goal.kind === 'project').map(goal => milestoneReview(goal)?.done || false) };
  })()`);
  assert.equal(result.after, result.original);
  assert.equal(result.entries, 0);
  assert.ok(result.accepted.every(value => value === false));
});
