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
const videoTask = tasks.find(task => task.track === 'ls' && task.activity === 'video' && task.segments.length > 1
  && task.segments[0].startMinute * 60 <= 600 && task.segments[0].endMinute * 60 >= 600
  && task.segments[1].startMinute * 60 <= 300 && task.segments[1].endMinute * 60 >= 420);
const practiceTask = tasks.find(task => task.track === 'ydy' && task.activity === 'practice');
const coreHandoff = tasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
const courseWorkday = coreHandoff.workSessions.find(session => { const day = new Date(session.date).getUTCDay(); return day >= 1 && day <= 5; }).date;

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

test('unfinished prerequisites traverse completed gates, deduplicate shared work and tolerate dependency cycles', () => {
  const h = harness();
  const result = h.json(`(() => {
    const target = { id: 'prerequisite-target', prerequisiteTaskIds: ['completed-gate', 'shared-work'] };
    const gate = { id: 'completed-gate', prerequisiteTaskIds: ['earlier-work', 'shared-work'] };
    const earlier = { id: 'earlier-work', prerequisiteTaskIds: ['shared-work'] };
    const shared = { id: 'shared-work', prerequisiteTaskIds: ['completed-gate', 'prerequisite-target'] };
    for (const task of [target, gate, earlier, shared]) taskById.set(task.id, task);
    state.entries[gate.id] = { done: true, updatedAt: ${JSON.stringify(stamp)} };
    return unfinishedPrerequisites(target).map(task => task.id);
  })()`);
  assert.deepEqual(result, ['earlier-work', 'shared-work'],
    'Completed gates cannot conceal unfinished ancestors, and shared or cyclic dependencies appear only once');
});

test('project recommendations cannot skip unfinished Yibo through a completed final gate or ready later project', () => {
  const yiboVideo = tasks.find(task => task.projectId === 'yibo' && task.activity === 'video');
  const yiboPractice = tasks.find(task => task.projectId === 'yibo' && task.activity === 'practice');
  const lastYibo = tasks.filter(task => task.projectId === 'yibo').at(-1);
  const entries = Object.fromEntries(tasks.filter(task => task.id !== yiboVideo.id && task.id !== yiboPractice.id
    && !(task.track === 'ydy' && task.projectId !== 'yibo' && task.activity !== 'video'))
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const eligible = serialProjectTasks(allTasks.filter(task => task.track === 'ydy'));
    const practice = nextProjectPractice(allTasks.filter(task => task.track === 'ydy'));
    return { active: activeProjectLearningGroup(), projects: [...new Set(eligible.map(projectLearningGroup))],
      first: eligible.find(task => !taskDone(task.id))?.id, practice: practice?.id,
      gate: taskDone(${JSON.stringify(lastYibo.id)}), blockers: unfinishedPrerequisites(practice).map(task => task.id) };
  })()`);
  assert.equal(result.active, 'yibo');
  assert.deepEqual(result.projects, ['yibo']);
  assert.equal(result.first, yiboVideo.id, 'Weekend Continue resumes the earliest unfinished Yibo video');
  assert.equal(result.practice, yiboPractice.id, 'Weekday practice stays in Yibo even if a later project has ready exercises');
  assert.equal(result.gate, true, 'This regression includes an accidentally completed final gate');
  assert.ok(result.blockers.includes(yiboVideo.id));

  h.evaluate(`changeTask(${JSON.stringify(yiboVideo.id)}, true); changeTask(${JSON.stringify(yiboPractice.id)}, true)`);
  assert.equal(h.evaluate('activeProjectLearningGroup()'), 'yunzhujiao');
  h.evaluate(`for (const task of allTasks.filter(task => task.projectId === 'yunzhujiao')) changeTask(task.id, true)`);
  assert.equal(h.evaluate('activeProjectLearningGroup()'), 'studio-course');
  const studioGroups = h.json(`[...new Set(serialProjectTasks(allTasks.filter(task => task.track === 'ydy')).map(projectLearningGroup))]`);
  assert.deepEqual(studioGroups, ['studio-course'], 'All Studio course modules remain one project group');
});

test('calendar recommendations resume the active project instead of a later scheduled project', () => {
  const cloudStart = tasks.find(task => task.projectId === 'yunzhujiao').date;
  const yiboFirst = tasks.find(task => task.projectId === 'yibo');
  const h = harness();
  const selection = h.json(`(() => {
    const value = todayLearningSelection(${JSON.stringify(cloudStart)});
    return { active: value.activeProject, blocked: value.blockedProjects,
      tasks: value.tasks.map(task => ({ id: task.id, group: projectLearningGroup(task), date: task.date })) };
  })()`);
  assert.equal(selection.active, 'yibo');
  assert.ok(selection.blocked.includes('yunzhujiao'));
  assert.ok(selection.tasks.length > 0);
  assert.ok(selection.tasks.every(task => task.group === 'yibo'));
  assert.equal(selection.tasks[0].id, yiboFirst.id);
  assert.equal(selection.tasks[0].date, yiboFirst.date, 'Replacement cards retain their actual original date');

  h.evaluate(`for (const task of allTasks.filter(task => task.projectId === 'yibo')) changeTask(task.id, true)`);
  const completedDay = h.json(`todayLearningSelection(${JSON.stringify(yiboFirst.date)}).blockedProjects`);
  assert.deepEqual(completedDay, [], 'Already completed earlier calendar tasks are not mislabeled as a blocked later project');
});

test('a weekday with only an earlier project video pending cannot recommend later practice or watch it automatically', () => {
  const yiboVideo = tasks.find(task => task.projectId === 'yibo' && task.activity === 'video');
  const laterWeekday = courseWorkday;
  const entries = Object.fromEntries(tasks.filter(task => task.id !== yiboVideo.id
    && (task.track !== 'ydy' || task.projectId === 'yibo'))
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const today = todayLearningSelection(${JSON.stringify(laterWeekday)});
    return { tasks: today.tasks.map(task => task.id), pendingVideo: today.pendingVideo?.id,
      practice: nextProjectPractice(allTasks.filter(task => task.track === 'ydy'))?.id || null };
  })()`);
  assert.deepEqual(result.tasks, [], 'A delayed earlier video does not become a weekday watch assignment');
  assert.equal(result.pendingVideo, yiboVideo.id);
  assert.equal(result.practice, null, 'A ready later project cannot substitute for the unfinished earlier video');

  const stillStudying = harness();
  const weekdayTracks = stillStudying.json(`todayLearningSelection(${JSON.stringify(laterWeekday)}).tasks.map(task => task.track)`);
  assert.deepEqual(weekdayTracks, ['ls'], 'If Zero Voice is also unfinished, a blocked later project cannot displace weekday coursework');
});

test('completed Cloud Teaching gates cannot recommend Studio over unfinished earlier Cloud Teaching work', () => {
  const cloudVideo = tasks.find(task => task.projectId === 'yunzhujiao' && task.activity === 'video');
  const cloudPractice = tasks.find(task => task.projectId === 'yunzhujiao' && task.activity === 'practice');
  const studioVideo = tasks.find(task => task.projectId === 'studio-course' && task.activity === 'video');
  const studioPractice = tasks.find(task => task.projectId === 'studio-course' && task.activity === 'practice');
  assert.ok(cloudVideo && cloudPractice && studioVideo && studioPractice);
  const pending = new Set([cloudVideo.id, cloudPractice.id]);
  const entries = Object.fromEntries(tasks.filter(task => !pending.has(task.id)
    && !(task.projectId === 'studio-course' && task.activity === 'practice'))
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const blockers = h.json(`unfinishedPrerequisites(taskById.get(${JSON.stringify(studioVideo.id)})).map(task => task.id)`);
  assert.ok(blockers.includes(cloudPractice.id), 'The first Studio video retains the earlier Cloud Teaching practice prerequisite');
  assert.ok(blockers.includes(cloudVideo.id), 'A completed final Cloud Teaching gate cannot hide an unfinished earlier video');
  const recommendation = h.json(`(() => {
    const task = nextProjectPractice(allTasks.filter(task => task.track === 'ydy'));
    return { id: task.id, blockers: unfinishedPrerequisites(task).map(item => item.id) };
  })()`);
  assert.equal(recommendation.id, cloudPractice.id, 'Default practice resumes Cloud Teaching before Studio');
  assert.ok(recommendation.blockers.includes(cloudVideo.id));

  h.evaluate(`changeTask(${JSON.stringify(studioPractice.id)}, true)`);
  assert.equal(h.evaluate(`taskDone(${JSON.stringify(studioPractice.id)})`), true,
    'Prerequisite warnings must preserve manual advance learning and completion');
  assert.equal(h.evaluate(`taskDone(${JSON.stringify(cloudPractice.id)})`), false);
});

test('weekday recommendations finish the original course handoff and enter career directly', () => {
  const firstCareer = tasks.find(task => task.id === data.careerWorkflow.projectPreparationTaskIds[0]);
  const entries = Object.fromEntries(tasks.filter(task => task.optional !== true && task.id !== coreHandoff.id
    && ['ls', 'ydy'].includes(task.track)).map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const date = DATA.careerWorkflow.preparationStartDate;
    const before = learningRecommendation(defaultContinueTrack(date), date);
    const careerBlocked = learningRecommendation('review', date).blockedByLearning;
    changeTask(${JSON.stringify(coreHandoff.id)}, true);
    const after = learningRecommendation(defaultContinueTrack(date), date);
    return { order: [before.next?.id, after.next?.id], careerBlocked,
      extraProject: nextProjectPractice(allTasks.filter(task => task.track === 'ydy'))?.id || null };
  })()`);
  assert.deepEqual(result.order, [coreHandoff.id, firstCareer.id]);
  assert.equal(result.careerBlocked, true);
  assert.equal(result.extraProject, null, 'Cancelling portfolio work cannot introduce a replacement project gate');
});

test('Today and Continue share the direct transition from original course handoff to career preparation', () => {
  const firstCareer = tasks.find(task => task.id === data.careerWorkflow.projectPreparationTaskIds[0]);
  const entries = Object.fromEntries(tasks.filter(task => task.optional !== true && task.id !== coreHandoff.id
    && ['ls', 'ydy'].includes(task.track)).map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const date = DATA.careerWorkflow.preparationStartDate;
    const selection = () => ({ today: todayLearningSelection(date).tasks.map(task => task.id),
      next: learningRecommendation(defaultContinueTrack(date), date).next?.id });
    const order = [selection()];
    changeTask(${JSON.stringify(coreHandoff.id)}, true);
    order.push(selection());
    return order;
  })()`);
  assert.deepEqual(result, [coreHandoff, firstCareer].map(task => ({ today: [task.id], next: task.id })));
});

test('unfinished Zero Voice displaces calendar résumé preparation in both Today and Continue', () => {
  const h = harness();
  const result = h.json(`(() => {
    const date = DATA.careerWorkflow.preparationStartDate;
    return { today: todayLearningSelection(date).tasks.map(task => task.id),
      next: learningRecommendation(defaultContinueTrack(date), date).next.id,
      calendarTracks: allTasks.filter(task => task.date === date).map(task => task.track),
      manualProject: learningRecommendation('ydy', date).next.activity };
  })()`);
  const first = tasks.find(task => task.track === 'ls');
  assert.deepEqual(result.calendarTracks, ['review'], 'The regression includes the scheduled first résumé preparation day');
  assert.deepEqual(result.today, [first.id]);
  assert.equal(result.next, first.id);
  assert.notEqual(result.manualProject, 'video', 'Selecting project work manually cannot assign a weekday video');
});

test('calendar whole-project acceptance cannot precede unfinished Studio source modules', () => {
  const entries = Object.fromEntries(tasks.filter(task => task.track === 'ls'
    || task.track === 'ydy' && (task.activity === 'video' || ['yibo', 'yunzhujiao'].includes(task.projectId)))
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const practice = tasks.find(task => task.projectId === 'studio-course' && task.activity === 'practice');
  const handoff = tasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
  const result = h.json(`(() => {
    const today = todayLearningSelection(${JSON.stringify(handoff.date)});
    return { today: today.tasks.map(task => task.id), redirected: today.redirected,
      recommendation: learningRecommendation('ydy', ${JSON.stringify(handoff.date)}).next.id };
  })()`);
  assert.deepEqual(result.today, [practice.id]);
  assert.equal(result.recommendation, practice.id);
  assert.equal(result.redirected, true);
});

test('weekday Today resumes the same unfinished Yibo practice with a partial session action and prerequisite warning', () => {
  const practice = tasks.find(task => task.projectId === 'yibo' && task.activity === 'practice');
  const entries = Object.fromEntries(tasks.filter(task => task.track === 'ls'
    || task.projectId === 'yibo' && task.activity === 'video')
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const date = '2027-05-26';
    const today = todayLearningSelection(date);
    const next = learningRecommendation(defaultContinueTrack(date), date).next;
    const warning = taskMarkup(recommendedSessionTask(taskById.get(${JSON.stringify(practice.id)}), date), true, [], { date });
    return { today: today.tasks.map(task => task.id), next: next.id,
      html: warning, duration: taskDuration(next), session: practiceSessionMinutes(next, date),
      sunday: todayLearningSelection('2027-05-30').tasks.map(task => task.id) };
  })()`);
  assert.deepEqual(result.today, [practice.id]);
  assert.equal(result.next, practice.id);
  assert.match(result.html, /本次 40 分钟.*模块预计总/);
  assert.match(result.html, /data-progress-action="record-session">记录本次 40 分钟/);
  assert.doesNotMatch(result.html, /data-task-action="toggle"/,
    'A weekday partial session must not accidentally offer a whole-task check-in as its primary shortcut');
  assert.equal(result.session, 40);
  assert.deepEqual(result.sunday, [], 'Sunday remains unassigned despite backlog');

  const blocked = harness({ entries: Object.fromEntries(tasks.filter(task => task.track === 'ls')
    .map(task => [task.id, { done: true, updatedAt: stamp }])) });
  assert.match(blocked.evaluate(`taskMarkup(taskById.get(${JSON.stringify(practice.id)}), true, [], { date: '2027-05-26' })`),
    /前置任务尚未打卡.*周六先补前置课节/, 'Resumed practice keeps its missing-video warning in Today');
});

test('a manually completed handoff cannot conceal unfinished course modules or prevent manual advance', () => {
  const prior = tasks.find(task => task.id === 'edoyun-module-v1-studio-course-environment-qt');
  const firstCareer = tasks.find(task => task.id === data.careerWorkflow.projectPreparationTaskIds[0]);
  const entries = Object.fromEntries(tasks.filter(task => task.optional !== true && task.id !== prior.id
    && (task.track === 'ls' || task.track === 'ydy' && (task.phaseId === 'courses' || task.activity === 'video')))
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const recommendation = nextProjectPractice(allTasks.filter(task => task.track === 'ydy'));
    const blockers = unfinishedPrerequisites(taskById.get(${JSON.stringify(firstCareer.id)})).map(task => task.id);
    changeTask(${JSON.stringify(firstCareer.id)}, true);
    return { id: recommendation?.id, blockers, advanced: taskDone(${JSON.stringify(firstCareer.id)}),
      prior: taskDone(${JSON.stringify(prior.id)}) };
  })()`);
  assert.equal(result.id, prior.id);
  assert.ok(result.blockers.includes(prior.id));
  assert.equal(result.advanced, true);
  assert.equal(result.prior, false);
});

test('an unused repair pool cannot block career entry after the final required learning work', () => {
  const handoff = tasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
  const entries = Object.fromEntries(tasks.filter(task => task.optional !== true && ['ls', 'ydy'].includes(task.track) && task.id !== handoff.id)
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const first = nextProjectPractice(allTasks.filter(task => task.track === 'ydy'));
    const before = allLearningComplete();
    changeTask(${JSON.stringify(handoff.id)}, true);
    return { first: first.id, before, after: allLearningComplete(), default: defaultContinueTrack('2027-08-09'),
      optional: allTasks.filter(task => !isRequiredTask(task)).map(task => taskDone(task.id)) };
  })()`);
  assert.equal(result.first, handoff.id);
  assert.equal(result.before, false);
  assert.equal(result.after, true);
  assert.equal(result.default, 'review');
  assert.deepEqual(result.optional, [false], 'The repair pool remains untouched without an actual need');
});

test('original Studio module handoffs keep Today and Continue on unfinished prerequisite work', () => {
  for (const [blockerId, laterId] of [
    ['edoyun-module-v1-studio-course-scene-editing', 'edoyun-module-v1-studio-course-ai-hook'],
    ['edoyun-module-v1-studio-course-ai-hook', 'edoyun-module-v1-studio-course-selftest-handoff']
  ]) {
    const blocker = tasks.find(task => task.id === blockerId);
    const later = tasks.find(task => task.id === laterId);
    assert.ok(blocker && later);
    const entries = Object.fromEntries(tasks.filter(task => (task.track === 'ls' || task.track === 'ydy')
      && task.id !== blockerId && (task.date < later.date || task.id === laterId))
      .map(task => [task.id, { done: true, updatedAt: stamp }]));
    const h = harness({ entries });
    const result = h.json(`(() => {
      const later = taskById.get(${JSON.stringify(laterId)});
      const date = later.workSessions.find(session => isLearningWeekday(session.date)).date;
      return { today: todayLearningSelection(date).tasks.map(task => task.id),
        next: learningRecommendation(defaultContinueTrack(date), date).next?.id,
        unfinished: unfinishedPrerequisites(later).map(task => task.id), manuallyAdvanced: taskDone(later.id) };
    })()`);
    assert.ok(result.unfinished.includes(blockerId), `${laterId} must retain its actual earlier prerequisite`);
    assert.deepEqual(result.today, [blockerId]);
    assert.equal(result.next, blockerId);
    assert.equal(result.manuallyAdvanced, true, 'A manual advance remains a real check-in without concealing the unfinished prerequisite');
  }
});

test('career preparation waits for final required acceptance and starts immediately after actual completion', () => {
  const finalBuffer = tasks.find(task => task.id === 'edoyun-module-v1-studio-course-selftest-handoff');
  const firstCareer = tasks.find(task => task.id === data.careerWorkflow.projectPreparationTaskIds[0]);
  assert.ok(finalBuffer && firstCareer);
  const entries = Object.fromEntries(tasks.filter(task => ['ls', 'ydy'].includes(task.track) && task.id !== finalBuffer.id)
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  entries[firstCareer.id] = { done: true, updatedAt: stamp, evidence: '已有面试记录需要保留' };
  const nextCareer = tasks.find(task => task.id === data.careerWorkflow.projectPreparationTaskIds[1]);
  const h = harness({ entries });
  const result = h.json(`(() => {
    const lateDate = DATA.careerWorkflow.preparationStartDate;
    const before = { complete: allLearningComplete(), default: defaultContinueTrack(lateDate),
      manual: learningRecommendation('review', lateDate).next?.id || null,
      blocked: learningRecommendation('review', lateDate).blockedByLearning,
      today: todayLearningSelection(lateDate).tasks.map(task => task.id) };
    changeTask(${JSON.stringify(finalBuffer.id)}, true);
    const earlyDate = '2027-05-11';
    return { before, after: { complete: allLearningComplete(), default: defaultContinueTrack(earlyDate),
      next: learningRecommendation(defaultContinueTrack(earlyDate), earlyDate).next?.id,
      today: todayLearningSelection(earlyDate).tasks.map(task => task.id),
      weekend: defaultContinueTrack('2027-05-15'),
      weekendNext: learningRecommendation('review', '2027-05-15').next?.id,
      priorCareer: taskEntry(${JSON.stringify(firstCareer.id)}) } };
  })()`);
  assert.equal(result.before.complete, false);
  assert.equal(result.before.default, 'ydy', 'Reaching the planned career start cannot bypass unfinished learning');
  assert.equal(result.before.manual, null, 'Selecting the interview direction cannot automatically assign a career task while learning is incomplete');
  assert.equal(result.before.blocked, true);
  assert.deepEqual(result.before.today, [finalBuffer.id]);
  assert.equal(result.after.complete, true);
  assert.equal(result.after.default, 'review');
  assert.equal(result.after.next, nextCareer.id);
  assert.deepEqual(result.after.today, [nextCareer.id], 'Actual early completion can begin career preparation before its planned date');
  assert.equal(result.after.weekend, 'review', 'Optional Continue can offer career preparation after all learning has actually finished');
  assert.equal(result.after.weekendNext, data.careerWorkflow.skillPreparationTaskIds[0],
    'Saturday can start the independent skill materials before their suggested date while weekday project materials remain unfinished');
  assert.equal(result.after.priorCareer.done, true);
  assert.equal(result.after.priorCareer.evidence, '已有面试记录需要保留', 'Rescheduling career preparation must preserve prior manual check-ins');
});

test('project Mondays resume the active learning module instead of leaving the new study time unused', () => {
  const project = tasks.find(task => task.track === 'ydy' && task.activity === 'practice'
    && task.workSessions?.some(session => new Date(session.date).getUTCDay() === 1));
  const monday = project.workSessions.find(session => new Date(session.date).getUTCDay() === 1).date;
  const practice = tasks.find(task => task.projectId === 'yibo' && task.activity === 'practice');
  const entries = Object.fromEntries(tasks.filter(task => task.track === 'ls'
    || task.projectId === 'yibo' && task.activity === 'video')
    .map(task => [task.id, { done: true, updatedAt: stamp }]));
  const h = harness({ entries });
  const result = h.json(`(() => {
    const value = todayLearningSelection(${JSON.stringify(monday)});
    return { ids: value.tasks.map(task => task.id), optional: value.optional,
      session: practiceSessionMinutes(value.tasks[0], ${JSON.stringify(monday)}),
      scheduled: scheduledTasksForDate(${JSON.stringify(monday)}).map(task => task.id),
      sunday: todayLearningSelection(dateAt(${JSON.stringify(monday)}, 6)).tasks.map(task => task.id) };
  })()`);
  assert.deepEqual(result.ids, [practice.id]);
  assert.equal(result.optional, false, 'Original course practice uses the newly available Monday study time');
  assert.ok(result.scheduled.includes(project.id));
  assert.equal(result.session, 40);
  assert.deepEqual(result.sunday, []);
});

test('overview rhythm follows actual learning and career progress while planner rhythm follows the selected week', () => {
  const h = harness();
  const learningWeek = data.weeks.find(week => week.start <= courseWorkday && courseWorkday <= week.end);
  const careerWeek = data.weeks.find(week => week.tasks.some(task => task.track === 'review'));
  const restWeek = h.json(`DATA.weeks.find(week => week.start >= DATA.planRhythm.weekdayTransitionDate
    && !scheduledTasksForWeek(week, requiredTasks()).some(task => task.day === '周六'))`);
  assert.ok(learningWeek && careerWeek && restWeek);
  h.evaluate(`globalThis.learningWeek = DATA.weeks.find(week => week.week === ${learningWeek.week});
    globalThis.careerWeek = DATA.weeks.find(week => week.week === ${careerWeek.week});
    globalThis.restWeek = DATA.weeks.find(week => week.week === ${restWeek.week});`);
  assert.match(h.evaluate('rhythmDescription(careerWeek, careerWeek.start)'), /先完成零声课程/,
    'A later calendar date cannot turn the overview rhythm into interview preparation before Zero Voice finishes');
  assert.match(h.evaluate('rhythmDescription(careerWeek, null)'), /材料|简历|老师/,
    'The planner describes the selected career week independently from current check-ins');
  h.evaluate(`for (const task of allTasks.filter(task => task.track === 'ls')) changeTask(task.id, true)`);
  assert.match(h.evaluate('rhythmDescription(careerWeek, careerWeek.start)'), /工作日项目练习.*全部学习完成后再准备面试求职/);
  assert.match(h.evaluate('rhythmDescription(restWeek, null)'), /周六机动或休息/);
  assert.doesNotMatch(h.evaluate('rhythmDescription(restWeek, null)'), /(?:^|\D)0 分钟/);
  h.evaluate(`for (const task of allTasks.filter(task => task.track === 'ydy')) changeTask(task.id, true)`);
  assert.match(h.evaluate('rhythmDescription(learningWeek, learningWeek.start)'), /简历|老师/);
  assert.match(h.evaluate('rhythmDescription(learningWeek, null)'), /工作日项目练习/,
    'Actual early completion does not rewrite the planner historical arrangement');
  assert.doesNotMatch(h.evaluate('rhythmDescription(learningWeek, learningWeek.start)'), /周六易道云视频|(?:^|\D)0 分钟/);
});

test('career navigation and phase captions distinguish learning from the later job-search stage', () => {
  const h = harness();
  const labels = h.json(`planPhases.map(phase => ({ id: phase.id,
    caption: phaseScheduleCaption(phase),
    first: phaseWeekLabel(DATA.weeks.find(week => week.week === phase.startWeek)) }))`);
  assert.deepEqual(labels.map(item => item.first), ['第 1 周', '材料第 1 周']);
  assert.ok(labels.slice(0, -1).every(item => !/面试|求职/.test(item.caption)),
    'Learning-phase navigation must not advertise interview preparation');
  assert.match(labels.at(-1).caption, /老师.*简历/);
  assert.match(labels.at(-1).caption, /面试/);
});

test('career details summarize the complete learning gate without expanding all original video sessions', () => {
  const h = harness();
  const career = tasks.find(task => task.id === data.careerWorkflow.projectPreparationTaskIds[0]);
  const learningCount = tasks.filter(task => task.optional !== true && (task.track === 'ls' || task.track === 'ydy')).length;
  const initial = h.evaluate(`taskPrerequisiteMarkup(taskById.get(${JSON.stringify(career.id)}))`);
  assert.match(initial, new RegExp(`全部学习 0 / ${learningCount} 项`));
  assert.doesNotMatch(initial, /data-prerequisite-task-id="(?:ls40|ls-server-v1|ls-module-v2)-/,
    'Course sessions remain accessible in their own outline rather than repeated in each career task');
  assert.match(initial, /data-prerequisite-task-id="edoyun-module-v1-studio-course-selftest-handoff"/,
    'The final learning acceptance remains directly accessible');
  h.evaluate(`for (const task of allTasks.filter(task => ['ls', 'ydy'].includes(task.track))) changeTask(task.id, true)`);
  const ready = h.evaluate(`taskPrerequisiteMarkup(taskById.get(${JSON.stringify(career.id)}))`);
  assert.match(ready, new RegExp(`全部学习 ${learningCount} / ${learningCount} 项`));
  assert.equal(h.evaluate('learningRecommendation("review").blockedByLearning'), false);
});

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
  assert.equal(data.weeks.length, Math.max(...data.planPhases.map(phase => phase.endWeek)));
  const lsSessions = tasks.filter(task => task.track === 'ls' && task.activity === 'video');
  assert.equal(lsSessions.length, 122);
  assert.equal(lsSessions.reduce((sum, task) => sum + task.durationSeconds, 0), 292533);
  const requiredLS = lsSessions.filter(task => task.optional !== true);
  assert.equal(requiredLS.length, 122);
  assert.equal(requiredLS.reduce((sum, task) => sum + task.durationSeconds, 0), 292533);
  const edoyunSegments = tasks.filter(task => task.track === 'ydy').flatMap(task => task.learningSegments || []);
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
