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
const workflow = data.careerWorkflow;
const eventId = workflow.teacherTaskId;
const firstInterview = workflow.interviewTaskIds[0];

function harness(entries = {}, custom = data, preferences = {}) {
  const saved = new Map([['av_study_tracker_regenerated_v2', JSON.stringify({ entries })],
    ['av_study_tracker_ui_v1', JSON.stringify(preferences)]]);
  const nodes = new Map();
  const selectors = new Map();
  const downloads = [];
  const element = () => {
    const classes = new Set();
    const attributes = new Map();
    return { innerHTML: '', value: '', textContent: '', hidden: false, open: false, style: {}, dataset: {}, options: [],
      focus() {}, select() {}, close() { this.open = false; },
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
      setAttribute: (name, value) => attributes.set(name, String(value)), getAttribute: name => attributes.get(name) ?? null,
      hasAttribute: name => attributes.has(name), removeAttribute: name => attributes.delete(name),
      classList: { toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); },
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
      parentElement: { setAttribute() {} } };
  };
  const context = vm.createContext({ DATA: structuredClone(custom), console, navigator: { onLine: true },
    localStorage: { get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null,
      getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, { ...element(), id }); return nodes.get(id); },
      querySelector: selector => { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
      querySelectorAll: () => [], body: { dataset: {}, classList: { toggle() {} } }, createElement: () => ({ click() {} }) },
    window: { scrollY: 0, scrollTo({ top }) { this.scrollY = top; } }, requestAnimationFrame: callback => callback(),
    CSS: { escape: value => value }, URL: class extends URL {
      static createObjectURL(blob) { downloads.push(JSON.parse(blob.parts.join(''))); return 'blob:backup'; }
      static revokeObjectURL() {}
    }, Blob: class { constructor(parts) { this.parts = parts; } }, setTimeout: () => 0 });
  const originalGet = context.document.getElementById;
  context.document.getElementById = id => {
    const node = originalGet(id);
    if (id === 'taskDialogBody') node.querySelector = selector => selector === '[data-progress-kind]' && node.innerHTML.includes('data-progress-kind="external"')
      ? { dataset: { progressKind: 'external' } } : null;
    return node;
  };
  vm.runInContext(source, context);
  vm.runInContext('render = () => {}; syncToServer = () => {}; showToast = () => {};', context);
  return { nodes, selectors, saved, downloads, run: expression => vm.runInContext(expression, context),
    json: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}

function finishLearning(h) { h.run('for (const task of requiredLearningTasks()) state.entries[task.id] = createEntry(true, '+JSON.stringify(stamp)+');'); }
function finishPreparation(h) { h.run('for (const id of DATA.careerWorkflow.preparationTaskIds) state.entries[id] = createEntry(true, '+JSON.stringify(stamp)+');'); }
function openTeacher(h, note = '') {
  h.run(`detailTaskId = ${JSON.stringify(eventId)}; $('taskDialog').open = true; $('taskProgressNote').value = ${JSON.stringify(note)}; renderTaskDetails();
    render = () => { if ($('taskDialog').open) renderTaskDetails(); }; showToast = (...args) => { globalThis.lastToast = args; };`);
}

function careerCards(html, materialsOnly = false) {
  const source = materialsOnly ? html.split('<section class="career-next-sections"')[0] : html;
  return [...source.matchAll(/<article\b([^>]*)>/g)].flatMap(([, attributes]) => {
    const classes = attributes.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) || [];
    const id = attributes.match(/\bdata-task-id="([^"]*)"/)?.[1];
    return id && classes.includes('task-card') ? [{ id, classes }] : [];
  });
}

function showCareer(h, date = workflow.preparationStartDate) {
  h.run(`selectedPhase = 'career'; selectedProgressPhase = 'career'; selectedWeek = DATA.planPhases.find(phase => phase.id === 'career').startWeek;
    selectedView = 'planner'; todayISO = () => ${JSON.stringify(date)}; renderPlanner();`);
  return h.nodes.get('weekTasks').innerHTML;
}

test('materials and teacher confirmation are strict prerequisites even with earlier interview check-ins', () => {
  const h = harness();
  const date = '2030-01-07';
  const firstCourse = tasks.find(task => task.track === 'ls');
  assert.equal(h.run(`todayLearningSelection(DATA.careerWorkflow.preparationStartDate).tasks[0].id`), firstCourse.id);
  assert.equal(h.run(`learningRecommendation('review', '${date}').next`), undefined);
  finishLearning(h);
  assert.equal(h.run(`learningRecommendation('review', '${date}').next.id`), workflow.preparationTaskIds[0]);
  h.run('for (const id of DATA.careerWorkflow.interviewTaskIds) state.entries[id] = createEntry(true, '+JSON.stringify(stamp)+');');
  finishPreparation(h);
  assert.equal(h.run(`learningRecommendation('review', '${date}').next.id`), eventId);
  assert.deepEqual(h.json(`todayLearningSelection('${date}').tasks.map(task => task.id)`), [eventId]);
  assert.equal(h.run('applicationReadiness().ready'), false);
  h.run(`state.entries[${JSON.stringify(firstInterview)}] = createEntry(false, ${JSON.stringify(stamp)});`);
  assert.ok(h.json(`unfinishedPrerequisites(taskById.get(${JSON.stringify(firstInterview)})).map(task => task.id)`).includes(eventId));
  assert.match(h.run(`taskProgressMarkup(taskById.get(${JSON.stringify(firstInterview)}))`), /面试准备尚未开始/);
  assert.equal(h.run(`saveTaskProgress(${JSON.stringify(firstInterview)}, { kind: 'practice', workedMinutes: 40, note: '不应提前写入' })`), false);
  h.run(`changeTask(${JSON.stringify(firstInterview)}, true)`);
  assert.equal(h.run(`taskDone(${JSON.stringify(firstInterview)})`), false, 'A new interview completion cannot bypass teacher confirmation');
  h.run(`changeTask(${JSON.stringify(eventId)}, true)`);
  assert.equal(h.run('applicationReadiness().ready'), true);
  assert.equal(h.run(`learningRecommendation('review', '${date}').next.id`), firstInterview);
  h.run(`changeTask(${JSON.stringify(eventId)}, false)`);
  assert.equal(h.run('applicationReadiness().ready'), false);
  assert.equal(h.run(`learningRecommendation('review', '${date}').next.id`), eventId);
});

test('the teacher event has no scheduled work or waiting budget and interviews keep relative 40-minute sessions', () => {
  const h = harness();
  const view = h.json(`(() => {
    const teacher = taskById.get(DATA.careerWorkflow.teacherTaskId);
    const career = DATA.planPhases.find(phase => phase.id === 'career');
    const referenceSessions = phaseWeeks(career).flatMap(week => scheduledTasksForWeek(week));
    return { sessions: referenceSessions.map(task => task.id), minutes: totalTaskMinutes(referenceSessions),
      duration: taskDuration(teacher), eventDate: taskPlanDateLabel(teacher), teacherMinutes: taskMinutes(teacher),
      budget: allTasks.filter(task => task.track === 'review').reduce((sum, task) => sum + taskMinutes(task), 0),
      labels: DATA.careerWorkflow.interviewTaskIds.map(id => taskPlanDateLabel(taskById.get(id))) };
  })()`);
  assert.deepEqual([...new Set(view.sessions)].sort(), [...workflow.preparationTaskIds].sort());
  assert.equal(view.minutes, 800);
  assert.equal(view.teacherMinutes, 0);
  assert.equal(view.budget, 1400);
  assert.match(view.duration, /外部协作.*不估算等待时长/);
  assert.doesNotMatch(view.duration, /0 分钟/);
  assert.match(view.eventDate, /无固定日期/);
  assert.deepEqual(view.labels, workflow.interviewTaskIds.map((_, index) => `沟通确认后 · 第 ${index + 1} 次`));
  finishLearning(h); finishPreparation(h);
  h.run(`changeTask(${JSON.stringify(eventId)}, true)`);
  const html = h.run(`taskMarkup(recommendedSessionTask(taskById.get(${JSON.stringify(firstInterview)}), '2030-01-07'), true, [], { date: '2030-01-07' })`);
  assert.match(html, /记录本次 40 分钟/);
  assert.doesNotMatch(html, /data-task-action="toggle"/);
  h.run(`saveTaskProgress(${JSON.stringify(firstInterview)}, { kind: 'practice', workedMinutes: 30, note: '实际答题进度' })`);
  assert.equal(h.run(`taskDone(${JSON.stringify(firstInterview)})`), false);
});

test('completed remote-control work enters materials and the fifth interview without repeating its course or claiming unverified capabilities', () => {
  const preparation = tasks.find(task => task.id === workflow.preparationTaskIds[0]);
  const remoteInterview = tasks.find(task => task.id === workflow.interviewTaskIds[4]);
  assert.match(preparation.title, /远控/);
  assert.match(remoteInterview.title, /远控/);
  assert.equal(remoteInterview.relativeOrder, 5);
  assert.equal(workflow.preparationTaskIds.length, 7);
  assert.equal(workflow.preparationMinutes, 800);
  assert.equal(workflow.interviewTaskIds.length, 15);
  assert.equal(workflow.interviewMinutes, 600);
  assert.match([preparation.summary, ...preparation.steps].join(' '), /现有|已完成/);
  assert.match([preparation.summary, ...preparation.steps].join(' '), /回看|核对|确认/);
  assert.match([preparation.summary, ...preparation.steps].join(' '), /不.*未做功能.*未测指标/);
  assert.equal(preparation.track, 'review');
  assert.equal(preparation.durationMinutes, 160);
  assert.equal(preparation.workSessions.length, 4);
  assert.equal(remoteInterview.track, 'review');
  assert.equal(remoteInterview.durationMinutes, 40);
  assert.equal(tasks.some(task => task.track !== 'review' && /远控/.test(task.title)), false,
    'A completed remote-control project must not be scheduled as a new video or implementation task');
  assert.ok(data.completedProjects.some(project => /远控/.test(project.name)), 'The completed project remains explicitly recorded');
  const h = harness(); finishLearning(h);
  h.run(`for (const id of DATA.careerWorkflow.preparationTaskIds.filter(id => id !== ${JSON.stringify(preparation.id)})) state.entries[id] = createEntry(true, ${JSON.stringify(stamp)});`);
  assert.equal(h.run(`learningRecommendation('review', '2030-01-07').next.id`), preparation.id,
    'Other prepared modules cannot conceal the missing complete remote-control module');
  assert.ok(h.json(`unfinishedPrerequisites(taskById.get(${JSON.stringify(eventId)})).map(task => task.id)`).includes(preparation.id));
  assert.equal(h.run('applicationReadiness().ready'), false);
  h.run(`changeTask(${JSON.stringify(eventId)}, true)`);
  assert.equal(h.run(`taskDone(${JSON.stringify(eventId)})`), false);
  h.run(`changeTask(${JSON.stringify(preparation.id)}, true)`);
  assert.equal(h.run(`learningRecommendation('review', '2030-01-07').next.id`), eventId);
  assert.equal(h.run('applicationReadiness().ready'), false, 'Preparing remote-control evidence alone cannot confirm the teacher event');
  h.run(`changeTask(${JSON.stringify(eventId)}, true)`);
  assert.equal(h.run('applicationReadiness().ready'), true);
  assert.equal(h.json('applicationReadiness().tasks').length, 8);
  for (const id of workflow.interviewTaskIds.slice(0, 4)) h.run(`changeTask(${JSON.stringify(id)}, true)`);
  assert.equal(h.run(`learningRecommendation('review', '2030-01-07').next.id`), remoteInterview.id);
});

test('complete project modules share progress across dated sessions and preserve only real session focus', () => {
  const h = harness(); finishLearning(h);
  const remote = tasks.find(task => task.id === workflow.projectPreparationTaskIds[0]);
  const yibo = tasks.find(task => task.id === workflow.projectPreparationTaskIds[1]);
  assert.equal(remote.workSessions.length, 4);
  assert.ok(remote.workSessions.every(session => session.minutes === 40 && session.focus));
  const result = h.json(`(() => {
    const source = taskById.get(${JSON.stringify(remote.id)});
    const firstDate = source.workSessions[0].date, secondDate = source.workSessions[1].date;
    const first = scheduledTasksForDate(firstDate).find(task => task.id === source.id);
    const second = recommendedSessionTask(source, secondDate);
    const early = recommendedSessionTask(source, '2027-05-17');
    return { unique: allTasks.filter(task => task.id === source.id).length,
      first: { focus: first.sessionFocus, text: taskDescription(first), minutes: totalTaskMinutes([first]) },
      second: { focus: second.sessionFocus, text: taskDescription(second), minutes: totalTaskMinutes([second]) },
      early: { focus: early.sessionFocus, text: taskDescription(early), minutes: totalTaskMinutes([early]) },
      sourceFocus: source.sessionFocus || null, total: taskMinutes(source), details: taskWorkSessionsMarkup(source) };
  })()`);
  assert.equal(result.unique, 1);
  assert.equal(result.first.focus, remote.workSessions[0].focus);
  assert.equal(result.second.focus, remote.workSessions[1].focus);
  assert.notEqual(result.first.focus, result.second.focus);
  assert.match(result.first.text, /本次参考重点/);
  assert.ok(result.second.text.includes(remote.workSessions[1].focus));
  assert.equal(result.first.minutes, 40); assert.equal(result.second.minutes, 40);
  assert.equal(result.early.minutes, 40); assert.equal(result.early.focus, '');
  assert.equal(result.sourceFocus, null); assert.equal(result.total, 160);
  for (const session of remote.workSessions) assert.ok(result.details.includes(session.focus));
  h.run(`saveTaskProgress(${JSON.stringify(remote.id)}, { kind: 'practice', workedMinutes: 40, completedSteps: [0], note: '首日已梳理，继续核对其余模块' })`);
  assert.equal(h.run(`taskDone(${JSON.stringify(remote.id)})`), false);
  assert.equal(h.run(`learningRecommendation('review', ${JSON.stringify(remote.workSessions[1].date)}).next.id`), remote.id);
  assert.ok(h.json(`unfinishedPrerequisites(taskById.get(${JSON.stringify(yibo.id)})).map(task => task.id)`).includes(remote.id));
});

test('weekdays prefer complete projects while Saturdays prefer independent skills and both allow advance study', () => {
  const h = harness(); finishLearning(h);
  const remote = tasks.find(task => task.id === workflow.projectPreparationTaskIds[0]);
  const av = tasks.find(task => task.id === workflow.skillPreparationTaskIds[0]);
  const build = tasks.find(task => task.id === workflow.skillPreparationTaskIds[1]);
  const cpp = tasks.find(task => task.id === workflow.skillPreparationTaskIds[2]);
  assert.deepEqual(h.json(`unfinishedPrerequisites(taskById.get(${JSON.stringify(av.id)})).map(task => task.id)`), []);
  assert.equal(h.run(`learningRecommendation('review', ${JSON.stringify(remote.date)}).next.id`), remote.id);
  assert.equal(h.run(`learningRecommendation('review', ${JSON.stringify(av.date)}).next.id`), av.id);
  assert.deepEqual(h.json(`todayLearningSelection(${JSON.stringify(av.date)}).tasks.map(task => task.id)`), [av.id]);
  assert.equal(h.run(`practiceSessionMinutes(taskById.get(${JSON.stringify(av.id)}), ${JSON.stringify(av.date)})`), 120);
  h.run(`saveTaskProgress(${JSON.stringify(av.id)}, { kind: 'practice', workedMinutes: 120, note: '技能材料已整理，待核对产物' })`);
  assert.equal(h.run(`taskDone(${JSON.stringify(av.id)})`), false);
  const reviewCard = h.run(`taskMarkup(recommendedSessionTask(taskById.get(${JSON.stringify(av.id)}), ${JSON.stringify(av.date)}), true, [], { date: ${JSON.stringify(av.date)} })`);
  assert.match(reviewCard, /核对成果并完成模块/);
  assert.match(reviewCard, /追加实际记录/);
  assert.doesNotMatch(reviewCard, /记录本次 2 小时/);
  assert.deepEqual(h.json(`todayLearningSelection(${JSON.stringify(build.date)}).tasks.map(task => task.id)`), [av.id, build.id, cpp.id],
    'A skill awaiting verification remains visible alongside the other modules scheduled for that Saturday');
  h.run(`changeTask(${JSON.stringify(av.id)}, true)`);
  assert.equal(h.run(`learningRecommendation('review', ${JSON.stringify(build.date)}).next.id`), build.id);
  assert.equal(h.run(`practiceSessionMinutes(taskById.get(${JSON.stringify(build.id)}), ${JSON.stringify(build.date)})`), 60);
  assert.equal(h.run(`totalTaskMinutes(scheduledTasksForDate(${JSON.stringify(build.date)}))`), 120);
  h.run(`changeTask(${JSON.stringify(build.id)}, true)`);
  assert.deepEqual(h.json(`todayLearningSelection(${JSON.stringify(cpp.date)}).tasks.map(task => task.id)`), [cpp.id]);
  assert.equal(h.run(`learningRecommendation('review', ${JSON.stringify(cpp.date)}).next.id`), cpp.id);
  h.run(`changeTask(${JSON.stringify(cpp.id)}, true)`);
  assert.equal(h.run(`learningRecommendation('review', ${JSON.stringify(cpp.date)}).next.id`), remote.id,
    'Completing Saturday skills can bring unfinished project preparation forward');
  assert.equal(h.run(`practiceSessionMinutes(taskById.get(${JSON.stringify(remote.id)}), ${JSON.stringify(cpp.date)})`), 40);
  h.run(`for (const id of DATA.careerWorkflow.projectPreparationTaskIds) changeTask(id, true); changeTask(${JSON.stringify(av.id)}, false);`);
  assert.equal(h.run(`learningRecommendation('review', '2027-06-11').next.id`), av.id,
    'Completing project preparation may bring the remaining skill module into a weekday');
  assert.equal(h.run(`practiceSessionMinutes(taskById.get(${JSON.stringify(av.id)}), '2027-06-11')`), 40);
  assert.equal(h.run('applicationReadiness().ready'), false, 'The teacher still requires the remaining skill module');
  h.run(`changeTask(${JSON.stringify(av.id)}, true)`);
  assert.equal(h.run(`learningRecommendation('review', '2027-06-11').next.id`), eventId);
});

test('early and delayed Saturdays share the skill recommendation without assigning Sunday work', () => {
  const h = harness(); finishLearning(h);
  const av = tasks.find(task => task.id === workflow.skillPreparationTaskIds[0]);
  for (const date of ['2026-10-10', '2027-06-12', '2030-01-05']) {
    const value = h.json(`(() => { const selection = todayLearningSelection(${JSON.stringify(date)}); return {
      ids: selection.tasks.map(task => task.id), optional: selection.optional, focus: selection.tasks[0]?.sessionFocus,
      next: learningRecommendation('review', ${JSON.stringify(date)}).next?.id,
      raw: scheduledTasksForDate(${JSON.stringify(date)}).map(task => task.track) }; })()`);
    assert.deepEqual(value.ids, [av.id], `${date} should display the pending skill module instead of an old completed course or empty calendar`);
    assert.equal(value.next, av.id);
    assert.equal(value.optional, true);
    assert.equal(value.focus, '', 'A date with no planned session cannot invent a daily focus');
  }
  assert.deepEqual(h.json(`todayLearningSelection('2027-06-13').tasks.map(task => task.id)`), []);
  assert.deepEqual(h.json(`todayLearningSelection('2030-01-06').tasks.map(task => task.id)`), []);
});

test('overview Saturday rhythm follows pending preparation while the planner retains its selected reference week', () => {
  const h = harness(); finishLearning(h);
  const saturday = tasks.find(task => task.id === workflow.skillPreparationTaskIds[0]).date;
  const week = data.weeks.find(week => week.start <= saturday && saturday <= week.end);
  h.run(`globalThis.skillWeek = DATA.weeks.find(week => week.week === ${week.week});`);
  assert.match(h.run(`rhythmDescription(skillWeek, ${JSON.stringify(saturday)})`), /周六优先整理技能材料/);
  assert.doesNotMatch(h.run(`rhythmDescription(skillWeek, ${JSON.stringify(saturday)})`), /周六机动或休息/);
  assert.match(h.run(`rhythmDescription(skillWeek, '2027-05-17')`), /周六优先整理技能材料/,
    'Early course completion may bring skill preparation forward');
  assert.match(h.run(`rhythmDescription(skillWeek, '2030-01-07')`), /周六优先整理技能材料/,
    'Delayed skill preparation is still actionable after the reference calendar');
  assert.match(h.run('rhythmDescription(skillWeek, null)'), /工作日优先完整梳理项目.*周六技能材料整理 2 小时/);
  h.run(`changeTask(DATA.careerWorkflow.skillPreparationTaskIds[0], true);`);
  assert.match(h.run(`rhythmDescription(skillWeek, '2027-06-05')`), /周六优先整理技能材料，下一模块暂估 1 小时/,
    'The next one-hour module estimate is distinguished from the Saturday total');
  h.run(`for (const id of DATA.careerWorkflow.skillPreparationTaskIds) changeTask(id, true);`);
  assert.match(h.run(`rhythmDescription(skillWeek, ${JSON.stringify(saturday)})`), /周六可继续完整项目梳理/);
  assert.match(h.run('rhythmDescription(skillWeek, null)'), /周六技能材料整理 2 小时/,
    'Actual early completion cannot rewrite the selected reference calendar');
});

test('teacher note drafts use conflict detection, explicit confirmation, backup and Undo without minute fields', async () => {
  const h = harness(); finishLearning(h); finishPreparation(h); openTeacher(h);
  const html = h.nodes.get('taskDialogBody').innerHTML;
  assert.match(html, /data-progress-kind="external"/);
  assert.match(html, /保存沟通记录/);
  assert.doesNotMatch(html, /id="practiceWorkedTotal"|id="practiceSessionMinutes"|建议本次|累计 0/);
  h.run(`$('taskProgressNote').value = '老师反馈：突出原项目职责，简历v1待核对'; markTaskProgressDirty(); confirmAction = async options => { globalThis.exitPrompt = options.message; return false; };`);
  assert.equal(h.run('detailProgressDirty'), true);
  assert.equal(await h.run('confirmTaskDialogExit()'), false);
  assert.match(h.run('exitPrompt'), /沟通记录尚未保存/);
  await h.run('saveTaskProgressDraft()');
  assert.equal(h.run(`taskDone(${JSON.stringify(eventId)})`), false);
  assert.deepEqual(h.json(`taskProgress(${JSON.stringify(eventId)})`), { kind: 'practice', note: '老师反馈：突出原项目职责，简历v1待核对' });
  const firstStamp = h.run(`taskEntry(${JSON.stringify(eventId)}).updatedAt`);
  h.run(`$('taskProgressNote').value = '本地核对备注'; markTaskProgressDirty(); state.entries[${JSON.stringify(eventId)}] = createEntry(false, freshTimestamp(), '', { kind: 'practice', note: '另一设备反馈' }); saveState();`);
  await h.run('saveTaskProgressDraft()');
  assert.equal(h.run(`taskProgress(${JSON.stringify(eventId)}).note`), '另一设备反馈');
  assert.equal(h.nodes.get('taskProgressNote').value, '本地核对备注');
  assert.equal(h.nodes.get('taskProgressConflict').hidden, false);
  await h.run('saveTaskProgressDraft(true)');
  assert.equal(h.run(`taskProgress(${JSON.stringify(eventId)}).note`), '本地核对备注');
  h.run('lastToast[1].run()');
  assert.equal(h.run(`taskProgress(${JSON.stringify(eventId)}).note`), '另一设备反馈');
  assert.equal(h.run(`taskDone(${JSON.stringify(eventId)})`), false);
  h.run(`changeTask(${JSON.stringify(eventId)}, true); exportData();`);
  const backup = h.downloads.at(-1);
  assert.equal(backup.entries[eventId].done, true);
  assert.equal(backup.entries[eventId].progress.note, '另一设备反馈');
  assert.ok(Date.parse(backup.entries[eventId].updatedAt) >= Date.parse(firstStamp));
  const parsed = h.json(`importStateWithReport(${JSON.stringify(backup)})`);
  assert.deepEqual(parsed.entries[eventId], backup.entries[eventId]);
  assert.ok(h.run(`taskPlanDateLabel(taskById.get(${JSON.stringify(firstInterview)}))`).includes('沟通确认后'));
  assert.equal(h.run(`Object.hasOwn(taskById.get(${JSON.stringify(firstInterview)}), 'date')`), false);
});

test('floating workflow tasks render below the shared weekly cards, in global search, outlines and details without invented dates', () => {
  const h = harness();
  h.run(`selectedPhase = 'career'; selectedProgressPhase = 'career'; selectedWeek = DATA.weeks.at(-1).week; selectedView = 'planner';
    todayISO = () => '2030-01-07'; renderPlanner(); renderWeekList(); renderWeekPreview(); renderSummary(); renderToday(); renderContinue(); renderMilestones();`);
  const html = h.nodes.get('weekTasks').innerHTML;
  assert.doesNotMatch(html, /data-career-board|data-career-open-task/);
  assert.match(html, /data-career-workflow/);
  assert.match(html, /与老师沟通定制简历/);
  assert.match(html, /面试准备/);
  assert.match(html, /class="task-card/);
  assert.doesNotMatch(h.nodes.get('planPhaseSwitch').innerHTML, />1 周</);
  assert.match(h.nodes.get('planPhaseSwitch').innerHTML, /按进度推进/);
  assert.match(h.nodes.get('currentWeekHint').textContent, /参考日历.*按实际进度/);
  assert.equal(h.nodes.get('currentWeekHint').hidden, false, 'A weekly reference view retains its calendar context');
  assert.doesNotMatch(h.nodes.get('currentWeekHint').textContent, /学习计划已.*结束/);
  assert.doesNotMatch(h.nodes.get('applicationMilestone').innerHTML, /datetime="undefined"|2027年6月1日|计划开始投递/);
  for (const id of [eventId, ...workflow.interviewTaskIds]) {
    h.run(`detailTaskId = ${JSON.stringify(id)}; renderTaskDetails();`);
    assert.doesNotMatch(h.nodes.get('taskDialogBody').innerHTML, /Invalid Date|undefined|datetime=""/);
    assert.doesNotThrow(() => h.run(`taskOutlineMarkup(taskById.get(${JSON.stringify(id)}), new Set())`));
  }
  h.run(`searchQuery = '老师'; renderPlanner();`);
  assert.ok(h.nodes.get('weekTasks').innerHTML.includes(eventId));
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /data-career-board/);
  h.run(`searchQuery = ''; progressListScope = { phase: 'career', track: 'review', project: '' }; renderPlanner();`);
  assert.match(h.nodes.get('weekTasks').innerHTML, /task-outline-item/);
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /Invalid Date|undefined/);
});

test('career reference weeks use the same day cards for seventeen sessions while retaining seven shared module records', () => {
  const h = harness(); showCareer(h);
  const counts = [];
  const ids = new Set();
  let plannedMinutes = 0;
  for (const week of data.weeks.filter(week => week.week >= data.planPhases.find(phase => phase.id === 'career').startWeek)) {
    h.run(`selectedWeek = ${week.week}; renderPlanner();`);
    const html = h.nodes.get('weekTasks').innerHTML;
    const scheduled = h.json(`scheduledTasksForWeek(${week.week}).map(task => ({ id: task.id, focus: task.sessionFocus, date: task.date, minutes: task.sessionMinutes }))`);
    assert.deepEqual(careerCards(html, true).map(card => card.id), scheduled.map(task => task.id));
    assert.deepEqual(careerCards(html).slice(scheduled.length).map(card => card.id), [eventId, ...workflow.interviewTaskIds]);
    counts.push(scheduled.length);
    for (const task of scheduled) {
      ids.add(task.id); plannedMinutes += task.minutes;
      assert.ok(html.includes(`id="day-${task.date}"`));
      assert.ok(html.includes(h.run(`escapeHTML(${JSON.stringify(task.focus)})`)), 'Each dated card retains its own real focus');
    }
    assert.doesNotMatch(html, /data-career-board|career-module-row|career-steps|data-career-open-task/);
    assert.match(html, /data-career-section="teacher">/);
    assert.match(html, /data-career-section="interviews">/);
    assert.doesNotMatch(html, /data-career-section="(?:teacher|interviews)" open/);
    assert.doesNotMatch(html, /Invalid Date|undefined|NaN/);
  }
  assert.deepEqual(counts, [6, 7, 4]);
  assert.deepEqual([...ids].sort(), [...workflow.preparationTaskIds].sort());
  assert.equal(plannedMinutes, 800);
  assert.equal(h.run(`allTasks.filter(isCareerPreparation).length`), 7);
  assert.equal(h.nodes.get('plannerView').classList.contains('is-career-plan'), true);
  for (const id of ['planPhaseCaption', 'trackFilter', 'progressListContext']) assert.equal(h.nodes.get(id).hidden, true);
  for (const id of ['weekTopic', 'weekMeta', 'allWeeksDetails', 'weekCount']) assert.equal(h.nodes.get(id).hidden, false);
  for (const selector of ['.planner-topbar', '.week-navigation', '.list-context']) assert.equal(h.selectors.get(selector).hidden, false);
  assert.equal(h.selectors.get('label[for="trackFilter"]').hidden, true);
  assert.equal(h.nodes.get('weekTopic').innerHTML, data.weeks.at(-1).range);
  assert.equal(h.nodes.get('taskSearch').hidden, false);
  assert.equal(h.nodes.get('taskFilter').hidden, false);
});

test('career day cards preview before learning ends and share partial recording, verification and completion with course modules', () => {
  const h = harness();
  showCareer(h);
  let html = h.nodes.get('weekTasks').innerHTML.split('<section class="career-next-sections"')[0];
  assert.doesNotMatch(html, /data-progress-action="record-session"|data-task-action="toggle"/);
  assert.match(html, /class="check"[^>]*data-task-action="details"/);
  assert.equal(h.run(`learningRecommendation('review').next`), undefined);
  finishLearning(h); h.run('renderPlanner();');
  html = h.nodes.get('weekTasks').innerHTML.split('<section class="career-next-sections"')[0];
  assert.match(html, /class="check"[^>]*data-progress-action="record-session"/);
  assert.match(html, /本次 40 分钟.*模块预计总 2 小时 40 分钟/);
  h.run(`saveTaskProgress(DATA.careerWorkflow.projectPreparationTaskIds[0], { kind: 'practice', workedMinutes: 40, note: '首轮梳理' }); renderPlanner();`);
  assert.equal(h.run(`taskDone(DATA.careerWorkflow.projectPreparationTaskIds[0])`), false);
  assert.equal(h.run(`learningRecommendation('review').next.id`), workflow.projectPreparationTaskIds[0]);
  html = h.nodes.get('weekTasks').innerHTML;
  assert.equal((html.match(/已投入 40 分钟/g) || []).length, 4, 'All four dated cards read the same concise module progress');
  h.run(`saveTaskProgress(DATA.careerWorkflow.projectPreparationTaskIds[0], { kind: 'practice', workedMinutes: 160 }); renderPlanner();`);
  assert.equal(h.run(`taskDone(DATA.careerWorkflow.projectPreparationTaskIds[0])`), false, 'Estimated time never completes the module automatically');
  html = h.nodes.get('weekTasks').innerHTML;
  assert.equal((html.match(/aria-label="核对模块成果：/g) || []).length, 4);
  h.run(`changeTask(DATA.careerWorkflow.projectPreparationTaskIds[0], true); renderPlanner();`);
  assert.equal(careerCards(h.nodes.get('weekTasks').innerHTML, true).filter(card => card.classes.includes('is-done')).length, 4);
  assert.equal(h.run(`learningRecommendation('review').next.id`), workflow.projectPreparationTaskIds[1]);
  finishPreparation(h); h.run('renderPlanner();');
  assert.equal(h.run(`learningRecommendation('review').next.id`), eventId);
  assert.match(h.nodes.get('weekTasks').innerHTML, /data-career-section="teacher">/);
  h.run(`changeTask(${JSON.stringify(eventId)}, true); renderPlanner();`);
  assert.equal(h.run(`learningRecommendation('review').next.id`), firstInterview);
  assert.match(h.nodes.get('weekTasks').innerHTML, /data-career-section="interviews">/,
    'Finishing teacher confirmation does not auto-expand all fifteen interviews');
  for (const id of workflow.preparationTaskIds) {
    h.run(`detailTaskId = ${JSON.stringify(id)}; renderTaskDetails();`);
    const detail = h.nodes.get('taskDialogBody').innerHTML;
    const task = tasks.find(task => task.id === id);
    for (const item of [...task.steps, ...task.workSessions.map(session => session.focus)]) assert.ok(detail.includes(h.run(`escapeHTML(${JSON.stringify(item)})`)));
    assert.match(detail, /模块学习安排/);
  }
});

test('career status filters shared day cards while global search and outlines retain their original paths', () => {
  const h = harness(); showCareer(h); finishLearning(h);
  h.run(`changeTask(DATA.careerWorkflow.projectPreparationTaskIds[0], true); trackFilter = 'ls'; renderPlanner();`);
  assert.equal(careerCards(h.nodes.get('weekTasks').innerHTML, true).length, 6, 'A hidden saved source filter cannot hide the selected week');
  h.run(`taskFilter = 'done'; renderPlanner();`);
  assert.deepEqual(careerCards(h.nodes.get('weekTasks').innerHTML).map(card => card.id), Array(4).fill(workflow.projectPreparationTaskIds[0]));
  h.run(`taskFilter = 'all'; trackFilter = 'all'; searchQuery = '老师'; renderPlanner();`);
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /data-career-board/);
  assert.equal(h.nodes.get('plannerView').classList.contains('is-career-plan'), false);
  assert.equal(h.nodes.get('trackFilter').hidden, false);
  assert.ok(h.nodes.get('weekTasks').innerHTML.includes(eventId));
  h.run(`searchQuery = ''; progressListScope = { phase: 'career', track: 'review', project: '' }; renderPlanner();`);
  assert.doesNotMatch(h.nodes.get('weekTasks').innerHTML, /data-career-board/);
  assert.match(h.nodes.get('weekTasks').innerHTML, /task-outline-item/);
  assert.match(h.nodes.get('weekTasks').innerHTML, /outline-week-group/);
  assert.equal(h.nodes.get('progressListContext').hidden, false);
  h.run(`progressListScope = null; selectedPhase = 'courses'; selectedWeek = 1; renderPlanner();`);
  for (const id of ['weekTopic', 'weekMeta', 'planPhaseCaption', 'allWeeksDetails', 'trackFilter']) assert.equal(h.nodes.get(id).hidden, false);
  assert.equal(h.selectors.get('.planner-topbar').hidden, false);
  assert.equal(h.selectors.get('.week-navigation').hidden, false);
  assert.equal(h.nodes.get('plannerView').classList.contains('is-career-plan'), false);
});

test('career task positioning opens collapsed ancestors and history restores the expanded section and real row focus', async () => {
  const h = harness(); showCareer(h);
  h.run(`globalThis.navigationCalls = [];
    globalThis.outerDetails = { tagName: 'DETAILS', open: false, dataset: {}, parentElement: $('weekTasks') };
    globalThis.teacherSection = { tagName: 'DETAILS', open: false, dataset: { careerSection: 'teacher' }, parentElement: outerDetails };
    globalThis.teacherRow = { dataset: { taskId: DATA.careerWorkflow.teacherTaskId }, parentElement: teacherSection,
      scrollIntoView: options => navigationCalls.push(['scroll', options.block]), querySelector: () => teacherButton };
    globalThis.teacherButton = { dataset: { taskAction: 'details' }, matches: () => false,
      closest: selector => selector === '[data-task-id]' ? teacherRow : selector.includes('#weekTasks') ? $('weekTasks') : null,
      focus: () => { navigationCalls.push(['focus', DATA.careerWorkflow.teacherTaskId]); document.activeElement = teacherButton; } };
    $('weekTasks').querySelector = selector => selector === '[data-career-workflow]' ? {} : selector.includes(DATA.careerWorkflow.teacherTaskId) ? teacherRow : null;
    $('weekTasks').querySelectorAll = selector => selector === '[data-career-section][open]' ? (teacherSection.open ? [teacherSection] : [])
      : selector === '[data-task-action="details"]' ? [teacherButton] : [];
    const previousQuery = document.querySelector;
    document.querySelector = selector => selector.includes(DATA.careerWorkflow.teacherTaskId) && selector.includes('data-task-action') ? teacherButton : previousQuery(selector);
    globalThis.positioned = focusPlannerTask(DATA.careerWorkflow.teacherTaskId);
    globalThis.savedCareerLocation = captureLocation();`);
  assert.equal(h.run('positioned'), true);
  assert.equal(h.run('teacherSection.open && outerDetails.open'), true);
  assert.deepEqual(h.json('navigationCalls'), [['scroll', 'center'], ['focus', eventId]]);
  assert.deepEqual(h.json('savedCareerLocation.careerSections'), ['teacher']);
  assert.deepEqual(h.json('savedCareerLocation.focus'), { task: eventId, action: 'details', scope: 'weekTasks', index: 0 });
  assert.equal(h.run(`focusPlannerTask('removed-task')`), false);
  h.run(`teacherSection.open = false; outerDetails.open = false; careerOpenSections = new Set(['interviews']); document.activeElement = null;
    render = () => { globalThis.sectionsBeforeRender = [...careerOpenSections]; renderPlanner(); };`);
  await h.run('restoreLocation(savedCareerLocation)');
  assert.deepEqual(h.json('sectionsBeforeRender'), ['teacher'], 'History state is restored before rendering stale collapsed DOM');
  assert.deepEqual(h.json('[...careerOpenSections]'), ['teacher']);
  assert.match(h.nodes.get('weekTasks').innerHTML, /data-career-section="teacher" open/);
  assert.match(h.nodes.get('weekTasks').innerHTML, /data-career-section="interviews">/);
  assert.deepEqual(h.json('navigationCalls.at(-1)'), ['focus', eventId]);
  assert.equal(h.run('document.activeElement === teacherButton'), true);
});

test('late dates or newer communication notes never create a teacher deadline or reset the interview sequence', () => {
  const h = harness(); finishLearning(h); finishPreparation(h);
  h.run(`todayISO = () => '2030-01-07'; renderContinue();`);
  assert.match(h.nodes.get('continueBox').innerHTML, /沟通待确认/);
  assert.doesNotMatch(h.nodes.get('continueBox').innerHTML, /0 分钟|早于今天待补|原计划.*undefined/);
  h.run(`changeTask(${JSON.stringify(eventId)}, true); state.entries[${JSON.stringify(eventId)}] = createEntry(true, '2040-01-01T00:00:00Z', '', { kind: 'practice', note: '仅补充沟通记录' });`);
  assert.equal(h.run(`learningRecommendation('review', '2030-01-07').next.id`), firstInterview);
  assert.equal(h.run(`learningRecommendation('review', '2050-01-07').next.id`), firstInterview);
  assert.deepEqual(h.json(`scheduledTasksForDate('2040-01-02').map(task => task.id)`), []);
  assert.equal(h.run(`taskPlanDateLabel(taskById.get(${JSON.stringify(firstInterview)}))`), '沟通确认后 · 第 1 次');
});
