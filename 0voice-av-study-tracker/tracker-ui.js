'use strict';

const STORE_KEY = 'av_study_tracker_regenerated_v2';
const REPLACE_STORE_KEY = `${STORE_KEY}:replace_v1`;
const REPLACE_JOURNAL_PREFIX = `${REPLACE_STORE_KEY}:entry:`;
const LEGACY_KEYS = ['av_study_tracker_regenerated_v1', 'av_tracker_v4'];
const LEGACY_CHECKIN_PLAN = { start: '2026-05-04', weeks: 24 };
const API_KEY_STORE = 'av_study_tracker_sync_key';
const UI_STORE_KEY = 'av_study_tracker_ui_v1';
const allTasks = DATA.weeks.flatMap(week => week.tasks);
const planPhases = DATA.planPhases?.length ? DATA.planPhases : [{ id: 'courses', label: '课程计划', startWeek: DATA.weeks[0].week, endWeek: DATA.weeks.at(-1).week, start: DATA.weeks[0].start, end: DATA.weeks.at(-1).end }];
const availableTracks = new Set(allTasks.map(task => task.track));
const taskById = new Map(allTasks.map(task => [task.id, task]));
const legacyVideoTaskById = new Map((DATA.legacyVideoTasks || []).map(task => [task.id, task]));
const legacyPracticeTaskById = new Map((DATA.legacyPracticeTasks || []).map(task => [task.id, task]));
const legacyReferenceTaskById = new Map((DATA.legacyReferenceTasks || []).map(task => [task.id, task]));
const legacyTaskById = new Map([...legacyVideoTaskById, ...legacyPracticeTaskById, ...legacyReferenceTaskById]);
const lessonById = new Map((DATA.courseCatalog || []).map(lesson => [lesson.id, lesson]));
const legacyLessonById = new Map((DATA.legacyCourseCatalog || []).map(lesson => [lesson.id, lesson]));
const $ = id => document.getElementById(id);
const state = loadState();
const initialReplacementMarker = readReplaceMarker();
let replacementToken = initialReplacementMarker?.id || '';
let replacementRevision = initialReplacementMarker?.revision || 0;
let replacementStatus = initialReplacementMarker?.status || '';
let observedEntries = entrySignatures(state.entries);
let replacementCounter = 0;
const preferences = loadPreferences();
let selectedPhase = planPhases.some(phase => phase.id === preferences.phase) ? preferences.phase : (planPhases.find(phase => phase.id === 'courses') || planPhases[0]).id;
const initialPhaseWeeks = DATA.weeks.filter(week => phaseForWeek(week).id === selectedPhase);
let selectedWeek = initialPhaseWeeks.some(week => week.week === preferences.week) ? preferences.week
  : initialPhaseWeeks.find(week => week.week === calendarWeek()?.week)?.week || initialPhaseWeeks[0].week;
const phaseSelections = new Map([[selectedPhase, selectedWeek]]);
let selectedView = ['overview', 'planner', 'milestones'].includes(preferences.view) ? preferences.view : 'overview';
let taskFilter = ['all', 'pending', 'partial', 'done'].includes(preferences.filter) ? preferences.filter : 'all';
let trackFilter = availableTracks.has(preferences.track) ? preferences.track : 'all';
let searchQuery = typeof preferences.search === 'string' ? preferences.search : '';
let progressListScope = normalizeProgressListScope(preferences.progressScope);
let progressListReturn = progressListScope ? normalizeProgressReturn(preferences.progressReturn) : null;
const outlineWeekStates = new Map();
const outlineTaskStates = new Map();
const outlineScrollStates = new Map();
const outlineCursorStates = new Map();
const outlineContexts = new Map();
let careerOpenSections = new Set();
let outlineScrollReady = false;
let outlinePositionChanging = false;
let outlineCursorTaskId = '';
let selectedProgressPhase = planPhases.some(phase => phase.id === preferences.progressPhase) ? preferences.progressPhase : planPhases[0].id;
let continueTrackChoice = null;
let continueChoiceDate = todayISO();
let detailTaskId = '';
let detailOpenerFocus = null;
let detailProgressDirty = false;
let detailProgressEditing = false;
let detailProgressBase = 'null';
let detailProgressInitialForm = 'null';
let detailProgressSession = 0;
let detailProgressSaveBusy = false;
const activeContinueSessionSaves = new Set();
let timestampFloor = 0;
let localRevision = 0;
let replaceEpoch = 0;
let activeSyncPromise = null;
let syncRequested = false;
let replaceRequested = state.pendingReplace;
let syncRetryTimer = null;
let syncRetryAttempt = 0;
let lastVisibleSyncAt = 0;
let persistenceError = false;
let memoryApiKey = null;
let toastTimer = null;
let toastFocusContext = null;
const openDialogOrder = [];
const toastReturnFocus = new WeakMap();
let confirmationResolver = null;
const syncState = { busy: false, authRequired: false, authRejected: false, reachable: null, status: '正在检查同步连接', lastSyncedAt: state.lastSyncedAt || '' };
const positionHistory = [];
let positionHistoryIndex = -1;
let locationChangeDepth = 0;
let restoringLocation = false;
let locationNavigationBusy = false;
let locationRevision = 0;
const queuedLocationDirections = [];

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function recordTextMarkup(value) {
  const text = String(value ?? '');
  const urls = /https?:\/\/[^\s<>"'\x60，。；、！？（）【】“”‘’]+/giu;
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let result = '';
  let offset = 0;
  for (const match of text.matchAll(urls)) {
    const raw = match[0];
    let candidate = raw;
    while (candidate) {
      const last = candidate.at(-1);
      const opening = pairs[last];
      const unmatched = opening && candidate.split(last).length > candidate.split(opening).length;
      if (/[.,;:!?]/.test(last) || unmatched) candidate = candidate.slice(0, -1);
      else break;
    }
    let url;
    try { url = new URL(candidate); } catch {}
    const valid = url && ['http:', 'https:'].includes(url.protocol) && url.hostname;
    result += escapeHTML(text.slice(offset, match.index));
    result += valid ? `<a class="record-link" href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(candidate)}</a>` : escapeHTML(candidate);
    result += escapeHTML(raw.slice(candidate.length));
    offset = match.index + raw.length;
  }
  return result + escapeHTML(text.slice(offset));
}

function icon(name) {
  const paths = {
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    edit: '<path d="m16 4 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15v5Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.5"/>',
    book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-12 5h2"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}

function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateAt(date, offset = 0) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

function formatDate(date, year = false) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', ...(year ? { year: 'numeric' } : {}), month: 'long', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}

function formatSyncTime(value) {
  if (!isValidIso(value)) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function recordUpdateMarkup(task, className) {
  const updatedAt = taskEntry(task.id)?.updatedAt;
  if (!isValidIso(updatedAt) || Date.parse(updatedAt) <= 0) return '';
  const label = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(updatedAt));
  return `<p class="${className}">记录更新 · <time data-record-update datetime="${escapeHTML(updatedAt)}">${escapeHTML(label)}</time></p>`;
}

function clockSecond(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return `${hours ? hours + ':' : ''}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function formatMinutes(value) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value) || 0); }
function secondDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}${remainder ? '分' + remainder + '秒' : '分钟'}` : `${remainder}秒`;
}
function planRhythm() {
  const defaults = { weekdayVideoMinutes: 40, weekdayPracticeMinutes: 0, weekdaySource: 'phased', saturdayMinutes: 300, saturdayVideoMinutes: 300, saturdayStudioVideoMinutes: 120, sundayOptional: true,
    zeroVoiceCompletionDate: '2027-05-10', weekdayTransitionDate: '2027-05-11', lessonCompletionDate: '2027-05-01',
    courseDeadline: '2027-05-31', afterCourseWeekdays: { interviewDays: [], projectDays: [1, 2, 3, 4, 5], minutes: 40 } };
  return { ...defaults, ...(DATA.planRhythm || {}), afterCourseWeekdays: { ...defaults.afterCourseWeekdays, ...(DATA.planRhythm?.afterCourseWeekdays || {}) } };
}
function isRequiredTask(task) { return task?.optional !== true; }
function optionalTaskGroups(tasks) {
  const optional = tasks.filter(task => !isRequiredTask(task));
  return [
    { label: '按需补漏', shortLabel: '按需', tasks: optional }
  ].filter(group => group.tasks.length);
}
function optionalCompletionSummary(tasks, compact = false) {
  return optionalTaskGroups(tasks).map(group => `${compact ? group.shortLabel : group.label} ${group.tasks.filter(task => taskDone(task.id)).length} / ${group.tasks.length}`).join(' · ');
}
function optionalTaskHint() {
  return '按需补漏；没有对应缺口时可不执行，不影响项目完成或面试求职。';
}
function requiredTasks(tasks = allTasks) { return tasks.filter(isRequiredTask); }
function requiredLearningTasks(tasks = allTasks) {
  return requiredTasks(tasks).filter(task => task.track === 'ls' || task.track === 'ydy');
}
function taskCompletionLabel(tasks, suffix = '已完成') {
  const unique = [...new Map(tasks.map(task => [task.id, task])).values()];
  const required = requiredTasks(unique);
  const optional = unique.filter(task => !isRequiredTask(task));
  const done = required.filter(task => taskDone(task.id)).length;
  return `${optional.length ? '必修 ' : ''}${done} / ${required.length}${suffix ? ` ${suffix}` : ''}${optional.length ? ` · ${optionalCompletionSummary(optional, true)}` : ''}`;
}
function formatDuration(minutes) {
  const seconds = Math.max(0, Math.round((Number(minutes) || 0) * 60));
  const hours = Math.floor(seconds / 3600);
  const remainderMinutes = Math.floor(seconds % 3600 / 60);
  const remainderSeconds = seconds % 60;
  if (!hours) return remainderSeconds ? `${remainderMinutes} 分 ${remainderSeconds} 秒` : `${remainderMinutes} 分钟`;
  return `${hours} 小时${remainderMinutes ? ` ${remainderMinutes} 分钟` : ''}${remainderSeconds ? ` ${remainderSeconds} 秒` : ''}`;
}
function isTransitionWeek(week, rhythm = planRhythm()) {
  return !!week && week.start < rhythm.weekdayTransitionDate && week.end >= rhythm.weekdayTransitionDate;
}
function rhythmDescription(week = currentWeek(), referenceDate = todayISO()) {
  const rhythm = planRhythm();
  const minutes = formatDuration(rhythm.afterCourseWeekdays.minutes);
  const scheduled = scheduledTasksForWeek(week, requiredTasks());
  const weekdayTasks = scheduled.filter(task => isLearningWeekday(task.date));
  const pendingZeroVoice = requiredLearningTasks().some(task => task.track === 'ls' && !taskDone(task.id));
  const pendingProjects = requiredLearningTasks().some(task => task.track === 'ydy' && !taskDone(task.id));
  const pendingCareer = requiredTasks().some(task => task.track === 'review' && !taskDone(task.id));
  const weekday = referenceDate !== null
    ? pendingZeroVoice ? `工作日先完成零声课程（每次约 ${formatDuration(rhythm.weekdayVideoMinutes)}），再进入项目练习`
      : pendingProjects ? `工作日项目练习约 ${minutes}，全部学习完成后再准备面试求职`
        : pendingCareer && DATA.careerWorkflow ? careerRhythmDescription() : pendingCareer ? applicationReadiness().ready ? `已具备投递条件，可投递并继续面试复习（每次约 ${minutes}）`
          : `课程与项目已完成，集中准备面试求职（每次约 ${minutes}）`
          : '学习与求职准备已全部完成'
    : weekdayTasks.some(task => task.track === 'ls')
      ? weekdayTasks.some(task => task.track === 'ydy')
        ? `工作日先完成零声，再进入项目练习（每次约 ${minutes}）`
        : `工作日零声课程约 ${formatDuration(rhythm.weekdayVideoMinutes)}`
      : weekdayTasks.some(task => task.track === 'ydy') ? `工作日项目练习约 ${minutes}`
        : weekdayTasks.some(task => task.track === 'review') ? DATA.careerWorkflow ? DATA.careerWorkflow.projectPreparationTaskIds?.length
          ? `工作日优先完整梳理项目（每次约 ${minutes}），周六整理技能材料；与老师确认简历后再准备面试`
          : `工作日整理项目与技能材料（每次约 ${minutes}），与老师沟通确认简历后再准备面试` : `工作日集中准备面试求职（每次约 ${minutes}）` : '工作日机动';
  const saturday = scheduled.filter(task => task.day === '周六');
  const video = saturday.reduce((sum, task) => sum + (task.activity === 'video' ? task.sessionMinutes ?? task.budget?.videoMinutes ?? 0 : 0), 0);
  const practice = saturday.reduce((sum, task) => sum + (task.activity !== 'video' ? task.sessionMinutes ?? task.budget?.practiceMinutes ?? 0 : 0), 0);
  const buffer = saturday.reduce((sum, task) => sum + (task.activity === 'buffer' ? task.sessionMinutes ?? task.budget?.bufferMinutes ?? 0 : 0), 0);
  const activeProject = referenceDate !== null && activeProjectLearningGroup();
  const pendingVideo = activeProject && requiredLearningTasks().find(task => projectLearningGroup(task) === activeProject
    && task.activity === 'video' && !taskDone(task.id));
  const careerPreparation = referenceDate !== null && !pendingZeroVoice && !pendingProjects
    && DATA.careerWorkflow?.projectPreparationTaskIds?.length && !careerWorkflowState()?.preparationComplete;
  const careerSaturday = careerPreparation ? dateAt(referenceDate, (6 - new Date(`${referenceDate}T00:00:00Z`).getUTCDay() + 7) % 7) : '';
  const careerNext = careerPreparation && learningRecommendation('review', careerSaturday).next;
  const careerWeekend = careerNext && isCareerPreparation(careerNext)
    ? !practiceRemainingMinutes(careerNext) ? '周六先核对材料模块成果，也可继续其他材料'
      : careerPreparationGroup(careerNext) === 'skill' ? `周六优先整理技能材料，下一模块暂估 ${formatDuration(practiceSessionMinutes(careerNext, careerSaturday))}`
        : '周六可继续完整项目梳理，每次约40分钟' : '';
  const weekend = careerWeekend || (!saturday.length || referenceDate !== null && !pendingProjects ? '周六机动或休息'
    : activeProject ? courseAccessState(pendingVideo, referenceDate)?.expired
      ? '平台课程已到期；周六可复习已保存资料或继续项目' : `周六继续${projectLearningName(activeProject)}课程与项目`
      : video > 0 ? `周六易道云视频 ${formatDuration(video)}${practice ? ` + 代码复现 ${formatDuration(practice)}` : ''}`
        : totalTaskMinutes(saturday) > 0 ? `周六${saturday.some(task => careerPreparationGroup(task) === 'skill') ? '技能材料整理' : saturday.some(task => task.track === 'review') ? '面试求职准备' : buffer > 0 ? '项目与补漏' : '项目实践'} ${formatDuration(totalTaskMinutes(saturday))}`
          : '周六机动或休息');
  return `${weekday} · ${weekend} · ${rhythm.sundayOptional ? '周日机动' : '周日按计划安排'}`;
}
function taskMinutes(task) {
  if (Number.isFinite(task.durationMinutes)) return Math.max(0, task.durationMinutes);
  if (task.budget) return ['videoMinutes', 'practiceMinutes', 'bufferMinutes'].reduce((sum, key) => sum + Math.max(0, Number(task.budget[key]) || 0), 0);
  return 0;
}
function totalTaskMinutes(tasks) { return tasks.reduce((sum, task) => sum + (Number.isFinite(task.sessionMinutes) ? Math.max(0, task.sessionMinutes) : taskMinutes(task)), 0); }
function activityLabel(task) {
  if (!isRequiredTask(task)) return '按需补漏';
  if (Number.isInteger(task.integrationSequence)) return '集成验证';
  if (isExternalConfirmation(task)) return '老师沟通确认';
  if (task.track === 'review' && isCareerPreparation(task)) return '沟通材料整理';
  if (task.track === 'review') return '面试准备';
  if (task.activity === 'review' && task.track === 'ls') return '零声复盘';
  return { video: '课程学习', practice: '实践练习', portfolio: '作品打磨', deepening: '项目深化', buffer: '补漏整理', review: '复盘整理' }[task.activity] || '';
}

function displayTrackName(task) {
  if (!isRequiredTask(task)) return '按需补漏';
  if (task.track === 'ydy' && Number.isInteger(task.integrationSequence)) return '集成验证';
  if (isExternalConfirmation(task)) return '老师沟通确认';
  if (task.track === 'review' && isCareerPreparation(task)) return '沟通材料整理';
  if (task.track === 'review') return '面试准备';
  if (task.track === 'ydy') return { video: '易道云视频', practice: '配套练习', portfolio: '作品打磨', deepening: '项目深化', buffer: '验证与收尾' }[task.activity] || task.trackName;
  return task.trackName;
}

function isValidIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function blankClientState() { return { entries: {}, lastSyncedAt: '', pendingReplace: false }; }
function validTaskProgress(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress) || !['video', 'practice'].includes(progress.kind)) return false;
  const fields = new Set(['kind', 'segmentIndex', 'positionSecond', 'completedSteps', 'workedMinutes', 'note']);
  if (Object.keys(progress).some(key => !fields.has(key))) return false;
  for (const [key, maximum] of [['segmentIndex', 999], ['positionSecond', 864000], ['workedMinutes', 100000]]) {
    if (progress[key] !== undefined && (!Number.isInteger(progress[key]) || progress[key] < 0 || progress[key] > maximum)) return false;
  }
  if (progress.completedSteps !== undefined && (!Array.isArray(progress.completedSteps) || progress.completedSteps.length > 200
    || progress.completedSteps.some(index => !Number.isInteger(index) || index < 0 || index > 199)
    || new Set(progress.completedSteps).size !== progress.completedSteps.length)) return false;
  if (progress.note !== undefined && (typeof progress.note !== 'string' || progress.note.length > 1000)) return false;
  return progress.kind === 'video' ? progress.completedSteps === undefined && progress.workedMinutes === undefined
    : progress.segmentIndex === undefined && progress.positionSecond === undefined;
}
function normalizeTaskProgress(progress) {
  if (!validTaskProgress(progress)) return undefined;
  const normalized = { kind: progress.kind };
  for (const key of ['segmentIndex', 'positionSecond', 'workedMinutes', 'completedSteps', 'note']) {
    if (progress[key] !== undefined) normalized[key] = key === 'completedSteps' ? [...progress[key]] : progress[key];
  }
  return normalized;
}
function createEntry(done, updatedAt, evidence, progress) {
  const normalizedProgress = normalizeTaskProgress(progress);
  return { done: done === true, updatedAt: isValidIso(updatedAt) ? new Date(updatedAt).toISOString() : new Date(0).toISOString(),
    ...(typeof evidence === 'string' && evidence ? { evidence: evidence.slice(0, 4000) } : {}),
    ...(normalizedProgress ? { progress: normalizedProgress } : {}) };
}
function milestoneReviewKey(milestone) {
  const goal = typeof milestone === 'string' ? DATA.milestones?.find(item => item.id === milestone) : milestone;
  return goal?.reviewKey || `milestone:${goal?.id || milestone}`;
}
function milestoneEntryIds() { return (DATA.milestones || []).filter(goal => goal.kind === 'project').map(milestoneReviewKey); }
function isMilestoneEntryId(id) { return milestoneEntryIds().includes(id); }
function isHistoricalMilestoneEntryId(id) {
  return typeof id === 'string' && /^milestone:[A-Za-z0-9._-]+$/.test(id) && !isMilestoneEntryId(id);
}
function validEntryRecord(record) {
  return typeof record === 'string' ? isValidIso(record)
    : !!record && !Array.isArray(record) && typeof record === 'object' && typeof record.done === 'boolean'
      && isValidIso(record.updatedAt) && (record.evidence === undefined || typeof record.evidence === 'string' && record.evidence.length <= 4000)
      && (record.progress === undefined || validTaskProgress(record.progress));
}
function videoSegmentRange(segment) {
  if (segment?.sectionId === undefined || segment.sectionId === null || segment.sectionId === '') return null;
  const start = Number(segment.startSecond), end = Number(segment.endSecond);
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start
    ? { sectionId: String(segment.sectionId), start, end } : null;
}

function legacyVideoSegments(task) {
  const mappings = DATA.legacyZeroVoiceVideoRanges?.[task.id];
  if (mappings === undefined) return (task.learningSegments || []).map(videoSegmentRange);
  // Old Zero Voice tasks used local clocks inside manually split lessons.
  // Keep the archived task and record untouched; translate only while reading
  // coverage against the canonical original video used by the new plan.
  const originals = taskLearningSegments(task);
  if (!Array.isArray(mappings) || mappings.length !== originals.length) return [];
  const ranges = mappings.map((mapping, index) => {
    const range = videoSegmentRange(mapping);
    const sourceStart = mapping?.sourceStartSecond, sourceEnd = mapping?.sourceEndSecond;
    const original = originals[index];
    if (!range || !Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd)
      || sourceStart < 0 || sourceEnd <= sourceStart
      || sourceStart !== original.startSecond || sourceEnd !== original.endSecond
      || range.end - range.start > sourceEnd - sourceStart) return null;
    return { ...range, sourceStart, sourceEnd };
  });
  return ranges.some(range => !range) ? [] : ranges;
}

function legacyVideoPosition(segment, position) {
  const start = segment.sourceStart ?? segment.start;
  const end = segment.sourceEnd ?? segment.end;
  if (!Number.isInteger(position) || position < start || position > end) return null;
  // A displayed lesson duration was rounded to minutes. Translate the real
  // stop second rather than scaling it; never claim unseen extra tail seconds.
  return Math.min(segment.end, segment.start + position - start);
}

function legacyVideoGeneration(task) {
  // A later reordering can archive a task verbatim, without adding migration
  // fields to its original snapshot. Keep that precedence in separate data.
  const generation = DATA.legacyZeroVoiceVideoGenerations?.[task.id] ?? task.generation;
  return Number.isInteger(generation) && generation > 0 ? generation : 1;
}

function legacyVideoRecords(id, entries = state.entries) {
  const task = taskById.get(id);
  if (task?.activity !== 'video' || !task.learningSegments?.length) return [];
  const ranges = task.learningSegments.map(videoSegmentRange).filter(Boolean);
  return [...legacyVideoTaskById.values()].flatMap(legacyTask => {
    const record = entries[legacyTask.id];
    if (!record) return [];
    const segments = legacyVideoSegments(legacyTask);
    return segments.some(segment => segment && ranges.some(range => range.sectionId === segment.sectionId
      && range.start < segment.end && segment.start < range.end)) ? [{ task: legacyTask, record, segments }] : [];
  });
}

function firstUncoveredSecond(range, intervals) {
  let cursor = range.start;
  for (const interval of intervals.filter(item => item.sectionId === range.sectionId && item.end > cursor && item.start < range.end)
    .sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (interval.start > cursor) break;
    cursor = Math.max(cursor, interval.end);
    if (cursor >= range.end) return range.end;
  }
  return Math.min(cursor, range.end);
}

function unmaskedVideoIntervals(intervals, masks) {
  return intervals.flatMap(interval => {
    let remaining = [interval];
    for (const mask of masks) {
      if (mask.sectionId !== interval.sectionId) continue;
      remaining = remaining.flatMap(part => mask.end <= part.start || mask.start >= part.end ? [part] : [
        ...(mask.start > part.start ? [{ ...part, end: mask.start }] : []),
        ...(mask.end < part.end ? [{ ...part, start: mask.end }] : [])
      ]);
    }
    return remaining;
  });
}

function legacyPracticeParts(id) {
  const task = taskById.get(id);
  if (task?.activity === 'video' || !Array.isArray(task?.practiceParts)) return [];
  return task.practiceParts.map((part, index) => {
    const source = legacyPracticeTaskById.get(part?.sourceTaskId);
    const totalSeconds = source ? Math.round(taskMinutes(source) * 60) : 0;
    const { sourceStepIndex, startSecond, endSecond } = part || {};
    const valid = source && index < (task.steps?.length || 0) && Number.isInteger(sourceStepIndex)
      && sourceStepIndex >= 0 && sourceStepIndex < (source.steps?.length || 0)
      && Number.isInteger(startSecond) && Number.isInteger(endSecond) && startSecond >= 0
      && startSecond < endSecond && endSecond <= totalSeconds;
    if (!valid) return null;
    const result = { task: source, index, sourceStepIndex, startSecond, endSecond, totalSeconds };
    if (part.previousTaskId === undefined && part.previousStepIndex === undefined) return result;
    const previous = legacyPracticeTaskById.get(part.previousTaskId);
    const previousParts = previous?.practiceParts;
    const previousIndex = part.previousStepIndex;
    const previousPart = Number.isInteger(previousIndex) && previousIndex >= 0 ? previousParts?.[previousIndex] : null;
    if (!previousPart || previousIndex >= (previous.steps?.length || 0)
      || previousPart.sourceTaskId !== part.sourceTaskId || previousPart.sourceStepIndex !== sourceStepIndex
      || previousPart.startSecond !== startSecond || previousPart.endSecond !== endSecond) return null;
    const durations = previousParts.map(item => Number(item.endSecond) - Number(item.startSecond));
    if (durations.some(seconds => !Number.isInteger(seconds) || seconds <= 0)) return null;
    const previousStart = durations.slice(0, previousIndex).reduce((sum, seconds) => sum + seconds, 0);
    result.previous = { task: previous, index, sourceStepIndex: previousIndex, startSecond: previousStart,
      endSecond: previousStart + durations[previousIndex], totalSeconds: durations.reduce((sum, seconds) => sum + seconds, 0) };
    return result;
  });
}

function legacyPracticeRecords(id, entries = state.entries) {
  const unique = new Map();
  for (const part of legacyPracticeParts(id)) {
    for (const source of part ? [part, part.previous].filter(Boolean) : []) {
      if (entries[source.task.id] && !unique.has(source.task.id)) {
        unique.set(source.task.id, { task: source.task, record: entries[source.task.id] });
      }
    }
  }
  return [...unique.values()];
}

function legacyTaskRecords(idOrTask, entries = state.entries) {
  const current = typeof idOrTask === 'object' && idOrTask ? idOrTask : taskById.get(idOrTask);
  const id = current?.id || idOrTask;
  // Rewritten tasks retain their old records for review, without deriving new
  // completion, checked steps, actual time or notes from different work.
  const references = [...new Set(current?.historicalTaskIds || [])].flatMap(sourceId => {
    const task = legacyTaskById.get(sourceId);
    const record = entries[sourceId];
    return task && record ? [{ task, record, referenceOnly: true }] : [];
  });
  return [...new Map([...legacyVideoRecords(id, entries), ...legacyPracticeRecords(id, entries), ...references]
    .map(source => [source.task.id, source])).values()];
}

function sourceRecordText(sources, field) {
  return sources.filter(source => field === 'note' ? source.record.progress?.note : source.record.evidence)
    .map(source => `${source.task.title}：${field === 'note' ? source.record.progress.note : source.record.evidence}`).join('\n');
}

function latestSourceTime(sources) {
  return sources.reduce((latest, source) => Date.parse(source.record.updatedAt) > Date.parse(latest)
    ? source.record.updatedAt : latest, new Date(0).toISOString());
}

function derivedPracticeEntry(id, entries) {
  const parts = legacyPracticeParts(id);
  if (!parts.length || parts.some(part => !part)) return null;
  const task = taskById.get(id);
  if (parts.length !== task.steps?.length) return null;
  const selectedParts = parts.map(part => part.previous && Object.hasOwn(entries, part.previous.task.id) ? part.previous : part);
  const sources = [...new Map(selectedParts.filter(part => entries[part.task.id])
    .map(part => [part.task.id, { task: part.task, record: entries[part.task.id] }])).values()];
  if (!sources.length) return null;
  const completedSteps = [];
  let workedMinutes = 0;
  for (const part of selectedParts) {
    const record = entries[part.task.id];
    if (!record) continue;
    const progress = normalizeTaskProgress(record.progress);
    if (record.done || progress?.kind === 'practice' && progress.completedSteps?.includes(part.sourceStepIndex)) completedSteps.push(part.index);
    if (progress?.kind !== 'practice') continue;
    const worked = Math.max(0, Number(progress.workedMinutes) || 0);
    // Cumulative rounding conserves the original actual minutes across splits.
    // Extra time belongs to the original final step rather than earlier weeks.
    const base = Math.min(worked, part.totalSeconds / 60);
    workedMinutes += Math.round(base * part.endSecond / part.totalSeconds) - Math.round(base * part.startSecond / part.totalSeconds);
    if (part.endSecond === part.totalSeconds) workedMinutes += worked - Math.round(base);
  }
  const done = selectedParts.every(part => entries[part.task.id]?.done === true);
  const notes = sourceRecordText(sources, 'note');
  const progress = done || completedSteps.length || workedMinutes || notes
    ? { kind: 'practice', workedMinutes, completedSteps, ...(notes ? { note: notes.slice(0, 1000) } : {}) } : undefined;
  return createEntry(done, latestSourceTime(sources), sourceRecordText(sources, 'evidence'), progress);
}

function taskEntry(id, entries = state.entries) {
  // A deliberate check-in, cancellation or reset on the new task always wins.
  if (Object.hasOwn(entries, id)) return entries[id];
  if (taskById.get(id)?.practiceParts) return derivedPracticeEntry(id, entries);
  const sources = legacyVideoRecords(id, entries);
  if (!sources.length) return null;
  const ranges = taskById.get(id).learningSegments.map(videoSegmentRange);
  if (ranges.some(range => !range)) return null;
  const completed = [], watched = [];
  let hasStop = false;
  for (const { task, record, segments } of sources) {
    // Every explicit newer record owns its whole original range, including a
    // cancellation or an unfinished suffix. Older completion cannot fill it.
    const generation = legacyVideoGeneration(task);
    const masks = sources.filter(source => legacyVideoGeneration(source.task) > generation)
      .flatMap(source => source.segments.filter(Boolean));
    const visible = intervals => unmaskedVideoIntervals(intervals, masks);
    if (record.done) {
      completed.push(...visible(segments.filter(Boolean)));
      watched.push(...visible(segments.filter(Boolean)));
      continue;
    }
    const progress = normalizeTaskProgress(record.progress);
    if (progress?.kind !== 'video') continue;
    const index = progress.segmentIndex ?? 0;
    const segment = segments[index];
    const position = segment ? legacyVideoPosition(segment, progress.positionSecond) : null;
    if (position === null) continue;
    hasStop = true;
    watched.push(...visible(segments.slice(0, index).filter(Boolean)));
    if (position > segment.start) watched.push(...visible([{ ...segment, end: position }]));
  }
  const done = ranges.every(range => firstUncoveredSecond(range, completed) === range.end);
  const gapIndex = ranges.findIndex(range => firstUncoveredSecond(range, watched) < range.end);
  const index = gapIndex < 0 ? ranges.length - 1 : gapIndex;
  const positionSecond = gapIndex < 0 ? ranges[index].end : firstUncoveredSecond(ranges[index], watched);
  const notes = sourceRecordText(sources, 'note');
  const evidence = sourceRecordText(sources, 'evidence');
  const updatedAt = latestSourceTime(sources);
  const progress = done || watched.length || hasStop || notes ? { kind: 'video', segmentIndex: index, positionSecond, ...(notes ? { note: notes.slice(0, 1000) } : {}) } : undefined;
  return createEntry(done, updatedAt, evidence, progress);
}

function taskDone(id) { return !!taskEntry(id)?.done; }
function taskProgress(id) { return normalizeTaskProgress(taskEntry(id)?.progress) || null; }
function percent(done, total) { return total ? Math.round(done * 100 / total) : 0; }
function calendarWeek(date = todayISO()) { return DATA.weeks.find(week => week.start <= date && date <= week.end); }
function isCareerPreparation(task) { return !!task && DATA.careerWorkflow?.preparationTaskIds?.includes(task.id) === true; }
function careerPreparationGroup(task) {
  if (DATA.careerWorkflow?.projectPreparationTaskIds?.includes(task?.id)) return 'project';
  if (DATA.careerWorkflow?.skillPreparationTaskIds?.includes(task?.id)) return 'skill';
  return '';
}
function nextCareerTask(tasks, date = todayISO()) {
  const pending = tasks.filter(task => !taskDone(task.id));
  const preparation = pending.filter(isCareerPreparation);
  if (preparation.length && DATA.careerWorkflow?.projectPreparationTaskIds?.length) {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    const preferred = day === 6 || day === 0 ? 'skill' : 'project';
    return preparation.find(task => careerPreparationGroup(task) === preferred) || preparation[0];
  }
  return pending[0];
}
function isExternalConfirmation(task) { return task?.scheduleKind === 'external'; }
function isRelativeCareerTask(task) { return task?.scheduleKind === 'after-event'; }
function isUnscheduledCareerTask(task) { return isExternalConfirmation(task) || isRelativeCareerTask(task); }
function openEndedCareerPhase() { return planPhases.find(phase => phase.id === 'career' && phase.openEnded); }
function careerWorkflowState() {
  const workflow = DATA.careerWorkflow;
  if (!workflow) return null;
  const preparation = (workflow.preparationTaskIds || []).map(id => taskById.get(id)).filter(Boolean);
  const teacher = taskById.get(workflow.teacherTaskId);
  const interviews = (workflow.interviewTaskIds || []).map(id => taskById.get(id)).filter(Boolean);
  const preparationComplete = preparation.length > 0 && preparation.length === workflow.preparationTaskIds.length
    && preparation.every(task => taskDone(task.id));
  return { preparation, teacher, interviews, preparationComplete,
    projectPreparation: (workflow.projectPreparationTaskIds || []).map(id => taskById.get(id)).filter(Boolean),
    skillPreparation: (workflow.skillPreparationTaskIds || []).map(id => taskById.get(id)).filter(Boolean),
    teacherConfirmed: !!teacher && taskDone(teacher.id) && preparationComplete && !unfinishedPrerequisites(teacher).length };
}
function careerRhythmDescription() {
  const workflow = careerWorkflowState();
  if (!workflow) return '';
  const projectsPending = workflow.projectPreparation.some(task => !taskDone(task.id));
  const skillsPending = workflow.skillPreparation.some(task => !taskDone(task.id));
  return !workflow.preparationComplete ? DATA.careerWorkflow?.projectPreparationTaskIds?.length
    ? projectsPending && skillsPending ? '工作日完整梳理项目，每次约40分钟；周六整理技能材料，材料齐后与易道云老师沟通'
      : projectsPending ? '技能材料已整理，继续完整梳理项目，每次约40分钟；材料齐后与老师沟通'
        : '项目材料已整理，可继续技能模块；技能整理完成后再与老师沟通'
    : '整理项目与已掌握技能，每次约 40 分钟；材料齐后与易道云老师沟通'
    : !workflow.teacherConfirmed ? '待与易道云老师沟通并确认定制简历，确认后再准备面试'
      : workflow.interviews.some(task => !taskDone(task.id)) ? '定制简历已与老师确认，按顺序准备面试并按准备情况投递'
        : '面试准备已完成，按实际求职反馈继续推进';
}
function careerTaskBlocked(task) {
  return task?.track === 'review' && (!allLearningComplete() || unfinishedPrerequisites(task).length > 0);
}
function taskWorkSessions(task) {
  return Array.isArray(task?.workSessions) ? task.workSessions.filter(session => /^\d{4}-\d{2}-\d{2}$/.test(session?.date)
    && Number.isFinite(session.minutes) && session.minutes > 0) : [];
}
function supportsPracticeProgress(task) {
  return !!task && task.activity !== 'video' && (task.track === 'ydy'
    || task.track === 'review' && (taskWorkSessions(task).length > 0 || isRelativeCareerTask(task)));
}
function taskForSession(task, session) {
  const week = calendarWeek(session.date);
  const day = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${session.date}T00:00:00Z`).getUTCDay()];
  return { ...task, date: session.date, day, week: week?.week || task.week, sessionMinutes: session.minutes,
    sessionFocus: typeof session.focus === 'string' ? session.focus : '',
    plannedStartDate: task.plannedStartDate || task.date };
}
function scheduledTasksForDate(date, tasks = allTasks) {
  return tasks.flatMap(task => {
    if (task.onDemand || isUnscheduledCareerTask(task)) return [];
    const sessions = taskWorkSessions(task);
    return sessions.length ? sessions.filter(session => session.date === date).map(session => taskForSession(task, session))
      : task.date === date ? [task] : [];
  });
}
function scheduledTasksForWeek(week = currentWeek(), tasks = allTasks) {
  const value = typeof week === 'number' ? DATA.weeks.find(item => item.week === week) : week;
  if (!value) return [];
  return tasks.flatMap(task => {
    if (task.onDemand || isUnscheduledCareerTask(task)) return [];
    const sessions = taskWorkSessions(task);
    return sessions.length ? sessions.filter(session => value.start <= session.date && session.date <= value.end)
      .map(session => taskForSession(task, session)) : value.start <= task.date && task.date <= value.end ? [task] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
}
function recommendedSessionTask(task, date = todayISO()) {
  if (!task) return task;
  if (isRelativeCareerTask(task)) return { ...task, date, sessionMinutes: Math.min(taskMinutes(task), 40) };
  if (!taskWorkSessions(task).length) return task;
  const planned = taskWorkSessions(task).find(session => session.date === date);
  if (careerPreparationGroup(task)) return taskForSession(task, { ...planned, date, minutes: practiceSessionMinutes(task, date) });
  return taskForSession(task, { ...planned, date, minutes: Math.min(planned?.minutes || (isLearningWeekday(date)
    ? planRhythm().afterCourseWeekdays.minutes : planRhythm().saturdayMinutes), practiceRemainingMinutes(task) || taskMinutes(task)) });
}
function taskPlanStart(task) { return task.plannedStartDate || taskById.get(task.id)?.date || task.date; }
function taskPlanEnd(task) { return task.endDate || taskWorkSessions(task).at(-1)?.date || taskPlanStart(task); }
function taskPlanDateLabel(task) {
  if (isExternalConfirmation(task)) return '材料齐后与老师沟通确认，无固定日期';
  if (isRelativeCareerTask(task)) return `沟通确认后 · 第 ${task.relativeOrder || 1} 次`;
  if (task.onDemand) return '按需执行，无固定日期';
  return taskWorkSessions(task).length && taskPlanEnd(task) !== taskPlanStart(task)
    ? `${formatDate(taskPlanStart(task), true)} – ${formatDate(taskPlanEnd(task), true)}` : formatDate(taskPlanStart(task), true);
}
function currentWeek() { const date = todayISO(); return calendarWeek(date) || DATA.weeks.find(week => week.start > date) || DATA.weeks.at(-1); }
function phaseForWeek(week) {
  const number = typeof week === 'number' ? week : week?.week;
  return planPhases.find(phase => phase.startWeek <= number && number <= phase.endWeek) || planPhases[0];
}
function selectedPhaseData() { return planPhases.find(phase => phase.id === selectedPhase) || planPhases[0]; }
function phaseWeeks(phase = selectedPhaseData()) { return DATA.weeks.filter(week => phaseForWeek(week).id === phase.id); }
function selectedWeekData() { return phaseWeeks().find(week => week.week === selectedWeek) || phaseWeeks()[0] || DATA.weeks[0]; }
function phaseWeekLabel(week) {
  const phase = phaseForWeek(week);
  const number = Number.isInteger(week.phaseWeek) ? week.phaseWeek : week.week - phase.startWeek + 1;
  return phase.id === 'career' && phase.openEnded ? `材料第 ${number} 周` : phase.id === 'career' ? `求职第 ${number} 周` : phase.weekLabel ? `${phase.weekLabel}第 ${number} 周` : `第 ${number} 周`;
}
function phaseScheduleCaption(phase) {
  return phase.id === 'career' && DATA.careerWorkflow ? '先整理项目与技能材料，与易道云老师沟通确认简历后再准备面试' : phase.id === 'career' ? '全部学习完成后，集中准备面试求职'
    : '工作日零声，周六易道云课程与实践';
}
function weekTopics(week) {
  const configured = Array.isArray(week.topics) ? week.topics.filter(topic => topic?.title) : [];
  const scheduled = scheduledTasksForWeek(week);
  if (scheduled.some(task => taskWorkSessions(task).length)) {
    return ['ls', 'ydy', 'review'].flatMap(track => {
      if (track === 'ls' && configured.some(topic => topic.track === track)) {
        return configured.filter(topic => topic.track === track);
      }
      const tasks = [...new Map(scheduled.filter(task => task.track === track).map(task => [task.id, task])).values()];
      if (!tasks.length) return [];
      const title = tasks.map(task => taskWorkSessions(task).length
        ? `${task.title}${taskById.get(task.id)?.date < week.start ? '（续学）' : ''}` : displayTitle(task)).join('；');
      return [{ track, label: { ls: '零声', ydy: tasks.every(task => !isRequiredTask(task)) ? '按需补漏' : '项目', review: '求职' }[track], title }];
    });
  }
  return configured.length
    ? configured
    : [{ track: 'ydy', label: '项目', title: week.projectTopic || week.topic || week.theme || '' }];
}
function weekTopicsText(week, track = null) { return weekTopics(week).filter(topic => !track || topic.track === track).map(topic => `${topic.label || '主题'}：${topic.title}`).join('；'); }
function weekTopicsMarkup(week) {
  return `<span class="week-topics">${weekTopics(week).map(topic => `<span class="week-topic-line ${escapeHTML(topic.track || '')}"><span class="week-topic-label">${escapeHTML(topic.label || '主题')}</span><span class="week-topic-title">${escapeHTML(topic.title)}</span></span>`).join('')}</span>`;
}

function legacyCheckinTaskId(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const offset = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${LEGACY_CHECKIN_PLAN.start}T00:00:00Z`)) / 86400000;
  if (!Number.isInteger(offset) || offset < 0 || offset >= LEGACY_CHECKIN_PLAN.weeks * 7) return null;
  return `w${String(Math.floor(offset / 7) + 1).padStart(2, '0')}-${['周一', '周二', '周三', '周四', '周五', '周六', '周日'][offset % 7]}-${offset % 7 < 5 ? 'ls' : 'ydy'}`;
}

function normalizeState(data) {
  const next = blankClientState();
  // v3 exports keep retired task IDs in archivedEntries. Keep them as raw
  // records so a later sync or import can update the original source safely.
  for (const records of [data?.archivedEntries, data?.entries]) {
    if (records && typeof records === 'object' && !Array.isArray(records)) {
      for (const [id, record] of Object.entries(records)) {
        if (!id) continue;
        if (typeof record === 'string' && isValidIso(record)) next.entries[id] = createEntry(true, record);
        else if (record && typeof record === 'object' && typeof record.done === 'boolean') next.entries[id] = createEntry(record.done, record.updatedAt, record.evidence, record.progress);
      }
    }
  }
  if (data?.done && typeof data.done === 'object') {
    for (const [id, value] of Object.entries(data.done)) {
      if (id && (typeof value === 'boolean' || isValidIso(value))) next.entries[id] = createEntry(value !== false, typeof value === 'string' ? value : new Date(0).toISOString());
    }
  }
  if (data?.checkins && typeof data.checkins === 'object') {
    for (const [date, checked] of Object.entries(data.checkins)) {
      const id = checked === true && legacyCheckinTaskId(date);
      if (id) next.entries[id] = createEntry(true, `${date}T12:00:00+08:00`);
    }
  }
  if (typeof data?.lastSyncedAt === 'string') next.lastSyncedAt = data.lastSyncedAt;
  next.pendingReplace = data?.pendingReplace === true;
  return next;
}

function readReplaceMarker() {
  try {
    const keys = [];
    if (typeof localStorage.key === 'function' && Number.isInteger(localStorage.length)) {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(REPLACE_JOURNAL_PREFIX)) keys.push(key);
      }
    }
    // The single-key fallback also reads a pending restore left by older clients.
    if (!keys.length) keys.push(REPLACE_STORE_KEY);
    const markers = keys.map(key => {
      try {
        const marker = JSON.parse(localStorage.getItem(key) || 'null');
        if (!marker || typeof marker.id !== 'string' || !marker.id
          || !['pending', 'ack'].includes(marker.status)
          || !Number.isSafeInteger(marker.revision) || marker.revision < 0
          || !marker.entries || typeof marker.entries !== 'object' || Array.isArray(marker.entries)) return null;
        const generation = Number.isSafeInteger(marker.generation) && marker.generation >= 0
          ? marker.generation : Number.parseInt(marker.id, 10) || 0;
        return { id: marker.id, generation, status: marker.status, revision: marker.revision,
          entries: normalizeState({ entries: marker.entries }).entries };
      } catch { return null; }
    }).filter(Boolean);
    if (!markers.length) return null;
    const generation = Math.max(...markers.map(marker => marker.generation));
    const latestId = markers.filter(marker => marker.generation === generation)
      .map(marker => marker.id).sort().at(-1);
    const generationMarkers = markers.filter(marker => marker.id === latestId && marker.generation === generation);
    const revision = Math.max(...generationMarkers.map(marker => marker.revision));
    const current = generationMarkers.filter(marker => marker.revision === revision);
    const pending = current.filter(marker => marker.status === 'pending');
    const acknowledged = current.filter(marker => marker.status === 'ack');
    const mergeRecords = list => list.reduce((entries, marker) => mergeEntryMaps(entries, marker.entries), {});
    const pendingEntries = mergeRecords(pending);
    const ackEntries = mergeRecords(acknowledged);
    const progressKey = progress => JSON.stringify(['kind', 'segmentIndex', 'positionSecond', 'completedSteps', 'workedMinutes', 'note'].map(key => progress?.[key]));
    const ackCoversPending = Object.entries(pendingEntries).every(([id, record]) => {
      const confirmed = ackEntries[id];
      return confirmed && (Date.parse(confirmed.updatedAt) > Date.parse(record.updatedAt)
        || Date.parse(confirmed.updatedAt) === Date.parse(record.updatedAt)
          && confirmed.done === record.done && (confirmed.evidence || '') === (record.evidence || '')
          && progressKey(confirmed.progress) === progressKey(record.progress));
    });
    const status = acknowledged.length && ackCoversPending ? 'ack' : 'pending';
    return { id: latestId, generation, revision, status, entries: status === 'ack' ? ackEntries : pendingEntries };
  } catch { return null; }
}

function writeReplaceMarker(marker) {
  try {
    if (typeof localStorage.key !== 'function' || !Number.isInteger(localStorage.length)) {
      localStorage.setItem(REPLACE_STORE_KEY, JSON.stringify(marker));
      return true;
    }
    const key = `${REPLACE_JOURNAL_PREFIX}${marker.generation}:${marker.id}:${marker.revision}:${marker.status}:${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, JSON.stringify(marker));
    // Keep the current revision's concurrent writes, but bound storage while offline.
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const priorKey = localStorage.key(index);
      if (!priorKey?.startsWith(REPLACE_JOURNAL_PREFIX) || priorKey === key) continue;
      try {
        const prior = JSON.parse(localStorage.getItem(priorKey) || 'null');
        if (prior && (prior.generation < marker.generation
          || prior.generation === marker.generation && prior.id === marker.id && prior.revision < marker.revision)) {
          localStorage.removeItem(priorKey);
        }
      } catch { /* Leave unreadable old keys untouched. */ }
    }
    return true;
  } catch { return false; }
}

function entrySignatures(entries) {
  return Object.fromEntries(Object.entries(entries || {}).map(([id, record]) => [id, JSON.stringify(record)]));
}

function localEntryChanges() {
  return Object.fromEntries(Object.entries(state.entries).filter(([id, record]) => observedEntries[id] !== JSON.stringify(record)));
}

function applyEntryChanges(base, changes) {
  const entries = { ...base };
  for (const [id, record] of Object.entries(changes)) {
    const old = entries[id];
    const needsNewTime = old && Date.parse(record.updatedAt) <= Date.parse(old.updatedAt);
    if (needsNewTime) {
      state.entries = entries;
      entries[id] = createEntry(record.done, freshTimestamp(), record.evidence, record.progress);
    } else entries[id] = record;
  }
  return entries;
}

function beginReplacement() {
  const generation = Math.max(Date.now(), (readReplaceMarker()?.generation || 0) + 1);
  const randomId = globalThis.crypto?.randomUUID?.() || `${Math.random().toString(36).slice(2)}-${++replacementCounter}`;
  const marker = { id: `${generation}-${randomId}`, generation, status: 'pending', revision: 0,
    entries: normalizeState({ entries: state.entries }).entries };
  writeReplaceMarker(marker);
  replacementToken = marker.id;
  replacementRevision = 0;
  replacementStatus = 'pending';
  observedEntries = entrySignatures(state.entries);
  replaceEpoch++;
  replaceRequested = true;
  state.pendingReplace = true;
  return marker.id;
}

function loadState() {
  let next = blankClientState();
  try {
    for (const key of [STORE_KEY, ...LEGACY_KEYS]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { next = normalizeState(JSON.parse(raw)); break; } catch { /* Try another previous version. */ }
    }
  } catch { /* The page can still work when browser storage is unavailable. */ }
  const marker = readReplaceMarker();
  if (marker?.status === 'pending') {
    next.entries = marker.entries;
    next.pendingReplace = true;
  } else if (marker?.status === 'ack') {
    next.entries = next.pendingReplace ? marker.entries : mergeEntryMaps(marker.entries, next.entries);
    next.pendingReplace = false;
  }
  return next;
}

function saveState({ authoritativeReplacement = false, fromSync = false } = {}) {
  try {
    // A server response is not a local edit; never mint a newer timestamp for it.
    const changes = fromSync ? {} : localEntryChanges();
    let marker = readReplaceMarker();
    if (marker) {
      const changed = marker.id !== replacementToken || marker.revision !== replacementRevision || marker.status !== replacementStatus;
      if (changed) replaceEpoch++;
      const wasPending = state.pendingReplace;
      replacementToken = marker.id;
      replacementRevision = marker.revision;
      replacementStatus = marker.status;
      if (marker.status === 'pending') {
        state.entries = applyEntryChanges(marker.entries, changes);
        state.pendingReplace = true;
        replaceRequested = true;
        if (Object.keys(changes).length) {
          marker = { ...marker, revision: marker.revision + 1, entries: state.entries };
          if (!writeReplaceMarker(marker)) throw new Error('Cannot persist pending backup replacement');
          replacementRevision = marker.revision;
          replaceEpoch++;
        }
      } else {
        let stored = null;
        try { stored = normalizeState(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch {}
        const base = authoritativeReplacement || stored?.pendingReplace || !fromSync && (changed || wasPending)
          ? marker.entries : mergeEntryMaps(marker.entries, stored?.entries || {});
        state.entries = fromSync && !authoritativeReplacement
          ? mergeEntryMaps(base, state.entries) : applyEntryChanges(base, changes);
        state.pendingReplace = false;
        replaceRequested = false;
      }
    } else if (fromSync) {
      let stored = null;
      try { stored = normalizeState(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch {}
      state.entries = mergeEntryMaps(stored?.entries || {}, state.entries);
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    observedEntries = entrySignatures(state.entries);
    persistenceError = false;
    return true;
  } catch {
    persistenceError = true;
    return false;
  }
}

function adoptReplacementMarker(marker) {
  if (!marker) return;
  const changes = localEntryChanges();
  const incoming = loadState();
  replacementToken = marker.id;
  replacementRevision = marker.revision;
  replacementStatus = marker.status;
  replaceEpoch++;
  state.entries = incoming.entries;
  state.pendingReplace = incoming.pendingReplace;
  replaceRequested = incoming.pendingReplace;
  observedEntries = entrySignatures(state.entries);
  if (Object.keys(changes).length) {
    state.entries = applyEntryChanges(state.entries, changes);
    saveState();
  }
}

function loadPreferences() { try { return JSON.parse(localStorage.getItem(UI_STORE_KEY)) || {}; } catch { return {}; } }
function savePreferences() {
  rememberOutlineWeeks();
  const key = outlineStateKey();
  if (outlineScrollReady && !outlinePositionChanging && !restoringLocation && selectedView === 'planner' && document.body.dataset.view === 'planner' && key && $('weekTasks').dataset.outlineState === key) {
    outlineScrollStates.set(key, window.scrollY);
  }
  const outlineStates = Array.from(outlineContexts).filter(([contextKey]) => outlineWeekStates.has(contextKey)).map(([contextKey, context]) => ({
    ...context, weeks: [...(outlineWeekStates.get(contextKey) || [])],
    tasks: [...(outlineTaskStates.get(contextKey) || [])], cursor: outlineCursorStates.get(contextKey) || '',
    scroll: outlineScrollStates.get(contextKey) || 0
  }));
  const outlineState = key ? outlineStates.find(item => outlineStateKeyFor(item) === key) || null : null;
  try { localStorage.setItem(UI_STORE_KEY, JSON.stringify({ view: selectedView, phase: selectedPhase, week: selectedWeek, progressPhase: selectedProgressPhase, filter: taskFilter, track: trackFilter, search: searchQuery, progressScope: progressListScope, progressReturn: progressListScope ? progressListReturn : null, outlineState, outlineStates })); } catch {}
}

function saveOutlineScroll() {
  const key = outlineStateKey();
  if (!outlineScrollReady || outlinePositionChanging || restoringLocation || selectedView !== 'planner' || document.body.dataset.view !== 'planner' || !key || $('weekTasks').dataset.outlineState !== key) return;
  outlineScrollStates.set(key, window.scrollY);
  try {
    const stored = loadPreferences();
    if (stored.view !== 'planner' || !stored.outlineState || outlineStateKeyFor(stored.outlineState) !== key) return;
    stored.outlineState.scroll = window.scrollY;
    const context = stored.outlineStates?.find(item => outlineStateKeyFor(item) === key);
    if (context) context.scroll = window.scrollY;
    localStorage.setItem(UI_STORE_KEY, JSON.stringify(stored));
  } catch {}
}
function getStoredApiKey() {
  if (memoryApiKey !== null) return memoryApiKey;
  try { return localStorage.getItem(API_KEY_STORE) || ''; } catch { return ''; }
}
function setStoredApiKey(value) {
  memoryApiKey = value;
  try { if (value) localStorage.setItem(API_KEY_STORE, value); else localStorage.removeItem(API_KEY_STORE); return true; } catch { return false; }
}

function mergeEntryMaps(left, right) {
  const result = { ...left };
  for (const [id, record] of Object.entries(right || {})) {
    if (!result[id] || Date.parse(record.updatedAt) >= Date.parse(result[id].updatedAt)) result[id] = record;
  }
  return result;
}

function freshTimestamp() {
  const latest = Object.values(state.entries).reduce((maximum, record) => Math.max(maximum, Date.parse(record.updatedAt) || 0), 0);
  timestampFloor = Math.max(Date.now(), timestampFloor + 1, latest + 1);
  return new Date(timestampFloor).toISOString();
}

function plannerFocusTarget() {
  return document.querySelector('.planner-topbar').hidden ? $('pageTitle') : $('weekTitle');
}

function rememberCareerSections() {
  if (restoringLocation || !$('weekTasks').querySelector('[data-career-workflow]')) return;
  careerOpenSections = new Set(Array.from($('weekTasks').querySelectorAll('[data-career-section][open]'), section => section.dataset.careerSection));
}

function focusPlannerTask(id, { scroll = true } = {}) {
  const card = $('weekTasks').querySelector(`[data-task-id="${CSS.escape(id)}"]`);
  if (!card) return false;
  let ancestor = card.parentElement;
  while (ancestor && ancestor !== $('weekTasks')) {
    if (ancestor.tagName === 'DETAILS') {
      ancestor.open = true;
      if (ancestor.dataset.careerSection) careerOpenSections.add(ancestor.dataset.careerSection);
    }
    ancestor = ancestor.parentElement;
  }
  if (scroll) card.scrollIntoView({ behavior: 'instant', block: 'center' });
  card.querySelector('[data-task-action="details"]')?.focus({ preventScroll: true });
  return true;
}

function focusSnapshot() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  if (active.id) return { id: active.id };
  if (active.matches('a.record-link')) {
    const milestone = active.closest('[data-milestone-id]');
    const task = active.closest('[data-task-id]');
    const inDialog = !!active.closest('#taskDialogBody');
    const owner = milestone || task || (inDialog ? $('taskDialogBody') : null);
    const section = active.closest('.outline-content-section');
    const container = section || owner;
    if (container) {
      const href = active.getAttribute('href');
      return { record: { milestone: milestone?.dataset.milestoneId, task: task?.dataset.taskId || (inDialog ? detailTaskId : ''),
        dialog: inDialog, section: section?.querySelector('h4')?.textContent, href,
        index: Array.from(container.querySelectorAll('a.record-link')).filter(link => link.getAttribute('href') === href).indexOf(active) } };
    }
  }
  const card = active.closest('[data-task-id]');
  if (card && (active.dataset.taskAction || active.dataset.progressAction)) {
    const scope = active.closest('#todayBox, #continueBox, #weekTasks, #applicationMilestone');
    const attribute = active.dataset.taskAction ? 'data-task-action' : 'data-progress-action';
    const action = active.dataset.taskAction || active.dataset.progressAction;
    return { task: card.dataset.taskId, ...(active.dataset.taskAction ? { action } : { progressAction: action }),
      scope: scope?.id, index: scope ? Array.from(scope.querySelectorAll(`[${attribute}="${CSS.escape(action)}"]`)).indexOf(active) : 0 };
  }
  if (active.dataset.week) return { week: active.dataset.week };
  return null;
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  let element;
  if (snapshot.id) element = snapshot.id === 'weekTitle' ? plannerFocusTarget() : $(snapshot.id);
  else if (snapshot.record) {
    const record = snapshot.record;
    const owner = record.milestone ? document.querySelector(`[data-milestone-id="${CSS.escape(record.milestone)}"]`)
      : record.dialog ? (detailTaskId === record.task && $('taskDialog').open ? $('taskDialogBody') : null)
      : $('weekTasks').querySelector(`[data-task-id="${CSS.escape(record.task)}"]`);
    const container = record.section ? Array.from(owner?.querySelectorAll('.outline-content-section') || [])
      .find(section => section.querySelector('h4')?.textContent === record.section) : owner;
    element = container && Array.from(container.querySelectorAll('a.record-link'))
      .filter(link => link.getAttribute('href') === record.href)[record.index];
    if (!element || element.closest('details:not([open])')) {
      element = record.milestone ? owner?.querySelector('h3')
        : record.dialog ? $('taskDialogTitle') : plannerFocusTarget();
      if (element && !element.hasAttribute('tabindex')) element.tabIndex = -1;
    }
  }
  else if (snapshot.task) {
    const actionSelector = snapshot.progressAction ? `[data-progress-action="${CSS.escape(snapshot.progressAction)}"]`
      : `[data-task-action="${CSS.escape(snapshot.action || '')}"]`;
    const cardSelector = `${snapshot.scope ? '#' + snapshot.scope : ''} [data-task-id="${CSS.escape(snapshot.task)}"]`;
    element = document.querySelector(`${cardSelector} ${actionSelector}`)
      || (snapshot.progressAction ? document.querySelector(`${cardSelector} [data-task-action="details"]`) : null);
    if (!element) {
      if (snapshot.action === 'toggle' || snapshot.progressAction) {
        element = snapshot.scope === 'weekTasks' ? plannerFocusTarget() : snapshot.scope === 'continueBox'
          ? $(`continue-track-${continueTrackChoice || defaultContinueTrack()}`) : $('todayHeading');
        if (element && !element.hasAttribute('tabindex')) element.tabIndex = -1;
      } else {
        const candidates = document.querySelectorAll(`${snapshot.scope ? '#' + snapshot.scope : ''} ${actionSelector}`);
        element = candidates[Math.min(snapshot.index || 0, candidates.length - 1)]
          || (snapshot.scope === 'continueBox' ? $(`continue-track-${continueTrackChoice || defaultContinueTrack()}`) : $('taskFilter'));
      }
    }
  }
  else if (snapshot.week) element = document.querySelector(`#weekList [data-week="${snapshot.week}"]`);
  const dialog = element?.closest('dialog');
  if (element && !element.closest('[hidden]') && (!dialog || dialog.open) && document.activeElement !== element) element.focus({ preventScroll: true });
}

function captureLocation() {
  return {
    view: selectedView, phase: selectedPhase, week: selectedWeek, query: searchQuery,
    filter: taskFilter, track: trackFilter, progressPhase: selectedProgressPhase,
    progressScope: progressListScope ? { ...progressListScope } : null,
    progressReturn: progressListReturn ? { ...progressListReturn } : null,
    projectProgressOpen: $('projectProgressDetails')?.open || false,
    projectHistoryOpen: Array.from($('milestones').querySelectorAll('[data-project-history][open]'), item => item.dataset.projectHistory),
    projectRequirementsOpen: Array.from($('milestonesView').querySelectorAll('[data-project-requirements][open]'), item => item.dataset.projectRequirements),
    outlineOpen: Array.from($('weekTasks').querySelectorAll('.task-outline-content[open]'), item => item.dataset.outlineTaskId),
    outlineWeeks: Array.from($('weekTasks').querySelectorAll('.outline-week-group[open]'), item => Number(item.dataset.resultWeek)),
    outlineCursor: outlineCursorTaskId,
    continueTrack: continueTrackChoice, phaseSelections: [...phaseSelections],
    scroll: window.scrollY, focus: focusSnapshot(),
    allWeeksOpen: $('allWeeksDetails').open,
    careerSections: [...careerOpenSections],
    months: Array.from($('weekList').querySelectorAll('.month-group[open]'), item => item.dataset.month),
    detail: $('taskDialog').open && taskById.has(detailTaskId)
      ? { id: detailTaskId, scroll: $('taskDialog').scrollTop, opener: detailOpenerFocus } : null
  };
}

function locationKey(location, includeQuery = true) {
  return JSON.stringify([location.view, location.phase, location.week, includeQuery ? location.query : '',
    location.filter, location.track, location.progressPhase, location.progressScope || null, location.progressReturn?.week || null, location.continueTrack, location.detail?.id || '']);
}

function updateHistoryControls() {
  const blocked = locationNavigationBusy || restoringLocation || detailProgressSaveBusy || practiceSessionSaveBusy;
  for (const id of ['navigationBackBtn', 'taskHistoryBackBtn']) {
    if ($(id)) $(id).disabled = blocked || positionHistoryIndex <= 0;
  }
  for (const id of ['navigationForwardBtn', 'taskHistoryForwardBtn']) {
    if ($(id)) $(id).disabled = blocked || positionHistoryIndex >= positionHistory.length - 1;
  }
  $('closeTaskBtn').disabled = detailProgressSaveBusy;
  for (const id of ['closePracticeSessionBtn', 'cancelPracticeSessionBtn']) $(id).disabled = practiceSessionSaveBusy;
}

function checkpointLocation() {
  if (restoringLocation || !positionHistory.length) return;
  const location = captureLocation();
  const previous = positionHistory[positionHistoryIndex];
  if (['navigationBackBtn', 'navigationForwardBtn', 'taskHistoryBackBtn', 'taskHistoryForwardBtn'].includes(location.focus?.id)) {
    location.focus = previous.focus;
  }
  // Closing a detail is not a new reading location. Preserve that task for Back.
  if (locationKey(previous) === locationKey(location)) positionHistory[positionHistoryIndex] = { ...location, kind: previous.kind };
}

function rememberLocation(kind = 'location', force = false) {
  if (restoringLocation) return;
  savePreferences();
  const location = { ...captureLocation(), kind };
  const previous = positionHistory[positionHistoryIndex];
  if (previous && locationKey(previous) === locationKey(location) && !force) {
    positionHistory[positionHistoryIndex] = { ...location, kind: previous.kind };
  } else if (kind === 'search' && previous?.kind === 'search' && locationKey(previous, false) === locationKey(location, false)) {
    positionHistory.splice(positionHistoryIndex + 1);
    positionHistory[positionHistoryIndex] = location;
  } else {
    positionHistory.splice(positionHistoryIndex + 1);
    positionHistory.push(location);
    if (positionHistory.length > 100) positionHistory.shift();
    positionHistoryIndex = positionHistory.length - 1;
  }
  updateHistoryControls();
  const revision = ++locationRevision;
  requestAnimationFrame(() => { if (revision === locationRevision) checkpointLocation(); });
}

function changeLocation(action, { kind = 'location', force = false } = {}) {
  const outer = locationChangeDepth === 0;
  if (outer) checkpointLocation();
  locationChangeDepth++;
  try { return action(); }
  finally {
    locationChangeDepth--;
    if (outer) rememberLocation(kind, force);
  }
}

async function closeLocationDialogs() {
  const dialogs = [$('taskDialog')].filter(dialog => dialog.open);
  if (!dialogs.length) return;
  const closed = dialogs.map(dialog => new Promise(resolve => dialog.addEventListener('close', resolve, { once: true })));
  for (const dialog of dialogs) dialog.close();
  await Promise.all(closed);
}

async function restoreLocation(location) {
  restoringLocation = true;
  const revision = ++locationRevision;
  try {
    await closeLocationDialogs();
    selectedView = location.view;
    selectedPhase = location.phase;
    selectedWeek = location.week;
    searchQuery = location.query;
    taskFilter = location.filter;
    trackFilter = location.track;
    selectedProgressPhase = location.progressPhase;
    progressListScope = normalizeProgressListScope(location.progressScope);
    progressListReturn = normalizeProgressReturn(location.progressReturn);
    outlineCursorTaskId = location.outlineCursor || '';
    continueTrackChoice = location.continueTrack;
    careerOpenSections = new Set((location.careerSections || []).filter(section => ['teacher', 'interviews'].includes(section)));
    phaseSelections.clear();
    for (const pair of location.phaseSelections) phaseSelections.set(...pair);
    savePreferences(); render();
    if ($('projectProgressDetails')) $('projectProgressDetails').open = location.projectProgressOpen;
    for (const history of $('milestones').querySelectorAll('[data-project-history]')) history.open = (location.projectHistoryOpen || []).includes(history.dataset.projectHistory);
    for (const requirements of $('milestonesView').querySelectorAll('[data-project-requirements]')) requirements.open = (location.projectRequirementsOpen || []).includes(requirements.dataset.projectRequirements);
    for (const outline of $('weekTasks').querySelectorAll('.task-outline-content')) outline.open = (location.outlineOpen || []).includes(outline.dataset.outlineTaskId);
    for (const group of $('weekTasks').querySelectorAll('.outline-week-group')) group.open = (location.outlineWeeks || []).includes(Number(group.dataset.resultWeek));
    rememberOutlineWeeks(); updateOutlineControls(); savePreferences();
    $('allWeeksDetails').open = location.allWeeksOpen;
    for (const month of $('weekList').querySelectorAll('.month-group')) month.open = location.months.includes(month.dataset.month);
    if (location.detail && taskById.has(location.detail.id)) {
      openTaskDetails(location.detail.id);
      detailOpenerFocus = location.detail.opener;
      renderTaskDetails();
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (revision !== locationRevision) return;
    window.scrollTo({ top: location.scroll, behavior: 'instant' });
    if (location.detail && $('taskDialog').open) $('taskDialog').scrollTop = location.detail.scroll;
    restoreFocus(location.focus);
  } finally { restoringLocation = false; savePreferences(); updateHistoryControls(); }
}

async function navigatePositionHistory(direction) {
  if (detailProgressSaveBusy || practiceSessionSaveBusy || $('confirmDialog').open || $('syncDialog').open) return;
  if (locationNavigationBusy) {
    if (restoringLocation) queuedLocationDirections.push(direction);
    return;
  }
  if (restoringLocation || !positionHistory[positionHistoryIndex + direction]) return;
  checkpointLocation();
  queuedLocationDirections.push(direction);
  locationNavigationBusy = true; updateHistoryControls();
  try {
    if ($('practiceSessionDialog')?.open && !await closePracticeSessionDialog()) return;
    if ($('taskDialog').open && !await confirmTaskDialogExit()) return;
    detailProgressDirty = false;
    let restored = false;
    while (queuedLocationDirections.length) {
      // A restored dialog can receive edits before its next animation frame.
      if (restored && (detailProgressDirty || detailProgressSaveBusy || practiceSessionSaveBusy
        || $('confirmDialog').open || $('syncDialog').open || $('practiceSessionDialog').open)) break;
      const next = positionHistoryIndex + queuedLocationDirections.shift();
      if (!positionHistory[next]) continue;
      positionHistoryIndex = next;
      await restoreLocation(positionHistory[next]);
      restored = true;
      if (queuedLocationDirections.length) checkpointLocation();
    }
  } finally { queuedLocationDirections.length = 0; locationNavigationBusy = false; updateHistoryControls(); }
}

function jumpToSection(id) {
  const target = $(id);
  if (!target) return;
  changeLocation(() => {
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, { force: true });
}

function displayTitle(task) {
  return task.title || taskLearningSegments(task)[0]?.title || task.summary || '学习任务';
}

function taskDuration(task) {
  if (isExternalConfirmation(task)) return '外部协作，不估算等待时长';
  if (isRelativeCareerTask(task)) return `每次 ${formatDuration(taskMinutes(task))}`;
  if (task.onDemand) return `按需预留最多 ${formatDuration(taskMinutes(task))}`;
  if (taskWorkSessions(task).length) return `${Number.isFinite(task.sessionMinutes) ? `本次 ${formatDuration(task.sessionMinutes)} · ` : ''}模块预计总 ${formatDuration(taskMinutes(task))}`;
  return Number.isFinite(task.durationMinutes) || task.budget ? formatDuration(taskMinutes(task)) : task.duration || '时长未设置';
}

function taskWorkSessionsMarkup(task) {
  const sessions = taskWorkSessions(task);
  if (!sessions.length) return '';
  return `<details class="detail-section"><summary>模块学习安排 · ${formatDate(sessions[0].date, true)} – ${formatDate(sessions.at(-1).date, true)} · ${sessions.length} 次</summary><p class="detail-hint">多次学习共用这一个模块记录。按实际投入记录进度，核对成果后完成模块；日期不会自动完成任务。</p><ol>${sessions.map(session => `<li><time datetime="${session.date}">${formatDate(session.date, true)}</time> · ${formatDuration(session.minutes)}${session.focus ? ` · ${escapeHTML(session.focus)}` : ''}</li>`).join('')}</ol></details>`;
}

function taskModuleSpecificationMarkup(task) {
  const sections = Array.isArray(task.sourceSections) ? task.sourceSections : [];
  const criteria = Array.isArray(task.completionCriteria) ? task.completionCriteria : [];
  const basis = typeof task.estimateBasis === 'string' ? task.estimateBasis : Array.isArray(task.estimateBasis) ? task.estimateBasis.join('；') : '';
  return (basis ? `<section class="detail-section"><h4>预计用时依据</h4><p>${escapeHTML(basis)}</p></section>` : '')
    + (criteria.length ? `<section class="detail-section"><h4>模块完成标准</h4><ul>${criteria.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></section>` : '')
    + (sections.length ? `<details class="detail-section"><summary>相关课程 · ${sections.length} 节</summary><ul>${sections.map(section => {
      const video = taskById.get(section.videoTaskId);
      return `<li>${escapeHTML([section.chapterTitle, section.title].filter(Boolean).join(' · ') || section.sectionId)}${section.videoCompletionDate ? `<small>计划看完 ${formatDate(section.videoCompletionDate, true)}</small>` : ''}${video ? `<button class="text-btn" type="button" data-prerequisite-task-id="${escapeHTML(video.id)}">查看对应视频${icon('arrow')}</button>` : ''}</li>`;
    }).join('')}</ul></details>` : '');
}

function taskLearningSegments(task) {
  if (task.learningSegments?.length) return task.learningSegments;
  return (task.segments || []).map(segment => {
    const lesson = lessonById.get(segment.lessonId) || legacyLessonById.get(segment.lessonId);
    return { courseTitle: '零声音视频课程', chapterTitle: lesson?.theme || '', title: lesson?.title || task.title,
      startSecond: segment.startMinute * 60, endSecond: segment.endMinute * 60,
      totalSeconds: Number(lesson?.minutes) * 60 || undefined };
  });
}

function segmentMarkup(task) {
  return `<div class="segment-list">${taskLearningSegments(task).map((segment, index) => {
    const context = [segment.courseTitle, segment.chapterTitle].filter(Boolean).join(' · ');
    return `<div class="segment-row" data-segment-index="${index}"><span class="segment-number">${String(index + 1).padStart(2, '0')}</span><div>${context ? `<small class="segment-course">${escapeHTML(context)}</small>` : ''}<strong>${escapeHTML(segment.title || '课程片段')}</strong><span>${clockSecond(segment.startSecond)} – ${clockSecond(segment.endSecond)} · ${secondDuration(segment.endSecond - segment.startSecond)}</span>${Number(segment.totalSeconds) > 0 ? `<small class="segment-source">原视频总时长 ${clockSecond(segment.totalSeconds)}</small>` : ''}</div></div>`;
  }).join('')}</div>`;
}

function taskDescription(task) {
  if (typeof task.sessionFocus === 'string' && task.sessionFocus.trim()) return `本次参考重点：${task.sessionFocus.trim()}`;
  const segments = taskLearningSegments(task);
  if (task.activity === 'video' || task.track === 'ls' && !task.activity) {
    if (segments.length === 1) return `观看区间 ${clockSecond(segments[0].startSecond)} – ${clockSecond(segments[0].endSecond)}`;
    if (segments.length > 1) return `${segments.length} 节课程 · 查看具体观看区间`;
  }
  if (task.steps?.length) return task.steps[0];
  if (task.deliverables?.length) return `交付：${task.deliverables[0]}`;
  const summary = taskDetailSummary(task);
  if (summary) return summary;
  if (segments.length === 1) return `观看区间 ${clockSecond(segments[0].startSecond)} – ${clockSecond(segments[0].endSecond)}`;
  if (segments.length > 1) return `${segments.length} 节课程 · 查看具体观看区间`;
  return activityLabel(task) || (task.track === 'ydy' ? '易道云项目实践' : '面试准备');
}

function taskDetailSummary(task) {
  const summary = String(task.summary || '').trim();
  if (summary.startsWith('本周目标：')) return summary.split('。')[0];
  if (/^(按标注的观看区间|先学习本周指定片段|本次用 40 分钟|本次只完成一个40分钟|40分钟只完成本项|周六前3小时|周六后2小时)/.test(summary)) return '';
  return summary;
}

function taskBudgetMarkup(task) {
  if (!task.budget) return '';
  const interview = task.track === 'review';
  const labels = [['videoMinutes', interview ? '题目与资料' : '课程观看'],
    ['practiceMinutes', interview ? '面试准备' : task.track === 'ls' && task.activity === 'review' ? '课程复盘' : '实践练习'],
    ['bufferMinutes', interview ? '整理要点' : '补漏缓冲']];
  const active = labels.map(([key, label]) => ({ minutes: Math.max(0, Number(task.budget[key]) || 0), label })).filter(item => item.minutes > 0);
  if (active.length < 2) return '';
  return `<section class="detail-budget" aria-label="本次时间预算"><div class="detail-section-head"><h4>时间分配</h4></div><dl class="budget-grid">${active.map(({ minutes, label }) => {
    const seconds = Math.round(minutes * 60);
    const wholeHours = seconds % 3600 === 0;
    const precise = seconds % 60 !== 0 || (seconds >= 3600 && !wholeHours);
    const value = precise ? formatDuration(minutes).replaceAll(' ', '').replace('分钟', '分') : formatMinutes(wholeHours ? minutes / 60 : minutes);
    return `<div class="budget-item"><dt>${label}</dt><dd${precise ? ' class="budget-precise"' : ''}>${value}${precise ? '' : `<span>${wholeHours ? '小时' : '分钟'}</span>`}</dd></div>`;
  }).join('')}</dl></section>`;
}

function taskStepsMarkup(task) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const deliverables = Array.isArray(task.deliverables) ? task.deliverables : [];
  const review = task.track === 'ls' && task.activity === 'review';
  const interview = task.track === 'review';
  const editableSteps = supportsPracticeProgress(task);
  return (steps.length && !editableSteps ? `<section class="detail-section detail-steps"><h4>${isExternalConfirmation(task) ? '沟通核对内容' : isCareerPreparation(task) ? '材料整理步骤' : interview ? '面试准备步骤' : review ? '复盘步骤' : '实践步骤'}</h4><ol>${steps.map(step => `<li>${escapeHTML(step)}</li>`).join('')}</ol></section>` : '')
    + (deliverables.length ? `<section class="detail-section detail-deliverables"><h4>${isExternalConfirmation(task) ? '沟通确认内容' : isCareerPreparation(task) ? '供老师沟通的材料' : interview ? '面试练习记录' : review ? '复盘记录' : '本次交付物'}</h4><ul>${deliverables.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></section>` : '');
}

function legacyTaskRecordMarkup(task, { readOnly = false } = {}) {
  const sources = legacyTaskRecords(task).filter(({ record }) => record.done || record.progress || record.evidence || Date.parse(record.updatedAt) > 0);
  if (!sources.length) return '';
  return `<section class="detail-section outline-content-section"><details><summary>重排前的学习记录 · ${sources.length} 项</summary>${sources.map(source => {
    const progress = normalizeTaskProgress(source.record.progress);
    const position = progress?.kind === 'video' && Number.isInteger(progress.positionSecond)
      ? `原第 ${(progress.segmentIndex ?? 0) + 1} 节 · ${clockSecond(progress.positionSecond)}` : '';
    const practice = legacyPracticeTaskById.has(source.task.id) || source.referenceOnly;
    const completed = new Set(progress?.kind === 'practice' ? progress.completedSteps || [] : []);
    const steps = practice ? `<ol>${(source.task.steps || []).map((step, index) => `<li>${source.record.done || completed.has(index) ? '已完成' : '未完成'} · ${escapeHTML(step)}</li>`).join('')}</ol>` : '';
    const worked = progress?.kind === 'practice' && Number.isInteger(progress.workedMinutes) ? ` · 原累计投入 ${progress.workedMinutes} 分钟` : '';
    const referenceHint = source.referenceOnly ? `<p class="detail-hint">${readOnly ? '原记录仅供追溯，不纳入当前计划的进度或完成门槛。' : source.task.activity === 'video' && task.activity === 'video' ? '旧版记录仅供追溯，不计入新版课程的观看进度或完成状态。' : '任务内容已调整，原记录仅供追溯，不计入当前任务的进度或完成状态；请按当前任务重新验收。'}</p>` : '';
    return `<article><h4>${escapeHTML(source.task.title)}</h4>${referenceHint}<p>${source.record.done ? '原任务已完成' : '原任务未完成'}${position ? ` · ${position}` : ''}${worked}</p>${recordUpdateMarkup(source.task, 'detail-hint')}${steps}${progress?.note ? `<p>${recordTextMarkup(progress.note)}</p>` : ''}${source.record.evidence ? `<p>${recordTextMarkup(source.record.evidence)}</p>` : ''}</article>`;
  }).join('')}</details></section>`;
}

function practiceRemainingMinutes(task) {
  return Math.max(0, Math.ceil(taskMinutes(task)) - Math.max(0, Number(taskProgress(task.id)?.workedMinutes) || 0));
}

function practiceSessionMinutes(task, date = todayISO()) {
  return practiceSuggestedMinutes(task, Math.max(0, Number(taskProgress(task.id)?.workedMinutes) || 0), date);
}

function practiceSuggestedMinutes(task, workedMinutes, date = todayISO()) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const session = taskWorkSessions(task).find(item => item.date === date);
  const group = careerPreparationGroup(task);
  const defaultLimit = group === 'project' ? 40 : group === 'skill' && day === 6
    ? taskWorkSessions(task).find(item => new Date(`${item.date}T00:00:00Z`).getUTCDay() === 6)?.minutes || taskMinutes(task)
    : day === 6 ? planRhythm().saturdayMinutes : planRhythm().afterCourseWeekdays.minutes;
  const limit = Math.min(session?.minutes || Infinity, defaultLimit);
  const plannedRemaining = Math.max(0, Math.ceil(taskMinutes(task)) - workedMinutes);
  return Math.min(limit, plannedRemaining || limit, practiceRecordingLimit(workedMinutes));
}

function taskProgressNote(task, includeCompleted = false) {
  if (taskDone(task.id) && !includeCompleted) return '';
  const progress = taskProgress(task.id);
  if (isExternalConfirmation(task)) return progress?.note?.trim() ? '已存沟通记录' : '';
  if (!progress) return '';
  if (progress.kind === 'video' && Number.isInteger(progress.segmentIndex) && Number.isInteger(progress.positionSecond)) {
    return `已存观看位置 · 第 ${progress.segmentIndex + 1} 节 ${clockSecond(progress.positionSecond)}`;
  }
  if (progress.kind === 'practice') {
    const minutes = Math.max(0, Number(progress.workedMinutes) || 0);
    const steps = Array.isArray(progress.completedSteps) ? progress.completedSteps.length : 0;
    if (minutes || steps) return `已投入 ${formatDuration(minutes)}${task.steps?.length ? ` · 步骤 ${steps} / ${task.steps.length}` : ''}`;
  }
  return progress.note?.trim() ? '已存学习记录' : '';
}

function progressConflictMarkup() {
  return `<div id="taskProgressConflict" class="progress-conflict" role="status" hidden><strong>此任务在其他设备有更新</strong><p>当前草稿还在。请选择载入同步进度，或明确保存本机草稿覆盖它。</p><div><button class="secondary-btn" type="button" data-progress-action="reload">载入同步进度</button><button class="danger-btn" type="button" data-progress-action="overwrite">保留草稿并覆盖</button></div></div>`;
}

function videoProgressMarkup(task) {
  const segments = taskLearningSegments(task);
  if (!segments.length) return '';
  const progress = taskProgress(task.id);
  const savedIndex = progress?.kind === 'video' && Number.isInteger(progress.segmentIndex) ? progress.segmentIndex : 0;
  const index = Math.min(Math.max(0, savedIndex), segments.length - 1);
  const segment = segments[index];
  const start = Math.max(0, Math.round(Number(segment.startSecond) || 0));
  const end = Math.max(start, Math.round(Number(segment.endSecond) || 0));
  const position = progress?.kind === 'video' && index === savedIndex && Number.isInteger(progress.positionSecond)
    ? Math.min(end, Math.max(start, progress.positionSecond)) : start;
  return `<section class="resume-progress" data-progress-kind="video" aria-labelledby="resumeProgressHeading"><div class="resume-progress-head"><h4 id="resumeProgressHeading">${taskDone(task.id) ? '编辑观看位置' : '下次从这里继续'}</h4></div><div class="video-progress-fields"><label for="videoSegmentSelect">课节<select id="videoSegmentSelect">${segments.map((item, itemIndex) => `<option value="${itemIndex}"${itemIndex === index ? ' selected' : ''}>${itemIndex + 1}. ${escapeHTML(item.title || '课程片段')}</option>`).join('')}</select></label><label for="videoPositionText">原视频时间点<input id="videoPositionText" type="text" inputmode="numeric" autocomplete="off" value="${clockSecond(position)}" aria-describedby="videoPositionHint"></label></div><p id="videoPositionHint" class="resume-help">本节范围 ${clockSecond(start)} – ${clockSecond(end)}，填原视频上的时间。</p><input id="videoPositionInput" type="range" min="${start}" max="${end}" step="1" value="${position}" aria-label="原视频观看位置"><div class="video-progress-scale"><span>${clockSecond(start)}</span><output id="videoPositionValue" for="videoPositionInput">${clockSecond(position)}</output><span>${clockSecond(end)}</span></div>${progressConflictMarkup()}<div class="progress-editor-actions"><button class="secondary-btn" type="button" data-progress-action="save-video" disabled>保存观看位置</button>${taskDone(task.id) ? '<button class="text-btn" type="button" data-progress-action="cancel-edit">取消编辑</button>' : ''}</div></section>`;
}

function practiceRecordingLimit(workedMinutes) {
  return Math.max(0, 100000 - workedMinutes);
}

function practiceProgressMarkup(task) {
  const progress = taskProgress(task.id);
  const worked = progress?.kind === 'practice' ? Math.max(0, Number(progress.workedMinutes) || 0) : 0;
  const completed = new Set(progress?.kind === 'practice' && Array.isArray(progress.completedSteps) ? progress.completedSteps : []);
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return `<section class="resume-progress" data-progress-kind="practice" aria-labelledby="resumeProgressHeading"><div class="resume-progress-head"><h4 id="resumeProgressHeading">${taskDone(task.id) ? '编辑实践记录' : '记录本次进度'}</h4></div><p id="practiceSessionLimitHint" class="resume-help">此前累计 ${formatDuration(worked)} · 建议本次 ${formatDuration(practiceSuggestedMinutes(task, worked))}，可按实际投入调整</p><label class="practice-session-field" for="practiceWorkedTotal">此前累计 <span><input id="practiceWorkedTotal" type="number" min="0" max="100000" step="1" value="${worked}" inputmode="numeric"> 分钟</span></label><label class="practice-session-field" for="practiceSessionMinutes">本次实际投入 <span><input id="practiceSessionMinutes" type="number" min="0" max="${practiceRecordingLimit(worked)}" step="1" value="0" inputmode="numeric" aria-describedby="practiceSessionLimitHint"> 分钟</span></label>${steps.length ? `<fieldset class="practice-step-list detail-steps"><legend>${isCareerPreparation(task) ? '材料核对步骤' : '已完成的实践步骤'}</legend><ol>${steps.map((step, index) => `<li><label><input type="checkbox" data-progress-step="${index}"${completed.has(index) ? ' checked' : ''}><span>${escapeHTML(step)}</span></label></li>`).join('')}</ol></fieldset>` : ''}<label class="practice-note-field" for="taskProgressNote">学习记录<textarea id="taskProgressNote" maxlength="1000" rows="3" placeholder="记下已验证的结果或下次要继续的地方">${escapeHTML(progress?.kind === 'practice' ? progress.note || '' : '')}</textarea></label>${progressConflictMarkup()}<div class="progress-editor-actions"><button class="secondary-btn" type="button" data-progress-action="save-practice" disabled>保存实践进度</button>${taskDone(task.id) ? '<button class="text-btn" type="button" data-progress-action="cancel-edit">取消编辑</button>' : ''}</div></section>`;
}

function updatePracticeSessionLimit() {
  const totalInput = $('practiceWorkedTotal');
  const sessionInput = $('practiceSessionMinutes');
  const task = taskById.get(detailTaskId);
  if (!totalInput || !sessionInput || !task) return;
  const worked = Number(totalInput.value);
  const valid = /^\d+$/.test(totalInput.value) && worked <= 100000;
  const limit = valid ? practiceRecordingLimit(worked) : 0;
  sessionInput.max = String(limit);
  $('practiceSessionLimitHint').textContent = valid
    ? `此前累计 ${formatDuration(worked)} · 建议本次 ${formatDuration(practiceSuggestedMinutes(task, worked))}，可按实际投入调整`
    : '此前累计须为 0–100000 的整数分钟';
}

function taskProgressReadOnlyMarkup(task) {
  const progress = taskProgress(task.id);
  const video = task.activity === 'video';
  let value;
  let steps = '';
  let note = '';
  if (video) {
    const index = Number.isInteger(progress?.segmentIndex) ? progress.segmentIndex : 0;
    const segment = progress?.kind === 'video' && taskLearningSegments(task)[index];
    value = segment && Number.isInteger(progress.positionSecond)
      ? `第 ${index + 1} 节 · 已保存至 ${clockSecond(progress.positionSecond)}` : '未单独保存观看位置';
  } else {
    const recorded = progress?.kind === 'practice';
    const completed = new Set(recorded ? progress.completedSteps || [] : []);
    const taskSteps = Array.isArray(task.steps) ? task.steps : [];
    value = recorded ? `已累计 ${formatDuration(Math.max(0, Number(progress.workedMinutes) || 0))}${taskSteps.length ? ` · 步骤 ${completed.size} / ${taskSteps.length}` : ''}` : '未保存分次记录';
    steps = taskSteps.length ? `<ol class="progress-readonly-steps${recorded ? '' : ' is-untracked'}">${taskSteps.map((step, index) => `<li${completed.has(index) ? ' class="is-recorded"' : ''}>${recorded ? `<span class="progress-step-status">${completed.has(index) ? '已记录' : '未记录'}</span>` : ''}<span>${escapeHTML(step)}</span></li>`).join('')}</ol>` : '';
    note = recorded && progress.note ? `<p class="progress-readonly-note">${recordTextMarkup(progress.note)}</p>` : '';
  }
  return `<section class="progress-readonly" aria-label="${video ? '观看记录' : '实践记录'}"><div class="progress-readonly-head"><h4>${video ? '观看记录' : '实践记录'}</h4><button id="editTaskProgressBtn" class="progress-edit-btn" type="button" data-progress-action="edit">编辑进度</button></div><p class="progress-readonly-value">${escapeHTML(value)}</p>${steps}${note}</section>`;
}

function externalConfirmationProgressMarkup(task) {
  const note = taskProgress(task.id)?.note || '';
  if (taskDone(task.id) && !detailProgressEditing) return `<section class="progress-readonly" aria-label="老师沟通记录"><div class="progress-readonly-head"><h4>老师沟通记录</h4><button id="editTaskProgressBtn" class="progress-edit-btn" type="button" data-progress-action="edit">编辑记录</button></div>${note ? `<p class="progress-readonly-note">${recordTextMarkup(note)}</p>` : '<p>尚未单独保存沟通说明</p>'}</section>`;
  return `<section class="resume-progress" data-progress-kind="external" aria-labelledby="resumeProgressHeading"><div class="resume-progress-head"><h4 id="resumeProgressHeading">老师沟通与简历确认记录</h4></div><p class="resume-help">记下沟通要点、老师的反馈或定制简历链接。保存记录不会自动确认完成，不计算老师等待时长。</p><label class="practice-note-field" for="taskProgressNote">沟通记录<textarea id="taskProgressNote" maxlength="1000" rows="5">${escapeHTML(note)}</textarea></label>${progressConflictMarkup()}<div class="progress-editor-actions"><button class="secondary-btn" type="button" data-progress-action="save-practice" disabled>保存沟通记录</button>${taskDone(task.id) ? '<button class="text-btn" type="button" data-progress-action="cancel-edit">取消编辑</button>' : ''}</div></section>`;
}

function taskProgressMarkup(task) {
  if (isExternalConfirmation(task)) return externalConfirmationProgressMarkup(task);
  if (isRelativeCareerTask(task) && careerTaskBlocked(task) && !taskProgress(task.id) && !taskDone(task.id)) return '<section class="detail-section"><h4>面试准备尚未开始</h4><p>先整理沟通材料，与易道云老师沟通并确认定制简历后，再记录这项面试准备。</p></section>';
  if (taskDone(task.id) && !detailProgressEditing && (task.activity === 'video' && taskLearningSegments(task).length || supportsPracticeProgress(task))) return taskProgressReadOnlyMarkup(task);
  if (task.activity === 'video') return videoProgressMarkup(task);
  if (supportsPracticeProgress(task)) return practiceProgressMarkup(task);
  return '';
}

function highlightSearchText(value, words) {
  if (!words.length) return escapeHTML(value);
  const pattern = words.slice().sort((a, b) => b.length - a.length).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return String(value || '').split(new RegExp(`(${pattern})`, 'giu')).map((part, index) => index % 2 ? `<mark class="search-hit">${escapeHTML(part)}</mark>` : escapeHTML(part)).join('');
}

function searchMatchMarkup(task, words) {
  const specific = words.filter(word => !['零声', '易道云', '项目', '课程', '课程计划', '项目深化', '作品打磨', '面试', '面试准备'].includes(word));
  if (!specific.length) return '';
  const matches = taskLearningSegments(task).map((segment, index) => ({ segment, index })).filter(({ segment }) =>
    specific.some(word => [segment.title, segment.chapterTitle, segment.courseTitle].filter(Boolean).join(' ').toLocaleLowerCase().includes(word)));
  if (matches.length) return `<div class="search-match-context"><span>匹配课节</span>${matches.slice(0, 2).map(({ segment, index }) => `<button type="button" data-task-action="details" data-detail-segment="${index}">${highlightSearchText(segment.title, words)}<small>${clockSecond(segment.startSecond)} – ${clockSecond(segment.endSecond)}</small></button>`).join('')}${matches.length > 2 ? `<small>另有 ${matches.length - 2} 节匹配 · 在详情中查看</small>` : ''}</div>`;
  const match = [
    ...(task.steps || []).map(text => ({ text, section: 'steps', label: '匹配步骤' })),
    ...(task.deliverables || []).map(text => ({ text, section: 'deliverables', label: '匹配成果' }))
  ].find(item => specific.some(word => item.text.toLocaleLowerCase().includes(word)));
  if (match && !taskDescription(task).includes(match.text)) return `<div class="search-match-context"><span>${match.label}</span><button type="button" data-task-action="details" data-detail-section="${match.section}">${highlightSearchText(match.text, words)}</button></div>`;
  if (task.summary && specific.some(word => task.summary.toLocaleLowerCase().includes(word)) && !specific.some(word => [task.title, taskDescription(task)].join(' ').toLocaleLowerCase().includes(word))) return `<div class="search-match-context"><span>匹配说明</span><p>${highlightSearchText(task.summary, words)}</p></div>`;
  return '';
}

function taskMarkup(task, expanded = false, words = [], context = {}) {
  const done = taskDone(task.id);
  const progressNote = taskProgressNote(task);
  const module = supportsPracticeProgress(task) && (taskWorkSessions(task).length > 0 || task.onDemand === true || isRelativeCareerTask(task));
  const blocked = isUnscheduledCareerTask(task) && careerTaskBlocked(task)
    || context.preview === true && isCareerPreparation(task) && !done;
  const awaitingReview = module && !done && taskMinutes(task) > 0 && !practiceRemainingMinutes(task);
  const weekdaySession = expanded && supportsPracticeProgress(task)
    && (module || isLearningWeekday(context.date || todayISO()));
  const prerequisites = expanded && !done ? unfinishedPrerequisites(task) : [];
  const session = weekdaySession && !done && !blocked ? practiceSessionMinutes(task, context.date) : 0;
  const duration = awaitingReview ? '待核对成果' : weekdaySession && !module ? `原任务总量 ${taskDuration(task)}` : taskDuration(task);
  return `<article class="task-card${done ? ' is-done' : ''}${task.track === 'ydy' ? ' is-project' : ''}${expanded ? ' is-focus today-task' : ''}" data-task-id="${escapeHTML(task.id)}">
    ${expanded ? '' : isExternalConfirmation(task) || blocked ? `<button class="check${done ? ' done' : ''}" type="button" data-task-action="details" aria-label="查看记录：${escapeHTML(displayTitle(task))}">${icon(done ? 'check' : 'edit')}</button>` : module ? `<button class="check${done ? ' done' : ''}" type="button" ${done || awaitingReview ? 'data-task-action="details"' : 'data-progress-action="record-session"'} aria-label="${done ? '查看模块记录' : awaitingReview ? '核对模块成果' : '记录本次学习'}：${escapeHTML(displayTitle(task))}">${icon(done ? 'check' : awaitingReview ? 'arrow' : 'edit')}</button>` : `<button class="check${done ? ' done' : ''}" type="button" data-task-action="toggle" aria-pressed="${done}" aria-label="${done ? '取消完成' : '完成打卡'}：${escapeHTML(displayTitle(task))}">${done ? icon('check') : ''}</button>`}
    <div class="task-content"><div class="task-meta"><span class="track ${task.track}">${escapeHTML(displayTrackName(task))}</span><span class="duration-chip">${escapeHTML(duration)}</span>${done ? '<span class="done-label">已完成</span>' : ''}</div>
    <button class="task-title" type="button" data-task-action="details">${highlightSearchText(displayTitle(task), words)}</button><p class="task-desc">${highlightSearchText(taskDescription(task), words)}</p>${words.length ? searchMatchMarkup(task, words) : ''}${progressNote ? `<p class="task-progress-note">${escapeHTML(progressNote)}</p>` : ''}${prerequisites.length ? `<p class="continue-prerequisite">${escapeHTML(prerequisiteWarning(task, todayISO(), prerequisites))}</p>` : ''}${courseAccessMarkup(task)}${expanded && !isRequiredTask(task) ? `<p class="detail-hint">${optionalTaskHint()}</p>` : ''}${expanded && task.track === 'ls' && task.activity !== 'practice' && task.segments?.length > 1 ? segmentMarkup(task) : ''}${isExternalConfirmation(task) || blocked ? expanded ? `<button class="primary" type="button" data-task-action="details">${isExternalConfirmation(task) ? '记录沟通与简历确认' : '查看前置要求'}${icon('arrow')}</button>` : '' : expanded && awaitingReview ? `<div class="focus-actions"><button class="primary" type="button" data-task-action="details" data-detail-section="deliverables">核对成果并完成模块${icon('arrow')}</button><button class="text-btn" type="button" data-progress-action="record-session">追加实际记录</button><p class="detail-hint">已达到暂估时长，请核对实际产物后确认完成；不会按累计时长自动打卡。</p></div>` : session ? `<div class="focus-actions"><button class="primary" type="button" data-progress-action="record-session">记录本次 ${formatDuration(session)}${icon('edit')}</button><button class="text-btn" type="button" data-task-action="details" data-detail-section="deliverables">核对成果${icon('arrow')}</button></div>` : expanded ? `<button class="primary" type="button" data-task-action="toggle" aria-pressed="${done}">${done ? '取消完成' : '完成打卡'}${icon(done ? 'check' : 'arrow')}</button>` : ''}</div>
    </article>`;
}

function render() {
  const focus = focusSnapshot();
  document.body.dataset.view = selectedView;
  for (const view of ['overview', 'planner', 'milestones']) $(view + 'View').hidden = view !== selectedView;
  for (const button of document.querySelectorAll('button[data-view]')) {
    const active = button.dataset.view === selectedView;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  renderSummary();
  renderToday();
  renderContinue();
  renderWeekPreview();
  renderPlanner();
  renderWeekList();
  renderMilestones();
  updateSyncUI();
  if ($('taskDialog').open && detailTaskId) {
    if (detailProgressDirty) updateTaskProgressConflict();
    else renderTaskDetails();
  }
  restoreFocus(focus);
  updateHistoryControls();
}

function progressTrackLabel(track) {
  return { ls: '零声课程', ydy: '易道云 / 项目', review: DATA.careerWorkflow ? '沟通材料与面试' : '面试准备' }[track] || '';
}

function normalizeProgressListScope(value) {
  if (!value || (value.phase !== 'all' && !planPhases.some(phase => phase.id === value.phase)) || !availableTracks.has(value.track)) return null;
  const project = typeof value.project === 'string' ? value.project : '';
  if (project && (value.track !== 'ydy' || !DATA.milestones.some(item => item.kind === 'project' && item.id === project))) return null;
  return { phase: value.phase, track: value.track, project };
}

function normalizeProgressReturn(value) {
  if (!value || !DATA.weeks.some(week => week.week === value.week)) return null;
  return { week: value.week, scroll: Number.isFinite(value.scroll) ? Math.max(0, value.scroll) : 0 };
}

function outlineScopeKey(scope = progressListScope) { return scope ? JSON.stringify(scope) : ''; }
function outlineStateKeyFor(context) { return JSON.stringify([context.scope, context.filter, context.track]); }
function outlineStateKey(scope = progressListScope, filter = taskFilter, track = trackFilter) {
  return scope ? outlineStateKeyFor({ scope: outlineScopeKey(scope), filter, track }) : '';
}

function restoreOutlinePreferences(saved) {
  if (!saved || !Array.isArray(saved.weeks) || !Array.isArray(saved.tasks)) return;
  let scope;
  try { scope = normalizeProgressListScope(JSON.parse(saved.scope)); } catch { return; }
  if (!scope || outlineScopeKey(scope) !== saved.scope) return;
  const filter = saved.filter === undefined ? taskFilter : saved.filter;
  const track = saved.track === undefined ? saved.scope === outlineScopeKey() ? trackFilter : scope.track : saved.track;
  if (!['all', 'pending', 'partial', 'done'].includes(filter) || !['all', scope.track].includes(track)) return;
  const context = { scope: saved.scope, filter, track };
  const key = outlineStateKeyFor(context);
  const tasks = progressScopeTasks(scope);
  const ids = new Set(tasks.map(task => task.id));
  const weeks = new Set(tasks.map(task => task.week));
  const openWeeks = saved.weeks.filter(week => Number.isInteger(week) && weeks.has(week));
  if (saved.weeks.length && !openWeeks.length) return;
  outlineContexts.set(key, context);
  outlineWeekStates.set(key, new Set(openWeeks));
  outlineTaskStates.set(key, new Set(saved.tasks.filter(id => ids.has(id))));
  if (Number.isFinite(saved.scroll) && saved.scroll >= 0) outlineScrollStates.set(key, saved.scroll);
  outlineCursorStates.set(key, ids.has(saved.cursor) ? saved.cursor : '');
}

function rememberOutlineWeeks() {
  const key = $('weekTasks').dataset.outlineState;
  if (!key || !$('weekTasks').querySelector('.outline-week-group')) return;
  outlineWeekStates.set(key, new Set(Array.from($('weekTasks').querySelectorAll('.outline-week-group[open]'), group => Number(group.dataset.resultWeek))));
  outlineTaskStates.set(key, new Set(Array.from($('weekTasks').querySelectorAll('.task-outline-content[open]'), item => item.dataset.outlineTaskId)));
  if (key === outlineStateKey()) outlineCursorStates.set(key, outlineCursorTaskId);
}

function restoreOutlineReadingPosition(action) {
  rememberOutlineWeeks(); saveOutlineScroll();
  const wasChanging = outlinePositionChanging;
  outlinePositionChanging = true;
  try {
    const result = action();
    // The outgoing page's scroll must not overwrite the destination reading position during render.
    if (selectedView === 'planner' && progressListScope) window.scrollTo({ top: outlineScrollStates.get(outlineStateKey()) || 0, behavior: 'instant' });
    return result;
  } finally { outlinePositionChanging = wasChanging; savePreferences(); }
}

function changeOutlineFilter(filter) {
  return restoreOutlineReadingPosition(() => {
    taskFilter = filter;
    renderPlanner();
  });
}

function outlineTasks() {
  return requiredTasks(Array.from($('weekTasks').querySelectorAll('.task-outline-item'), item => taskById.get(item.dataset.taskId)).filter(Boolean));
}

function updateOutlineControls() {
  const groups = Array.from($('weekTasks').querySelectorAll('.outline-week-group'));
  const tasks = outlineTasks();
  const partialCount = tasks.filter(task => taskOutlineState(task) === 'partial').length;
  const pendingCount = tasks.filter(task => !taskDone(task.id)).length;
  $('outlineNavigation').hidden = !progressListScope || !groups.length;
  $('outlineNextPartialBtn').hidden = !partialCount || partialCount === pendingCount;
  $('outlineNextPartialBtn').disabled = !partialCount;
  $('outlineNextPendingBtn').hidden = !pendingCount;
  $('outlineNextPendingBtn').disabled = !pendingCount;
  const expanded = groups.length > 0 && groups.every(group => group.open);
  $('outlineExpandAllBtn').textContent = expanded ? '收起全部' : '展开全部';
  $('outlineExpandAllBtn').setAttribute('aria-expanded', String(expanded));
  $('outlineExpandAllBtn').hidden = groups.length <= 1;
  $('outlineExpandAllBtn').disabled = groups.length === 0;
}

function locateOutlineTask(id) {
  const row = $('weekTasks').querySelector(`.task-outline-item[data-task-id="${CSS.escape(id)}"]`);
  if (!row) return;
  return changeLocation(() => {
    for (const group of $('weekTasks').querySelectorAll('.outline-week-group')) group.open = group === row.closest('.outline-week-group');
    row.closest('.outline-week-group').open = true;
    outlineCursorTaskId = id;
    $('outlineWeekSelect').value = String(taskById.get(id).week);
    row.scrollIntoView({ behavior: 'instant', block: 'center' });
    row.querySelector('.task-outline-title').focus({ preventScroll: true });
    rememberOutlineWeeks(); updateOutlineControls();
  }, { force: true });
}

function jumpToOutlineProgress(partial) {
  const tasks = outlineTasks();
  const start = tasks.findIndex(task => task.id === outlineCursorTaskId);
  const ordered = [...tasks.slice(start + 1), ...tasks.slice(0, start + 1)];
  const task = ordered.find(task => partial ? taskOutlineState(task) === 'partial' : !taskDone(task.id));
  if (task) locateOutlineTask(task.id);
}

function returnToProgressWeek() {
  const origin = progressListReturn || { week: selectedWeek, scroll: 0 };
  changeLocation(() => {
    resetPlannerFilters(); selectWeek(origin.week);
    window.scrollTo({ top: origin.scroll, behavior: 'instant' });
    plannerFocusTarget().focus({ preventScroll: true });
  });
}

function progressScopeTasks(scope) {
  const milestone = scope.project ? DATA.milestones.find(item => item.id === scope.project && item.kind === 'project') : null;
  const tasks = milestone ? milestoneTasks(milestone) : allTasks;
  return requiredTasks(tasks).filter(task => task.track === scope.track && (scope.phase === 'all' || phaseForWeek(task.week).id === scope.phase));
}

function onDemandTasksForScope(scope = { phase: selectedPhase, track: 'all', project: '' }) {
  const milestone = scope.project ? DATA.milestones.find(item => item.id === scope.project) : null;
  const projectIds = milestone ? new Set(milestone.taskIds || []) : null;
  return allTasks.filter(task => task.onDemand && !isRequiredTask(task)
    && (scope.phase === 'all' || (task.phaseId || phaseForWeek(task.week).id) === scope.phase)
    && (!scope.track || scope.track === 'all' || task.track === scope.track)
    && (!projectIds || projectIds.has(task.id)));
}

function onDemandTasksMarkup(tasks) {
  if (!tasks.length) return '';
  return `<section class="detail-section" data-on-demand-tasks><h3>按需补漏</h3><p class="detail-hint">发现对应缺口时再执行；没有缺口可不打卡。这些记录独立保存，不计入固定日程或必修完成门槛。</p>${tasks.map(task => taskMarkup(task, false)).join('')}</section>`;
}

function optionalExtensionsMarkup() {
  const extensions = Array.isArray(DATA.optionalExtensions) ? DATA.optionalExtensions.filter(item => item?.title) : [];
  if (!extensions.length) return '';
  return `<section class="detail-section" data-optional-extensions><details><summary>后续可选方向 · ${extensions.length} 个${icon('chevron')}</summary><p class="detail-hint">按求职方向和实际需要选择；这些内容不安排固定日期，不纳入本轮必修任务或求职准备门槛。</p>${extensions.map(extension => `<article data-optional-extension-id="${escapeHTML(extension.id)}"><h4>${escapeHTML(extension.title)}</h4>${extension.summary ? `<p>${escapeHTML(extension.summary)}</p>` : ''}${Array.isArray(extension.topics) && extension.topics.length ? `<ul>${extension.topics.map(topic => `<li>${escapeHTML(topic)}</li>`).join('')}</ul>` : ''}${legacyTaskRecordMarkup(extension, { readOnly: true })}${historicalMilestoneReviewsMarkup(extension, { readOnly: true })}</article>`).join('')}</details></section>`;
}

function careerWorkflowMarkup() {
  const workflow = careerWorkflowState();
  if (!workflow || !['all', 'review'].includes(trackFilter)) return '';
  const teacherStatus = workflow.teacherConfirmed ? '已确认' : !allLearningComplete() ? '先完成课程与项目'
    : workflow.preparationComplete ? '可以沟通' : '材料齐后进行';
  const interviewDone = workflow.interviews.filter(task => taskDone(task.id)).length;
  const sections = [
    { id:'teacher', title:'与老师沟通定制简历', status:teacherStatus, tasks:[workflow.teacher].filter(Boolean),
      hint:'提交四项目与技能材料，沟通并核对老师定制的简历。' },
    { id:'interviews', title:'面试准备', status:workflow.teacherConfirmed ? `${interviewDone} / ${workflow.interviews.length} 已完成` : '确认简历后开始', tasks:workflow.interviews,
      hint:'确认简历后，按顺序准备技术问答、项目讲解和模拟面试。' }
  ];
  return `<section class="career-next-sections" data-career-workflow>${sections.map(section => {
    const visible = section.tasks.filter(taskMatchesStatus);
    return `<details class="career-section" data-career-section="${section.id}"${careerOpenSections.has(section.id) ? ' open' : ''}><summary id="career-section-${section.id}"><span><strong>${section.title}</strong><small>${section.status}</small></span>${icon('chevron')}</summary><div class="career-section-body"><p class="detail-hint">${section.hint}</p>${visible.length ? `<div class="day-tasks">${visible.map(task => taskMarkup(task, false)).join('')}</div>` : '<p class="detail-hint">没有符合当前状态筛选的任务。</p>'}</div></details>`;
  }).join('')}</section>`;
}
function plannerSearchTasksMarkup(tasks, words) {
  const fixed = tasks.filter(task => !isUnscheduledCareerTask(task));
  const floating = tasks.filter(isUnscheduledCareerTask);
  return Array.from(new Set(fixed.map(task => task.date))).map(date => plannerDayMarkup(date, fixed.filter(task => task.date === date), false, words)).join('')
      + (floating.length ? `<section class="career-workflow"><h3>按沟通进度推进</h3>${floating.map(task => taskMarkup(task, false, words)).join('')}</section>` : '');
}

function onDemandSearchMarkup(tasks, words) {
  return tasks.length ? `<section class="detail-section" data-on-demand-search><h3>按需补漏</h3><p class="detail-hint">按实际缺口执行，无固定日期。</p>${tasks.map(task => taskMarkup(task, false, words)).join('')}</section>` : '';
}

function progressScopeLabel(scope) {
  return scope.project ? DATA.milestones.find(item => item.id === scope.project)?.name || progressTrackLabel(scope.track) : progressTrackLabel(scope.track);
}

function outlineWeekLabel(week, scope) {
  return scope.phase === 'all' ? `${phaseForWeek(week).label} · ${phaseWeekLabel(week)}` : phaseWeekLabel(week);
}

function progressCountButtons(scope, tasks, id) {
  const completed = tasks.filter(task => taskDone(task.id)).length;
  const projectAttribute = scope.project ? ` data-progress-project="${escapeHTML(scope.project)}"` : '';
  return `<span class="count"><button id="${id}" class="progress-completed-link" type="button" data-progress-completed="${scope.track}"${projectAttribute} aria-label="查看${escapeHTML(progressScopeLabel(scope))}的全部 ${completed} 项已打卡任务"${completed ? '' : ' disabled'}>${completed}<span class="sr-only"> 项已打卡</span></button><span aria-hidden="true">/</span><button id="${id.replace('-completed-', '-total-')}" class="progress-total-link" type="button" data-progress-total="${scope.track}"${projectAttribute} aria-label="查看${escapeHTML(progressScopeLabel(scope))}的全部 ${tasks.length} 项任务大纲和完成信息" title="全部任务大纲">${tasks.length}<span class="sr-only"> 项任务</span></button></span>`;
}

function openProgressList(track, project = '', filter = 'done', phase = selectedProgressPhase) {
  const scope = normalizeProgressListScope({ phase, track, project });
  if (!scope) return;
  const tasks = progressScopeTasks(scope);
  const first = filter === 'all' ? tasks[0] : tasks.find(task => taskDone(task.id));
  if (!first) return;
  const origin = progressListScope && progressListReturn || { week: selectedWeek, scroll: selectedView === 'planner' ? window.scrollY : 0 };
  changeLocation(() => restoreOutlineReadingPosition(() => {
    resetPlannerFilters(); selectWeek(first.week);
    progressListScope = scope; progressListReturn = origin; taskFilter = filter; trackFilter = track;
    outlineCursorTaskId = outlineCursorStates.get(outlineStateKey()) || '';
    render();
    plannerFocusTarget().focus({ preventScroll: true });
  }));
}

function openProgressRecords(track, project = '', phase = selectedProgressPhase) { openProgressList(track, project, 'done', phase); }
function openProgressOutline(track, project = '') { openProgressList(track, project, 'all'); }

function openProgressTarget(track, project = '') {
  const scope = normalizeProgressListScope({ phase: selectedProgressPhase, track, project });
  if (!scope) return;
  const tasks = progressScopeTasks(scope);
  const task = tasks.find(task => !taskDone(task.id));
  if (!task) { openProgressRecords(track, project); return; }
  changeLocation(() => {
    resetPlannerFilters(); trackFilter = track; selectWeek(task.week);
    focusPlannerTask(task.id);
  });
}

function renderSummary() {
  const phase = planPhases.find(item => item.id === selectedProgressPhase) || planPhases[0];
  const phaseTasks = requiredTasks().filter(task => phaseForWeek(task.week).id === phase.id);
  const done = phaseTasks.filter(task => taskDone(task.id)).length;
  const value = percent(done, phaseTasks.length);
  const required = requiredTasks();
  const overallDone = required.filter(task => taskDone(task.id)).length;
  const optional = allTasks.filter(task => !isRequiredTask(task));
  const projects = (DATA.milestones || []).filter(milestone => milestone.kind === 'project');
  const parallel = (DATA.milestones || []).filter(milestone => milestone.kind === 'parallel');
  $('pageTitle').textContent = { overview: '今日学习', planner: '学习计划', milestones: '关键里程碑' }[selectedView];
  $('pageSubtitle').textContent = selectedView === 'milestones'
    ? `${projects.length} 个项目目标 · ${parallel.length} 个课程与求职目标 · ${planPhases.map(phase => `${phase.label} ${phase.countLabel || `${phaseWeeks(phase).length} 周`}`).join('＋')}`
    : rhythmDescription(selectedView === 'planner' ? selectedWeekData() : currentWeek(), selectedView === 'planner' ? null : todayISO());
  if ($('allWeeksLabel')) $('allWeeksLabel').textContent = `${selectedPhaseData().label} · ${selectedPhaseData().countLabel || `全部 ${phaseWeeks().length} 周`}`;
  $('progressHeading').textContent = `${phase.label}进度`;
  $('progressPhaseSwitch').innerHTML = planPhases.map(item => `<button id="progress-phase-${escapeHTML(item.id)}" type="button" data-progress-phase="${escapeHTML(item.id)}" aria-pressed="${item.id === selectedProgressPhase}">${escapeHTML(item.label)}</button>`).join('');
  $('doneDays').textContent = done;
  $('totalDays').textContent = phaseTasks.length;
  $('overallProgressSummary').textContent = `全计划${optional.length ? '必修' : ''} ${overallDone} / ${required.length} 项 · ${percent(overallDone, required.length)}%${optional.length ? ` · ${optionalCompletionSummary(optional)}` : ''}`;
  $('progressPct').textContent = `${value}%`;
  $('progressPercentText').textContent = `${value}%`;
  $('progressBar').style.width = `${value}%`;
  $('progressBar').parentElement.setAttribute('aria-valuenow', value);
  $('progressBar').parentElement.setAttribute('aria-label', `${phase.label}任务完成进度`);
  const projectProgressOpen = $('projectProgressDetails')?.open || false;
  if ($('trackProgress')) $('trackProgress').innerHTML = [
    ['ls', allTasks.some(task => task.track === 'ls' && task.activity === 'review') ? '零声课程与复盘' : allTasks.some(task => task.track === 'ls' && task.activity === 'practice') ? '零声课程与练习' : '零声课程'],
    ['ydy', '易道云 / 项目'], ['review', DATA.careerWorkflow ? '沟通材料与面试' : '面试准备']
  ].filter(([track]) => phaseTasks.some(task => task.track === track)).map(([track, label]) => {
    const tasks = phaseTasks.filter(task => task.track === track);
    const completed = tasks.filter(task => taskDone(task.id)).length;
    const scope = { phase: phase.id, track, project: '' };
    const projectDetails = track === 'ydy' ? `<details id="projectProgressDetails" class="project-progress-details"${projectProgressOpen ? ' open' : ''}><summary>项目明细 ${icon('chevron')}</summary>${projects.map(project => {
      const projectScope = { ...scope, project: project.id };
      const projectTasks = progressScopeTasks(projectScope);
      if (!projectTasks.length) return '';
      const projectDone = projectTasks.filter(task => taskDone(task.id)).length;
      return `<div class="project-progress-row" data-progress-project-id="${escapeHTML(project.id)}"><button id="progress-project-${escapeHTML(project.id)}" class="progress-target" type="button" data-progress-project="${escapeHTML(project.id)}" title="定位${escapeHTML(project.name)}的任务">${escapeHTML(project.name)}</button>${progressCountButtons(projectScope, projectTasks, `progress-project-completed-${escapeHTML(project.id)}`)}<div class="track-meter" aria-hidden="true"><span style="width:${percent(projectDone, projectTasks.length)}%"></span></div></div>`;
    }).join('')}</details>` : '';
    return `<div class="track-progress-item ${track}"><div class="track-progress-label"><button id="progress-track-${track}" class="progress-target" type="button" data-progress-track="${track}" title="定位${escapeHTML(label)}的任务">${label}</button>${progressCountButtons(scope, tasks, `progress-completed-${track}`)}</div><div class="track-meter" aria-hidden="true"><span style="width:${percent(completed, tasks.length)}%"></span></div>${projectDetails}</div>`;
  }).join('');
  const date = todayISO();
  const visibleWeek = currentWeek();
  if ($('todayProgressSummary')) $('todayProgressSummary').innerHTML = `<button type="button" data-overview-jump="week">${date < DATA.weeks[0].start ? '首周' : date > DATA.weeks.at(-1).end ? openEndedCareerPhase() ? '材料参考周' : '末周' : '本周'} ${taskCompletionLabel(scheduledTasksForWeek(visibleWeek), '')}</button><span aria-hidden="true">·</span><button type="button" data-overview-jump="progress">${escapeHTML(phase.label)}打卡 ${done} / ${phaseTasks.length}</button>`;
  $('currentWeek').textContent = date < DATA.weeks[0].start ? '待开始' : date > DATA.weeks.at(-1).end ? openEndedCareerPhase() ? '求职按进度推进' : '学习期结束' : phaseWeekLabel(currentWeek());
  $('planNotes').innerHTML = (DATA.notes || []).map(note => `<p class="note">${escapeHTML(note)}</p>`).join('');
  const rhythm = planRhythm();
  $('planSummary').innerHTML = [
    ['零声首轮完课', formatDate(rhythm.zeroVoiceCompletionDate, true)],
    ['易道云课节完成', formatDate(rhythm.lessonCompletionDate, true)],
    ...(rhythm.practiceCompletionDate ? [['配套练习收尾', formatDate(rhythm.practiceCompletionDate, true)]] : []),
    ['全部课程最晚收尾', formatDate(rhythm.courseDeadline, true)],
    ...(rhythm.projectEndDate ? [['项目推进至', formatDate(rhythm.projectEndDate, true)]] : []),
    ...(rhythm.careerPreparationStartDate ? [['沟通材料参考周起', formatDate(rhythm.careerPreparationStartDate, true)]] : []),
    ...(rhythm.interviewStartDate && rhythm.interviewCompletionDate
      ? [['集中面试准备', `${formatDate(rhythm.interviewStartDate, true)} – ${formatDate(rhythm.interviewCompletionDate, true)}`]] : [])
  ].map(([label, value]) => `<div class="summary-item"><span class="summary-label">${label}</span><strong class="summary-value">${value}</strong></div>`).join('') + (DATA.completedProjects || []).map(project => `<div class="summary-item"><span class="summary-label">已完成项目</span><span class="badge done">${icon('check')}${escapeHTML(project.name)}</span></div>`).join('');
}

function renderToday() {
  const date = todayISO();
  const coursesClosed = date > planRhythm().courseDeadline;
  const before = date < DATA.weeks[0].start;
  const after = date > DATA.weeks.at(-1).end;
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  const weekend = day === 0 || day === 6;
  $('todayHeading').innerHTML = `<span class="section-index">01</span>${before ? '接下来学习' : '今日任务'}`;
  $('todayDate').textContent = `${formatDate(date)} · ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day]}`;
  const selection = todayLearningSelection(date);
  const tasks = selection.tasks;
  if (selection.redirected && (tasks.length || selection.pendingVideo)) $('todayHeading').innerHTML = `<span class="section-index">01</span>${selection.optional ? '机动续学' : '当前待学'}`;
  if (tasks.length) {
    const completed = tasks.every(task => taskDone(task.id));
    $('todayHint').textContent = selection.redirected
      ? `${selection.reason}显示当前待学内容，${tasks.some(isUnscheduledCareerTask) ? '安排' : '原计划'} ${[...new Set(tasks.map(task => taskPlanDateLabel(task)))].join('、')}。`
      : completed ? '今日任务已全部打卡。' : tasks.length > 1 ? `今日合计 ${formatDuration(totalTaskMinutes(tasks))} · ${tasks.length} 项任务` : '';
    $('todayHint').hidden = !$('todayHint').textContent;
    $('todayBox').innerHTML = tasks.map(task => taskMarkup(task, true, [], { date })).join('');
    return;
  }
  if (selection.redirected && selection.pendingVideo) {
    const lesson = selection.pendingVideo;
    const reminder = pendingCourseReminder(lesson, date);
    $('todayHint').textContent = selection.reason;
    $('todayHint').hidden = false;
    $('todayBox').innerHTML = `<article class="focus-preview is-rest"><div class="focus-context"><span class="focus-status">${selection.blockedProjects.length ? '前一项目尚未完成' : '前置课程尚未完成'}</span></div><h3 class="focus-title">${escapeHTML(reminder.title)}</h3><p class="focus-description">${escapeHTML(reminder.description)}原计划 ${formatDate(lesson.date, true)}。</p><div class="focus-actions"><button class="primary" type="button" data-week="${lesson.week}" data-track="ydy">查看未完成课节与记录${icon('arrow')}</button></div></article>`;
    return;
  }
  const period = DATA.specialPeriods?.find(period => period.start <= date && date <= period.end);
  $('todayHint').textContent = after && openEndedCareerPhase() ? '固定材料参考周已过，老师沟通与面试仍按实际进度推进。' : after ? `计划已于 ${formatDate(DATA.weeks.at(-1).end, true)}结束；待补任务请在下方“继续学习”中查看。`
    : before ? `${formatDate(DATA.weeks[0].start)}开始`
    : day === 0 ? ''
    : day === 6 && allLearningComplete() && DATA.careerWorkflow?.projectPreparationTaskIds?.length ? '周六可整理技能材料；技能整理完成后也可继续项目梳理。' : day === 6 ? '周六用于易道云课程和项目，继续学习可查看尚未完成的内容。'
    : '';
  $('todayHint').hidden = !$('todayHint').textContent;
  // Calendar-free days remain unassigned; backlog and ahead-of-plan work belong to Continue.
  const next = before && !weekend ? requiredTasks().find(task => !taskDone(task.id)) : null;
  if (next) {
    $('todayBox').innerHTML = `<article class="focus-preview" data-task-id="${escapeHTML(next.id)}"><div class="focus-context"><span class="focus-status">${before ? '计划待开始' : '下一项待完成'}</span><span>${formatDate(next.date)} · ${next.day}</span></div><h3 class="focus-title">${escapeHTML(displayTitle(next))}</h3><div class="focus-meta"><span class="track ${next.track}">${escapeHTML(displayTrackName(next))}</span><span class="duration-chip">${escapeHTML(taskDuration(next))}</span></div><p class="focus-description">${escapeHTML(taskDescription(next))}</p><div class="focus-actions"><button class="primary" type="button" data-task-action="details">${next.track === 'ls' && (!next.activity || next.activity === 'video') ? '查看课程详情' : '查看任务详情'}${icon('arrow')}</button><button class="text-btn" type="button" data-week="${next.week}">查看整周安排 <span aria-hidden="true">→</span></button></div></article>`;
  } else {
    const title = after ? '今天没有固定任务' : day === 0 ? '周日机动' : requiredTasks().every(task => taskDone(task.id)) ? '本轮学习安排已完成' : period?.title || '今天没有固定任务';
    const description = after && openEndedCareerPhase() ? '可以继续整理沟通材料、记录老师反馈，或在简历确认后准备面试。' : after ? '课程与项目排期已结束；下方仍可按实际进度补学。'
      : weekend ? `可以继续易道云${coursesClosed ? '项目' : '课程或项目'}，也可以休息；不安排零声。`
      : period ? `${formatDate(period.start)} – ${formatDate(period.end)} · ${period.title}` : '在学习计划中查看课程、复盘和项目记录。';
    $('todayBox').innerHTML = `<article class="focus-preview is-rest"><div class="focus-context"><span class="focus-status">${after ? '无固定排期' : weekend ? '无固定任务' : '学习回顾'}</span></div><h3 class="focus-title">${escapeHTML(title)}</h3><p class="focus-description">${escapeHTML(description)}</p><div class="focus-actions"><button class="primary" type="button" data-week="${currentWeek().week}"${weekend && !after ? ' data-track="ydy"' : ''}>${after ? '查看最后一周' : weekend ? '查看本周项目' : '查看学习计划'}${icon('arrow')}</button></div></article>`;
  }
}

function projectLearningGroup(task) {
  return task?.projectId?.startsWith('studio-') ? 'studio-course' : task?.projectId || '';
}

function projectLearningName(id) {
  return { yibo: '易播', yunzhujiao: '云助教', 'studio-course': 'Course Studio' }[id] || id;
}

function projectLearningOrder() {
  return DATA.projectLearningScope?.length
    ? DATA.projectLearningScope.map(project => typeof project === 'string' ? project : project.projectId)
    : ['yibo', 'yunzhujiao', 'studio-course'];
}

function serialProjectNotice(activeProject) {
  const order = projectLearningOrder();
  const nextProject = order[order.indexOf(activeProject) + 1];
  return nextProject ? `先完成${projectLearningName(activeProject)}，再进入${projectLearningName(nextProject)}。`
    : `先完成${projectLearningName(activeProject)}的当前任务。`;
}

function courseAccessState(task, date = todayISO()) {
  if (task?.track !== 'ydy' || task.activity !== 'video' || taskDone(task.id)) return null;
  const project = projectLearningGroup(task);
  const scope = (DATA.projectLearningScope || []).find(item => typeof item === 'object' && item.projectId === project);
  const expiresAt = String(scope?.expiresAt || planRhythm().courseAccessDeadline || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return null;
  const daysRemaining = Math.round((Date.parse(`${expiresAt}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const nextSaturday = dateAt(date, (6 - day + 7) % 7);
  const expired = date > expiresAt;
  return { project, expiresAt, daysRemaining, expired, expiresBeforeSaturday: !expired && expiresAt < nextSaturday };
}

function courseAccessMessage(task, date = todayISO()) {
  const access = courseAccessState(task, date);
  if (!access) return '';
  const end = formatDate(access.expiresAt, true);
  return access.expired
    ? `平台课程已于 ${end} 到期，请先确认能否继续访问；如已保存笔记、代码或课程资料，可继续核对和复习。`
    : `平台课程有效至 ${end}${access.daysRemaining === 0 ? '，今天是最后一天' : ''}；请在有效期内完成未学课节。`;
}

function courseAccessMarkup(task, date = todayISO()) {
  const access = courseAccessState(task, date);
  return access ? `<p class="continue-prerequisite" data-course-access="${access.expired ? 'expired' : 'active'}" data-expires-at="${access.expiresAt}">${escapeHTML(courseAccessMessage(task, date))}</p>` : '';
}

function pendingCourseReminder(task, date = todayISO()) {
  const access = courseAccessState(task, date);
  return access?.expired ? { title: '平台课程已到期', description: courseAccessMessage(task, date) }
    : access?.expiresBeforeSaturday ? { title: '课程即将到期，请先确认补课安排', description: `${courseAccessMessage(task, date)}本周六已超过有效期，不自动改排工作日视频。` }
      : { title: '待补课程留到周六', description: `${projectLearningName(projectLearningGroup(task))}还有课程未打卡，工作日不自动改排视频。${courseAccessMessage(task, date)}` };
}

function activeProjectLearningGroup() {
  return projectLearningOrder().find(project => requiredLearningTasks().some(task => task.track === 'ydy'
    && projectLearningGroup(task) === project && !taskDone(task.id))) || '';
}

function serialProjectTasks(tasks, activeProject = activeProjectLearningGroup()) {
  return activeProject ? tasks.filter(task => task.track !== 'ydy' || projectLearningGroup(task) === activeProject) : tasks;
}

function todayLearningSelection(date = todayISO()) {
  const scheduled = scheduledTasksForDate(date, requiredTasks());
  const activeProject = activeProjectLearningGroup();
  const order = projectLearningOrder();
  const blockedProjects = [...new Set(scheduled.filter(task => task.track === 'ydy'
    && activeProject && order.indexOf(projectLearningGroup(task)) > order.indexOf(activeProject)).map(projectLearningGroup))];
  const weekday = isLearningWeekday(date);
  const learningComplete = allLearningComplete();
  const calendar = calendarWeek(date);
  const optionalStudyWeekday = weekday && calendar && phaseForWeek(calendar).id !== 'career'
    && (!scheduled.length || date >= planRhythm().weekdayTransitionDate);
  // Sunday and genuinely free study days stay optional. Finishing all learning
  // ahead of schedule may bring career preparation forward on a weekday.
  const preparationSaturday = new Date(`${date}T00:00:00Z`).getUTCDay() === 6 && learningComplete
    && DATA.careerWorkflow?.projectPreparationTaskIds?.length && !careerWorkflowState()?.preparationComplete;
  if (!scheduled.length && !(weekday && (learningComplete || optionalStudyWeekday)) && !preparationSaturday) return { tasks: scheduled, activeProject, blockedProjects };
  if (weekday) {
    const track = defaultContinueTrack(date);
    const recommendation = learningRecommendation(track, date);
    const next = recommendation.next;
    const tasks = next ? [recommendedSessionTask(next, date)] : [];
    const redirected = !next || scheduled.length !== 1 || scheduled[0]?.id !== next.id;
    const optional = !scheduled.length && !learningComplete;
    return { tasks, activeProject, blockedProjects, redirected, optional,
      reason: (optional ? `今天没有固定任务，可机动续学约 ${formatDuration(planRhythm().afterCourseWeekdays.minutes)}。` : '') + (track === 'ls' ? '先完成零声课程，再进入工作日项目。'
        : track === 'ydy' ? blockedProjects.length ? serialProjectNotice(activeProject)
          : '先完成当前项目及前置任务；全部学习完成后再准备面试求职。'
          : DATA.careerWorkflow ? `${careerRhythmDescription()}。` : '课程与必修项目已完成，进入统一面试求职准备。'),
      pendingVideo: recommendation.pendingVideo };
  }
  if (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 && learningComplete
      && DATA.careerWorkflow?.projectPreparationTaskIds?.length) {
    const recommendation = learningRecommendation('review', date);
    const next = recommendation.next;
    const sameDaySkills = careerPreparationGroup(next) === 'skill' ? scheduled.filter(task => careerPreparationGroup(task) === 'skill'
      && !taskDone(task.id) && recommendation.eligibleTasks.some(eligible => eligible.id === task.id)) : [];
    const nextTasks = [...new Map([next, ...sameDaySkills].filter(Boolean).map(task => [task.id, task])).values()];
    const optional = !scheduled.some(task => isCareerPreparation(task) && !taskDone(task.id));
    return { tasks: nextTasks.map(task => recommendedSessionTask(taskById.get(task.id), date)), activeProject, blockedProjects, optional,
      redirected: true, reason: `${optional ? '今天没有固定的材料任务，可机动续学。' : ''}${careerRhythmDescription()}。` };
  }
  if (scheduled.some(task => task.track === 'review') && !learningComplete) {
    const recommendation = learningRecommendation('ydy', date);
    const next = recommendation.next;
    return { tasks: next ? recommendation.eligibleTasks.filter(task => !taskDone(task.id) && task.date === next.date).map(task => recommendedSessionTask(task, date)) : [],
      activeProject, blockedProjects, redirected: true,
      reason: '先完成全部课程与必修项目，再集中准备面试求职。', pendingVideo: recommendation.pendingVideo };
  }
  const scheduledIds = new Set(scheduled.map(task => task.id));
  const blockedPrerequisites = scheduled.some(task => task.track === 'ydy'
    && unfinishedPrerequisites(task).some(prerequisite => !scheduledIds.has(prerequisite.id)));
  if (!blockedProjects.length && !blockedPrerequisites) return { tasks: scheduled, activeProject, blockedProjects };
  const recommendation = learningRecommendation('ydy', date);
  const retained = scheduled.filter(task => task.track !== 'ydy');
  const pending = recommendation.eligibleTasks.filter(task => !taskDone(task.id));
  const replacement = weekday ? [recommendation.next].filter(Boolean)
    : pending.length ? pending.filter(task => task.date === pending[0].date) : [];
  const tasks = [...new Map([...retained, ...replacement.map(task => recommendedSessionTask(task, date))].map(task => [task.id, task])).values()];
  return { tasks, activeProject, blockedProjects, redirected: true,
    reason: blockedProjects.length ? serialProjectNotice(activeProject) : '先完成前置任务，再继续后续安排。',
    pendingVideo: recommendation.pendingVideo };
}

function isLearningWeekday(date = todayISO()) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function learningRecommendation(track, date = todayISO()) {
  const tasks = requiredTasks().filter(task => task.track === track);
  const eligibleTasks = track === 'ydy' ? serialProjectTasks(tasks)
    : track === 'review' ? tasks.filter(task => !unfinishedPrerequisites(task).length) : tasks;
  const projectPractice = track === 'ydy' && isLearningWeekday(date);
  const blockedByLearning = track === 'review' && !allLearningComplete();
  return { tasks, eligibleTasks, projectPractice,
    blockedByLearning,
    next: blockedByLearning ? undefined : projectPractice ? nextProjectPractice(eligibleTasks)
      : track === 'review' ? nextCareerTask(eligibleTasks, date) : eligibleTasks.find(task => !taskDone(task.id)),
    pendingVideo: eligibleTasks.find(task => !taskDone(task.id) && task.activity === 'video') };
}

function allLearningComplete() {
  return requiredLearningTasks().every(task => taskDone(task.id));
}

function applicationReadiness() {
  const configured = DATA.applicationMilestone?.readinessTaskIds;
  const ids = Array.isArray(configured) && configured.length ? [...new Set(configured)]
    : requiredTasks().filter(task => task.track === 'review').map(task => task.id);
  const tasks = ids.map(id => taskById.get(id)).filter(Boolean);
  const completed = tasks.filter(task => taskDone(task.id)).length;
  const learningComplete = allLearningComplete();
  return { tasks, completed, learningComplete, ready: learningComplete && tasks.length === ids.length
    && tasks.length > 0 && completed === tasks.length && tasks.every(task => !unfinishedPrerequisites(task).length) };
}

function prerequisiteWarning(task, date = todayISO(), prerequisites = unfinishedPrerequisites(task)) {
  const unavailableVideo = prerequisites.find(item => courseAccessState(item, date)?.expired);
  if (unavailableVideo) return `${prerequisites.length} 项前置任务待完成；${courseAccessMessage(unavailableVideo, date)}`;
  const expiringVideo = prerequisites.find(item => courseAccessState(item, date)?.expiresBeforeSaturday);
  if (expiringVideo) return `${prerequisites.length} 项前置任务待完成；${pendingCourseReminder(expiringVideo, date).description}`;
  const video = prerequisites.find(item => item.activity === 'video');
  return task.track === 'ydy' && isLearningWeekday(date) && video
    ? `${prerequisites.length} 项前置任务尚未打卡，建议周六先补前置课节；已有基础时也可继续实践。${courseAccessMessage(video, date)}`
    : `${prerequisites.length} 项前置任务待完成，建议先完成前置任务。`;
}

function defaultContinueTrack(date = todayISO()) {
  if (allLearningComplete()) return 'review';
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return 'ydy';
  if (requiredLearningTasks().some(task => task.track === 'ls' && !taskDone(task.id))) return 'ls';
  return 'ydy';
}

function unfinishedPrerequisites(task, completedTasks = new Map()) {
  const visited = new Set([task.id]);
  const unfinished = [];
  const visit = current => {
    for (const id of new Set([...(current.prerequisiteTaskIds || []), ...(isRelativeCareerTask(current) && current.anchorTaskId ? [current.anchorTaskId] : [])])) {
      if (visited.has(id)) continue;
      visited.add(id);
      const prerequisite = taskById.get(id);
      if (!prerequisite) continue;
      // Optional repair work never becomes an implicit compulsory gate through
      // another task's dependency list. Its records remain independently editable.
      if (!isRequiredTask(prerequisite)) continue;
      // A manually completed gate does not imply its earlier work is complete.
      if (!completedTasks.has(id)) completedTasks.set(id, taskDone(id));
      if (!completedTasks.get(id)) unfinished.push(prerequisite);
      visit(prerequisite);
    }
  };
  visit(task);
  return unfinished;
}

function nextProjectPractice(tasks) {
  const pending = serialProjectTasks(requiredTasks(tasks)).filter(task => !taskDone(task.id));
  // Engineering review and handoff remain real work before the next phase,
  // even when videos and exercises were checked in ahead of schedule.
  const work = pending.filter(task => ['practice', 'deepening', 'buffer'].includes(task.activity));
  const phase = planPhases.find(item => work.some(task => phaseForWeek(task.week).id === item.id));
  const candidates = phase ? work.filter(task => phaseForWeek(task.week).id === phase.id) : [];
  const completedTasks = new Map();
  return candidates.find(task => !unfinishedPrerequisites(task, completedTasks).length) || candidates[0];
}

function renderContinue() {
  const date = todayISO();
  if (date !== continueChoiceDate) { continueChoiceDate = date; continueTrackChoice = null; }
  const selected = continueTrackChoice || defaultContinueTrack(date);
  const sources = [['ls', '零声'], ['ydy', '易道云 / 项目'], ['review', DATA.careerWorkflow ? '求职准备' : '面试']].filter(([track]) => availableTracks.has(track));
  $('continueTrackTabs').innerHTML = sources.map(([track, label]) => `<button id="continue-track-${track}" type="button" data-continue-track="${track}" aria-pressed="${track === selected}">${label}</button>`).join('');
  const { tasks, eligibleTasks, projectPractice, next, blockedByLearning } = learningRecommendation(selected, date);
  if (blockedByLearning) {
    $('continueBox').innerHTML = `<div class="continue-complete"><span class="continue-complete-icon">${icon('book')}</span><div><h3>全部学习完成后再准备面试求职</h3><p>先完成零声课程与全部必修项目；已有记录仍可查看和修正。</p></div>${tasks[0] ? `<button class="text-btn" type="button" data-week="${tasks[0].week}" data-track="review">查看求职安排 <span aria-hidden="true">→</span></button>` : ''}${tasks.some(task => taskDone(task.id)) ? '<button class="text-btn" type="button" data-continue-records="review">查看已有记录 <span aria-hidden="true">→</span></button>' : ''}</div>`;
    return;
  }
  if (!next) {
    const lesson = projectPractice && eligibleTasks.find(task => !taskDone(task.id) && task.activity === 'video');
    if (lesson) {
      const reminder = pendingCourseReminder(lesson, date);
      $('continueBox').innerHTML = `<div class="continue-complete"><span class="continue-complete-icon">${icon('calendar')}</span><div><h3>${escapeHTML(reminder.title)}</h3><p>${escapeHTML(reminder.description)}</p></div><button class="text-btn" type="button" data-week="${lesson.week}" data-track="ydy">查看未完成课节与记录 <span aria-hidden="true">→</span></button></div>`;
      return;
    }
    $('continueBox').innerHTML = `<div class="continue-complete"><span class="continue-complete-icon">${icon('check')}</span><div><h3>这一方向已全部打卡</h3><p>可以切换上方方向，或回看已完成的任务。</p></div>${tasks[0] ? `<button class="text-btn" type="button" data-continue-records="${selected}">查看记录 <span aria-hidden="true">→</span></button>` : ''}</div>`;
    return;
  }
  if ($('todayBox').querySelector(`[data-task-id="${CSS.escape(next.id)}"]`)) {
    $('continueBox').innerHTML = `<div class="continue-inline-status"><span>当前待学：上方${date < DATA.weeks[0].start ? '课程' : '今日任务'}</span><button class="text-btn" type="button" data-continue-today="${escapeHTML(next.id)}">前往任务 <span aria-hidden="true">↑</span></button></div>`;
    return;
  }
  const module = taskWorkSessions(next).length > 0 || isRelativeCareerTask(next);
  const timingCode = isUnscheduledCareerTask(next) ? 'event' : taskPlanEnd(next) < date ? 'late' : taskPlanStart(next) > date ? 'ahead' : 'today';
  const timing = timingCode === 'event' ? isExternalConfirmation(next) ? '沟通待确认' : '沟通后安排' : timingCode === 'late' ? '待补' : timingCode === 'ahead' ? '可提前' : module ? '模块续学' : '今日原定';
  const missed = eligibleTasks.filter(task => !isUnscheduledCareerTask(task) && !taskDone(task.id) && taskPlanEnd(task) < date).length;
  const prerequisites = unfinishedPrerequisites(next);
  const unmet = prerequisites.length;
  const prerequisiteNote = prerequisiteWarning(next, date, prerequisites);
  const weekdaySession = supportsPracticeProgress(next) && (projectPractice || module);
  const session = weekdaySession ? practiceSessionMinutes(next, date) : 0;
  const worked = weekdaySession ? Math.max(0, Number(taskProgress(next.id)?.workedMinutes) || 0) : 0;
  const progressNote = taskProgressNote(next);
  const sessionProgressNote = !worked && progressNote ? progressNote : `已累计 ${formatDuration(worked)}`;
  const reviewOutputs = weekdaySession && !practiceRemainingMinutes(next);
  const displayedDuration = reviewOutputs ? '待核对成果' : module ? taskDuration(recommendedSessionTask(next, date))
    : `${weekdaySession ? '原任务总量 ' : ''}${taskDuration(next)}`;
  $('continueBox').innerHTML = `<article class="continue-task" data-task-id="${escapeHTML(next.id)}"><div class="continue-task-top"><span class="track ${selected}">${escapeHTML(displayTrackName(next))}</span><span class="continue-timing" data-timing="${timingCode}">${timing}</span></div><h3 class="continue-title">${escapeHTML(displayTitle(next))}</h3><p class="continue-desc">${escapeHTML(taskDescription(next))}</p><div class="continue-meta"><span>${isUnscheduledCareerTask(next) ? '' : '原计划 '}${taskPlanDateLabel(next)} · ${escapeHTML(displayedDuration)}</span>${missed ? `<span>${missed} 项早于今天待补</span>` : ''}</div>${weekdaySession ? `<p class="continue-session-note">${escapeHTML(sessionProgressNote)}${practiceRemainingMinutes(next) ? '' : ' · 已达到计划时长，核对交付物后完成打卡'}</p>` : progressNote ? `<p class="continue-session-note">${escapeHTML(progressNote)}</p>` : ''}${unmet ? `<p class="continue-prerequisite">${escapeHTML(prerequisiteNote)}</p>` : ''}${courseAccessMarkup(next, date)}<div class="continue-actions"><button class="primary-btn" type="button" data-task-action="details"${reviewOutputs ? ' data-detail-section="deliverables"' : ''}>${reviewOutputs ? '核对成果' : '查看任务详情'} ${icon('arrow')}</button>${isExternalConfirmation(next) ? '' : weekdaySession && session ? `<button class="secondary-btn" type="button" data-progress-action="record-session">${reviewOutputs ? '追加实际记录' : `记录本次 ${formatDuration(session)}`}</button>` : `<button class="secondary-btn" type="button" data-task-action="toggle">${weekdaySession ? '核对后完成打卡' : '完成打卡'}</button>`}<button class="text-btn" type="button" data-week="${next.week}" data-track="${selected}" data-plan-task="${escapeHTML(next.id)}">${isUnscheduledCareerTask(next) ? '查看求职流程' : '查看原计划周'} <span aria-hidden="true">→</span></button></div></article>`;
}

function renderWeekPreview() {
  const week = currentWeek();
  const scheduled = scheduledTasksForWeek(week);
  const date = todayISO();
  const before = date < DATA.weeks[0].start;
  const after = date > DATA.weeks.at(-1).end;
  $('weeklyHeading').textContent = before ? '第一周预览' : after && openEndedCareerPhase() ? '材料参考周' : after ? '最后一周回顾' : '本周一览';
  $('weekDoneLabel').textContent = before ? '首周完成' : after && openEndedCareerPhase() ? '材料周完成' : after ? '末周完成' : '本周完成';
  $('weeklyPlanBtn').innerHTML = `${before ? '查看第一周计划' : after && openEndedCareerPhase() ? '查看材料参考周' : after ? '查看最后一周' : '查看本周计划'} <span aria-hidden="true">→</span>`;
  $('previewWeekLabel').textContent = `${phaseWeekLabel(week)} · ${week.range}`;
  $('overviewWeekCaption').innerHTML = weekTopicsMarkup(week);
  $('weekDoneCount').textContent = taskCompletionLabel(scheduled, '');
  $('overviewWeekPreview').innerHTML = Array.from({ length: 7 }, (_, index) => {
    const day = dateAt(week.start, index);
    const tasks = scheduled.filter(task => task.date === day);
    const fixed = requiredTasks(tasks);
    const optional = tasks.filter(task => !isRequiredTask(task));
    const done = fixed.length > 0 && fixed.every(task => taskDone(task.id));
    const tracks = new Set(tasks.map(task => task.track));
    const label = !tasks.length ? index === 6 ? '周日机动' : '无固定任务' : !fixed.length ? '按需补漏' : tasks.length > 1 && tracks.size > 1 ? '学习与项目'
      : tracks.has('ls') ? tasks.every(task => task.activity === 'review') ? '零声复盘' : '零声课程'
      : tracks.has('ydy') ? '易道云 / 项目' : tracks.has('review') ? '面试准备' : '其他安排';
    const minutes = totalTaskMinutes(fixed);
    const shortLabel = !tasks.length ? index === 6 ? '机动' : '空闲' : !fixed.length ? '按需' : tracks.size > 1 ? '混合'
      : tracks.has('ls') ? tasks.every(task => task.activity === 'review') ? '复盘' : '零声'
      : tracks.has('ydy') ? '项目' : tracks.has('review') ? '面试' : '其他';
    return `<button class="preview-day${day === date ? ' is-today' : ''}${done ? ' is-done' : ''}${index >= 5 ? ' is-weekend' : ''}" type="button" data-preview-day="${day}" aria-label="查看${formatDate(day)}的安排，${label}，${fixed.length ? `${fixed.length}项，固定${formatDuration(minutes)}${done ? '，已完成' : ''}` : '无固定任务'}${optional.length ? `，另有${optional.length}项按需补漏` : ''}"><span class="preview-weekday">${['一', '二', '三', '四', '五', '六', '日'][index]}</span><strong class="preview-date">${Number(day.slice(8))}</strong><span class="preview-dot ${fixed[0]?.track || tasks[0]?.track || 'rest'}" aria-hidden="true"></span><span class="preview-title"><span class="preview-title-full">${label}</span><span class="preview-title-short" aria-hidden="true">${shortLabel}</span></span><span class="preview-meta">${done ? '已完成' : fixed.length ? formatDuration(minutes) : optional.length ? '按需执行' : '不固定排课'}</span></button>`;
  }).join('');
}

function plannerDayMarkup(date, tasks, showRest = false, words = [], context = {}) {
  if (!tasks.length && !showRest) return '';
  const day = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(date + 'T00:00:00Z').getUTCDay()];
  return `<div class="day-group" id="day-${date}"><div class="day-heading"><div><strong class="day-label">${day}</strong><span class="day-caption">${formatDate(date)}</span>${date === todayISO() ? '<span class="badge">今天</span>' : ''}</div><span class="day-count">${tasks.length ? taskCompletionLabel(tasks, '') : '弹性安排'}</span></div><div class="day-tasks">${tasks.length ? tasks.map(task => taskMarkup(task, false, words, { ...context, date })).join('') : `<p class="rest-day">${context.careerPlan ? '周日机动，可继续整理材料或休息。' : '周日机动，不排固定任务。可以继续易道云项目或休息，不安排零声。'}</p>`}</div></div>`;
}

function taskSearchText(task) {
  const week = DATA.weeks.find(item => item.week === task.week);
  const lessons = (task.segments || []).map(segment => {
    const lesson = lessonById.get(segment.lessonId);
    return lesson ? `${lesson.title} ${lesson.theme}` : '';
  }).join(' ');
  const learning = (task.learningSegments || []).map(segment => [segment.courseTitle, segment.chapterTitle, segment.title, segment.sectionId].filter(Boolean).join(' ')).join(' ');
  const track = { ls: '零声课程 零声复盘', ydy: '易道云课程 易道云 项目 项目复现', review: '面试 面试准备 求职准备' }[task.track] || displayTrackName(task);
  return [task.title, task.summary, lessons, learning, ...(task.steps || []), ...(task.deliverables || []), displayTrackName(task), track, activityLabel(task), task.day, task.date,
    ...taskWorkSessions(task).map(session => session.date), task.endDate,
    week && task.track !== 'ydy' && weekTopicsText(week, task.track), week && phaseWeekLabel(week), week && phaseWeekLabel(week).replaceAll(' ', ''), `第${task.week}周`]
    .filter(Boolean).join(' ').toLocaleLowerCase();
}

function taskOutlineState(task) {
  if (taskDone(task.id)) return 'done';
  return taskProgressNote(task) ? 'partial' : 'pending';
}

function taskMatchesStatus(task) {
  return taskFilter === 'all' || (taskFilter === 'partial' ? taskOutlineState(task) === 'partial'
    : taskFilter === 'done' ? taskDone(task.id) : !taskDone(task.id));
}

function taskOutlineMarkup(task, openIds) {
  const status = taskOutlineState(task);
  const done = status === 'done';
  const progress = taskProgressNote(task, true);
  const saved = taskProgress(task.id);
  const segments = taskLearningSegments(task);
  const steps = task.steps || [];
  const deliverables = task.deliverables || [];
  const video = task.activity === 'video' || task.track === 'ls' && !task.activity;
  const list = items => `<ol class="outline-content-list">${items.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ol>`;
  const recordedSteps = new Set(saved?.kind === 'practice' ? saved.completedSteps || [] : []);
  const stepList = `<ol class="outline-content-list">${steps.map((step, index) => `<li class="outline-step${recordedSteps.has(index) ? ' is-recorded' : ''}">${saved?.kind === 'practice' ? `<span class="outline-step-status">${recordedSteps.has(index) ? '已记录' : '未记录'}</span>` : ''}<span>${escapeHTML(step)}</span></li>`).join('')}</ol>`;
  const contents = (segments.length ? `<section class="outline-content-section"><h4>${video ? '课节与观看区间' : '对应课节'}</h4><ol class="outline-content-list">${segments.map(segment => `<li><strong>${escapeHTML(segment.title)}</strong><small>${clockSecond(segment.startSecond)} – ${clockSecond(segment.endSecond)}</small></li>`).join('')}</ol></section>` : '')
    + (steps.length ? `<section class="outline-content-section"><h4>${task.track === 'review' ? '面试准备步骤' : '实践步骤'}</h4>${stepList}</section>` : '')
    + (deliverables.length ? `<section class="outline-content-section"><h4>本次成果</h4>${list(deliverables)}</section>` : '')
    + (saved?.note?.trim() ? `<section class="outline-content-section"><h4>学习记录</h4><p>${recordTextMarkup(saved.note)}</p></section>` : '')
    + (taskEntry(task.id)?.evidence?.trim() ? `<section class="outline-content-section"><h4>成果记录</h4><p>${recordTextMarkup(taskEntry(task.id).evidence)}</p></section>` : '')
    + taskWorkSessionsMarkup(task) + taskModuleSpecificationMarkup(task) + legacyTaskRecordMarkup(task);
  const heading = video && segments.length ? `课节大纲 · ${segments.length} 节` : steps.length ? `${isExternalConfirmation(task) ? '沟通' : isCareerPreparation(task) ? '材料' : task.track === 'review' ? '面试' : '实践'}大纲 · ${steps.length} 步` : deliverables.length ? `成果大纲 · ${deliverables.length} 项` : `课节大纲 · ${segments.length} 节`;
  return `<article class="task-outline-item${done ? ' is-done' : ''}" data-task-id="${escapeHTML(task.id)}"><div class="task-outline-head"><button class="outline-check" type="button" data-task-action="${taskWorkSessions(task).length || isUnscheduledCareerTask(task) ? 'details' : 'toggle'}"${taskWorkSessions(task).length || isUnscheduledCareerTask(task) ? ' data-detail-section="deliverables"' : ` aria-pressed="${done}"`} aria-label="${taskWorkSessions(task).length || isUnscheduledCareerTask(task) ? '核对记录与成果' : done ? '取消完成' : '完成打卡'}：${escapeHTML(displayTitle(task))}">${done ? icon('check') : taskWorkSessions(task).length || isUnscheduledCareerTask(task) ? icon('arrow') : ''}</button><div class="task-outline-main"><button class="task-outline-title" type="button" data-task-action="details">${escapeHTML(displayTitle(task))}</button><div class="task-outline-meta"><span>${taskPlanDateLabel(task)}</span><span>${escapeHTML(activityLabel(task))}</span><span>${escapeHTML(taskDuration(task))}</span></div></div><span class="outline-task-status${done ? ' is-done' : status === 'partial' ? ' is-partial' : ''}">${done ? '已完成' : status === 'partial' ? '进行中' : '未开始'}</span></div>${progress || status === 'partial' ? `<p class="task-outline-progress">${escapeHTML(progress || '已保存学习记录')}</p>` : ''}${courseAccessMarkup(task)}${recordUpdateMarkup(task, 'task-outline-recorded')}${contents ? `<details class="task-outline-content" data-outline-task-id="${escapeHTML(task.id)}"${openIds.has(task.id) ? ' open' : ''}><summary id="outline-summary-${escapeHTML(task.id)}">${heading}${icon('chevron')}</summary>${contents}</details>` : ''}</article>`;
}

function renderPlanner() {
  rememberOutlineWeeks();
  rememberCareerSections();
  const stateKey = outlineStateKey();
  if (!restoringLocation && $('weekTasks').dataset.outlineState !== stateKey) outlineCursorTaskId = outlineCursorStates.get(stateKey) || '';
  const openOutlineIds = progressListScope ? outlineTaskStates.get(stateKey) || new Set()
    : new Set(Array.from($('weekTasks').querySelectorAll('.task-outline-content[open]'), item => item.dataset.outlineTaskId));
  const phase = selectedPhaseData();
  const weeks = phaseWeeks();
  const week = selectedWeekData();
  const index = weeks.indexOf(week);
  const words = searchQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const scope = progressListScope;
  const scoped = !!scope;
  const outlineMode = scoped;
  const listMode = searching || scoped;
  const careerPlan = !listMode && phase.id === 'career' && !!DATA.careerWorkflow;
  if (careerPlan && !['all', 'review'].includes(trackFilter)) trackFilter = 'all';
  const scopeTasks = scoped ? progressScopeTasks(scope) : [];
  const onDemand = !searching ? onDemandTasksMarkup(onDemandTasksForScope(scoped ? scope
    : { phase: selectedPhase, track: trackFilter, project: '' }).filter(task => taskMatchesStatus(task))) : '';
  const extraSections = onDemand + (!listMode && phase.id === 'courses' && ['all', 'ydy'].includes(trackFilter) ? optionalExtensionsMarkup() : '')
    + (careerPlan ? careerWorkflowMarkup() : '');
  $('plannerView').classList.toggle('is-outline', scoped);
  $('plannerView').classList.toggle('is-list', listMode);
  $('plannerView').classList.toggle('is-career-plan', careerPlan);
  const plannerList = selectedView === 'planner' && listMode;
  document.body.classList.toggle('is-plan-list', plannerList);
  $('pageSubtitle').hidden = plannerList;
  document.querySelector('.page-eyebrow').hidden = plannerList;
  document.querySelector('.header-note').hidden = plannerList;
  document.querySelector('.planner-topbar').hidden = listMode;
  $('planPhaseSwitch').hidden = listMode;
  document.querySelector('.week-navigation').hidden = listMode;
  $('weekTopic').hidden = listMode;
  $('progressListContext').hidden = !scoped;
  $('weekMeta').hidden = scoped;
  $('planPhaseCaption').hidden = scoped || careerPlan;
  $('outlineNavigation').hidden = !scoped;
  $('allWeeksDetails').hidden = scoped;
  $('trackFilter').hidden = scoped || careerPlan;
  document.querySelector('label[for="trackFilter"]').hidden = scoped || careerPlan;
  if (scoped) {
    $('progressListTitle').textContent = progressScopeLabel(scope);
    const doneCount = scopeTasks.filter(task => taskOutlineState(task) === 'done').length;
    const partialCount = scopeTasks.filter(task => taskOutlineState(task) === 'partial').length;
    const unstartedCount = scopeTasks.length - doneCount - partialCount;
    const summary = [scope.phase === 'all' ? '全计划' : phase.label, `已完成 ${doneCount} / ${scopeTasks.length}`];
    if (partialCount) {
      summary.push(`进行中 ${partialCount}`);
      if (unstartedCount) summary.push(`未开始 ${unstartedCount}`);
    }
    $('progressListSummary').innerHTML = summary
      .map(text => `<span class="outline-summary-stat">${escapeHTML(text)}</span>`).join(' · ');
  }
  if (selectedView === 'planner') {
    $('pageTitle').textContent = scoped ? taskFilter === 'done' ? '打卡记录' : '任务大纲' : searching ? '搜索结果' : '学习计划';
    $('pageSubtitle').textContent = listMode ? '' : rhythmDescription(week, null);
  }
  if ($('planPhaseSwitch')) $('planPhaseSwitch').innerHTML = planPhases.map(item => `<button id="phase-${escapeHTML(item.id)}" class="plan-phase-btn${item.id === selectedPhase ? ' is-active' : ''}" type="button" data-phase="${escapeHTML(item.id)}" aria-pressed="${item.id === selectedPhase}"><strong>${escapeHTML(item.label)}</strong><span>${escapeHTML(item.countLabel || `${phaseWeeks(item).length} 周`)}</span></button>`).join('');
  if ($('planPhaseCaption')) $('planPhaseCaption').textContent = scoped ? '' : phase.openEnded ? `${phaseScheduleCaption(phase)}；参考材料周为${formatDate(phase.start, true)}起，后续按实际进度推进。` : searching
    ? '全部阶段 · 按来源和完成状态筛选'
    : `${formatDate(phase.start, true)} – ${formatDate(phase.end, phase.start.slice(0, 4) !== phase.end.slice(0, 4))} · ${phaseScheduleCaption(phase)}`;
  if ($('weekSelect').dataset.phase !== selectedPhase) {
    $('weekSelect').innerHTML = weeks.map(item => `<option value="${item.week}">${phaseWeekLabel(item)} · ${item.range}</option>`).join('');
    $('weekSelect').dataset.phase = selectedPhase;
  }
  $('weekSelect').value = String(selectedWeek);
  $('weekTitle').textContent = scoped ? taskFilter === 'done' ? '打卡记录' : '任务大纲' : searching ? '搜索结果' : phaseWeekLabel(week);
  $('weekTopic').innerHTML = listMode ? '' : careerPlan ? escapeHTML(week.range) : weekTopicsMarkup(week);
  $('weekMeta').textContent = scoped ? '' : searching
    ? `${formatDate(DATA.weeks[0].start, true)} – ${formatDate(DATA.weeks.at(-1).end, true)}`
    : `${formatDate(week.start, true)} – ${formatDate(week.end, week.start.slice(0, 4) !== week.end.slice(0, 4))} · 固定 ${formatDuration(Number.isFinite(week.scheduledMinutes) ? week.scheduledMinutes : totalTaskMinutes(requiredTasks(scheduledTasksForWeek(week))))}${week.totalMin > 0 ? ` · 零声视频 ${formatDuration(week.totalMin)}` : ''}${scheduledTasksForWeek(week).some(task => task.activity === 'video' && task.track === 'ydy') ? ` · 易道云视频 ${formatDuration(scheduledTasksForWeek(week).filter(task => task.activity === 'video' && task.track === 'ydy').reduce((sum, task) => sum + (task.budget?.videoMinutes || 0), 0))}` : ''}${scheduledTasksForWeek(week).some(task => !isRequiredTask(task)) ? ' · 另有按需补漏' : ''}${isTransitionWeek(week) ? ` · ${formatDate(planRhythm().zeroVoiceCompletionDate)}最后一节零声` : ''}`;
  $('weekPrevBtn').disabled = index === 0;
  $('weekNextBtn').disabled = index === weeks.length - 1;
  const actualWeek = calendarWeek();
  $('jumpTodayBtn').disabled = !actualWeek;
  $('currentWeekHint').hidden = !!actualWeek && phaseForWeek(actualWeek).id === selectedPhase;
  if (listMode) $('currentWeekHint').hidden = true;
  $('currentWeekHint').textContent = actualWeek ? `本周在${phaseForWeek(actualWeek).label}，点击“回到本周”可切换阶段。` : todayISO() < DATA.weeks[0].start
    ? `计划尚未开始；${phase.label}将于${formatDate(phase.start)}开始。`
    : openEndedCareerPhase() ? '今天不在参考日历内，材料、老师沟通与面试仍按实际进度推进。' : `学习计划已于${formatDate(DATA.weeks.at(-1).end, true)}结束，今天没有对应的计划周。`;
  $('taskFilter').value = taskFilter;
  for (const option of $('trackFilter').options) {
    const unavailable = option.value !== 'all' && !availableTracks.has(option.value);
    option.hidden = unavailable;
    option.disabled = unavailable;
  }
  $('trackFilter').value = trackFilter;
  if ($('taskSearch').value !== searchQuery) $('taskSearch').value = searchQuery;
  const weekScheduled = scheduledTasksForWeek(week);
  const source = scoped ? scopeTasks : searching ? allTasks : weekScheduled;
  const filtered = source.filter(task => taskMatchesStatus(task)
    && (careerPlan || trackFilter === 'all' || task.track === trackFilter)
    && (!searching || words.every(word => taskSearchText(task).includes(word))));
  const filtersActive = taskFilter !== 'all' || (!scoped && ((!careerPlan && trackFilter !== 'all') || searching));
  const searchOnDemand = searching && !scoped ? filtered.filter(task => task.onDemand) : [];
  const resultWeeks = listMode ? DATA.weeks.map(resultWeek => ({ week: resultWeek,
    tasks: filtered.filter(task => task.week === resultWeek.week && (!searching || !task.onDemand)) })).filter(group => group.tasks.length) : [];
  $('weekCount').hidden = scoped && taskFilter === 'all';
  document.querySelector('.list-context .interaction-hint').hidden = scoped;
  document.querySelector('.list-context .interaction-hint').textContent = careerPlan
    ? allLearningComplete() ? '点圆圈记录本次，核对成果后完成模块' : '先完成课程与项目，点标题预览整理要求'
    : '点标题看详情，点圆圈打卡';
  document.querySelector('.list-context').hidden = scoped && taskFilter === 'all';
  $('clearFiltersBtn').hidden = !filtersActive || !scoped && !careerPlan && !filtered.length;
  $('weekCount').textContent = scoped ? `${filtered.length} 项${taskFilter === 'done' ? '已打卡' : taskFilter === 'partial' ? '进行中' : taskFilter === 'pending' ? '待完成' : '任务'} · ${resultWeeks.length} 周` : searching ? `全计划找到 ${filtered.length} 项${resultWeeks.length ? ` · ${resultWeeks.length} 周` : ''}${searchOnDemand.length ? ` · ${searchOnDemand.length} 项无固定日期` : ''}`
    : filtersActive ? `显示 ${filtered.length} / ${weekScheduled.length} 项` : taskCompletionLabel(weekScheduled);
  const scopeKey = outlineScopeKey(scope);
  if (scoped) {
    $('outlineWeekSelect').innerHTML = '<option value="">选择周次</option>' + resultWeeks.map(({ week: resultWeek }) => `<option value="${resultWeek.week}">${escapeHTML(outlineWeekLabel(resultWeek, scope))} · ${escapeHTML(weekTopics(resultWeek).filter(topic => topic.track === scope.track).map(topic => topic.title).join('、'))}</option>`).join('');
    $('outlineWeekSelect').disabled = !resultWeeks.length;
    $('weekTasks').dataset.outlineScope = scopeKey;
    $('weekTasks').dataset.outlineState = stateKey;
    outlineContexts.set(stateKey, { scope: scopeKey, filter: taskFilter, track: trackFilter });
  } else {
    delete $('weekTasks').dataset.outlineScope;
    delete $('weekTasks').dataset.outlineState;
  }
  if (!filtered.length) {
    if (scoped) {
      $('weekTasks').innerHTML = `<div class="empty"><span class="empty-icon">${icon('book')}</span><h3>${taskFilter === 'done' ? '该范围暂无已打卡任务' : taskFilter === 'partial' ? '该范围暂无进行中的任务' : taskFilter === 'pending' ? '该范围任务已全部打卡' : '该范围暂无任务'}</h3><p>可切换完成状态查看其他任务。</p></div>` + extraSections;
      updateOutlineControls();
      return;
    }
    $('weekTasks').innerHTML = `<div class="empty"><span class="empty-icon">${icon('book')}</span><h3>${!searching && taskFilter === 'pending' && trackFilter === 'all' ? '本周安排已完成' : '没有匹配的任务'}</h3><p>${searching ? '试试课程名称、项目名或日期，或清除筛选。' : '可以调整筛选条件，或切换到其他周次。'}</p>${filtersActive ? '<div class="empty-actions"><button type="button" data-clear-filters>清除筛选</button></div>' : ''}</div>` + extraSections;
    return;
  }
  if (outlineMode) {
    let openWeeks = outlineWeekStates.get(stateKey);
    if (!openWeeks || openWeeks.size > 0 && !resultWeeks.some(group => openWeeks.has(group.week.week))) {
      const first = filtered.find(task => taskOutlineState(task) === 'partial') || filtered.find(task => !taskDone(task.id)) || filtered[0];
      openWeeks = new Set([first.week]);
    }
    outlineWeekStates.set(stateKey, openWeeks);
    $('weekTasks').innerHTML = resultWeeks.map(({ week: resultWeek, tasks }) => {
      const topic = weekTopics(resultWeek).filter(item => item.track === scope.track).map(item => item.title).join('、');
      const weekScopeTasks = scopeTasks.filter(task => task.week === resultWeek.week);
      return `<details class="search-week-group outline-week-group" data-result-week="${resultWeek.week}" aria-labelledby="search-week-heading-${resultWeek.week}"${openWeeks.has(resultWeek.week) ? ' open' : ''}><summary id="outline-week-summary-${resultWeek.week}" class="outline-week-summary"><div><h3 id="search-week-heading-${resultWeek.week}">${escapeHTML(outlineWeekLabel(resultWeek, scope))}</h3>${topic ? `<p class="outline-week-topic">${escapeHTML(topic)}</p>` : ''}<p class="outline-week-date">${formatDate(resultWeek.start, true)} – ${formatDate(resultWeek.end, resultWeek.start.slice(0, 4) !== resultWeek.end.slice(0, 4))}</p></div><span class="outline-week-count">${weekScopeTasks.filter(task => taskDone(task.id)).length} / ${weekScopeTasks.length} 已完成</span>${icon('chevron')}</summary><div class="search-week-tasks progress-outline">${tasks.map(task => taskOutlineMarkup(task, openOutlineIds)).join('')}</div><div class="outline-week-footer"><button id="search-week-link-${resultWeek.week}" class="text-btn" type="button" data-search-week="${resultWeek.week}">查看该周 <span aria-hidden="true">→</span></button></div></details>`;
    }).join('') + extraSections;
    if (!filtered.some(task => task.id === outlineCursorTaskId)) outlineCursorTaskId = filtered.find(task => openWeeks.has(task.week))?.id || '';
    const cursor = taskById.get(outlineCursorTaskId);
    if (cursor) $('outlineWeekSelect').value = String(cursor.week);
    updateOutlineControls(); savePreferences();
    return;
  }
  if (listMode) {
    $('weekTasks').innerHTML = resultWeeks.map(({ week: resultWeek, tasks }) => `<section class="search-week-group" data-result-week="${resultWeek.week}" aria-labelledby="search-week-heading-${resultWeek.week}"><header class="search-week-heading"><div><h3 id="search-week-heading-${resultWeek.week}">${escapeHTML(phaseForWeek(resultWeek).label)} · ${phaseWeekLabel(resultWeek)}</h3><div class="search-week-topics">${weekTopicsMarkup(resultWeek)}</div><p>${formatDate(resultWeek.start, true)} – ${formatDate(resultWeek.end, resultWeek.start.slice(0, 4) !== resultWeek.end.slice(0, 4))} · ${tasks.length} 项匹配</p></div><button id="search-week-link-${resultWeek.week}" class="text-btn" type="button" data-search-week="${resultWeek.week}">查看该周 <span aria-hidden="true">→</span></button></header><div class="search-week-tasks">${plannerSearchTasksMarkup(tasks, words)}</div></section>`).join('') + onDemandSearchMarkup(searchOnDemand, words);
  } else {
    $('weekTasks').innerHTML = Array.from({ length: 7 }, (_, index) => {
      const date = dateAt(week.start, index);
      return plannerDayMarkup(date, filtered.filter(task => task.date === date), !filtersActive && index === 6, [],
        { careerPlan, preview: careerPlan && !allLearningComplete() });
    }).join('') + extraSections;
  }
}

function renderWeekList() {
  const date = todayISO();
  const selectedMonth = selectedWeekData().start.slice(0, 7);
  const previousMonth = $('weekList').dataset.selectedMonth;
  const openMonths = new Set(Array.from($('weekList').querySelectorAll('.month-group[open]')).map(group => group.dataset.month));
  if (selectedMonth !== previousMonth) openMonths.add(selectedMonth);
  const months = new Map();
  for (const week of phaseWeeks()) {
    const month = week.start.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(week);
  }
  $('weekList').innerHTML = Array.from(months, ([month, weeks]) => {
    const tasks = weeks.flatMap(week => scheduledTasksForWeek(week));
    return `<details class="month-group" data-month="${month}"${openMonths.has(month) ? ' open' : ''}><summary id="month-${month}"><span class="month-label">${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月</span><span class="month-meta">${weeks.length} 周 · ${taskCompletionLabel(tasks)}</span>${icon('chevron').replace('<svg ', '<svg class="disclosure-chevron" ')}</summary><div class="month-weeks">${weeks.map(week => {
      const scheduled = scheduledTasksForWeek(week);
      const required = requiredTasks(scheduled);
      const done = required.filter(task => taskDone(task.id)).length;
      const label = taskCompletionLabel(scheduled, '完成');
      const isCurrent = week.start <= date && date <= week.end;
      return `<button class="week-chip${week.week === selectedWeek ? ' selected' : ''}${required.length > 0 && done === required.length ? ' done' : ''}" type="button" data-week="${week.week}" aria-pressed="${week.week === selectedWeek}" aria-label="${phaseWeekLabel(week)}，${escapeHTML(week.range)}，${escapeHTML(weekTopicsText(week))}，${escapeHTML(label)}" title="${escapeHTML(weekTopicsText(week))}"><span class="week-chip-title">${phaseWeekLabel(week)}${isCurrent ? ' · 本周' : ''}</span><span class="week-chip-topic">${weekTopicsMarkup(week)}</span><span class="week-chip-range">${escapeHTML(week.range)}</span><span class="week-chip-count">${label}</span></button>`;
    }).join('')}</div></details>`;
  }).join('');
  $('weekList').dataset.selectedMonth = selectedMonth;
}

function milestoneTasks(milestone) {
  return requiredTasks((milestone.taskIds || []).map(id => taskById.get(id)).filter(Boolean));
}

function milestoneOptionalTasks(milestone) {
  return (milestone.taskIds || []).map(id => taskById.get(id)).filter(task => task && !isRequiredTask(task));
}

function milestoneOptionalTaskMarkup(tasks) {
  return optionalTaskGroups(tasks).map(group => `<details class="goal-deliverables"><summary>${group.label} · ${group.tasks.filter(task => taskDone(task.id)).length} / ${group.tasks.length} 已记录</summary><p>仅在有对应缺口时执行，不影响必修完成和求职准备。</p><ul>${group.tasks.map(task => `<li data-task-id="${escapeHTML(task.id)}"><button class="text-btn" type="button" data-task-action="details">${escapeHTML(displayTitle(task))}${icon('arrow')}</button><span>${taskDone(task.id) ? '已完成' : taskProgressNote(task) ? '有记录' : '按需执行'}</span></li>`).join('')}</ul></details>`).join('');
}

function milestoneProgress(milestone) {
  const tasks = milestoneTasks(milestone);
  const completed = tasks.filter(task => taskDone(task.id)).length;
  const started = completed > 0 || tasks.some(task => taskOutlineState(task) === 'partial');
  const next = tasks.find(task => !taskDone(task.id));
  return { tasks, completed, started, next, checked: tasks.length > 0 && completed === tasks.length };
}

function milestoneReview(milestone) { return state.entries[milestoneReviewKey(milestone)] || null; }

function historicalMilestoneReviews(milestone) {
  return [...new Set(milestone.historicalReviewKeys || [])].filter(key => key !== milestoneReviewKey(milestone))
    .flatMap(key => state.entries[key] ? [{ key, record: state.entries[key] }] : []);
}

function historicalMilestoneReviewsMarkup(milestone, { readOnly = false } = {}) {
  const reviews = historicalMilestoneReviews(milestone);
  return reviews.length ? `<details class="goal-deliverables"><summary>历史验收记录 · ${reviews.length} 份</summary><p>${readOnly ? '以下记录仅作历史参考，不纳入本轮必修任务或作品验收。' : '验收范围已更新；以下记录仅作历史参考，不代表当前模块已验收。'}</p>${reviews.map(({ key, record }) => `<article data-historical-review-key="${escapeHTML(key)}"><p>${record.done ? '原范围已验收' : '原范围未验收'} · <time datetime="${escapeHTML(record.updatedAt)}">${formatSyncTime(record.updatedAt)}</time></p>${record.evidence ? `<p>${recordTextMarkup(record.evidence)}</p>` : ''}</article>`).join('')}</details>` : '';
}

function projectRecordsMarkup(milestone, open = false) {
  const current = milestoneReview(milestone);
  const records = [...(current ? [{ key: milestoneReviewKey(milestone), record: current }] : []), ...historicalMilestoneReviews(milestone)]
    .filter(({ record }) => record.done || String(record.evidence || '').trim() || Date.parse(record.updatedAt) > 0);
  if (!records.length) return '';
  return `<details class="goal-deliverables goal-records" id="project-history-${escapeHTML(milestone.id)}" data-project-history="${escapeHTML(milestone.id)}"${open ? ' open' : ''}><summary id="project-history-summary-${escapeHTML(milestone.id)}">已有成果记录 · ${records.length} 份${icon('chevron')}</summary>${records.map(({ key, record }) => `<article data-historical-review-key="${escapeHTML(key)}"><p class="record-meta">历史记录 · <time datetime="${escapeHTML(record.updatedAt)}">${formatSyncTime(record.updatedAt)}</time></p>${record.evidence ? `<p>${recordTextMarkup(record.evidence)}</p>` : ''}</article>`).join('')}</details>`;
}

function milestoneCard(milestone, index, isNext = false, recordsOpen = false, requirementsOpen = false) {
  const { tasks, completed, started, next, checked } = milestoneProgress(milestone);
  const task = next || tasks.at(-1);
  const project = milestone.kind === 'project';
  const optional = milestoneOptionalTasks(milestone);
  const overdue = !!milestone.date && milestone.date < todayISO() && !checked;
  const status = checked ? 'checked' : project && overdue ? 'late' : started ? 'active' : 'pending';
  return `<article class="goal-card ${project ? 'is-project' : 'is-parallel'}${isNext ? ' is-next' : ''}${checked ? ' is-complete' : ''}" data-milestone-id="${escapeHTML(milestone.id)}" aria-labelledby="goal-title-${escapeHTML(milestone.id)}">
    <div class="goal-heading"><span class="goal-number" aria-hidden="true">${project ? String(index + 1).padStart(2, '0') : icon(milestone.id === 'courses' ? 'book' : 'calendar')}</span><div class="goal-heading-copy"><p class="goal-scope">${escapeHTML(milestone.scope)}</p><h3 id="goal-title-${escapeHTML(milestone.id)}">${escapeHTML(milestone.name)}</h3></div><span class="goal-status" data-state="${status}">${checked ? project ? '已完成' : '任务已打卡' : overdue && project ? '待补' : started ? '进行中' : '未开始'}</span></div>
    <div class="goal-date"><span>${milestone.date ? '暂定目标' : '推进方式'}</span>${milestone.date ? `<time datetime="${milestone.date}">${formatDate(milestone.date, true)}</time>` : `<span>${escapeHTML(milestone.dateLabel || '按实际进度推进')}</span>`}${overdue ? `<span class="goal-overdue">尚余 ${tasks.length - completed} 项未打卡</span>` : ''}</div>
    <div class="goal-progress"><div class="goal-progress-label"><span>${optional.length ? '必修任务已打卡' : project ? '项目任务已打卡' : '已打卡'}</span><strong>${completed} / ${tasks.length}</strong></div><div class="goal-meter" role="progressbar" aria-label="${escapeHTML(milestone.name)}必修任务打卡进度" aria-valuemin="0" aria-valuemax="${tasks.length}" aria-valuenow="${completed}" aria-valuetext="已打卡 ${completed} / ${tasks.length} 项必修任务"><span style="width:${percent(completed, tasks.length)}%"></span></div></div>
    <details class="goal-deliverables" data-project-requirements="${escapeHTML(milestone.id)}"${requirementsOpen ? ' open' : ''}><summary id="project-requirements-summary-${escapeHTML(milestone.id)}">${project ? '完成要求' : escapeHTML(milestone.deliverableLabel || '完成成果')}${icon('chevron')}</summary><ul>${(milestone.deliverables || []).map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></details>
    ${milestoneOptionalTaskMarkup(optional)}
    ${task ? `<div class="goal-next" data-task-id="${escapeHTML(task.id)}"><span>${next ? '下一项' : project ? '最终自测记录' : '末项任务'} · ${phaseWeekLabel(DATA.weeks.find(week => week.week === task.week))} · ${taskPlanDateLabel(task)}</span><button id="milestone-next-${escapeHTML(milestone.id)}" class="goal-next-task" type="button" data-task-action="details">${escapeHTML(displayTitle(task))}${icon('arrow')}</button></div>` : ''}
    <div class="goal-footer"><button id="milestone-plan-${escapeHTML(milestone.id)}" type="button" class="text-btn" data-milestone-plan="${escapeHTML(milestone.id)}">查看周计划 <span aria-hidden="true">→</span></button></div>
    ${project ? projectRecordsMarkup(milestone, recordsOpen) : ''}
  </article>`;
}

function renderMilestones() {
  const projects = (DATA.milestones || []).filter(milestone => milestone.kind === 'project');
  const completedCount = projects.filter(milestone => milestoneProgress(milestone).checked).length;
  const nextProject = projects.find(milestone => !milestoneProgress(milestone).checked);
  const openRecords = new Set(Array.from($('milestones').querySelectorAll('[data-project-history][open]'), item => item.dataset.projectHistory));
  // Requirements in both columns and the preparation checklist share the
  // existing location state so rerenders and navigation preserve the context.
  const openRequirements = new Set(Array.from($('milestonesView').querySelectorAll('[data-project-requirements][open]'), item => item.dataset.projectRequirements));
  $('milestoneSummary').innerHTML = `<div class="roadmap-completed">${icon('check')}<div><small>项目完成</small><strong>${completedCount} / ${projects.length} 个已完成</strong><span>历史完成：${(DATA.completedProjects || []).map(project => escapeHTML(project.name)).join('、') || '暂无记录'}</span></div></div><div class="roadmap-next"><small>${nextProject ? '下一项目目标' : '项目进度'}</small><strong>${nextProject ? escapeHTML(nextProject.name) : '项目已全部完成'}</strong>${nextProject ? `<time datetime="${nextProject.date}">暂定 ${formatDate(nextProject.date, true)}</time>` : '<span>继续整理项目与技能材料</span>'}</div>`;
  $('milestones').innerHTML = projects.map((milestone, index) => milestoneCard(milestone, index, milestone === nextProject, openRecords.has(milestone.id), openRequirements.has(milestone.id))).join('');
  $('parallelMilestones').innerHTML = (DATA.milestones || []).filter(milestone => milestone.kind === 'parallel')
    .map((milestone, index) => milestoneCard(milestone, index, false, false, openRequirements.has(milestone.id))).join('');
  const application = DATA.applicationMilestone;
  if (!application) { $('applicationMilestone').innerHTML = ''; return; }
  const readiness = applicationReadiness();
  const workflow = careerWorkflowState();
  const status = !readiness.learningComplete ? '先完成全部必修学习' : readiness.ready ? '可开始投递'
    : workflow ? !workflow.preparationComplete ? '先整理项目与技能材料' : '待老师沟通确认定制简历' : '先整理简历、演示与岗位目标';
  const timingLabel = application.timingLabel || (application.start && application.end
    ? `原计划${formatDate(application.start, true)}开始投递，${formatDate(application.end, true)}前进行首轮投递与复盘。`
    : '按实际准备情况开始投递');
  $('applicationMilestone').innerHTML = `<div class="application-heading"><h2>投递安排</h2><span class="application-status">${status}</span></div><p class="application-timing">${escapeHTML(timingLabel)}</p><details class="application-preparation goal-deliverables" id="application-preparation" data-project-requirements="application-preparation"${openRequirements.has('application-preparation') ? ' open' : ''}><summary id="project-requirements-summary-application-preparation"><span>投递准备</span><span class="application-preparation-count">${readiness.completed} / ${readiness.tasks.length}</span>${icon('chevron')}</summary><ul>${readiness.tasks.map(task => `<li data-task-id="${escapeHTML(task.id)}"><button class="text-btn" type="button" data-task-action="details">${escapeHTML(displayTitle(task))}${icon('arrow')}</button><span class="badge${taskDone(task.id) ? ' done' : ''}">${taskDone(task.id) ? '已打卡' : '待完成'}</span></li>`).join('')}</ul></details>`;
}

function openMilestonePlan(id) {
  const milestone = DATA.milestones.find(item => item.id === id);
  if (!milestone) return;
  const { tasks, next } = milestoneProgress(milestone);
  const task = next || tasks.at(-1);
  if (!task) return;
  changeLocation(() => {
    taskFilter = 'all'; trackFilter = task.track; searchQuery = '';
    selectWeek(task.week);
  });
  requestAnimationFrame(() => {
    focusPlannerTask(task.id);
    checkpointLocation();
  });
}

function moveToastToActiveDialog() {
  for (let index = openDialogOrder.length - 1; index >= 0; index--) {
    if (!openDialogOrder[index].open) openDialogOrder.splice(index, 1);
  }
  const dialog = openDialogOrder.at(-1);
  const host = dialog?.querySelector(':scope > .dialog-footer') || dialog || document.body;
  const region = $('toastRegion');
  if (region.parentElement === host) return;
  const previousDialog = region.closest('dialog');
  const previousScroll = previousDialog?.scrollTop;
  const nextScroll = dialog?.scrollTop;
  if (host.classList.contains('dialog-footer')) host.prepend(region);
  else host.append(region);
  if (previousDialog?.open) previousDialog.scrollTop = previousScroll;
  if (dialog) dialog.scrollTop = nextScroll;
}

function openAppDialog(dialog) {
  if ($('toastRegion').contains(document.activeElement)) toastReturnFocus.set(dialog, { element: document.activeElement, context: toastFocusContext });
  else toastReturnFocus.delete(dialog);
  dialog.showModal();
  const previousIndex = openDialogOrder.indexOf(dialog);
  if (previousIndex !== -1) openDialogOrder.splice(previousIndex, 1);
  openDialogOrder.push(dialog);
  moveToastToActiveDialog();
}

function handleDialogClose(event) {
  const dialog = event.currentTarget;
  moveToastToActiveDialog();
  if (dialog.open) return;
  const previousFocus = toastReturnFocus.get(dialog);
  toastReturnFocus.delete(dialog);
  if (previousFocus?.element.isConnected && $('toastRegion').contains(previousFocus.element)) {
    previousFocus.element.focus({ preventScroll: true });
  } else if (previousFocus && (document.activeElement === document.body || document.activeElement?.closest('dialog') === dialog)) {
    restoreToastFocus(previousFocus.context);
  }
}

function captureToastFocus() {
  const element = document.activeElement;
  if (!element || element === document.body || $('toastRegion').contains(element)) return null;
  const card = element.closest('[data-task-id]');
  const scope = card?.closest('#todayBox, #continueBox, #weekTasks');
  const group = card?.closest('[data-result-week]');
  return { element, snapshot: focusSnapshot(), dialog: element.closest('dialog')?.id,
    task: scope ? { id: card.dataset.taskId, scope: scope.id, week: group?.dataset.resultWeek,
      index: Array.from((group || scope).querySelectorAll('[data-task-id]')).indexOf(card),
      groupIndex: group ? Array.from(scope.querySelectorAll('[data-result-week]')).indexOf(group) : -1 } : null };
}

function focusToastTarget(element) {
  const dialog = $('toastRegion').closest('dialog');
  if (!element?.isConnected || element.disabled || element.closest('[hidden], [inert]')
    || $('toastRegion').contains(element) || element.closest('dialog') !== dialog
    || !element.checkVisibility()) return null;
  if (!element.matches('button, input, select, textarea, a[href], summary, [tabindex]')) element.tabIndex = -1;
  element.focus({ preventScroll: true });
  return document.activeElement === element ? element : null;
}

function restoreToastFocus(context) {
  moveToastToActiveDialog();
  const dialog = $('toastRegion').closest('dialog');
  if (dialog) {
    // Keep keyboard navigation inside the top modal, away from check-in actions.
    const source = context?.dialog === dialog.id && context.snapshot?.id !== 'detailToggleBtn'
      ? (context.snapshot?.id ? $(context.snapshot.id) : context.element) : null;
    return focusToastTarget(source) || focusToastTarget($(dialog.getAttribute('aria-labelledby')))
      || focusToastTarget(dialog);
  }
  if (context?.task) {
    const task = context.task;
    const scope = $(task.scope);
    const title = row => row?.querySelector('.task-title, .task-outline-title, [data-task-action="details"]');
    const original = scope?.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`);
    let target = focusToastTarget(title(original));
    if (target) return target;
    const group = task.week ? scope?.querySelector(`[data-result-week="${CSS.escape(task.week)}"]`) : scope;
    const rows = Array.from(group?.querySelectorAll('[data-task-id]') || []);
    // A filtered-out row leaves the next title at its old index; never focus a toggle.
    for (const row of [...rows.slice(Math.max(0, task.index)), ...rows.slice(0, Math.max(0, task.index)).reverse()]) {
      target = focusToastTarget(title(row));
      if (target) return target;
    }
    target = focusToastTarget(group?.querySelector(':scope > summary'));
    if (target) return target;
    if (task.week && !group) {
      const groups = Array.from(scope?.querySelectorAll('[data-result-week]') || []);
      const nearby = groups[Math.min(task.groupIndex, groups.length - 1)];
      target = focusToastTarget(nearby?.querySelector(':scope > summary'));
      if (target) return target;
    }
    const fallback = task.scope === 'weekTasks' ? plannerFocusTarget() : task.scope === 'continueBox'
      ? $(`continue-track-${continueTrackChoice || defaultContinueTrack()}`) : $('todayHeading');
    return focusToastTarget(fallback) || focusToastTarget($('taskFilter')) || focusToastTarget($('pageTitle'));
  }
  return focusToastTarget(context?.snapshot?.id ? $(context.snapshot.id) : context?.element)
    || focusToastTarget($('pageTitle'));
}

function dismissToast(action = null) {
  clearTimeout(toastTimer);
  toastTimer = null;
  const ownedFocus = $('toastRegion').contains(document.activeElement);
  const context = toastFocusContext;
  $('toastRegion').replaceChildren();
  toastFocusContext = null;
  const returnTarget = ownedFocus ? restoreToastFocus(context) : null;
  const returnedFocus = ownedFocus ? focusSnapshot() : null;
  if (action) {
    action.run();
    // Undo can put the original task back; respect actions that move focus themselves.
    const currentFocus = focusSnapshot();
    const keptFocus = returnedFocus?.id ? currentFocus?.id === returnedFocus.id : returnedFocus?.task
      && currentFocus?.task === returnedFocus.task && currentFocus.action === returnedFocus.action
      && currentFocus.progressAction === returnedFocus.progressAction && currentFocus.scope === returnedFocus.scope;
    if (ownedFocus && (keptFocus || document.activeElement === returnTarget || document.activeElement === document.body)) {
      restoreToastFocus(context);
    }
  }
}

function showToast(message, action = null, kind = 'success', returnContext = null) {
  clearTimeout(toastTimer);
  const ownedFocus = $('toastRegion').contains(document.activeElement);
  const context = returnContext || (ownedFocus ? toastFocusContext : captureToastFocus());
  // Share the modal's sticky footer so the notice and its actions cannot overlap.
  moveToastToActiveDialog();
  toastFocusContext = context;
  $('toastRegion').innerHTML = `<div class="toast ${kind}"><span>${escapeHTML(message)}</span>${action ? '<button class="toast-action" type="button">' + escapeHTML(action.label) + '</button>' : ''}<button class="toast-close" type="button" aria-label="关闭提示">${icon('close')}</button></div>`;
  $('toastRegion').querySelector('.toast-close').onclick = () => dismissToast();
  if (action) $('toastRegion').querySelector('.toast-action').onclick = () => dismissToast(action);
  toastTimer = setTimeout(() => dismissToast(), action ? 12000 : 6500);
  if (ownedFocus) restoreToastFocus(context);
}

function changeTask(id, done, announce = true) {
  if (!taskById.has(id)) return;
  const target = taskById.get(id);
  if (done && !taskDone(id) && isUnscheduledCareerTask(target) && careerTaskBlocked(target)) { showToast('请先完成前置学习和材料整理，并与老师沟通确认简历', null, 'error'); return; }
  const previousFocus = focusSnapshot();
  const returnContext = captureToastFocus();
  if (id === detailTaskId) detailProgressEditing = false;
  const previous = taskEntry(id) || createEntry(false, new Date(0).toISOString());
  const storedBefore = readUndoStorage();
  state.entries[id] = createEntry(done, freshTimestamp(), previous.evidence, previous.progress);
  localRevision++;
  const saved = saveState();
  render();
  if (announce) showToast(saved ? done ? '任务已完成' : '已取消完成' : '浏览器暂时无法保存，请同步或导出备份', makeCompletionUndo({ [id]: previous }, saved, storedBefore), saved ? 'success' : 'error', returnContext);
  if (announce && previousFocus?.task === id && previousFocus.action === 'toggle'
    && !document.querySelector(`${previousFocus.scope ? '#' + previousFocus.scope : ''} [data-task-id="${CSS.escape(id)}"] [data-task-action="toggle"]`)) {
    $('toastRegion').querySelector('.toast-action')?.focus({ preventScroll: true });
  }
  syncToServer({ silent: true });
}

function saveTaskProgress(id, progress) {
  const task = taskById.get(id);
  if (!task || !validTaskProgress(progress)) return false;
  if (isRelativeCareerTask(task) && careerTaskBlocked(task) && !taskProgress(id) && !taskDone(id)) { showToast('请先与老师沟通并确认定制简历，再记录面试准备', null, 'error'); return false; }
  const segments = taskLearningSegments(task);
  if (progress.kind === 'video') {
    const segment = segments[progress.segmentIndex ?? 0];
    if (!segment || progress.positionSecond !== undefined && (progress.positionSecond < segment.startSecond || progress.positionSecond > segment.endSecond)) return false;
  } else if (task.activity === 'video' || progress.completedSteps?.some(index => index >= (task.steps?.length || 0))) return false;
  const previous = taskEntry(id) || createEntry(false, new Date(0).toISOString());
  const storedBefore = readUndoStorage();
  state.entries[id] = createEntry(previous.done, freshTimestamp(), previous.evidence, progress);
  localRevision++;
  const saved = saveState();
  render();
  showToast(saved ? '学习进度已保存' : '浏览器暂时无法保存，请同步或导出备份', makeCompletionUndo({ [id]: previous }, saved, storedBefore), saved ? 'success' : 'error');
  syncToServer({ silent: true });
  return true;
}

function toggleTask(id) { changeTask(id, !taskDone(id)); }

function selectWeek(number, navigate = true) {
  const targetWeek = DATA.weeks.find(week => week.week === number);
  if (!targetWeek) return;
  return changeLocation(() => {
  progressListScope = null;
  const previousView = selectedView;
  const targetPhase = phaseForWeek(targetWeek);
  if (targetPhase.id !== selectedPhase) phaseSelections.set(selectedPhase, selectedWeek);
  selectedPhase = targetPhase.id;
  selectedWeek = number;
  phaseSelections.set(selectedPhase, selectedWeek);
  if (trackFilter !== 'all' && !phaseWeeks(targetPhase).some(week => week.tasks.some(task => task.track === trackFilter))) trackFilter = 'all';
  searchQuery = '';
  if (navigate) selectedView = 'planner';
  savePreferences();
  render();
  if (previousView !== selectedView) window.scrollTo({ top: 0, behavior: 'instant' });
  });
}

function selectPhase(id) {
  const phase = planPhases.find(item => item.id === id);
  if (!phase || phase.id === selectedPhase) return;
  return changeLocation(() => {
  progressListScope = null;
  phaseSelections.set(selectedPhase, selectedWeek);
  selectedPhase = phase.id;
  selectedWeek = phaseSelections.get(id) || phaseWeeks(phase)[0].week;
  if (trackFilter !== 'all' && !phaseWeeks(phase).some(week => week.tasks.some(task => task.track === trackFilter))) trackFilter = 'all';
  savePreferences();
  render();
  });
}

function activateView(view) {
  return changeLocation(() => restoreOutlineReadingPosition(() => {
  const changed = selectedView !== view;
  selectedView = view;
  savePreferences(); render();
  if (changed && !(view === 'planner' && progressListScope)) window.scrollTo({ top: 0, behavior: 'instant' });
  }));
}

function resetPlannerFilters() { taskFilter = 'all'; trackFilter = 'all'; searchQuery = ''; progressListScope = null; progressListReturn = null; }

function clearFilters() {
  return changeLocation(() => {
  const scoped = !!progressListScope;
  if (progressListScope) { searchQuery = ''; trackFilter = progressListScope.track; changeOutlineFilter('all'); }
  else resetPlannerFilters();
  savePreferences(); render(); $('taskSearch').focus({ preventScroll: scoped });
  });
}

function openTaskDetails(id, target = {}) {
  if (!taskById.has(id)) return;
  return changeLocation(() => {
  detailOpenerFocus = focusSnapshot();
  detailTaskId = id;
  detailProgressSession++;
  detailProgressDirty = false;
  detailProgressEditing = false;
  renderTaskDetails();
  openAppDialog($('taskDialog'));
  $('taskDialog').scrollTop = 0;
  const section = Number.isInteger(target.segmentIndex)
    ? $('taskDialogBody').querySelector(`[data-segment-index="${target.segmentIndex}"]`)
    : target.section === 'steps' ? $('taskDialogBody').querySelector('.detail-steps, .progress-readonly-steps')
    : target.section === 'deliverables' ? $('taskDialogBody').querySelector('.detail-deliverables') : null;
  if (section) section.scrollIntoView({ behavior: 'instant', block: 'center' });
  });
}

async function confirmTaskDialogExit() {
  if (detailProgressSaveBusy) { showToast('正在保存学习进度，请稍候'); return false; }
  if (!detailProgressDirty) return true;
  return confirmAction({ title: '放弃未保存的进度？', message: isExternalConfirmation(taskById.get(detailTaskId)) ? '沟通记录尚未保存。离开详情后，本次填写的内容不会保留。' : '本次编辑尚未保存。离开任务详情后，填写的观看位置、时长或步骤不会保留。', label: '放弃编辑', danger: true });
}

async function closeTaskDetails() {
  if (!await confirmTaskDialogExit()) return;
  checkpointLocation();
  detailProgressDirty = false;
  $('taskDialog').close();
}

async function navigateToPrerequisite(id) {
  const task = taskById.get(id);
  if (!task) return;
  if (!await confirmTaskDialogExit()) return;
  checkpointLocation();
  detailOpenerFocus = null;
  detailProgressDirty = false;
  await closeLocationDialogs();
  changeLocation(() => {
    taskFilter = 'all'; trackFilter = task.track; searchQuery = '';
    selectWeek(task.week);
  });
  requestAnimationFrame(() => {
    focusPlannerTask(id);
    checkpointLocation();
  });
}

function taskPrerequisiteMarkup(task) {
  const required = requiredTasks((task.prerequisiteTaskIds || []).map(id => taskById.get(id)).filter(Boolean));
  const career = task.track === 'review';
  // Career requires all learning; summarize its course gate rather than listing
  // every original Zero Voice session again in each interview task.
  const visible = career ? required.filter(item => item.track !== 'ls') : required;
  const learning = career ? requiredLearningTasks() : [];
  if (!required.length && !career) return '';
  const explanation = career
    ? `全部学习 ${learning.filter(item => taskDone(item.id)).length} / ${learning.length} 项已打卡；课程、项目实践与最终自测完成后，再统一准备面试求职。`
    : '可查看前置任务；本项目内可提前推进，开始下一项目应先完成前一项目。';
  return `<section class="detail-prerequisites"><h4>前置任务</h4><p>${explanation}</p>${visible.length ? `<ul>${visible.map(item => `<li><button type="button" data-prerequisite-task-id="${escapeHTML(item.id)}">${escapeHTML(displayTitle(item))}${icon('arrow')}</button><span class="badge${taskDone(item.id) ? ' done' : ''}">${taskDone(item.id) ? '已打卡' : '待完成'}</span></li>`).join('')}</ul>` : ''}</section>`;
}

function renderTaskDetails() {
  const task = taskById.get(detailTaskId);
  if (!task) return;
  $('taskDialogTitle').textContent = isExternalConfirmation(task) ? '老师沟通与简历确认' : task.track === 'ls' ? task.activity === 'review' ? '零声复盘' : task.activity === 'practice' ? '零声练习任务' : '本次零声课程'
    : task.track === 'ydy' ? taskLearningSegments(task).length ? '易道云课程与实践' : '易道云项目实践' : task.track === 'review' ? isCareerPreparation(task) ? '沟通材料整理' : '面试准备' : '学习任务';
  const related = task.prerequisiteLessonIds?.map(id => {
    const lesson = lessonById.get(id);
    const parts = allTasks.filter(task => task.segments?.some(segment => segment.lessonId === id));
    const done = parts.length > 0 && parts.every(task => taskDone(task.id));
    return `<li>${escapeHTML(lesson?.title || '相关课程')}<span class="badge${done ? ' done' : ''}">${done ? '已完成' : '待学习'}</span></li>`;
  }).join('');
  const prerequisiteMarkup = taskPrerequisiteMarkup(task);
  const segments = taskLearningSegments(task);
  const detailActivity = activityLabel(task);
  const segmentTitle = task.activity === 'practice' && Number(task.budget?.videoMinutes) === 0 ? '复现对应课节' : '本次课节与观看区间';
  const summary = taskDetailSummary(task);
  $('taskDialogBody').innerHTML = `<div class="detail-meta"><span class="track ${task.track}">${escapeHTML(displayTrackName(task))}</span><span>${taskPlanDateLabel(task)}${task.onDemand || taskWorkSessions(task).length || !task.day ? '' : ` · ${task.day}`}</span><span>${escapeHTML(taskDuration(task))}</span>${detailActivity && detailActivity !== displayTrackName(task) ? `<span>${escapeHTML(detailActivity)}</span>` : ''}</div><h3 class="detail-title">${escapeHTML(task.title)}</h3>${summary ? `<p class="detail-summary">${escapeHTML(summary)}</p>` : ''}${!isRequiredTask(task) ? `<p class="detail-hint">${optionalTaskHint()}</p>` : ''}${courseAccessMarkup(task)}${taskWorkSessionsMarkup(task)}${taskModuleSpecificationMarkup(task)}${taskBudgetMarkup(task)}${taskProgressMarkup(task)}${segments.length ? `<section class="detail-section detail-learning"><h4>${segmentTitle}</h4>${segmentMarkup(task)}</section>` : ''}${taskStepsMarkup(task)}${prerequisiteMarkup}${related ? '<div class="detail-related"><h4>相关课程</h4><ul>' + related + '</ul></div>' : ''}${legacyTaskRecordMarkup(task)}${taskDone(task.id) ? '<p class="detail-hint">记录更新 · ' + formatSyncTime(taskEntry(task.id)?.updatedAt) + '</p>' : ''}`;
  updateTaskDetailStatus(task);
  detailProgressBase = JSON.stringify(taskProgress(task.id) || null);
  detailProgressInitialForm = JSON.stringify(taskProgressFormSnapshot());
  detailProgressDirty = false;
}

function updateTaskDetailStatus(task = taskById.get(detailTaskId)) {
  if (!task) return;
  const done = taskDone(task.id);
  $('detailTaskStatus').textContent = isExternalConfirmation(task) ? done ? '沟通与简历已确认' : taskProgressNote(task) ? '已存沟通记录 · 待简历确认' : '待沟通与简历确认' : done ? '已打卡' : taskProgressNote(task) ? '已存部分进度 · 尚未打卡' : '尚未打卡';
  $('detailToggleBtn').textContent = done ? '取消完成' : isExternalConfirmation(task) ? '沟通完成并确认简历' : '标记完成';
  $('detailToggleBtn').disabled = !done && isUnscheduledCareerTask(task) && careerTaskBlocked(task);
  $('detailToggleBtn').setAttribute('aria-pressed', String(done));
}

function taskProgressFormSnapshot() {
  const kind = $('taskDialogBody').querySelector('[data-progress-kind]')?.dataset.progressKind;
  if (kind === 'external') return { kind, note: $('taskProgressNote').value };
  if (kind === 'video') return { kind, segment: $('videoSegmentSelect').value, position: $('videoPositionText').value };
  if (kind === 'practice') return { kind, workedTotal: $('practiceWorkedTotal').value, session: $('practiceSessionMinutes').value,
    steps: Array.from($('taskDialogBody').querySelectorAll('[data-progress-step]:checked'), input => input.dataset.progressStep), note: $('taskProgressNote').value };
  return null;
}

function updateTaskProgressConflict() {
  updateTaskDetailStatus();
  const panel = $('taskProgressConflict');
  if (!panel || !detailTaskId) return false;
  const conflict = detailProgressDirty && JSON.stringify(taskProgress(detailTaskId) || null) !== detailProgressBase;
  panel.hidden = !conflict;
  if (conflict) $('detailTaskStatus').textContent = '同步进度已更新 · 当前草稿未覆盖';
  return conflict;
}

function markTaskProgressDirty() {
  detailProgressDirty = JSON.stringify(taskProgressFormSnapshot()) !== detailProgressInitialForm;
  for (const button of $('taskDialogBody').querySelectorAll('[data-progress-action^="save-"]')) button.disabled = !detailProgressDirty || detailProgressSaveBusy;
  if (!detailProgressDirty && JSON.stringify(taskProgress(detailTaskId) || null) !== detailProgressBase) { renderTaskDetails(); return; }
  updateTaskProgressConflict();
}

function videoSegmentBounds(task, index) {
  const segment = taskLearningSegments(task)[index];
  if (!segment) return null;
  const start = Math.max(0, Math.round(Number(segment.startSecond) || 0));
  return { start, end: Math.max(start, Math.round(Number(segment.endSecond) || 0)) };
}

function setVideoProgressSegment(index) {
  const task = taskById.get(detailTaskId);
  const bounds = task && videoSegmentBounds(task, index);
  if (!bounds) return;
  $('videoPositionInput').min = String(bounds.start);
  $('videoPositionInput').max = String(bounds.end);
  $('videoPositionInput').value = String(bounds.start);
  $('videoPositionText').value = clockSecond(bounds.start);
  $('videoPositionValue').textContent = clockSecond(bounds.start);
  $('videoPositionHint').textContent = `本节范围 ${clockSecond(bounds.start)} – ${clockSecond(bounds.end)}，填原视频上的时间。`;
  const scale = $('videoPositionInput').nextElementSibling;
  if (scale) { scale.firstElementChild.textContent = clockSecond(bounds.start); scale.lastElementChild.textContent = clockSecond(bounds.end); }
  markTaskProgressDirty();
}

function parseClockPosition(value) {
  const parts = String(value).trim().split(':');
  if ((parts.length !== 2 && parts.length !== 3) || parts.some(part => !/^\d+$/.test(part))) return NaN;
  const numbers = parts.map(Number);
  if (numbers.at(-1) > 59 || numbers.at(-2) > 59 && parts.length === 3) return NaN;
  return parts.length === 3 ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2] : numbers[0] * 60 + numbers[1];
}

async function saveTaskProgressDraft(force = false) {
  if (detailProgressSaveBusy || !detailProgressDirty || !$('taskDialog').open) return;
  const id = detailTaskId;
  const task = taskById.get(id);
  if (!task) return;
  const sessionId = detailProgressSession;
  const formBeforeSync = JSON.stringify(taskProgressFormSnapshot());
  const versionAtChoice = JSON.stringify(taskProgress(id) || null);
  detailProgressSaveBusy = true;
  markTaskProgressDirty();
  updateHistoryControls();
  try {
    if (navigator.onLine) await syncToServer({ silent: true });
    if (sessionId !== detailProgressSession || detailTaskId !== id || !$('taskDialog').open) return;
    if (JSON.stringify(taskProgressFormSnapshot()) !== formBeforeSync) {
      showToast('同步期间又编辑了进度，请再次保存', null, 'error'); return;
    }
    const latestVersion = JSON.stringify(taskProgress(id) || null);
    if (force && latestVersion !== versionAtChoice) {
      updateTaskProgressConflict();
      showToast('刚收到更新的进度，请再次确认要覆盖', null, 'error'); return;
    }
    if (updateTaskProgressConflict() && !force) { $('taskProgressConflict').querySelector('button')?.focus(); return; }
    const base = JSON.parse(detailProgressBase) || {};
    const kind = $('taskDialogBody').querySelector('[data-progress-kind]')?.dataset.progressKind;
    let progress;
    if (kind === 'video') {
      const index = Number($('videoSegmentSelect').value);
      const bounds = videoSegmentBounds(task, index);
      const position = parseClockPosition($('videoPositionText').value);
      if (!bounds || !Number.isInteger(position) || position < bounds.start || position > bounds.end) {
        showToast('时间点需位于当前课节的观看范围内', null, 'error'); $('videoPositionText').focus(); return;
      }
      progress = { ...(base.kind === 'video' ? base : {}), kind: 'video', segmentIndex: index, positionSecond: position };
    } else if (kind === 'external') {
      progress = { kind: 'practice', note: $('taskProgressNote').value.trim() };
    } else if (kind === 'practice') {
      const correctedTotalText = $('practiceWorkedTotal').value;
      const correctedTotal = Number(correctedTotalText);
      if (!/^\d+$/.test(correctedTotalText) || correctedTotal > 100000) {
        showToast('此前累计须为 0–100000 的整数分钟', null, 'error'); $('practiceWorkedTotal').focus(); return;
      }
      const minutes = Number($('practiceSessionMinutes').value);
      const limit = practiceRecordingLimit(correctedTotal);
      if (!/^\d+$/.test($('practiceSessionMinutes').value) || !Number.isInteger(minutes) || minutes < 0 || minutes > limit || correctedTotal + minutes > 100000) {
        showToast(`本次请输入 0–${limit} 分钟`, null, 'error'); $('practiceSessionMinutes').focus(); return;
      }
      const prior = base.kind === 'practice' ? base : {};
      const completedSteps = Array.from($('taskDialogBody').querySelectorAll('[data-progress-step]:checked'), input => Number(input.dataset.progressStep));
      progress = { ...prior, kind: 'practice', workedMinutes: correctedTotal + minutes,
        completedSteps, note: $('taskProgressNote').value.trim() };
    } else return;
    detailProgressDirty = false;
    detailProgressEditing = false;
    if (saveTaskProgress(id, progress) && taskDone(id)) {
      $('taskDialogBody').querySelector('[data-progress-action="edit"]')?.focus({ preventScroll: true });
    }
  } finally {
    detailProgressSaveBusy = false;
    if ($('taskDialog').open && detailTaskId === id) markTaskProgressDirty();
    updateHistoryControls();
  }
}

async function cancelTaskProgressEditing() {
  if (!detailProgressEditing || !$('taskDialog').open) return true;
  if (!await confirmTaskDialogExit()) return false;
  detailProgressDirty = false;
  detailProgressEditing = false;
  renderTaskDetails();
  $('editTaskProgressBtn')?.focus({ preventScroll: true });
  return true;
}

let practiceSessionTaskId = '';
let practiceSessionDate = '';
let practiceSessionInitialValue = '';
let practiceSessionOpeningFocus = null;
let practiceSessionEpoch = 0;
let practiceSessionSaveBusy = false;

function openPracticeSessionDialog(id) {
  const task = taskById.get(id);
  const dialog = $('practiceSessionDialog');
  if (!dialog || dialog.open || !supportsPracticeProgress(task) || taskDone(id)) return;
  if (isRelativeCareerTask(task) && careerTaskBlocked(task)) { showToast('请先与老师沟通并确认定制简历，再进行面试准备', null, 'error'); return; }
  const worked = Math.max(0, Number(taskProgress(id)?.workedMinutes) || 0);
  const limit = practiceRecordingLimit(worked);
  if (!limit) { showToast('累计记录已达上限，请在任务详情核对或修正记录', null, 'error'); return; }
  practiceSessionTaskId = id;
  practiceSessionDate = todayISO();
  practiceSessionInitialValue = String(practiceSessionMinutes(task));
  practiceSessionOpeningFocus = document.activeElement;
  practiceSessionEpoch++;
  $('practiceSessionTitle').textContent = task.title;
  $('practiceSessionInput').min = '1';
  $('practiceSessionInput').max = String(limit);
  $('practiceSessionInput').value = practiceSessionInitialValue;
  $('savePracticeSessionBtn').disabled = false;
  $('practiceSessionHint').textContent = `建议本次 ${formatDuration(practiceSessionMinutes(task))} · 按实际投入记录 · 此前累计 ${formatDuration(worked)} · 原任务计划 ${taskDuration(task)}`;
  openAppDialog(dialog);
  $('practiceSessionInput').focus();
  $('practiceSessionInput').select();
}

async function closePracticeSessionDialog({ force = false } = {}) {
  const dialog = $('practiceSessionDialog');
  if (!dialog?.open) return true;
  if (practiceSessionSaveBusy && !force) { showToast('正在保存实践时长，请稍候'); return false; }
  if (!force && $('practiceSessionInput').value !== practiceSessionInitialValue) {
    const discard = await confirmAction({ title: '放弃本次实践时长？', message: '填写的分钟数还未保存。关闭后仍保留此前的实践记录。', label: '放弃填写' });
    if (!discard) return false;
  }
  const id = practiceSessionTaskId;
  const opener = practiceSessionOpeningFocus;
  practiceSessionEpoch++;
  practiceSessionTaskId = '';
  practiceSessionDate = '';
  practiceSessionInitialValue = '';
  practiceSessionOpeningFocus = null;
  dialog.close();
  moveToastToActiveDialog();
  requestAnimationFrame(() => {
    const card = $('todayBox').querySelector(`[data-task-id="${CSS.escape(id)}"]`)
      || $('continueBox').querySelector(`[data-task-id="${CSS.escape(id)}"]`);
    const fallback = card?.querySelector('[data-progress-action="record-session"]')
      || card?.querySelector('[data-task-action="details"]')
      || (opener?.isConnected ? opener : null)
      || $('continueTrackTabs').querySelector('[aria-pressed="true"]');
    fallback?.focus({ preventScroll: true });
  });
  return true;
}

async function savePracticeSessionDialog() {
  const dialog = $('practiceSessionDialog');
  const id = practiceSessionTaskId;
  const task = taskById.get(id);
  if (!dialog?.open || !task || practiceSessionSaveBusy || activeContinueSessionSaves.has(id)) return false;
  const input = $('practiceSessionInput');
  const raw = input.value.trim();
  const minutes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(minutes) || minutes < 1) {
    $('practiceSessionHint').textContent = '请输入至少 1 分钟的实际投入时间。';
    input.focus(); return false;
  }
  const date = practiceSessionDate;
  const epoch = practiceSessionEpoch;
  practiceSessionSaveBusy = true;
  updateHistoryControls();
  activeContinueSessionSaves.add(id);
  $('savePracticeSessionBtn').disabled = true;
  try {
    if (navigator.onLine) await syncToServer({ silent: true });
    if (!dialog.open || practiceSessionTaskId !== id || practiceSessionEpoch !== epoch) return false;
    if (input.value.trim() !== raw) {
      $('practiceSessionHint').textContent = '同步期间分钟数发生了变化，请重新确认并保存。';
      input.focus(); return false;
    }
    // A refreshed recommendation cannot change the task recorded by this open session.
    if (date !== todayISO() || taskDone(id)) {
      $('practiceSessionHint').textContent = '学习安排已更新，请查看当前任务；填写的分钟数尚未丢失。';
      return false;
    }
    const limit = practiceRecordingLimit(Math.max(0, Number(taskProgress(id)?.workedMinutes) || 0));
    input.max = String(limit);
    if (minutes > limit) {
      $('practiceSessionHint').textContent = `同步后此前累计 ${formatDuration(100000 - limit)}，本次可记 ${limit} 分钟；请调整分钟数再保存。`;
      input.focus(); return false;
    }
    const prior = taskProgress(id);
    const progress = prior?.kind === 'practice' ? prior : { kind: 'practice', workedMinutes: 0, completedSteps: [] };
    const workedMinutes = (Number(progress.workedMinutes) || 0) + minutes;
    if (workedMinutes > 100000 || !saveTaskProgress(id, { ...progress, kind: 'practice', workedMinutes })) {
      $('practiceSessionHint').textContent = '本次记录未保存，请检查分钟数后重试。';
      return false;
    }
    await closePracticeSessionDialog({ force: true });
    return true;
  } finally {
    practiceSessionSaveBusy = false;
    updateHistoryControls();
    activeContinueSessionSaves.delete(id);
    if (dialog.open) $('savePracticeSessionBtn').disabled = false;
  }
}

function recordContinueSession(id) { openPracticeSessionDialog(id); }

function updateSyncUI() {
  $('syncStatus').textContent = persistenceError ? '浏览器保存失败' : syncState.status;
  $('syncStatus').dataset.state = persistenceError || syncState.authRejected ? 'error' : syncState.busy ? 'busy' : syncState.reachable ? 'connected' : 'offline';
  $('sidebarSyncText').textContent = persistenceError ? '请同步或导出备份' : syncState.busy ? '正在同步' : syncState.authRejected ? '请更新同步口令' : syncState.authRequired && !getStoredApiKey() ? '等待同步口令' : syncState.reachable ? '已连接同步' : syncState.reachable === null ? '正在连接' : '本地保存';
  $('syncBtn').disabled = syncState.busy;
  $('syncBtn').textContent = syncState.busy ? '正在同步…' : '立即同步';
  $('setKeyBtn').textContent = getStoredApiKey() ? '更新口令' : '保存口令';
  $('syncHint').textContent = persistenceError
    ? '当前浏览器无法写入本地记录。请立即同步或导出备份，避免关闭页面后丢失进度。'
    : syncState.authRejected ? '同步口令不正确。更新口令后会重新同步，本机进度已保留。'
    : syncState.authRequired && !getStoredApiKey() ? '服务器需要同步口令。保存口令后，会自动同步当前进度。'
    : !syncState.reachable ? '打卡先保存在当前设备，恢复连接后会继续同步。'
    : state.pendingReplace ? '备份已在本机恢复，等待同步到其他设备。'
    : syncState.lastSyncedAt ? `最近同步：${formatSyncTime(syncState.lastSyncedAt)}。打卡会自动保存和同步。`
    : '打卡会自动保存，并与其他设备同步。';
}

function apiUrl(path) { return `api/${String(path).replace(/^\/+/, '')}`; }

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let payload;
    try { payload = await response.json(); }
    catch {
      const error = new Error('服务器响应不是有效 JSON');
      error.status = response.status;
      throw error;
    }
    if (!response.ok) { const error = new Error(payload?.message || '请求未成功'); error.status = response.status; throw error; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('服务器响应格式不正确');
    return payload;
  } finally { clearTimeout(timer); }
}

function clearSyncRetry() {
  if (syncRetryTimer !== null) clearTimeout(syncRetryTimer);
  syncRetryTimer = null;
}

function scheduleSyncRetry() {
  if (syncRetryTimer !== null || !navigator.onLine || syncState.authRejected || (syncState.authRequired && !getStoredApiKey())) return;
  const delay = Math.min(1000 * 2 ** syncRetryAttempt, 60000);
  syncRetryAttempt = Math.min(syncRetryAttempt + 1, 6);
  syncRetryTimer = setTimeout(async () => {
    syncRetryTimer = null;
    if (!navigator.onLine) return;
    await loadServerConfig();
    if (syncState.reachable) syncToServer({ silent: true });
  }, delay);
}

function validateSyncResponse(payload, snapshot) {
  const entries = payload?.state?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || !isValidIso(payload.serverTime)) {
    throw new Error('同步响应缺少有效状态');
  }
  for (const record of Object.values(entries)) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.done !== 'boolean' || !isValidIso(record.updatedAt)
      || (record.evidence !== undefined && (typeof record.evidence !== 'string' || record.evidence.length > 4000))
      || (record.progress !== undefined && !validTaskProgress(record.progress))) {
      throw new Error('同步响应包含无效记录');
    }
  }
  for (const [id, record] of Object.entries(snapshot)) {
    const confirmed = entries[id];
    if (!confirmed || Date.parse(confirmed.updatedAt) < Date.parse(record.updatedAt)
      || (Date.parse(confirmed.updatedAt) === Date.parse(record.updatedAt) && record.progress && !confirmed.progress)) {
      throw new Error('同步响应未确认本机记录');
    }
  }
  return entries;
}

async function loadServerConfig() {
  try {
    const config = await fetchJSON(apiUrl('config'));
    if (typeof config.authRequired !== 'boolean') throw new Error('同步配置格式不正确');
    syncState.authRequired = !!config.authRequired;
    syncState.reachable = true;
    syncState.status = syncState.authRequired && !getStoredApiKey() ? '请设置同步口令' : '已连接同步服务';
  } catch {
    syncState.reachable = false;
    syncState.status = '当前保存在本机';
    scheduleSyncRetry();
  }
  updateSyncUI();
}

function syncToServer({ silent = false, replace = false } = {}) {
  clearSyncRetry();
  if (replace) {
    const marker = readReplaceMarker();
    if (!marker || marker.status !== 'pending' || marker.id !== replacementToken) beginReplacement();
    replaceRequested = true;
    state.pendingReplace = true;
    saveState();
  }
  lastVisibleSyncAt = Date.now();
  syncRequested = true;
  if (activeSyncPromise) return activeSyncPromise;
  activeSyncPromise = runSyncLoop(silent).finally(() => {
    activeSyncPromise = null;
    syncState.busy = false;
    updateSyncUI();
    if (syncRequested) syncToServer({ silent: true });
  });
  return activeSyncPromise;
}

async function syncVisibleState() {
  if (document.hidden || !navigator.onLine || syncState.busy || activeSyncPromise || syncState.authRejected
    || (syncState.authRequired && !getStoredApiKey()) || Date.now() - lastVisibleSyncAt < 15000) return;
  lastVisibleSyncAt = Date.now();
  if (!syncState.reachable) await loadServerConfig();
  if (syncState.reachable && !(syncState.authRequired && !getStoredApiKey())) syncToServer({ silent: true });
}

async function runSyncLoop(silent) {
  let success = false;
  while (syncRequested) {
    syncRequested = false;
    if (syncState.authRequired && !getStoredApiKey()) {
      syncState.status = '请设置同步口令';
      if (!silent) showToast('先保存同步口令，再同步进度', { label: '设置口令', run: openSyncDialog }, 'error');
      break;
    }
    if (!navigator.onLine) { syncState.reachable = false; syncState.status = '离线，进度保存在本机'; break; }
    syncState.busy = true;
    syncState.status = '正在同步进度';
    updateSyncUI();
    let pending = readReplaceMarker();
    if (pending && (pending.id !== replacementToken || pending.revision !== replacementRevision || pending.status !== replacementStatus)) {
      adoptReplacementMarker(pending);
      pending = readReplaceMarker();
    }
    const mode = pending?.status === 'pending' || replaceRequested || state.pendingReplace ? 'replace' : 'merge';
    replaceRequested = false;
    const revision = localRevision;
    const epoch = replaceEpoch;
    const sentMarkerId = pending?.id || '';
    const sentMarkerRevision = pending?.revision ?? -1;
    const sentMarkerStatus = pending?.status || '';
    const sentKey = getStoredApiKey();
    const snapshot = { ...state.entries };
    try {
      const payload = await fetchJSON(apiUrl('sync'), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sentKey ? { 'x-api-key': sentKey } : {}) }, body: JSON.stringify({ mode, state: { entries: snapshot } }) });
      const confirmedEntries = validateSyncResponse(payload, snapshot);
      const latestMarker = readReplaceMarker();
      const markerChanged = (latestMarker?.id || '') !== sentMarkerId
        || (latestMarker?.revision ?? -1) !== sentMarkerRevision
        || (latestMarker?.status || '') !== sentMarkerStatus;
      if (epoch !== replaceEpoch || markerChanged) {
        if (latestMarker) adoptReplacementMarker(latestMarker);
        syncRequested = true;
        continue;
      }
      state.entries = mergeEntryMaps(state.entries, normalizeState({ entries: confirmedEntries }).entries);
      if (mode === 'replace') {
        const acknowledged = { id: sentMarkerId, generation: pending?.generation || 0,
          status: 'ack', revision: sentMarkerRevision, entries: state.entries };
        if (!writeReplaceMarker(acknowledged)) throw new Error('无法保存备份恢复确认');
        state.pendingReplace = false;
        replaceRequested = false;
      }
      state.lastSyncedAt = payload.serverTime || new Date().toISOString();
      syncState.lastSyncedAt = state.lastSyncedAt;
      saveState({ authoritativeReplacement: mode === 'replace', fromSync: true });
      if (mode === 'replace' && state.pendingReplace) {
        syncRequested = true;
        continue;
      }
      render();
      syncState.reachable = true;
      syncState.authRejected = false;
      syncState.status = '进度已同步';
      syncRetryAttempt = 0;
      clearSyncRetry();
      success = true;
      if (localRevision > revision) syncRequested = true;
    } catch (error) {
      const latestMarker = readReplaceMarker();
      if ((latestMarker?.id || '') !== sentMarkerId || (latestMarker?.revision ?? -1) !== sentMarkerRevision
        || (latestMarker?.status || '') !== sentMarkerStatus) {
        if (latestMarker) adoptReplacementMarker(latestMarker);
        syncRequested = true;
        continue;
      }
      if (mode === 'replace' && latestMarker?.status === 'pending') { state.pendingReplace = true; replaceRequested = true; saveState(); }
      if (error.status === 401 && sentKey !== getStoredApiKey()) { syncRequested = true; continue; }
      syncRequested = false;
      success = false;
      if (error.status === 401) {
        clearSyncRetry();
        syncRetryAttempt = 0;
        syncState.authRequired = true;
        syncState.authRejected = true;
        syncState.status = '同步口令不正确';
        if (!silent) showToast('同步口令不正确，请更新口令', null, 'error');
      } else {
        syncState.reachable = false;
        syncState.status = '同步未完成，进度保留在本机';
        if (!(error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)) scheduleSyncRetry();
        if (!silent) showToast('同步暂未完成，本地记录已保留', null, 'error');
      }
      break;
    }
  }
  if (success && !silent) showToast('进度已同步');
  return success;
}

function openSyncDialog() {
  $('apiKeyInput').value = getStoredApiKey();
  $('apiKeyInput').type = 'password';
  $('keyVisibilityBtn').textContent = '显示';
  $('keyVisibilityBtn').setAttribute('aria-label', '显示口令');
  $('keyVisibilityBtn').setAttribute('aria-pressed', 'false');
  updateSyncUI();
  if (!$('syncDialog').open) openAppDialog($('syncDialog'));
}

async function saveApiKey(event) {
  event.preventDefault();
  const saved = setStoredApiKey($('apiKeyInput').value.trim());
  showToast(saved ? '同步口令已保存' : '口令仅保留在当前页面，浏览器无法保存', null, saved ? 'success' : 'error');
  await loadServerConfig();
  if (!syncState.authRequired || getStoredApiKey()) await syncToServer({ silent: true });
}

function confirmAction({ title, message, label = '确认', danger = false }) {
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmAcceptBtn').textContent = label;
  $('confirmAcceptBtn').classList.toggle('danger', danger);
  openAppDialog($('confirmDialog'));
  $('confirmCancelBtn').focus();
  return new Promise(resolve => { confirmationResolver = resolve; });
}

function finishConfirmation(accepted) {
  const resolve = confirmationResolver;
  confirmationResolver = null;
  $('confirmDialog').close();
  if (resolve) resolve(accepted);
}

function strictTaskSignature(task) { return [task.track || '', task.day || '', task.title || '', task.date || ''].join('||'); }
function looseTaskSignature(task) { return [task.track || '', task.day || '', task.title || ''].join('||'); }

function resolveTaskFromSnapshot(snapshot) {
  if (!snapshot) return null;
  if (taskById.has(snapshot.id)) return taskById.get(snapshot.id);
  if (snapshot.track === 'ls' || /^w\d{2}-周[一二三四五六日]-ls$/.test(snapshot.id || '')) return null;
  const strict = allTasks.filter(task => strictTaskSignature(task) === strictTaskSignature(snapshot));
  if (strict.length === 1) return strict[0];
  const loose = allTasks.filter(task => looseTaskSignature(task) === looseTaskSignature(snapshot));
  return loose.length === 1 ? loose[0] : null;
}

function importStateWithReport(data) {
  for (const key of ['entries', 'archivedEntries']) {
    if (data?.[key] === undefined) continue;
    if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]) || Object.values(data[key]).some(record => !validEntryRecord(record))) throw new Error('Invalid backup records');
  }
  if (data?.entrySnapshots && (!Array.isArray(data.entrySnapshots) || data.entrySnapshots.some(item => !validEntryRecord(item?.record)))) throw new Error('Invalid backup snapshots');
  if (data?.milestoneReviews && (typeof data.milestoneReviews !== 'object' || Array.isArray(data.milestoneReviews) || Object.values(data.milestoneReviews).some(record => !validEntryRecord(record)))) throw new Error('Invalid milestone reviews');
  const normalized = normalizeState(data);
  const entries = {};
  const matchedTasks = new Set();
  let recognizedSources = 0;
  let reviewsMatched = 0;
  const archiveIds = new Set(Object.keys(data?.archivedEntries || {}));
  let sourceCount = Object.keys(normalized.entries).filter(id => !archiveIds.has(id) || taskById.has(id) || legacyTaskById.has(id) || isMilestoneEntryId(id) || isHistoricalMilestoneEntryId(id)).length;
  if (!sourceCount && Array.isArray(data?.entrySnapshots)) sourceCount = data.entrySnapshots.length;
  for (const [id, record] of Object.entries(normalized.entries)) {
    if (taskById.has(id)) { entries[id] = record; matchedTasks.add(id); recognizedSources++; }
    else if (legacyTaskById.has(id)) { entries[id] = record; recognizedSources++; }
    else if (isMilestoneEntryId(id) || isHistoricalMilestoneEntryId(id)) { entries[id] = record; reviewsMatched++; recognizedSources++; }
  }
  for (const [goalId, record] of Object.entries(data?.milestoneReviews || {})) {
    const id = `milestone:${goalId}`;
    sourceCount++;
    if (!isMilestoneEntryId(id) && !isHistoricalMilestoneEntryId(id)) continue;
    if (Object.hasOwn(entries, id)) { sourceCount--; continue; }
    entries[id] = typeof record === 'string' ? createEntry(true, record) : createEntry(record.done, record.updatedAt, record.evidence, record.progress);
    reviewsMatched++;
    recognizedSources++;
  }
  if (Array.isArray(data?.entrySnapshots)) {
    for (const item of data.entrySnapshots) {
      if (!item?.record) continue;
      const legacyId = item.task?.id || item.taskId;
      if (legacyTaskById.has(legacyId)) {
        if (!Object.hasOwn(entries, legacyId)) {
          entries[legacyId] = typeof item.record === 'string' ? createEntry(true, item.record) : createEntry(item.record.done, item.record.updatedAt, item.record.evidence, item.record.progress);
          recognizedSources++;
        }
        continue;
      }
      const task = resolveTaskFromSnapshot(item.task);
      if (!task || Object.hasOwn(entries, task.id)) continue;
      entries[task.id] = typeof item.record === 'string' ? createEntry(true, item.record) : createEntry(item.record.done, item.record.updatedAt, item.record.evidence, item.record.progress);
      matchedTasks.add(task.id); recognizedSources++;
    }
  }
  const activeMatchedTasks = new Set(matchedTasks);
  for (const task of allTasks) {
    const sources = legacyTaskRecords(task.id, entries);
    if (sources.length) matchedTasks.add(task.id);
    if (sources.some(source => !source.referenceOnly)) activeMatchedTasks.add(task.id);
  }
  const historyMatched = Object.keys(entries).filter(id => legacyTaskById.has(id)).length;
  return { entries, sourceCount, matched: matchedTasks.size, activeMatched: activeMatchedTasks.size, historyMatched,
    reviewsMatched, unmatched: Math.max(0, sourceCount - recognizedSources) };
}

function exportData() {
  // Do not turn a derived legacy result (or a blank placeholder) into an
  // explicit new-task override just by exporting it.
  const entries = Object.fromEntries(allTasks.filter(task => Object.hasOwn(state.entries, task.id) || !legacyTaskRecords(task.id).length)
    .map(task => [task.id, state.entries[task.id] || createEntry(false, new Date(0).toISOString())]));
  const archivedEntries = Object.fromEntries(Object.entries(state.entries).filter(([id]) => !taskById.has(id) && !isMilestoneEntryId(id)));
  const milestoneReviews = Object.fromEntries(milestoneEntryIds().map(id => [id.slice('milestone:'.length), state.entries[id] || createEntry(false, new Date(0).toISOString())]));
  const entrySnapshots = allTasks.filter(task => Object.hasOwn(entries, task.id)).map(task => ({ taskId: task.id, record: entries[task.id], task: { id: task.id, week: task.week, date: task.date, day: task.day, track: task.track, trackName: task.trackName, title: task.title } }));
  const blob = new Blob([JSON.stringify({ version: 3, exportedAt: new Date().toISOString(), planStart: DATA.weeks[0].start, planEnd: DATA.weeks.at(-1).end, entries, milestoneReviews, archivedEntries, entrySnapshots }, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `study-tracker-backup-${todayISO()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  showToast('备份已导出，包含当前任务与历史成果记录');
}

async function importData(file) {
  if (!file) return;
  let data, report;
  try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); report = importStateWithReport(data); }
  catch { showToast('备份格式或记录无效，进度未修改', null, 'error'); return; }
  if (!report.matched && !report.reviewsMatched && !report.historyMatched) { showToast(report.sourceCount ? '备份中的任务与当前排期不匹配，进度未修改' : '备份中没有可恢复的任务记录', null, 'error'); return; }
  const full = report.activeMatched === allTasks.length && report.unmatched === 0;
  const done = allTasks.filter(task => taskEntry(task.id, report.entries)?.done).length;
  const accepted = await confirmAction({ title: '恢复这份备份？', message: `匹配 ${report.matched} 项任务，其中 ${done} 项已完成。${report.historyMatched ? `\n包含 ${report.historyMatched} 项原始历史记录，按原时间保留。` : ''}${report.reviewsMatched ? `\n包含 ${report.reviewsMatched} 项历史成果记录。` : ''}${report.unmatched ? `\n另有 ${report.unmatched} 项与当前排期不匹配。` : ''}\n${full ? '这是一份完整备份，将恢复当前计划的全部打卡状态。' : '将合并匹配的记录，其他任务保持当前进度。'}`, label: '恢复备份' });
  if (!accepted) return;
  // An older complete backup can replace the new task IDs indirectly through
  // its archived sources. Undo must also restore every active task it removes.
  const previousIds = [...new Set([...Object.keys(report.entries), ...(full
    ? [...allTasks.map(task => task.id), ...Object.keys(state.entries).filter(id => legacyTaskById.has(id))] : [])])];
  const previous = Object.fromEntries(previousIds.map(id => [id, legacyTaskById.has(id) || isHistoricalMilestoneEntryId(id)
    ? state.entries[id] || null : taskEntry(id) || createEntry(false, new Date(0).toISOString())]));
  const storedBefore = readUndoStorage();
  const stamp = freshTimestamp();
  const restored = Object.fromEntries(Object.entries(report.entries).map(([id, record]) => [id, createEntry(record.done, legacyTaskById.has(id) || isHistoricalMilestoneEntryId(id) ? record.updatedAt : stamp, record.evidence, record.progress)]));
  if (full) {
    replaceEpoch++;
    const archives = mergeEntryMaps(state.entries, normalizeState({ entries: data.archivedEntries || {} }).entries);
    // A full older backup also replaces recognized intermediate generations.
    // Keeping a newer cancellation absent from that backup would mask its data.
    state.entries = { ...Object.fromEntries(Object.entries(archives).filter(([id]) => !taskById.has(id) && !legacyTaskById.has(id))), ...restored };
    state.pendingReplace = true;
    beginReplacement();
  } else state.entries = mergeEntryMaps(state.entries, restored);
  localRevision++;
  const saved = saveState(); render();
  showToast(saved ? `已恢复 ${report.matched} 项任务${report.reviewsMatched ? `与 ${report.reviewsMatched} 项成果记录` : ''}` : '备份已恢复，浏览器无法保存，请同步或导出备份', makeCompletionUndo(previous, saved, storedBefore), saved ? 'success' : 'error');
  syncToServer({ silent: true, replace: full });
}

function undoEntrySignature(record) {
  return record ? JSON.stringify(createEntry(record.done, record.updatedAt, record.evidence, record.progress)) : 'null';
}

function readUndoStorage() {
  try {
    localStorage.getItem(STORE_KEY);
    return loadState();
  } catch { return null; }
}

function makeCompletionUndo(snapshot, saved = true, storedBefore = null) {
  const before = JSON.parse(JSON.stringify(snapshot));
  const ids = Object.keys(before).filter(id => taskById.has(id) || legacyTaskById.has(id) || isMilestoneEntryId(id));
  const expected = Object.fromEntries(ids.map(id => [id, undoEntrySignature(state.entries[id])]));
  // A successful write only permits its own version. A failed write may still
  // have the older pre-operation record on disk, never a newly captured update.
  const storedBaseline = saved ? expected : storedBefore ? Object.fromEntries(ids.map(id => {
    const record = storedBefore.entries[id];
    const earlier = !record || Date.parse(record.updatedAt) <= Date.parse(before[id]?.updatedAt || new Date(0).toISOString());
    return [id, earlier ? undoEntrySignature(record) : expected[id]];
  })) : null;
  return { label: '撤销', run: () => restoreCompletion(before, expected, storedBaseline) };
}

function restoreCompletion(snapshot, expected, storedBaseline = null) {
  const records = Object.entries(snapshot).filter(([id]) => taskById.has(id) || legacyTaskById.has(id) || isMilestoneEntryId(id));
  if (!records.length) return;
  const stored = readUndoStorage();
  const conflict = expected && records.some(([id]) => {
    if (undoEntrySignature(state.entries[id]) !== expected[id]) return true;
    if (!stored) return false;
    const latestStored = undoEntrySignature(stored.entries[id]);
    const baseline = storedBaseline ? storedBaseline[id] : undoEntrySignature(snapshot[id]);
    return latestStored !== baseline && latestStored !== expected[id] && (storedBaseline !== null || latestStored !== 'null');
  });
  if (conflict) {
    showToast('记录已更新，本次未撤销', null, 'error');
    return;
  }
  // Include storage updates that may arrive before their cross-tab event.
  if (stored) {
    state.entries = mergeEntryMaps(stored.entries, state.entries);
    for (const [id, record] of Object.entries(stored.entries)) {
      if (undoEntrySignature(state.entries[id]) === undoEntrySignature(record)) observedEntries[id] = JSON.stringify(state.entries[id]);
    }
  }
  const stamp = freshTimestamp();
  for (const [id, record] of records) {
    if (legacyTaskById.has(id) && record === null) delete state.entries[id];
    else state.entries[id] = typeof record === 'boolean' ? createEntry(record, stamp)
      : createEntry(record?.done, legacyTaskById.has(id) ? record.updatedAt : stamp, record?.evidence, record?.progress);
  }
  // The existing replacement path can remove a raw intermediate-generation
  // override without leaving a false tombstone that hides older completion.
  const replacesLegacy = records.some(([id]) => legacyTaskById.has(id));
  if (replacesLegacy) beginReplacement();
  localRevision++;
  const saved = saveState(); render();
  syncToServer({ silent: true, ...(replacesLegacy ? { replace: true } : {}) });
  showToast(saved ? '已撤销，进度已恢复' : '进度已恢复，浏览器无法保存，请同步或导出备份', null, saved ? 'success' : 'error');
}

async function resetAllTasks() {
  const accepted = await confirmAction({ title: '清空当前计划的打卡？', message: '当前计划的所有任务会恢复为未完成，并同步到其他设备。操作后可以立即撤销。', label: '清空打卡', danger: true });
  if (!accepted) return;
  const previous = Object.fromEntries(allTasks.map(task => [task.id, taskEntry(task.id) || createEntry(false, new Date(0).toISOString())]));
  const storedBefore = readUndoStorage();
  const stamp = freshTimestamp();
  for (const task of allTasks) {
    const previousEntry = taskEntry(task.id);
    state.entries[task.id] = createEntry(false, stamp, previousEntry?.evidence, previousEntry?.progress);
  }
  localRevision++;
  const saved = saveState(); render();
  showToast(saved ? '当前计划的打卡已清空' : '打卡已清空，浏览器无法保存，请同步或导出备份', makeCompletionUndo(previous, saved, storedBefore), saved ? 'success' : 'error');
  syncToServer({ silent: true });
}

function bindActions() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', handleDialogClose);
  }
  document.querySelector('.brand').onclick = event => { event.preventDefault(); activateView('overview'); };
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (['navigationBackBtn', 'taskHistoryBackBtn'].includes(button.id)) navigatePositionHistory(-1);
    else if (['navigationForwardBtn', 'taskHistoryForwardBtn'].includes(button.id)) navigatePositionHistory(1);
    else if (button.dataset.overviewJump) jumpToSection(button.dataset.overviewJump === 'week' ? 'weeklyHeading' : 'progressHeading');
    else if (button.dataset.milestoneAnchor) jumpToSection({ projects: 'projectRoadmapHeading', parallel: 'parallelRoadmapHeading', application: 'applicationMilestone' }[button.dataset.milestoneAnchor]);
    else if (button.dataset.progressTotal) openProgressOutline(button.dataset.progressTotal, button.dataset.progressProject || '');
    else if (button.dataset.progressCompleted) openProgressRecords(button.dataset.progressCompleted, button.dataset.progressProject || '');
    else if (button.dataset.progressTrack) openProgressTarget(button.dataset.progressTrack);
    else if (button.dataset.progressProject) openProgressTarget('ydy', button.dataset.progressProject);
    else if (button.dataset.continueRecords) openProgressRecords(button.dataset.continueRecords, '', 'all');
    else if (button.dataset.continueTrack) {
      if (button.dataset.continueTrack === (continueTrackChoice || defaultContinueTrack())) return;
      changeLocation(() => { continueTrackChoice = button.dataset.continueTrack; renderContinue(); $(`continue-track-${continueTrackChoice}`)?.focus({ preventScroll: true }); });
    } else if (button.dataset.continueToday) {
      changeLocation(() => {
        const card = $('todayBox').querySelector(`[data-task-id="${CSS.escape(button.dataset.continueToday)}"]`);
        card?.scrollIntoView({ behavior: 'instant', block: 'center' });
        card?.querySelector('[data-task-action="details"]')?.focus({ preventScroll: true });
      }, { force: true });
    } else if (button.dataset.progressAction) {
      const action = button.dataset.progressAction;
      if (action === 'record-session') recordContinueSession(button.closest('[data-task-id]')?.dataset.taskId);
      else if (action === 'edit') {
        detailProgressEditing = true;
        renderTaskDetails();
        ($('videoPositionText') || $('practiceSessionMinutes') || $('taskProgressNote'))?.focus({ preventScroll: true });
      }
      else if (action === 'save-video' || action === 'save-practice') saveTaskProgressDraft();
      else if (action === 'cancel-edit') cancelTaskProgressEditing();
      else if (action === 'reload') {
        detailProgressDirty = false;
        renderTaskDetails();
        ($('videoPositionText') || $('practiceSessionMinutes') || $('taskProgressNote') || $('editTaskProgressBtn'))?.focus({ preventScroll: true });
      }
      else if (action === 'overwrite') saveTaskProgressDraft(true);
    } else if (button.dataset.progressPhase) {
      changeLocation(() => { selectedProgressPhase = button.dataset.progressPhase; savePreferences(); render(); });
    } else if (button.dataset.prerequisiteTaskId) {
      navigateToPrerequisite(button.dataset.prerequisiteTaskId);
    } else if (button.dataset.phase) {
      selectPhase(button.dataset.phase);

    } else if (button.dataset.taskAction) {
      const id = button.closest('[data-task-id]')?.dataset.taskId;
      if (button.closest('.task-outline-item')) outlineCursorTaskId = id;
      if (button.dataset.taskAction === 'toggle') toggleTask(id);
      else openTaskDetails(id, { segmentIndex: button.hasAttribute('data-detail-segment') ? Number(button.dataset.detailSegment) : undefined, section: button.dataset.detailSection });
    } else if (button.dataset.searchWeek) {
      changeLocation(() => {
        resetPlannerFilters(); selectWeek(Number(button.dataset.searchWeek));
        $('plannerView').scrollIntoView({ behavior: 'instant', block: 'start' }); plannerFocusTarget().focus({ preventScroll: true });
      });
    } else if (button.dataset.milestonePlan) {
      openMilestonePlan(button.dataset.milestonePlan);

    } else if (button.dataset.view) {
      const fromOverview = !!button.closest('#overviewView');
      if (button.id === 'weeklyPlanBtn') changeLocation(() => { resetPlannerFilters(); selectWeek(currentWeek().week); });
      else activateView(button.dataset.view);
      if (fromOverview && button.dataset.view === 'planner') plannerFocusTarget().focus({ preventScroll: true });
    } else if (button.dataset.week) {
      const fromWeekList = !!button.closest('#weekList');
      const fromOverview = !!button.closest('#overviewView');
      changeLocation(() => {
        if (button.dataset.track && availableTracks.has(button.dataset.track)) { trackFilter = button.dataset.track; taskFilter = 'all'; searchQuery = ''; }
        selectWeek(Number(button.dataset.week));
        if (button.dataset.planTask) focusPlannerTask(button.dataset.planTask);
        if (fromWeekList) $('plannerView').scrollIntoView({ behavior: 'instant', block: 'start' });
        if (fromOverview) plannerFocusTarget().focus({ preventScroll: true });
      });
    }
    else if (button.dataset.previewDay) {
      const date = button.dataset.previewDay;
      const week = DATA.weeks.find(week => week.start <= date && date <= week.end);
      changeLocation(() => { resetPlannerFilters(); selectWeek(week.week); });
      requestAnimationFrame(() => {
        $('day-' + date)?.scrollIntoView({ behavior: 'instant', block: 'center' });
        plannerFocusTarget().focus({ preventScroll: true });
        checkpointLocation();
      });
    } else if (button.hasAttribute('data-clear-filters')) clearFilters();
  });
  document.addEventListener('change', event => {
    if (!$('taskDialog').open) return;
    if (event.target.id === 'videoSegmentSelect') setVideoProgressSegment(Number(event.target.value));
    else if (event.target.id === 'practiceWorkedTotal') { updatePracticeSessionLimit(); markTaskProgressDirty(); }
    else if (event.target.matches('[data-progress-step]')) markTaskProgressDirty();
  });
  document.addEventListener('input', event => {
    if (!$('taskDialog').open) return;
    const target = event.target;
    if (target.id === 'videoPositionInput') {
      $('videoPositionText').value = clockSecond(Number(target.value));
      $('videoPositionValue').textContent = $('videoPositionText').value;
      markTaskProgressDirty();
    } else if (target.id === 'videoPositionText') {
      const value = parseClockPosition(target.value);
      const min = Number($('videoPositionInput').min), max = Number($('videoPositionInput').max);
      if (Number.isInteger(value) && value >= min && value <= max) { $('videoPositionInput').value = String(value); $('videoPositionValue').textContent = clockSecond(value); }
      markTaskProgressDirty();
    } else if (target.id === 'practiceWorkedTotal') { updatePracticeSessionLimit(); markTaskProgressDirty(); }
    else if (target.id === 'practiceSessionMinutes' || target.id === 'taskProgressNote') markTaskProgressDirty();
  });
  $('weekSelect').onchange = event => selectWeek(Number(event.target.value));
  $('weekPrevBtn').onclick = () => selectWeek(phaseWeeks()[phaseWeeks().indexOf(selectedWeekData()) - 1]?.week);
  $('weekNextBtn').onclick = () => selectWeek(phaseWeeks()[phaseWeeks().indexOf(selectedWeekData()) + 1]?.week);
  $('jumpFirstBtn').onclick = () => changeLocation(() => { resetPlannerFilters(); selectWeek(phaseWeeks()[0].week); });
  $('jumpTodayBtn').onclick = () => {
    const week = calendarWeek();
    if (week) changeLocation(() => { resetPlannerFilters(); selectWeek(week.week); });
  };
  $('taskSearch').oninput = event => changeLocation(() => {
    searchQuery = event.target.value;
    if (progressListScope && searchQuery.trim()) {
      progressListScope = null; progressListReturn = null;
      trackFilter = 'all'; taskFilter = 'all'; outlineCursorTaskId = '';
    }
    savePreferences(); renderPlanner();
  }, { kind: event.target.value ? 'search' : 'location' });
  $('taskFilter').onchange = event => changeLocation(() => changeOutlineFilter(event.target.value));
  $('trackFilter').onchange = event => changeLocation(() => { trackFilter = event.target.value; progressListScope = null; savePreferences(); renderPlanner(); });
  $('exitProgressListBtn').onclick = returnToProgressWeek;
  $('outlineWeekSelect').onchange = event => {
    const group = $('weekTasks').querySelector(`.outline-week-group[data-result-week="${Number(event.target.value)}"]`);
    const id = group?.querySelector('.task-outline-item')?.dataset.taskId;
    if (id) locateOutlineTask(id);
  };
  $('outlineNextPartialBtn').onclick = () => jumpToOutlineProgress(true);
  $('outlineNextPendingBtn').onclick = () => jumpToOutlineProgress(false);
  $('outlineExpandAllBtn').onclick = () => changeLocation(() => {
    const groups = Array.from($('weekTasks').querySelectorAll('.outline-week-group'));
    const expand = groups.some(group => !group.open);
    for (const group of groups) group.open = expand;
    rememberOutlineWeeks(); updateOutlineControls();
  }, { force: true });
  $('weekTasks').addEventListener('toggle', event => {
    if (event.target.isConnected && event.target.matches('[data-career-section]')) {
      rememberCareerSections(); checkpointLocation(); return;
    }
    if (!event.target.isConnected || !event.target.matches('.outline-week-group, .task-outline-content')) return;
    rememberOutlineWeeks(); updateOutlineControls(); savePreferences(); checkpointLocation();
  }, true);
  let outlineScrollTimer;
  window.addEventListener('scroll', () => {
    if (!outlineScrollReady || restoringLocation || selectedView !== 'planner' || !progressListScope) return;
    clearTimeout(outlineScrollTimer);
    outlineScrollTimer = setTimeout(saveOutlineScroll, 150);
  }, { passive: true });
  window.addEventListener('pagehide', saveOutlineScroll);
  $('clearFiltersBtn').onclick = clearFilters;
  $('openSyncBtn').onclick = openSyncDialog;
  $('closeSyncBtn').onclick = () => $('syncDialog').close();
  $('syncBtn').onclick = () => syncToServer();
  $('keyForm').onsubmit = saveApiKey;
  $('keyVisibilityBtn').onclick = () => { const show = $('apiKeyInput').type === 'password'; $('apiKeyInput').type = show ? 'text' : 'password'; $('keyVisibilityBtn').textContent = show ? '隐藏' : '显示'; $('keyVisibilityBtn').setAttribute('aria-label', show ? '隐藏口令' : '显示口令'); $('keyVisibilityBtn').setAttribute('aria-pressed', String(show)); };
  $('exportBtn').onclick = exportData;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = event => { const file = event.target.files[0]; event.target.value = ''; importData(file); };
  $('resetBtn').onclick = resetAllTasks;
  $('closeTaskBtn').onclick = closeTaskDetails;
  $('savePracticeSessionBtn').onclick = savePracticeSessionDialog;
  $('cancelPracticeSessionBtn').onclick = () => closePracticeSessionDialog();
  $('closePracticeSessionBtn').onclick = () => closePracticeSessionDialog();
  $('practiceSessionDialog').addEventListener('cancel', event => { event.preventDefault(); closePracticeSessionDialog(); });
  document.addEventListener('keydown', event => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); navigatePositionHistory(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  $('detailToggleBtn').onclick = () => {
    if (detailProgressDirty) { showToast('请先保存当前进度，再完成打卡', null, 'error'); $('taskDialogBody').querySelector('[data-progress-action^="save-"]')?.focus(); return; }
    toggleTask(detailTaskId);
  };
  $('taskDialog').addEventListener('cancel', event => { event.preventDefault(); closeTaskDetails(); });
  $('taskDialog').addEventListener('close', () => { if ($('taskDialog').open) return; detailTaskId = ''; detailProgressSession++; detailProgressDirty = false; detailProgressEditing = false; detailProgressBase = 'null'; detailProgressInitialForm = 'null'; restoreFocus(detailOpenerFocus); detailOpenerFocus = null; });
  $('confirmAcceptBtn').onclick = () => finishConfirmation(true);
  $('confirmCancelBtn').onclick = () => finishConfirmation(false);
  $('confirmDialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
  $('confirmDialog').addEventListener('close', () => { if (!$('confirmDialog').open && confirmationResolver) { const resolve = confirmationResolver; confirmationResolver = null; resolve(false); } });
  window.addEventListener('offline', () => { syncState.reachable = false; syncState.status = '离线，进度保存在本机'; updateSyncUI(); });
  window.addEventListener('online', async () => { await loadServerConfig(); if (syncState.reachable) syncToServer({ silent: true }); });
  window.addEventListener('storage', event => {
    if (event.key !== STORE_KEY && event.key !== REPLACE_STORE_KEY
      && !event.key?.startsWith(REPLACE_JOURNAL_PREFIX) || !event.newValue) return;
    const marker = readReplaceMarker();
    const markerChanged = marker && (marker.id !== replacementToken || marker.revision !== replacementRevision || marker.status !== replacementStatus);
    if (markerChanged) {
      replaceEpoch++;
      replacementToken = marker.id;
      replacementRevision = marker.revision;
      replacementStatus = marker.status;
      replaceRequested = marker.status === 'pending';
    }
    const incoming = loadState();
    state.entries = incoming.entries;
    state.pendingReplace = incoming.pendingReplace;
    observedEntries = entrySignatures(state.entries);
    render();
    if (markerChanged && marker.status === 'pending' && navigator.onLine && !syncState.authRejected) syncToServer({ silent: true });
  });
  let displayedDate = todayISO();
  const refreshDate = () => { const date = todayISO(); if (date !== displayedDate) { displayedDate = date; render(); } };
  window.addEventListener('focus', () => { refreshDate(); syncVisibleState(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshDate(); syncVisibleState(); } });
  setInterval(refreshDate, 60000);
  setInterval(syncVisibleState, 30000);
}

async function init() {
  if (state.pendingReplace && !readReplaceMarker()) beginReplacement();
  for (const saved of Array.isArray(preferences.outlineStates) ? preferences.outlineStates.slice(0, 100) : []) restoreOutlinePreferences(saved);
  if (preferences.outlineState?.scope === outlineScopeKey()) restoreOutlinePreferences(preferences.outlineState);
  bindActions(); render();
  const initialScope = outlineScopeKey();
  const revision = locationRevision;
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (selectedView === 'planner' && initialScope && outlineScopeKey() === initialScope && locationRevision === revision) {
    window.scrollTo({ top: outlineScrollStates.get(outlineStateKey()) || 0, behavior: 'instant' });
  }
  outlineScrollReady = true;
  rememberLocation();
  await loadServerConfig();
  if (syncState.reachable) await syncToServer({ silent: true });
}

init();
