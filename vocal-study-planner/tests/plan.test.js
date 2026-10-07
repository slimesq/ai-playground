import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASES,
  LESSONS,
  DEFAULT_CONFIG,
  validateConfig,
  buildPlan,
} from '../public/plan.js';

test('the supplied catalog has 14 + 20 + 20 + 20 ordered, stable lesson IDs', () => {
  assert.deepEqual(PHASES.map(phase => phase.id), ['foundation', 'breath', 'voice', 'style']);
  assert.deepEqual(PHASES.map(phase => phase.durationMonths), [2, 2.5, 2.5, 2.5]);
  assert.equal(LESSONS.length, 74);
  assert.deepEqual(PHASES.map(phase => LESSONS.filter(lesson => lesson.phaseId === phase.id).length), [14, 20, 20, 20]);
  assert.deepEqual(LESSONS.map(lesson => lesson.id), PHASES.flatMap(phase =>
    Array.from({ length: phase.number === 1 ? 14 : 20 }, (_, index) =>
      `s${phase.number}-${String(index + 1).padStart(2, '0')}`)));
  assert.equal(LESSONS.find(lesson => lesson.id === 's1-14').title, '期末考试及点评');
  for (const id of ['s1-14', 's2-07', 's2-09', 's4-07', 's4-08', 's4-18', 's4-19', 's4-20']) {
    const lesson = LESSONS.find(item => item.id === id);
    assert.equal(lesson.confirmed, false, `${id} needs source confirmation`);
    assert.ok(lesson.sourceNote, `${id} explains the uncertainty`);
  }
  assert.ok(LESSONS.every(lesson => lesson.confirmed === false || lesson.confirmed === true));
});

test('default full program retains 82 Wednesday/Saturday sessions with three week-long stage breaks', () => {
  assert.deepEqual(DEFAULT_CONFIG.days, [3, 6]);
  assert.equal(DEFAULT_CONFIG.sessionMinutes, 120);
  const plan = buildPlan();
  assert.deepEqual(plan.config, { startDate: '2026-10-05', program: 'full', days: [3, 6], sessionMinutes: 120 });
  assert.equal(plan.startDate, '2026-10-05');
  assert.equal(plan.endDate, '2027-08-09');
  assert.deepEqual(plan.phasePlans.map(phase => [phase.startDate, phase.endDate]), [
    ['2026-10-05', '2026-12-04'],
    ['2026-12-12', '2027-02-26'],
    ['2027-03-06', '2027-05-18'],
    ['2027-05-26', '2027-08-09'],
  ]);
  assert.deepEqual(plan.restPeriods, [
    { afterPhaseId: 'foundation', beforePhaseId: 'breath', startDate: '2026-12-05', endDate: '2026-12-11', days: 7 },
    { afterPhaseId: 'breath', beforePhaseId: 'voice', startDate: '2027-02-27', endDate: '2027-03-05', days: 7 },
    { afterPhaseId: 'voice', beforePhaseId: 'style', startDate: '2027-05-19', endDate: '2027-05-25', days: 7 },
  ]);
  assert.deepEqual(plan.sessions.slice(0, 3).map(session => session.date), [
    '2026-10-07', '2026-10-10', '2026-10-14',
  ]);
  assert.ok(plan.sessions.every(session => [3, 6].includes(session.weekday) && session.minutes === 120));
  assert.equal(plan.sessions.at(-1).date, '2027-08-07');
  assert.equal(plan.sessions.length, 82, 'the extra study dates are practice sessions, not new lessons');
  assert.ok(plan.weeks.every(week => week.sessions.length > 0), 'a deadline-only week is not shown as a study week');
});

test('all 74 lessons get at least one ordered session, with accurate parts and planned budget', () => {
  const plan = buildPlan();
  assert.deepEqual(Object.keys(plan.courseSchedules), LESSONS.map(lesson => lesson.id));
  assert.equal(new Set(plan.sessions.map(session => session.id)).size, plan.sessions.length);
  for (const phase of plan.phasePlans) {
    const phaseSessions = plan.sessions.filter(session => session.phaseId === phase.id);
    const indexes = phaseSessions.map(session => phase.lessonIds.indexOf(session.lessonId));
    assert.equal(indexes[0], 0);
    assert.equal(indexes.at(-1), phase.lessonIds.length - 1);
    assert.ok(indexes.every((index, position) => position === 0 || index >= indexes[position - 1]));
  }
  for (const lesson of LESSONS) {
    const schedule = plan.courseSchedules[lesson.id];
    const sessions = plan.sessions.filter(session => session.lessonId === lesson.id);
    assert.ok(sessions.length >= 1, lesson.id);
    assert.equal(schedule.startDate, sessions[0].date);
    assert.equal(schedule.endDate, sessions.at(-1).date);
    assert.deepEqual(schedule.sessionIds, sessions.map(session => session.id));
    assert.deepEqual(sessions.map(session => session.part), sessions.map((_, index) => index + 1));
    assert.ok(sessions.every(session => session.parts === sessions.length));
  }
  assert.equal(Object.hasOwn(plan, 'videoMinutes'), false, 'the source does not provide video duration');
});

test('extra study dates repeat practical skills, never ceremonies, exams, or showcases', () => {
  const practicePriority = /节奏|节拍|音阶|模进|气息|共鸣|母音|混声/;
  const singleSession = /典礼|考试|毕业|作品展|点评/;
  const byId = new Map(LESSONS.map(lesson => [lesson.id, lesson]));
  const defaultPlan = buildPlan();
  const repeated = Object.entries(defaultPlan.courseSchedules)
    .filter(([, schedule]) => schedule.sessionIds.length > 1)
    .map(([id]) => byId.get(id));
  assert.equal(repeated.length, 8, 'all eight surplus dates are spread across eight skill lessons');
  assert.ok(repeated.every(lesson => practicePriority.test(lesson.title)));
  assert.ok(repeated.some(lesson => lesson.phaseId === 'foundation'));
  assert.ok(repeated.some(lesson => lesson.phaseId === 'breath'));
  assert.ok(repeated.some(lesson => lesson.phaseId === 'voice'));
  assert.ok(repeated.some(lesson => lesson.phaseId === 'style'));

  const dailyPlan = buildPlan({ days: [1, 2, 3, 4, 5, 6, 7] });
  for (const plan of [defaultPlan, dailyPlan]) {
    for (const lesson of LESSONS.filter(item => singleSession.test(item.title))) {
      assert.equal(plan.courseSchedules[lesson.id].sessionIds.length, 1, `${lesson.id} should be visited once`);
    }
  }
  const calendarDays = (Date.parse(`${dailyPlan.endDate}T00:00:00Z`) -
    Date.parse(`${dailyPlan.startDate}T00:00:00Z`)) / 86_400_000 + 1;
  assert.equal(dailyPlan.sessions.length, calendarDays - 21,
    'daily study retains every active date and leaves the three seven-day breaks empty');
});

test('basic program ends after the first three phases and does not schedule style lessons', () => {
  const plan = buildPlan({ program: 'basic' });
  assert.equal(plan.endDate, '2027-05-18');
  assert.equal(plan.restPeriods.length, 2);
  assert.equal(plan.restPeriods.at(-1).beforePhaseId, 'voice');
  assert.deepEqual(plan.phasePlans.map(phase => phase.id), ['foundation', 'breath', 'voice']);
  assert.equal(Object.keys(plan.courseSchedules).length, 54);
  assert.ok(plan.sessions.every(session => session.phaseId !== 'style'));
  assert.equal(Object.hasOwn(plan.courseSchedules, 's4-01'), false);
});

test('custom weekdays and budget retain lesson coverage and true week numbers', () => {
  const plan = buildPlan({ startDate: '2026-10-05', days: [7, 1], sessionMinutes: 45 });
  assert.deepEqual(plan.config.days, [1, 7]);
  assert.ok(plan.sessions.every(session => [1, 7].includes(session.weekday) && session.minutes === 45));
  assert.equal(new Set(plan.sessions.map(session => session.lessonId)).size, 74);
  assert.ok(plan.weeks.every(week => week.sessions.every(session => session.weekNumber === week.number)));
  assert.ok(plan.weeks.every(week => week.sessions.every(session =>
    session.date >= week.startDate && session.date <= week.endDate)));
});

test('cross-year and month-end boundaries are deterministic UTC calendar dates', () => {
  const plan = buildPlan({ startDate: '2026-12-31', program: 'full', days: [2, 5] });
  assert.equal(plan.phasePlans[0].startDate, '2026-12-31');
  assert.equal(plan.phasePlans[0].endDate, '2027-02-27');
  assert.equal(plan.phasePlans[1].startDate, '2027-03-07');
  assert.equal(plan.endDate, '2027-11-04');
  assert.ok(plan.sessions.every(session => session.date >= plan.startDate && session.date <= plan.endDate));
  assert.ok(plan.sessions.every(session => [2, 5].includes(session.weekday)));
});

test('every stage break is exactly seven empty days, with no leading or trailing rest', () => {
  const dayMs = 86_400_000;
  const time = date => Date.parse(`${date}T00:00:00Z`);
  const scenarios = [
    { config: {}, activeDays: [61, 77, 74, 76], counts: [17, 22, 21, 22] },
    { config: { program: 'basic' }, activeDays: [61, 77, 74], counts: [17, 22, 21] },
    { config: { days: [1, 7] }, activeDays: [61, 77, 74, 76], counts: [17, 22, 22, 22] },
    { config: { startDate: '2026-12-31', days: [2, 5] }, activeDays: [59, 76, 77, 76], counts: [17, 22, 22, 21] },
    { config: { days: [1, 2, 3, 4, 5, 6, 7] }, activeDays: [61, 77, 74, 76], counts: [61, 77, 74, 76] },
  ];
  for (const { config, activeDays, counts } of scenarios) {
    const plan = buildPlan(config);
    assert.equal(plan.restPeriods.length, plan.phasePlans.length - 1);
    assert.equal(plan.phasePlans[0].startDate, plan.startDate);
    assert.equal(plan.phasePlans.at(-1).endDate, plan.endDate);
    assert.deepEqual(plan.phasePlans.map(phase =>
      (time(phase.endDate) - time(phase.startDate)) / dayMs + 1), activeDays,
    'stage breaks must not shrink or extend the original active teaching periods');
    assert.deepEqual(plan.phasePlans.map(phase =>
      plan.sessions.filter(session => session.phaseId === phase.id).length), counts,
    'the original lesson and practice session allocations must be retained');
    for (const [index, rest] of plan.restPeriods.entries()) {
      const previous = plan.phasePlans[index];
      const next = plan.phasePlans[index + 1];
      assert.equal(rest.afterPhaseId, previous.id);
      assert.equal(rest.beforePhaseId, next.id);
      assert.equal(rest.days, 7);
      assert.equal((time(rest.endDate) - time(rest.startDate)) / dayMs + 1, 7);
      assert.equal(time(rest.startDate), time(previous.endDate) + dayMs);
      assert.equal(time(next.startDate), time(rest.endDate) + dayMs);
      assert.ok(plan.sessions.every(session => session.date < rest.startDate || session.date > rest.endDate),
        `rest period ${rest.startDate}–${rest.endDate} must contain no lesson or practice sessions`);
    }
    const firstDate = new Date(`${plan.startDate}T00:00:00Z`);
    const firstMonday = firstDate.getTime() - ((firstDate.getUTCDay() + 6) % 7) * dayMs;
    for (const week of plan.weeks) {
      assert.ok(week.sessions.length > 0, 'rest-only weeks stay out of the study-week collection');
      assert.equal(week.number, (time(week.startDate) - firstMonday) / (7 * dayMs) + 1,
        'study week labels must follow the calendar even after a rest week');
    }
  }
});

test('the same config produces identical dates and IDs, and IDs stay tied to lesson parts', () => {
  const original = buildPlan({ startDate: '2027-01-01', days: [2, 6], sessionMinutes: 15 });
  const repeat = buildPlan({ startDate: '2027-01-01', days: [6, 2], sessionMinutes: 15 });
  assert.deepEqual(repeat, original);
  assert.ok(original.sessions.every(session => session.id ===
    `${session.lessonId}-p${String(session.part).padStart(2, '0')}`));
  const shifted = buildPlan({ startDate: '2027-01-08', days: [2, 6], sessionMinutes: 15 });
  assert.equal(shifted.courseSchedules['s1-01'].sessionIds[0], original.courseSchedules['s1-01'].sessionIds[0]);
});

test('invalid dates, weekdays, programs, and budgets are rejected', () => {
  for (const startDate of ['2019-12-31', '2041-01-01', '2026-02-29', '2026-2-09', '2026-13-01', '2026-10-05T00:00:00Z', 20261005]) {
    assert.throws(() => validateConfig({ startDate }), undefined, String(startDate));
  }
  for (const days of [[], [1], [0, 3], [1, 1], [2, 8], [1, 3.5], '1,3', [1, 2, 3, 4, 5, 6, 7, 1]]) {
    assert.throws(() => validateConfig({ days }), undefined, JSON.stringify(days));
  }
  for (const program of ['trial', 'FULL', 0]) assert.throws(() => validateConfig({ program }));
  for (const sessionMinutes of [0, 20, 90, '30']) assert.throws(() => validateConfig({ sessionMinutes }));
  assert.throws(() => validateConfig(null));
});
