// Course titles below are transcribed from the supplied course images. A false
// `confirmed` value means the source image needs a clearer copy before the
// title should be treated as authoritative.
export const PHASES = Object.freeze([
  { id: 'foundation', number: 1, title: '乐理 · 音准 · 节奏', durationMonths: 2, description: '学习乐理、节奏、音阶与视唱。' },
  { id: 'breath', number: 2, title: '气息及流行必备技巧训练', durationMonths: 2.5, description: '训练呼吸、声带闭合、共鸣与歌曲表达。' },
  { id: 'voice', number: 3, title: '发音咬字 · 高阶发声技巧训练', durationMonths: 2.5, description: '练习母音、发音、唱法与嗓音保护。' },
  { id: 'style', number: 4, title: '风格塑造 · 高阶混声技巧训练', durationMonths: 2.5, description: '练习混声、风格、音色与舞台表达。' },
]);

// An uncertain entry is [title, false, sourceNote]. All other entries are
// exact transcription of the legible source text supplied with the images.
const LESSON_SOURCE = {
  foundation: [
    '开班典礼', '简谱及音名唱名', '音符的认识',
    '节奏节拍的认识及结构（1）', '节奏节拍的认识及结构（2）', '节奏节拍的认识及结构（3）',
    '歌曲节奏节拍练习', 'C自然大调音阶', 'C自然大调的二、三度模进',
    'C自然大调的四、五度模进', 'C自然大调的六、七、八度模进',
    '简谱视唱练习', '流行歌曲视唱',
    ['期末考试及点评', false, '图片中课名末尾模糊，待核对。'],
  ],
  breath: [
    '正确的呼吸方式', '气息的练习方法', '气息在歌曲中的运用',
    '气泡音及声带闭合', '声带闭合与气息支撑', '共鸣系统的认知',
    ['共鸣训练·第7课', false, '图片中的完整课名不清晰，待核对。'],
    '头腔共鸣',
    ['共鸣训练·第9课', false, '图片中的完整课名不清晰，待核对。'],
    '技巧总结与复习一', '声音线条感训练', '声区的认识', '真假声转换',
    '颤音', '技巧总结复习二', 'K歌小秘诀', '歌曲情感处理',
    '歌曲实践一', '歌曲实践二', '期末考试',
  ],
  voice: [
    'a母音练习', 'e母音练习', 'i母音练习', 'o母音练习', 'u母音练习',
    '字词发音', '歌曲实践', '转音', 'R&B', '气声', '哭腔', '日韩流行',
    '咽音', '古风与戏腔', '嘻哈与说唱', '嗓音保护', '歌曲实践一',
    '歌曲实践二', '毕业音乐会', '学员优秀作品展及点评',
  ],
  style: [
    '平衡混声技巧与实践运用一', '平衡混声技巧与实践运用二',
    '强混声技巧与实践运用一', '强混声技巧与实践运用二', '欧美流行',
    '民谣与摇滚',
    ['弱混声技巧与实践运用一', false, '图片中局部文字模糊，待核对。'],
    ['弱混声技巧与实践运用二', false, '图片中局部文字模糊，待核对。'],
    '气混声技巧与实践运用', '和声演唱', '律动精讲',
    '港台音乐鉴赏与实践', '民族音乐鉴赏与实践', '音色改变与运用',
    '歌曲实践一', '歌曲实践二', '演唱风格定位与塑造',
    ['个人台风塑…', false, '课名后半部分被遮挡，待核对。'],
    ['学员毕业音乐…', false, '课名后半部分被遮挡，待核对。'],
    ['学员优秀作品…', false, '课名后半部分被遮挡，待核对。'],
  ],
};

export const LESSONS = Object.freeze(PHASES.flatMap(phase =>
  LESSON_SOURCE[phase.id].map((entry, index) => {
    const [title, confirmed = true, sourceNote = ''] = Array.isArray(entry) ? entry : [entry];
    return Object.freeze({
      id: `s${phase.number}-${String(index + 1).padStart(2, '0')}`,
      phaseId: phase.id,
      number: index + 1,
      title,
      confirmed,
      sourceNote,
    });
  })
));

export const DEFAULT_CONFIG = Object.freeze({
  startDate: '2026-10-05',
  program: 'full',
  days: Object.freeze([3, 6]),
  sessionMinutes: 120,
});

const DAY_MS = 86_400_000;
const SESSION_MINUTES = new Set([15, 30, 45, 60, 120, 180]);
export const CADENCE = Object.freeze({ cycleWeeks: 3, lessonsPerCycle: 2 });
const CYCLE_DAYS = CADENCE.cycleWeeks * 7;
const PHASE_REST_DAYS = 7;

function dateFromIso(value) {
  if (typeof value !== 'string' || !/^(20\d{2})-(\d{2})-(\d{2})$/.test(value)) {
    throw new RangeError('startDate must be a YYYY-MM-DD date from 2020 through 2040');
  }
  const year = Number(value.slice(0, 4));
  if (year < 2020 || year > 2040) throw new RangeError('startDate must be in 2020 through 2040');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError('startDate must be a real calendar date');
  }
  return date;
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function weekday(date) {
  return date.getUTCDay() || 7;
}

function cycleOffsets(start, daySet) {
  const first = Array.from({ length: 7 }, (_, offset) => offset)
    .find(offset => daySet.has(weekday(addDays(start, offset))));
  // Keep the two courses spaced across a full three-week cycle. Custom
  // weekdays can move the second course a few days, without adding sessions.
  const secondGap = [10, 9, 11, 8, 12, 13]
    .find(gap => daySet.has(weekday(addDays(start, first + gap))));
  return [first, first + secondGap];
}

export function validateConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be an object');
  }
  const startDate = config.startDate ?? DEFAULT_CONFIG.startDate;
  dateFromIso(startDate);
  const program = config.program ?? DEFAULT_CONFIG.program;
  if (program !== 'full' && program !== 'basic') {
    throw new RangeError('program must be full or basic');
  }
  const days = config.days ?? DEFAULT_CONFIG.days;
  if (!Array.isArray(days) || days.length < 2 || days.length > 7 ||
      days.some(day => !Number.isInteger(day) || day < 1 || day > 7) ||
      new Set(days).size !== days.length) {
    throw new RangeError('days must have 2–7 distinct weekdays numbered Monday 1 through Sunday 7');
  }
  const sessionMinutes = config.sessionMinutes ?? DEFAULT_CONFIG.sessionMinutes;
  if (!SESSION_MINUTES.has(sessionMinutes)) {
    throw new RangeError('sessionMinutes must be 15, 30, 45, 60, 120, or 180');
  }
  return { startDate, program, days: [...days].sort((a, b) => a - b), sessionMinutes };
}

export function buildPlan(input = {}) {
  const config = validateConfig(input);
  const start = dateFromIso(config.startDate);
  const activePhases = PHASES.slice(0, config.program === 'basic' ? 3 : 4);
  const daySet = new Set(config.days);
  const phasePlans = [];
  const restPeriods = [];
  const sessions = [];
  const courseSchedules = {};

  let phaseStart = start;
  for (let phaseIndex = 0; phaseIndex < activePhases.length; phaseIndex++) {
    const phase = activePhases[phaseIndex];
    const lessons = LESSONS.filter(lesson => lesson.phaseId === phase.id);
    const cycleCount = Math.ceil(lessons.length / CADENCE.lessonsPerCycle);
    const phaseEnd = addDays(phaseStart, cycleCount * CYCLE_DAYS - 1);
    const offsets = cycleOffsets(phaseStart, daySet);
    phasePlans.push({
      ...phase,
      startDate: iso(phaseStart),
      endDate: iso(phaseEnd),
      lessonIds: lessons.map(lesson => lesson.id),
    });

    for (const [index, lesson] of lessons.entries()) {
      const cycle = Math.floor(index / CADENCE.lessonsPerCycle);
      const date = addDays(phaseStart, cycle * CYCLE_DAYS + offsets[index % CADENCE.lessonsPerCycle]);
      const dateText = iso(date);
      const session = {
        id: `${lesson.id}-p01`,
        date: dateText,
        weekday: weekday(date),
        weekNumber: 0,
        phaseId: phase.id,
        lessonId: lesson.id,
        part: 1,
        parts: 1,
        minutes: config.sessionMinutes,
      };
      sessions.push(session);
      courseSchedules[lesson.id] = {
        startDate: dateText,
        endDate: dateText,
        sessionIds: [session.id],
      };
    }

    if (phaseIndex < activePhases.length - 1) {
      restPeriods.push({
        afterPhaseId: phase.id,
        beforePhaseId: activePhases[phaseIndex + 1].id,
        startDate: iso(addDays(phaseEnd, 1)),
        endDate: iso(addDays(phaseEnd, PHASE_REST_DAYS)),
        days: PHASE_REST_DAYS,
      });
      phaseStart = addDays(phaseEnd, PHASE_REST_DAYS + 1);
    }
  }

  const lastDate = new Date(`${phasePlans.at(-1).endDate}T00:00:00.000Z`);
  const firstMonday = addDays(start, 1 - weekday(start));
  const weekCount = Math.floor((lastDate.getTime() - firstMonday.getTime()) / (7 * DAY_MS)) + 1;
  const weeks = Array.from({ length: weekCount }, (_, index) => {
    const monday = addDays(firstMonday, index * 7);
    return {
      number: index + 1,
      startDate: iso(monday),
      endDate: iso(addDays(monday, 6)),
      phaseIds: [],
      lessonIds: [],
      sessions: [],
    };
  });
  for (const session of sessions) {
    const weekNumber = Math.floor((Date.parse(`${session.date}T00:00:00.000Z`) - firstMonday.getTime()) / (7 * DAY_MS)) + 1;
    session.weekNumber = weekNumber;
    const week = weeks[weekNumber - 1];
    week.sessions.push(session);
    if (!week.phaseIds.includes(session.phaseId)) week.phaseIds.push(session.phaseId);
    if (!week.lessonIds.includes(session.lessonId)) week.lessonIds.push(session.lessonId);
  }

  return {
    config,
    cadence: CADENCE,
    startDate: config.startDate,
    endDate: iso(lastDate),
    phasePlans,
    restPeriods,
    weeks: weeks.filter(week => week.sessions.length > 0),
    sessions,
    courseSchedules,
  };
}
