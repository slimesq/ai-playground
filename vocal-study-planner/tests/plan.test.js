import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASES,
  CADENCE,
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

const DAY_MS = 86_400_000;
const time = date => Date.parse(`${date}T00:00:00Z`);
const daysBetween = (start, end) => (time(end) - time(start)) / DAY_MS;

function assertCadence(plan) {
  assert.equal(plan.sessions.length, Object.keys(plan.courseSchedules).length);
  for (const phase of plan.phasePlans) {
    const sessions = plan.sessions.filter(session => session.phaseId === phase.id);
    const cycleCount = Math.ceil(phase.lessonIds.length / 2);
    assert.equal(daysBetween(phase.startDate, phase.endDate) + 1, cycleCount * 21);
    assert.deepEqual(sessions.map(session => session.lessonId), phase.lessonIds);
    for (let cycle = 0; cycle < cycleCount; cycle++) {
      const withinCycle = sessions.filter(session =>
        Math.floor(daysBetween(phase.startDate, session.date) / 21) === cycle);
      assert.equal(withinCycle.length, 2, `two courses in cycle ${cycle} of ${phase.id}`);
      assert.equal(new Set(withinCycle.map(session => session.lessonId)).size, 2);
      const gap = daysBetween(withinCycle[0].date, withinCycle[1].date);
      assert.ok(gap >= 8 && gap <= 13, 'courses are distributed across the three-week cycle');
    }
  }
  assert.ok(plan.sessions.every(session => plan.config.days.includes(session.weekday)));
  assert.ok(plan.sessions.every(session => session.date >= plan.startDate && session.date <= plan.endDate));
}

test('default schedule spaces two distinct courses across each three-week cycle and retains stage breaks', () => {
  assert.deepEqual(CADENCE, { cycleWeeks: 3, lessonsPerCycle: 2 });
  assert.deepEqual(DEFAULT_CONFIG.days, [3, 6]);
  assert.equal(DEFAULT_CONFIG.sessionMinutes, 120);
  const plan = buildPlan();
  assert.deepEqual(plan.config, { startDate: '2026-10-05', program: 'full', days: [3, 6], sessionMinutes: 120 });
  assert.deepEqual(plan.cadence, CADENCE);
  assert.equal(plan.startDate, '2026-10-05');
  assert.equal(plan.endDate, '2028-12-10');
  assert.deepEqual(plan.phasePlans.map(phase => [phase.startDate, phase.endDate]), [
    ['2026-10-05', '2027-02-28'],
    ['2027-03-08', '2027-10-03'],
    ['2027-10-11', '2028-05-07'],
    ['2028-05-15', '2028-12-10'],
  ]);
  assert.deepEqual(plan.restPeriods, [
    { afterPhaseId: 'foundation', beforePhaseId: 'breath', startDate: '2027-03-01', endDate: '2027-03-07', days: 7 },
    { afterPhaseId: 'breath', beforePhaseId: 'voice', startDate: '2027-10-04', endDate: '2027-10-10', days: 7 },
    { afterPhaseId: 'voice', beforePhaseId: 'style', startDate: '2028-05-08', endDate: '2028-05-14', days: 7 },
  ]);
  assert.deepEqual(plan.sessions.slice(0, 4).map(session => session.date), [
    '2026-10-07', '2026-10-17', '2026-10-28', '2026-11-07',
  ]);
  assert.equal(plan.sessions.at(-1).date, '2028-12-02');
  assert.equal(plan.sessions.length, 74);
  assertCadence(plan);
  for (const phase of plan.phasePlans) {
    const sessions = plan.sessions.filter(session => session.phaseId === phase.id);
    assert.deepEqual(sessions.slice(1).map((session, index) => daysBetween(sessions[index].date, session.date)),
      sessions.slice(1).map((_, index) => index % 2 === 0 ? 10 : 11));
  }
});

test('all 74 courses have one stable primary session, without automatic repetitions', () => {
  for (const config of [{}, { days: [1, 2, 3, 4, 5, 6, 7] }]) {
    const plan = buildPlan(config);
    assert.deepEqual(Object.keys(plan.courseSchedules), LESSONS.map(lesson => lesson.id));
    assert.equal(new Set(plan.sessions.map(session => session.id)).size, 74);
    for (const lesson of LESSONS) {
      const sessions = plan.sessions.filter(session => session.lessonId === lesson.id);
      assert.equal(sessions.length, 1, lesson.id);
      const session = sessions[0];
      assert.equal(session.id, `${lesson.id}-p01`);
      assert.equal(session.part, 1);
      assert.equal(session.parts, 1);
      assert.deepEqual(plan.courseSchedules[lesson.id], {
        startDate: session.date, endDate: session.date, sessionIds: [session.id],
      });
    }
    assert.equal(Object.hasOwn(plan, 'videoMinutes'), false);
  }
});

test('basic program schedules its 54 courses at the same pace with only two stage breaks', () => {
  const plan = buildPlan({ program: 'basic' });
  assert.equal(plan.endDate, '2028-05-07');
  assert.equal(plan.restPeriods.length, 2);
  assert.equal(plan.restPeriods.at(-1).beforePhaseId, 'voice');
  assert.deepEqual(plan.phasePlans.map(phase => phase.id), ['foundation', 'breath', 'voice']);
  assert.equal(plan.sessions.length, 54);
  assert.ok(plan.sessions.every(session => session.phaseId !== 'style'));
  assert.equal(Object.hasOwn(plan.courseSchedules, 's4-01'), false);
  assertCadence(plan);
});

test('all accepted weekday sets and start weekdays keep exactly two courses per cycle', () => {
  for (let mask = 1; mask < 128; mask++) {
    const days = Array.from({ length: 7 }, (_, index) => index + 1)
      .filter(day => mask & (1 << (day - 1)));
    if (days.length < 2) continue;
    for (let offset = 0; offset < 7; offset++) {
      const startDate = new Date(time('2030-01-28') + offset * DAY_MS).toISOString().slice(0, 10);
      const plan = buildPlan({ startDate, days, sessionMinutes: 45 });
      assertCadence(plan);
      assert.ok(plan.sessions.every(session => session.minutes === 45));
      const earliest = Array.from({ length: 7 }, (_, dayOffset) => dayOffset)
        .find(dayOffset => days.includes(new Date(time(startDate) + dayOffset * DAY_MS).getUTCDay() || 7));
      assert.equal(daysBetween(startDate, plan.sessions[0].date), earliest);
    }
  }
});

test('cross-year, leap-year, month-end and upper-bound starts retain real UTC dates', () => {
  const scenarios = [
    { config: { startDate: '2026-12-31', days: [2, 5] }, end: '2029-03-07' },
    { config: { startDate: '2030-01-31' }, end: '2032-04-07' },
    { config: { startDate: '2028-02-29' }, end: '2030-05-06' },
    { config: { startDate: '2040-12-31' }, end: '2043-03-08' },
  ];
  for (const { config, end } of scenarios) {
    const plan = buildPlan(config);
    assert.equal(plan.startDate, config.startDate);
    assert.equal(plan.endDate, end);
    assert.equal(daysBetween(plan.startDate, plan.endDate) + 1, 798);
    assertCadence(plan);
  }
});

test('stage breaks are seven empty days and calendar week numbers include unscheduled weeks', () => {
  for (const config of [{}, { program: 'basic' }, { startDate: '2026-12-31', days: [1, 7] }]) {
    const plan = buildPlan(config);
    assert.equal(plan.restPeriods.length, plan.phasePlans.length - 1);
    assert.equal(plan.phasePlans[0].startDate, plan.startDate);
    assert.equal(plan.phasePlans.at(-1).endDate, plan.endDate);
    for (const [index, rest] of plan.restPeriods.entries()) {
      const previous = plan.phasePlans[index];
      const next = plan.phasePlans[index + 1];
      assert.equal(rest.afterPhaseId, previous.id);
      assert.equal(rest.beforePhaseId, next.id);
      assert.equal(rest.days, 7);
      assert.equal(daysBetween(rest.startDate, rest.endDate) + 1, 7);
      assert.equal(daysBetween(previous.endDate, rest.startDate), 1);
      assert.equal(daysBetween(rest.endDate, next.startDate), 1);
      assert.ok(plan.sessions.every(session => session.date < rest.startDate || session.date > rest.endDate));
    }
    const firstDate = new Date(`${plan.startDate}T00:00:00Z`);
    const firstMonday = firstDate.getTime() - ((firstDate.getUTCDay() + 6) % 7) * DAY_MS;
    for (const week of plan.weeks) {
      assert.ok(week.sessions.length > 0, 'weeks without courses stay out of the course collection');
      assert.equal(week.number, (time(week.startDate) - firstMonday) / (7 * DAY_MS) + 1);
      assert.ok(week.sessions.every(session => session.weekNumber === week.number));
      assert.ok(week.sessions.every(session => session.date >= week.startDate && session.date <= week.endDate));
    }
    assert.ok(plan.weeks.some((week, index) => index > 0 && week.number > plan.weeks[index - 1].number + 1),
      'calendar labels skip weeks that have no lessons');
  }
});

test('dates are deterministic and course/session identities stay stable when the start moves', () => {
  const original = buildPlan({ startDate: '2027-01-01', days: [2, 6], sessionMinutes: 15 });
  const repeat = buildPlan({ startDate: '2027-01-01', days: [6, 2], sessionMinutes: 15 });
  assert.deepEqual(repeat, original);
  const shifted = buildPlan({ startDate: '2027-01-08', days: [2, 6], sessionMinutes: 15 });
  assert.deepEqual(shifted.sessions.map(session => session.id), original.sessions.map(session => session.id));
  assert.deepEqual(Object.keys(shifted.courseSchedules), Object.keys(original.courseSchedules));
  assert.ok(original.sessions.every(session => session.minutes === 15));
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
