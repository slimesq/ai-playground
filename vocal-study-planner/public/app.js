import { PHASES, LESSONS, DEFAULT_CONFIG, buildPlan, validateConfig } from './plan.js';
import { normalizeHistory, SYNC_BODY_LIMIT } from './journal.js';

const $ = id => document.getElementById(id);
const lessonById = new Map(LESSONS.map(lesson => [lesson.id, lesson]));
const phaseById = new Map(PHASES.map(phase => [phase.id, phase]));
const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const ACTIVE_KEY = 'vocal-study-planner:active-key';
const PROFILE_PREFIX = 'vocal-study-planner:profile:';
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_TIME = '1970-01-01T00:00:00.000Z';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="icons.svg#${name}"></use></svg>`;
function buttonLabel(id, label, name) { $(id).innerHTML = `${icon(name)}<span>${escape(label)}</span>`; }
let localAvailable = true;

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stored(key) {
  try { return localStorage.getItem(key); } catch { localAvailable = false; return null; }
}

function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

function dateLabel(value, year = false) {
  if (!value) return '待排期';
  return year ? `${value.slice(0, 4)}.${Number(value.slice(5, 7))}.${Number(value.slice(8, 10))}` : `${Number(value.slice(5, 7))} 月 ${Number(value.slice(8, 10))} 日`;
}

function validStamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function validateEntries(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('学习记录格式不正确');
  const result = {};
  for (const [id, value] of Object.entries(input)) {
    if (!lessonById.has(id) || !value || typeof value !== 'object' || Array.isArray(value)
      || !['pending', 'learning', 'done'].includes(value.status) || !Number.isInteger(value.minutes)
      || value.minutes < 0 || value.minutes > 100000 || typeof value.note !== 'string' || value.note.length > 4000
      || (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 160))
      || !validStamp(value.updatedAt)) throw new Error('备份包含无效的课程或学习记录');
    result[id] = { status: value.status, minutes: value.minutes, note: value.note, title: value.title || '', updatedAt: value.updatedAt, history: normalizeHistory(id, value) };
  }
  return result;
}

function emptyProfile() {
  return { config: validateConfig(DEFAULT_CONFIG), configUpdatedAt: ZERO_TIME, entries: {}, syncState: normalizeSyncState() };
}

function normalizeSyncState(raw, entries = {}, configUpdatedAt = ZERO_TIME) {
  const validVersion = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const state = { versions: { config: null, entries: {} }, pending: { config: null, entries: {} }, conflicts: { config: null, entries: {} } };
  if (!raw || typeof raw !== 'object' || !raw.versions || !raw.pending) {
    // Old profiles have no acknowledged server version. Never assume their offline edits are current.
    for (const id of Object.keys(entries)) state.pending.entries[id] = { expected: null, kind: 'edit' };
    if (configUpdatedAt !== ZERO_TIME) state.pending.config = { expected: null, kind: 'edit' };
    return state;
  }
  if (validVersion(raw.versions.config)) state.versions.config = raw.versions.config;
  for (const [id, version] of Object.entries(raw.versions.entries || {})) if (lessonById.has(id) && validVersion(version) && version !== null) state.versions.entries[id] = version;
  const pending = value => value && validVersion(value.expected) ? { expected: value.expected, kind: value.kind === 'undo' ? 'undo' : 'edit' } : null;
  state.pending.config = pending(raw.pending.config);
  for (const [id, value] of Object.entries(raw.pending.entries || {})) if (lessonById.has(id) && entries[id] && pending(value)) state.pending.entries[id] = pending(value);
  for (const [id, value] of Object.entries(raw.conflicts?.entries || {})) {
    if (!state.pending.entries[id]) continue;
    try { state.conflicts.entries[id] = value === null ? null : validateEntries({ [id]: value })[id]; } catch {}
  }
  if (state.pending.config && raw.conflicts?.config && validStamp(raw.conflicts.config.configUpdatedAt)) {
    try { state.conflicts.config = { config: raw.conflicts.config.config === null ? null : validateConfig(raw.conflicts.config.config), configUpdatedAt: raw.conflicts.config.configUpdatedAt }; } catch {}
  }
  return state;
}

function loadProfile(key) {
  try {
    const raw = stored(PROFILE_PREFIX + key);
    if (!raw) return emptyProfile();
    const value = JSON.parse(raw);
    const config = validateConfig(value.config);
    const configUpdatedAt = validStamp(value.configUpdatedAt) ? value.configUpdatedAt : ZERO_TIME;
    const entries = validateEntries(value.entries);
    return { config, configUpdatedAt, entries, syncState: normalizeSyncState(value.syncState, entries, configUpdatedAt) };
  } catch { return emptyProfile(); }
}

let studyKey = stored(ACTIVE_KEY);
if (!KEY_PATTERN.test(studyKey || '')) studyKey = newKey();
let profile = loadProfile(studyKey);
let plan = buildPlan(profile.config);
const phaseExpansion = new Map();
let selectedLesson = null;
let lessonFormBase = '';
let lessonRecordBase = '';
let stampFloor = 0;
let syncBusy = false;
let syncQueued = false;
let syncPullQueued = false;
let syncOnline = null;
let syncEpoch = 0;
let lastSyncedAt = '';
let toastTimer = null;
let toastReturnTarget = null;

function freshStamp() {
  const newest = Math.max(Date.parse(profile.configUpdatedAt) || 0, ...Object.values(profile.entries).map(entry => Date.parse(entry.updatedAt) || 0));
  stampFloor = Math.max(Date.now(), stampFloor + 1, newest + 1);
  return new Date(stampFloor).toISOString();
}

function persist() {
  try {
    localStorage.setItem(ACTIVE_KEY, studyKey);
    localStorage.setItem(PROFILE_PREFIX + studyKey, JSON.stringify(profile));
    localAvailable = true;
  } catch { localAvailable = false; }
  renderSyncStatus();
  updateSyncConflictControls();
}

function recordSignature(record) {
  return record ? JSON.stringify([record.status, record.minutes, record.note, record.title || '', new Date(record.updatedAt).toISOString(), record.history || []]) : null;
}

function historyTime(value) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

function combinedHistory(id, local, remote) {
  const items = new Map([...(remote?.history || []), ...(local.history || [])].map(item => [item.id, item]));
  return normalizeHistory(id, { history: Array.from(items.values()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) });
}

function configSignature(config, updatedAt) { return config ? JSON.stringify([validateConfig(config), updatedAt]) : null; }
function markPendingEntry(id, kind = 'edit') {
  const state = profile.syncState;
  state.pending.entries[id] = { expected: state.pending.entries[id] ? state.pending.entries[id].expected : state.versions.entries[id] ?? null, kind };
}
function markPendingConfig(kind = 'edit') {
  const state = profile.syncState;
  state.pending.config = { expected: state.pending.config ? state.pending.config.expected : state.versions.config, kind };
}
function syncConflictCount() { return Object.keys(profile.syncState.conflicts.entries).length + Number(Boolean(profile.syncState.conflicts.config)); }

function updateSyncConflictControls() {
  if (!$('syncConflictBanner')) {
    const banner = document.createElement('div');
    banner.id = 'syncConflictBanner'; banner.className = 'sync-conflict-banner'; banner.hidden = true;
    banner.innerHTML = '<p role="status"></p><button type="button" class="secondary-button">查看记录差异</button>';
    document.querySelector('.page-heading').after(banner);
    banner.querySelector('button').onclick = () => { updateSyncConflictControls(); showDialog('syncConflictDialog'); };
    const button = document.createElement('button'); button.type = 'button'; button.id = 'resolveSyncConflicts'; button.className = 'secondary-button'; button.textContent = '查看记录差异';
    $('syncNowBtn').after(button); button.onclick = banner.querySelector('button').onclick;
    const dialog = document.createElement('dialog'); dialog.id = 'syncConflictDialog'; dialog.className = 'app-dialog sync-conflict-dialog';
    dialog.setAttribute('aria-labelledby', 'syncConflictTitle');
    dialog.innerHTML = `<div class="dialog-header"><h2 id="syncConflictTitle">核对学习记录</h2><button type="button" class="icon-button" data-close="syncConflictDialog" aria-label="关闭记录差异">${icon('x')}</button></div><div class="dialog-body" id="syncConflictBody"></div><div class="dialog-footer"><button type="button" class="secondary-button" data-close="syncConflictDialog">关闭</button></div>`;
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog.id); });
    dialog.addEventListener('close', moveNotice);
    dialog.addEventListener('click', event => {
      const choice = event.target.closest('[data-sync-choice]');
      if (choice) resolveSyncConflict(choice.dataset.syncCourse, choice.dataset.syncChoice);
    });
    document.body.append(dialog);
  }
  const count = syncConflictCount();
  $('syncConflictBanner').hidden = !count; $('resolveSyncConflicts').hidden = !count;
  $('syncConflictBanner').querySelector('p').textContent = `有 ${count} 项记录需要确认`;
  const state = profile.syncState;
  if (selectedLesson && $('lessonDialog').open && Object.hasOwn(state.conflicts.entries, selectedLesson) && !$('viewLessonConflict')) {
    const button = document.createElement('button'); button.id = 'viewLessonConflict'; button.type = 'button'; button.className = 'text-btn'; button.textContent = '查看记录差异';
    button.onclick = () => { updateSyncConflictControls(); showDialog('syncConflictDialog'); };
    $('detailFeedback').append(document.createTextNode(' 本地草稿和服务器新记录均已保留。'), button);
  } else if (selectedLesson && !Object.hasOwn(state.conflicts.entries, selectedLesson)) $('viewLessonConflict')?.remove();
  const rows = Object.keys(state.conflicts.entries).map(id => ({ id, title: titleOf(lessonById.get(id)), local: entry(id), remote: state.conflicts.entries[id] }));
  if (state.conflicts.config) rows.unshift({ id: 'config', title: '学习排期', local: { config: profile.config, configUpdatedAt: profile.configUpdatedAt }, remote: state.conflicts.config });
  const contentKey = JSON.stringify(rows);
  if ($('syncConflictBody').dataset.content !== contentKey) {
    const describe = (record, id) => id === 'config' ? record?.config ? `开始日期：${record.config.startDate}\n学习方案：${record.config.program === 'full' ? '内推班' : '全能班'}\n练习日：${record.config.days.map(day => dayNames[day]).join('、')}` : '服务器尚无排期'
      : record ? `课程名称：${record.title || lessonById.get(id).title}\n状态：${statusLabel(record.status)}\n\n${record.history?.length ? [...record.history].reverse().map(item => `${historyTime(item.createdAt)}${item.legacy ? '（原有记录 · 最后更新时间）' : ''}\n${item.note}`).join('\n\n') : record.note || '暂无学习记录'}` : '服务器尚无本课记录';
    $('syncConflictBody').innerHTML = rows.length ? rows.map(row => `<section class="sync-conflict-item"><h3>${escape(row.title)}</h3><div class="sync-conflict-values"><label>本地草稿<textarea readonly rows="6">${escape(describe(row.local, row.id))}</textarea></label><label>服务器记录<textarea readonly rows="6">${escape(describe(row.remote, row.id))}</textarea></label></div><div class="sync-conflict-actions"><button type="button" class="secondary-button" data-sync-course="${row.id}" data-sync-choice="remote">使用服务器记录</button><button type="button" class="primary-button" data-sync-course="${row.id}" data-sync-choice="local">用本地草稿覆盖</button></div></section>`).join('') : '<p>记录差异已处理完成。</p>';
    $('syncConflictBody').dataset.content = contentKey;
  }
}

function resolveSyncConflict(id, choice) {
  const state = profile.syncState;
  if (id === 'config' ? !state.conflicts.config : !Object.hasOwn(state.conflicts.entries, id)) return;
  if (!confirm(choice === 'local' ? '是否用本地草稿覆盖这里显示的服务器记录？如果服务器再次更新，会重新请你核对。' : '是否使用这里显示的服务器记录？这将替换本地保存的草稿，正在编辑的内容会保留。')) return;
  if (id === 'config') {
    if (choice === 'local') { state.pending.config.expected = state.versions.config; profile.configUpdatedAt = freshStamp(); }
    else { const remote = state.conflicts.config; profile.config = remote.config || validateConfig(DEFAULT_CONFIG); profile.configUpdatedAt = remote.configUpdatedAt; state.pending.config = null; }
    state.conflicts.config = null;
  } else {
    if (choice === 'local') {
      let history;
      try { history = combinedHistory(id, entry(id), state.conflicts.entries[id]); }
      catch (error) { notify(error.message); return; }
      state.pending.entries[id].expected = state.versions.entries[id] ?? null;
      profile.entries[id] = { ...entry(id), history, updatedAt: freshStamp() };
    }
    else { const remote = state.conflicts.entries[id]; if (remote) profile.entries[id] = remote; else delete profile.entries[id]; delete state.pending.entries[id]; }
    delete state.conflicts.entries[id];
  }
  persist(); render(); sync({ pull: choice === 'remote' });
  $('syncConflictTitle').tabIndex = -1; $('syncConflictTitle').focus({ preventScroll: true });
  notify(choice === 'local' ? '已选择本地草稿，正在同步' : '已使用服务器记录');
}

function entry(id) {
  return profile.entries[id] || { status: 'pending', minutes: 0, note: '', title: '', updatedAt: ZERO_TIME, history: [] };
}

function titleOf(lesson) { return entry(lesson.id).title || lesson.title; }
function statusLabel(status) { return { pending: '未开始', learning: '学习中', done: '已完成' }[status]; }
function statusBadge(status) {
  return `<span class="lesson-status ${status}">${icon({ pending: 'circle', learning: 'play-circle', done: 'check-circle' }[status])}<span>${statusLabel(status)}</span></span>`;
}
function activeLessons() { return LESSONS.filter(lesson => plan.courseSchedules[lesson.id]); }
function courseWeeks(id) { return plan.weeks.filter(week => week.lessonIds.includes(id)); }
function nextLesson() { return activeLessons().find(lesson => entry(lesson.id).status !== 'done'); }
function dateRange(schedule) {
  const year = schedule.startDate.slice(0, 4) !== todayISO().slice(0, 4)
    || schedule.endDate.slice(0, 4) !== schedule.startDate.slice(0, 4);
  return `${dateLabel(schedule.startDate, year)}${schedule.startDate !== schedule.endDate ? ` — ${dateLabel(schedule.endDate, year)}` : ''}`;
}
function phaseExpansionKey(id) { return JSON.stringify([$('catalogSearch').value.trim().toLocaleLowerCase(), $('catalogPhase').value, $('catalogStatus').value, id]); }

function snapshotFocus() {
  const element = document.activeElement;
  const card = element?.closest('[data-lesson-id]');
  return { id: element?.id, course: card?.dataset.lessonId, action: element?.dataset.courseAction,
    dialog: element?.closest('dialog')?.id, area: element?.closest('#todayView, #catalogView')?.id, element };
}

function safeFocus(snapshot) {
  const modal = Array.from(document.querySelectorAll('dialog[open]')).at(-1);
  let target;
  if (modal) target = modal.querySelector('h2');
  else if (snapshot?.course) target = document.querySelector(`#${snapshot.area || 'catalogView'} [data-lesson-id="${snapshot.course}"] .lesson-card-title`);
  else if (snapshot?.id) target = $(snapshot.id);
  if (!target || !target.isConnected || !target.checkVisibility()) target = modal?.querySelector('h2') || $('pageTitle');
  if (!target.hasAttribute('tabindex') && !target.matches('button, input, select, textarea, a, summary')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function dismissNotice(action) {
  clearTimeout(toastTimer);
  const ownsFocus = $('toastRegion').contains(document.activeElement);
  const origin = toastReturnTarget;
  $('toastRegion').replaceChildren();
  if (ownsFocus) safeFocus(origin);
  if (action) {
    action();
    if (ownsFocus && !document.querySelector('dialog[open]')) safeFocus(origin);
  }
}

function moveNotice() {
  const modal = Array.from(document.querySelectorAll('dialog[open]')).at(-1);
  const host = modal?.querySelector('.dialog-footer') || modal || document.body;
  if ($('toastRegion').parentElement !== host) host.append($('toastRegion'));
}

function notify(message, action = null, origin = snapshotFocus()) {
  clearTimeout(toastTimer);
  const ownsFocus = $('toastRegion').contains(document.activeElement);
  const previousOrigin = toastReturnTarget;
  moveNotice();
  toastReturnTarget = ownsFocus ? previousOrigin : origin;
  $('toastRegion').innerHTML = `<div class="toast"><span>${escape(message)}</span>${action ? `<button type="button" class="toast-action">${icon('undo')}<span>撤销</span></button>` : ''}<button type="button" class="toast-close" aria-label="关闭提示">${icon('x')}</button></div>`;
  $('toastRegion').querySelector('.toast-close').onclick = () => dismissNotice();
  if (action) $('toastRegion').querySelector('.toast-action').onclick = () => dismissNotice(action);
  toastTimer = setTimeout(() => dismissNotice(), action ? 12000 : 6500);
  if (ownsFocus) safeFocus(toastReturnTarget);
}

function showDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
  moveNotice();
}

function lessonCard(lesson, { compact = false } = {}) {
  const record = entry(lesson.id);
  const phase = phaseById.get(lesson.phaseId);
  const schedule = plan.courseSchedules[lesson.id];
  const dates = schedule ? dateRange(schedule) : '未排期';
  const weeks = compact ? courseWeeks(lesson.id) : [];
  const weekSpan = weeks.length > 1 ? `<span class="course-week-span">第 ${weeks[0].number}–${weeks.at(-1).number} 周</span>` : '';
  return `<article class="lesson-card${compact ? ' compact lesson-row' : ' featured'}" data-lesson-id="${lesson.id}" data-state="${record.status}">
    <div class="lesson-card-head"><span class="lesson-number" aria-label="阶段 ${phase.number}，第 ${lesson.number} 课">${String(phase.number).padStart(2, '0')} / ${String(lesson.number).padStart(2, '0')}</span>${statusBadge(record.status)}</div>
    <button type="button" class="lesson-card-title" data-course-action="open">${escape(titleOf(lesson))}</button>
    <div class="lesson-card-meta">${!compact ? `<span>${escape(phase.title)}</span>` : ''}${weekSpan}<span>${schedule ? '原计划 · ' : ''}${escape(dates)}</span></div>
    <div class="lesson-card-actions">${!compact ? `<button type="button" class="primary-btn lesson-open" data-course-action="open">${icon(record.status === 'done' ? 'book' : 'edit')}<span>${record.status === 'done' ? '查看记录' : '记录学习'}</span></button>` : ''}<button type="button" class="text-btn lesson-complete" data-course-action="complete" aria-label="${record.status === 'done' ? '取消完成' : '完成'}：${escape(titleOf(lesson))}" aria-pressed="${record.status === 'done'}">${icon(record.status === 'done' ? 'undo' : 'check')}<span>${record.status === 'done' ? '取消完成' : compact ? '完成' : '完成此课'}</span></button></div>
  </article>`;
}

function renderOverall() {
  const lessons = activeLessons();
  const done = lessons.filter(lesson => entry(lesson.id).status === 'done').length;
  const percent = Math.round(done / lessons.length * 100);
  $('overallProgress').innerHTML = `<div class="progress-summary"><span>已完成</span><strong>${done}<span> / ${lessons.length} 课</span></strong></div><div class="progress-track" role="progressbar" aria-label="课程完成进度" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${lessons.length}"><span style="width:${percent}%"></span></div>`;
}

function renderToday() {
  const lesson = nextLesson();
  $('todayCoursesHeading').textContent = lesson ? '下一次学习' : '学习记录';
  $('todayCourses').innerHTML = lesson ? lessonCard(lesson)
    : `<div class="empty-state"><h3>全部课程已完成</h3><button class="secondary-btn" type="button" data-show-records>${icon('book')}<span>查看学习记录</span></button></div>`;
  $('locateNext').disabled = !lesson;
}

function renderCourseWeeks(lessons) {
  const groups = new Map();
  for (const lesson of lessons) {
    // Keep one record per course, even when its practice dates span two weeks.
    const week = courseWeeks(lesson.id)[0];
    if (!groups.has(week.number)) groups.set(week.number, { week, lessons: [] });
    groups.get(week.number).lessons.push(lesson);
  }
  return Array.from(groups.values(), ({ week, lessons: courses }) => {
    const showYear = week.startDate.slice(0, 4) !== todayISO().slice(0, 4)
      || week.startDate.slice(0, 4) !== week.endDate.slice(0, 4);
    const shortDate = date => `${showYear ? date.slice(0, 4) + '.' : ''}${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))}`;
    const heading = `week-${courses[0].phaseId}-${week.number}`;
    return `<div class="week-group" data-week="${week.number}" data-week-tone="${week.number % 2 ? 'a' : 'b'}"><h4 class="week-heading" id="${heading}" tabindex="-1"><span>第 ${week.number} 周</span><small>${shortDate(week.startDate)} — ${shortDate(week.endDate)}</small></h4>${courses.map(lesson => lessonCard(lesson, { compact: true })).join('')}</div>`;
  }).join('');
}

function renderPhaseRest(rest) {
  return `<div class="phase-rest" data-after-phase="${rest.afterPhaseId}" data-before-phase="${rest.beforePhaseId}">${icon('calendar')}<div><strong>休息一周</strong><span><time datetime="${rest.startDate}">${dateLabel(rest.startDate, true)}</time> — <time datetime="${rest.endDate}">${dateLabel(rest.endDate, true)}</time></span></div></div>`;
}

function renderCatalog() {
  const query = $('catalogSearch').value.trim().toLocaleLowerCase();
  const phase = $('catalogPhase').value || 'all';
  const status = $('catalogStatus').value || 'all';
  const words = query.split(/\s+/).filter(Boolean);
  const matches = activeLessons().filter(lesson => (phase === 'all' || lesson.phaseId === phase)
    && (status === 'all' || entry(lesson.id).status === status)
    && words.every(word => `${titleOf(lesson)} ${lesson.title} ${phaseById.get(lesson.phaseId).title} ${entry(lesson.id).note} ${entry(lesson.id).history.map(item => item.note).join(' ')}`.toLocaleLowerCase().includes(word)));
  const completed = matches.filter(lesson => entry(lesson.id).status === 'done').length;
  const filtered = Boolean(query || phase !== 'all' || status !== 'all');
  const currentPhase = nextLesson()?.phaseId || plan.phasePlans.at(-1).id;
  const scope = [phase !== 'all' ? phaseById.get(phase).title : '', status !== 'all' ? statusLabel(status) : '',
    query ? `关键词：${$('catalogSearch').value.trim()}` : ''].filter(Boolean).join(' · ');
  $('catalogCount').innerHTML = filtered ? `<span class="filter-summary">筛选结果 · ${matches.length} 课 · ${completed} 课已完成<small>${escape(scope)}</small></span><button type="button" id="clearCatalogFilters" class="text-btn" data-clear-search>${icon('x')}<span>清除筛选</span></button>` : '';
  $('catalogList').innerHTML = matches.length ? PHASES.map(group => {
    const lessons = matches.filter(lesson => lesson.phaseId === group.id);
    const all = activeLessons().filter(lesson => lesson.phaseId === group.id);
    const done = all.filter(lesson => entry(lesson.id).status === 'done').length;
    const open = phaseExpansion.get(phaseExpansionKey(group.id)) ?? (filtered || group.id === currentPhase);
    const rest = !filtered && plan.restPeriods.find(item => item.afterPhaseId === group.id);
    return lessons.length ? `<section class="catalog-group" data-phase="${group.id}"><h3><button type="button" class="phase-toggle" id="phase-toggle-${group.id}" data-phase-toggle="${group.id}" aria-expanded="${open}" aria-controls="phase-${group.id}"><span class="catalog-stage-number">阶段 0${group.number}</span><strong>${escape(group.title)}</strong><span class="catalog-stage-progress"><span class="catalog-stage-count">${done} / ${all.length} 课</span><span class="phase-progress" aria-hidden="true"><span style="width:${Math.round(done / all.length * 100)}%"></span></span></span>${icon('chevron-down')}</button></h3><div class="lesson-grid" id="phase-${group.id}"${open ? '' : ' hidden'}>${renderCourseWeeks(lessons)}${rest ? renderPhaseRest(rest) : ''}</div></section>` : '';
  }).join('') : '<div class="empty-state"><h3>没有匹配的课程</h3><p>试试其他关键词，或清除筛选查看全部课程。</p></div>';
}

function renderSyncStatus() {
  if (!$('syncStatus')) return;
  const conflicts = syncConflictCount();
  const text = syncBusy ? '正在同步学习记录…' : conflicts ? `有 ${conflicts} 项记录需要确认，本地草稿和服务器记录均已保留。` : syncOnline === false ? '暂时无法连接服务器，学习记录保存在当前浏览器。' : lastSyncedAt ? `已同步 · ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }).format(new Date(lastSyncedAt))}` : '学习记录自动保存，并同步到服务器。';
  $('syncStatus').textContent = localAvailable ? text : `${text} 浏览器暂时无法本地保存，请同步或导出备份。`;
  $('syncCode').value = studyKey;
  $('syncNowBtn').disabled = syncBusy;
}

function render() {
  const before = snapshotFocus();
  plan = buildPlan(profile.config);
  const phase = $('catalogPhase').value;
  $('catalogPhase').innerHTML = '<option value="all">全部阶段</option>' + plan.phasePlans.map(phase => `<option value="${phase.id}">阶段 ${phase.number} · ${escape(phase.title)}</option>`).join('');
  $('catalogPhase').value = plan.phasePlans.some(item => item.id === phase) ? phase : 'all';
  renderOverall(); renderToday(); renderCatalog(); renderSyncStatus();
  $('brandProgram').textContent = profile.config.program === 'full' ? '椰子音乐 · 内推班' : '椰子音乐 · 全能班';
  if (selectedLesson && $('lessonDialog').open) {
    if (JSON.stringify(entry(selectedLesson)) !== lessonRecordBase) {
      if (!lessonDirty()) renderLessonDialog(selectedLesson);
      else $('detailFeedback').textContent = '这门课的记录已更新，当前草稿已保留；保存前会请你确认。';
    }
    const done = entry(selectedLesson).status === 'done';
    const badge = $('lessonDialogBody').querySelector('.lesson-status');
    if (badge) badge.outerHTML = statusBadge(entry(selectedLesson).status);
    buttonLabel('lessonComplete', done ? '取消完成' : '完成此课', done ? 'undo' : 'check');
    $('lessonComplete').setAttribute('aria-pressed', String(done));
  }
  if ($('settingsDialog').open && !settingsDirty()
      && JSON.stringify([profile.config, profile.configUpdatedAt]) !== settingsRecordBase) refreshSettingsForm();
  if (before.id && $(before.id)?.checkVisibility()) $(before.id).focus({ preventScroll: true });
  else if (before.course && !before.dialog) {
    const target = document.querySelector(`#${before.area || 'catalogView'} [data-lesson-id="${before.course}"] [data-course-action="${before.action || 'open'}"]`);
    if (target?.checkVisibility()) target.focus({ preventScroll: true });
    else safeFocus(before);
  }
  updateSyncConflictControls();
}

function readLocation() {
  const parts = location.hash.replace(/^#/, '').split('/');
  const value = parts[0] === 'plan' && parts[1] === 'week' ? Number(parts[2]) : null;
  const week = plan.weeks.find(item => item.number === value);
  if (week) {
    // Existing week bookmarks now locate the full catalog instead of hiding other courses.
    $('catalogSearch').value = '';
    $('catalogPhase').value = 'all';
    $('catalogStatus').value = 'all';
    for (const id of week.phaseIds) phaseExpansion.set(phaseExpansionKey(id), true);
    renderCatalog();
    const target = document.querySelector(`#catalogList [data-week="${week.number}"] .week-heading`)
      || document.querySelector(`#catalogList [data-lesson-id="${week.lessonIds[0]}"] .lesson-card-title`);
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    target?.focus({ preventScroll: true });
  } else if (location.hash === '#catalog') {
    $('catalogView').scrollIntoView({ block: 'start', behavior: 'instant' });
    $('catalogSearch').focus({ preventScroll: true });
  }
}

function clearFilters() {
  $('catalogSearch').value = '';
  $('catalogPhase').value = 'all';
  $('catalogStatus').value = 'all';
  if (location.hash !== '#catalog') history.pushState(null, '', '#catalog');
  render();
}

function locateCourse(id) {
  const lesson = lessonById.get(id);
  if (!lesson || !plan.courseSchedules[id]) return;
  clearFilters();
  phaseExpansion.set(phaseExpansionKey(lesson.phaseId), true);
  renderCatalog();
  const target = document.querySelector(`#catalogList [data-lesson-id="${id}"] .lesson-card-title`);
  target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  target?.focus({ preventScroll: true });
}

function mergeRemote(remote, { submitted = null } = {}) {
  const entries = validateEntries(remote.entries || {});
  if (!remote.versions) {
    // Other tabs also share offline writes. Carry their original CAS base with the write.
    const incoming = normalizeSyncState(remote.syncState, entries, remote.configUpdatedAt);
    let changed = false;
    let rejectedUndo = false;
    for (const [id, value] of Object.entries(entries)) {
      const pending = profile.syncState.pending.entries[id];
      if (pending && recordSignature(value) !== recordSignature(entry(id))) {
        // A sibling tab's unsent edit is not a server acknowledgement of our edit.
        const version = incoming.versions.entries[id];
        if (!incoming.pending.entries[id] && version && pending.expected !== version) {
          profile.syncState.versions.entries[id] = version;
          if (pending.kind === 'undo') { delete profile.syncState.pending.entries[id]; delete profile.syncState.conflicts.entries[id]; profile.entries[id] = value; rejectedUndo = true; }
          else profile.syncState.conflicts.entries[id] = value;
          changed = true;
        }
        continue;
      }
      if (Date.parse(value.updatedAt) >= Date.parse(entry(id).updatedAt) && recordSignature(value) !== recordSignature(entry(id))) {
        profile.entries[id] = value;
        if (incoming.pending.entries[id]) profile.syncState.pending.entries[id] = incoming.pending.entries[id]; else delete profile.syncState.pending.entries[id];
        if (Object.hasOwn(incoming.conflicts.entries, id)) profile.syncState.conflicts.entries[id] = incoming.conflicts.entries[id]; else delete profile.syncState.conflicts.entries[id];
        if (incoming.versions.entries[id]) profile.syncState.versions.entries[id] = incoming.versions.entries[id];
        changed = true;
      }
    }
    if (remote.config && validStamp(remote.configUpdatedAt) && configSignature(remote.config, remote.configUpdatedAt) !== configSignature(profile.config, profile.configUpdatedAt)) {
      const pending = profile.syncState.pending.config;
      if (pending) {
        if (!incoming.pending.config && incoming.versions.config && pending.expected !== incoming.versions.config) {
          profile.syncState.versions.config = incoming.versions.config;
          if (pending.kind === 'undo') { profile.syncState.pending.config = null; profile.syncState.conflicts.config = null; profile.config = validateConfig(remote.config); profile.configUpdatedAt = remote.configUpdatedAt; rejectedUndo = true; }
          else profile.syncState.conflicts.config = { config: validateConfig(remote.config), configUpdatedAt: remote.configUpdatedAt };
          changed = true;
        }
      } else if (Date.parse(remote.configUpdatedAt) >= Date.parse(profile.configUpdatedAt)) {
        profile.config = validateConfig(remote.config); profile.configUpdatedAt = remote.configUpdatedAt;
        profile.syncState.pending.config = incoming.pending.config; profile.syncState.conflicts.config = incoming.conflicts.config; profile.syncState.versions.config = incoming.versions.config; changed = true;
      }
    }
    if (changed) { persist(); render(); }
    if (rejectedUndo) notify('另一设备已更新记录，本次未撤销，服务器记录已保留');
    return;
  }
  const state = profile.syncState;
  const before = JSON.stringify(profile);
  let rejectedUndo = false;
  stampFloor = Math.max(stampFloor, Date.parse(remote.serverTime) || 0, Date.parse(remote.configUpdatedAt) || 0, ...Object.values(entries).map(value => Date.parse(value.updatedAt) || 0));
  state.versions = { config: remote.versions.config, entries: { ...remote.versions.entries } };
  for (const id of new Set([...Object.keys(profile.entries), ...Object.keys(entries)])) {
    const value = entries[id] || null;
    const pending = state.pending.entries[id];
    if (pending && recordSignature(profile.entries[id]) === recordSignature(value)) {
      delete state.pending.entries[id]; delete state.conflicts.entries[id];
    } else if (pending && submitted && Object.hasOwn(submitted.entries, id) && pending.expected === submitted.expected.entries[id]) {
      // This response acknowledged an earlier local revision; rebase only the edit made while it was in flight.
      pending.expected = state.versions.entries[id] ?? null; delete state.conflicts.entries[id];
    } else if (pending && pending.expected !== (state.versions.entries[id] ?? null)) {
      if (pending.kind === 'undo') { delete state.pending.entries[id]; delete state.conflicts.entries[id]; rejectedUndo = true; }
      else state.conflicts.entries[id] = value;
    }
    if (!state.pending.entries[id]) { if (value) profile.entries[id] = value; else delete profile.entries[id]; }
  }
  if (remote.config !== null) { validateConfig(remote.config); buildPlan(remote.config); }
  const pending = state.pending.config;
  if (pending && configSignature(profile.config, profile.configUpdatedAt) === configSignature(remote.config, remote.configUpdatedAt)) {
    state.pending.config = null; state.conflicts.config = null;
  } else if (pending && submitted?.config && pending.expected === submitted.expected.config) {
    pending.expected = state.versions.config; state.conflicts.config = null;
  } else if (pending && pending.expected !== state.versions.config) {
    if (pending.kind === 'undo') { state.pending.config = null; state.conflicts.config = null; rejectedUndo = true; }
    else state.conflicts.config = { config: remote.config, configUpdatedAt: remote.configUpdatedAt };
  }
  if (!state.pending.config && remote.config !== null) { profile.config = validateConfig(remote.config); profile.configUpdatedAt = remote.configUpdatedAt; }
  if (before !== JSON.stringify(profile)) { persist(); render(); }
  if (rejectedUndo) notify('另一设备已更新记录，本次未撤销，服务器记录已保留');
}

/* Server writes require the acknowledged version, not a newer client timestamp. */
function syncPayload() {
  const state = profile.syncState;
  const ids = Object.keys(state.pending.entries).filter(id => !Object.hasOwn(state.conflicts.entries, id)).slice(0, 10);
  const includeConfig = state.pending.config && !state.conflicts.config;
  if (!ids.length && !includeConfig) return null;
  const payload = {
    ...(includeConfig ? { config: structuredClone(profile.config), configUpdatedAt: profile.configUpdatedAt } : {}),
    entries: {},
    expected: { ...(includeConfig ? { config: state.pending.config.expected } : {}), entries: {} },
  };
  for (const id of ids) {
    payload.entries[id] = structuredClone(entry(id));
    payload.expected.entries[id] = state.pending.entries[id].expected;
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > SYNC_BODY_LIMIT) {
      delete payload.entries[id]; delete payload.expected.entries[id];
      if (!Object.keys(payload.entries).length && !includeConfig) throw new Error('课程历史过大，暂时无法同步');
      break;
    }
  }
  return payload;
}

async function requestState(key, payload) {
  const response = await fetch(payload ? 'api/sync' : 'api/state', { method: payload ? 'POST' : 'GET', headers: { 'X-Study-Key': key, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(10000), cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.message || value.error || '服务器暂时无法同步');
    error.status = response.status; error.state = value.state; throw error;
  }
  return value;
}

async function sync({ pull = false, announce = false } = {}) {
  if (syncBusy) { syncQueued = true; syncPullQueued ||= pull; return; }
  const epoch = syncEpoch;
  const key = studyKey;
  const conflictBefore = JSON.stringify(profile.syncState.conflicts);
  syncBusy = true; renderSyncStatus();
  try {
    if (pull) {
      const remote = await requestState(key);
      if (epoch !== syncEpoch) return;
      mergeRemote(remote);
    }
    if (profile.configUpdatedAt === ZERO_TIME && !profile.syncState.conflicts.config) { markPendingConfig(); profile.configUpdatedAt = freshStamp(); persist(); }
    while (epoch === syncEpoch) {
      syncQueued = false;
      const payload = syncPayload();
      if (!payload) {
        if (syncPullQueued) { syncPullQueued = false; const remote = await requestState(key); if (epoch !== syncEpoch) return; mergeRemote(remote); continue; }
        break;
      }
      try {
        const remote = await requestState(key, payload);
        if (epoch !== syncEpoch) return;
        mergeRemote(remote, { submitted: payload });
      } catch (error) {
        if (epoch !== syncEpoch) return;
        if (error.status !== 409 || !error.state) throw error;
        mergeRemote(error.state);
      }
    }
    syncOnline = true; lastSyncedAt = new Date().toISOString();
    if (syncConflictCount() && (announce || conflictBefore !== JSON.stringify(profile.syncState.conflicts))) notify('另一设备已更新记录，本地草稿已保留，请查看记录差异');
    else if (announce) notify('学习记录已同步');
  } catch {
    if (epoch === syncEpoch) {
      syncOnline = false;
      if (announce) notify('暂时无法同步，学习记录已保留，可稍后重试');
    }
  } finally {
    if (epoch === syncEpoch) { syncBusy = false; renderSyncStatus(); updateSyncConflictControls(); }
  }
}

function commitEntry(id, patch, message) {
  const origin = snapshotFocus();
  const before = { ...entry(id) };
  markPendingEntry(id);
  profile.entries[id] = { ...before, ...patch, updatedAt: freshStamp() };
  const expected = JSON.stringify(profile.entries[id]);
  persist(); render();
  notify(message, () => {
    if (JSON.stringify(entry(id)) !== expected) { notify('这门课已有新记录，本次未撤销'); return; }
    markPendingEntry(id, 'undo');
    profile.entries[id] = { ...before, updatedAt: freshStamp() };
    persist(); render(); sync();
    if (selectedLesson === id && $('lessonDialog').open && !lessonDirty()) renderLessonDialog(id);
    notify('已撤销，学习记录已恢复');
  }, origin);
  if (origin.course && !origin.dialog && !document.querySelector(`#${origin.area || 'catalogView'} [data-lesson-id="${id}"]`)?.checkVisibility()) $('toastRegion').querySelector('.toast-action')?.focus({ preventScroll: true });
  sync();
}

function lessonForm() {
  return { title: $('lessonTitleInput').value.trim(), note: $('lessonNote').value };
}

function lessonDirty() { return selectedLesson && JSON.stringify(lessonForm()) !== lessonFormBase; }

function updateLessonSaveButton() {
  const values = lessonForm();
  const titleChanged = values.title !== JSON.parse(lessonFormBase).title;
  $('saveLesson').disabled = !values.note.trim() && !titleChanged;
  buttonLabel('saveLesson', titleChanged && !values.note.trim() ? '保存课程名称' : '添加学习记录', 'save');
}

function lessonHistory(record) {
  if (!record.history.length) return '';
  const items = [...record.history].reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return `<section class="lesson-history" aria-labelledby="lessonHistoryTitle"><h3 id="lessonHistoryTitle">学习历程 <span class="history-count">${items.length} 条</span></h3><ol class="history-list">${items.map(item => `<li class="history-entry" data-history-id="${escape(item.id)}"><header class="history-entry-meta"><time datetime="${escape(item.createdAt)}" title="北京时间">${historyTime(item.createdAt)}</time>${item.legacy ? '<span class="history-origin">原有记录 · 最后更新时间</span>' : ''}</header><p class="history-note">${escape(item.note)}</p></li>`).join('')}</ol></section>`;
}

function renderLessonDialog(id) {
  const lesson = lessonById.get(id);
  const phase = phaseById.get(lesson.phaseId);
  const record = entry(id);
  const schedule = plan.courseSchedules[id];
  $('lessonDialogTitle').textContent = titleOf(lesson);
  $('lessonDialogBody').innerHTML = `<div class="detail-course-meta"><span class="pill">阶段 ${phase.number} · 第 ${lesson.number} 课</span>${statusBadge(record.status)}</div>
    <p class="muted">${escape(phase.title)}${schedule ? ` · 原计划 ${dateRange(schedule)}` : ''}</p>
    <div class="field-group"><label for="lessonTitleInput">课程名称</label><input id="lessonTitleInput" type="text" maxlength="160" value="${escape(titleOf(lesson))}"></div>
    <div class="field-group"><label for="lessonNote">新增学习记录</label><textarea id="lessonNote" rows="4" maxlength="4000" placeholder="记录这次的练习、收获或录音链接，保存时自动标记时间。"></textarea></div>
    <p id="detailFeedback" class="detail-feedback" role="status"></p>${lessonHistory(record)}
    ${schedule ? `<button type="button" class="text-btn" data-course-locate="${id}">${icon('book')}<span>在课程列表中定位</span></button>` : ''}`;
  buttonLabel('lessonComplete', record.status === 'done' ? '取消完成' : '完成此课', record.status === 'done' ? 'undo' : 'check');
  $('lessonComplete').setAttribute('aria-pressed', String(record.status === 'done'));
  lessonFormBase = JSON.stringify(lessonForm());
  lessonRecordBase = JSON.stringify(record);
  updateLessonSaveButton();
  updateSyncConflictControls();
}

function openLesson(id) {
  if (!lessonById.has(id)) return;
  selectedLesson = id; renderLessonDialog(id); showDialog('lessonDialog');
  $('lessonDialog').scrollTop = 0;
}

function saveLesson(complete = false) {
  const values = lessonForm();
  if (!values.title) { $('detailFeedback').textContent = '请填写课程名称'; $('lessonTitleInput').focus(); return; }
  const current = entry(selectedLesson);
  const hasDraft = values.note.trim().length > 0;
  const titleChanged = values.title !== JSON.parse(lessonFormBase).title;
  if (!complete && !titleChanged && !hasDraft) return;
  const conflicted = Object.hasOwn(profile.syncState.conflicts.entries, selectedLesson);
  if (conflicted && !confirm('服务器已有另一份新记录。是否保存本次内容，并保留已有的学习历程？可先在“查看记录差异”中核对。')) return;
  if (!conflicted && JSON.stringify(current) !== lessonRecordBase && !confirm('这门课刚收到新的记录。是否在最新学习历程的基础上保存本次内容？')) return;
  let history;
  try {
    history = conflicted ? combinedHistory(selectedLesson, current, profile.syncState.conflicts.entries[selectedLesson]) : [...current.history];
    if (hasDraft) history.push({ id: newKey(), createdAt: new Date().toISOString(), note: values.note });
    history = normalizeHistory(selectedLesson, { history });
  } catch (error) { $('detailFeedback').textContent = error.message; return; }
  const lesson = lessonById.get(selectedLesson);
  const title = values.title === lesson.title ? '' : values.title;
  // Keep legacy duration data for backup/sync, without making it drive the UI state.
  const minutes = current.minutes;
  const note = hasDraft ? values.note : current.note;
  const hasProgress = history.length > 0 || note.trim().length > 0;
  const status = complete ? current.status === 'done' ? hasProgress ? 'learning' : 'pending' : 'done'
    : current.status === 'done' ? 'done' : hasProgress ? 'learning' : 'pending';
  if (conflicted) {
    profile.syncState.pending.entries[selectedLesson].expected = profile.syncState.versions.entries[selectedLesson] ?? null;
    delete profile.syncState.conflicts.entries[selectedLesson];
  }
  commitEntry(selectedLesson, { title, minutes, note, history, status }, complete ? status === 'done' ? '本课已完成' : '已取消完成，学习记录保留' : hasDraft ? '学习记录已添加，并标记时间' : '课程名称已保存');
  renderLessonDialog(selectedLesson);
}

function closeDialog(id) {
  if (id === 'lessonDialog' && lessonDirty() && !confirm('学习记录还未保存，是否放弃本次编辑？')) return false;
  if (id === 'settingsDialog' && settingsDirty() && !confirm('排期修改还未保存，是否放弃本次修改？')) return false;
  $(id).close();
  if (id === 'lessonDialog') selectedLesson = null;
  moveNotice();
  return true;
}

let settingsFormBase = '';
let settingsRecordBase = '';
function settingsValues() { return { startDate: $('startDate').value, program: $('program').value, days: Array.from(document.querySelectorAll('#settingsForm input[name="days"]:checked'), input => Number(input.value)) }; }
function settingsDirty() { return JSON.stringify(settingsValues()) !== settingsFormBase; }

function updateSettingsPreview() {
  $('saveSettings').disabled = !settingsDirty();
  try {
    const next = buildPlan(settingsValues());
    $('settingsPreview').textContent = `${next.phasePlans.length} 个阶段 · ${Object.keys(next.courseSchedules).length} 课 · 每三周 2 课 · 阶段间各休息一周（共 ${next.restPeriods.length} 周） · 预计 ${dateLabel(next.endDate, true)} 完成`;
    $('settingsPreview').classList.remove('error');
  } catch {
    $('saveSettings').disabled = true;
    $('settingsPreview').textContent = '请选择至少两个可上课的星期，以及有效的开始日期。';
    $('settingsPreview').classList.add('error');
  }
}

function refreshSettingsForm() {
  $('startDate').value = profile.config.startDate;
  $('program').value = profile.config.program;
  for (const input of document.querySelectorAll('#settingsForm input[name="days"]')) input.checked = profile.config.days.includes(Number(input.value));
  settingsFormBase = JSON.stringify(settingsValues());
  settingsRecordBase = JSON.stringify([profile.config, profile.configUpdatedAt]);
  updateSettingsPreview();
}

function openSettings() {
  refreshSettingsForm();
  $('dataFeedback').textContent = '';
  renderSyncStatus();
  showDialog('settingsDialog');
}

function applySettings(event) {
  event.preventDefault();
  let config;
  try { config = validateConfig({ ...profile.config, ...settingsValues() }); buildPlan(config); } catch { updateSettingsPreview(); return; }
  if (!settingsDirty()) { $('settingsDialog').close(); moveNotice(); return; }
  if (JSON.stringify([profile.config, profile.configUpdatedAt]) !== settingsRecordBase
    && !confirm('另一设备已更新排期。是否用当前选择的日期和学习日覆盖新排期？')) return;
  if (profile.syncState.conflicts.config) {
    if (!confirm('服务器已有另一份新排期。是否用当前选择覆盖？可先在“查看记录差异”中核对。')) return;
    profile.syncState.pending.config.expected = profile.syncState.versions.config;
    profile.syncState.conflicts.config = null;
  }
  markPendingConfig();
  profile.config = config; profile.configUpdatedAt = freshStamp();
  persist(); plan = buildPlan(config);
  if (location.hash.startsWith('#plan/week/')) history.replaceState(null, '', '#catalog');
  settingsFormBase = JSON.stringify(settingsValues());
  $('settingsDialog').close(); moveNotice(); render(); sync();
  notify('排期已更新，已有学习记录保留');
}

async function copyCode() {
  let copied = false;
  try { await navigator.clipboard.writeText(studyKey); copied = true; } catch {
    const field = document.createElement('textarea'); field.value = studyKey; field.style.position = 'fixed'; field.style.opacity = '0';
    $('settingsDialog').append(field); field.select();
    try { copied = document.execCommand('copy'); } catch {}
    field.remove(); $('copySyncCode').focus();
  }
  notify(copied ? '同步码已复制' : '请选中同步码，手动复制');
}

async function connectDevice(event) {
  event.preventDefault();
  const candidate = $('connectCode').value.trim().toLowerCase();
  const feedback = $('dataFeedback');
  if (!KEY_PATTERN.test(candidate)) { feedback.textContent = '请粘贴完整的同步码'; return; }
  if (syncBusy) { feedback.textContent = '当前正在同步，请完成后再切换'; return; }
  const submit = $('connectForm').querySelector('[type="submit"]');
  submit.disabled = true; feedback.textContent = '正在读取学习记录…';
  try {
    const remote = await requestState(candidate);
    if (!remote.config) { feedback.textContent = '这个同步码还没有已保存的计划，请先在原设备同步一次'; return; }
    const config = validateConfig(remote.config); buildPlan(config);
    const entries = validateEntries(remote.entries);
    if (!validStamp(remote.configUpdatedAt)) throw new Error('同步记录无效');
    persist(); syncEpoch++; syncBusy = false; syncQueued = false; syncPullQueued = false; studyKey = candidate;
    profile = loadProfile(candidate);
    mergeRemote({ ...remote, config, entries });
    syncOnline = true; lastSyncedAt = new Date().toISOString();
    persist(); render();
    if (!settingsDirty()) refreshSettingsForm();
    feedback.textContent = '已连接，课程进度和排期已恢复';
    $('connectCode').value = '';
    sync();
  } catch { feedback.textContent = '暂时无法连接，当前计划保持原样，请稍后重试'; }
  finally { submit.disabled = false; }
}

function exportBackup() {
  const text = JSON.stringify({ format: 'vocal-study-planner', version: 2, exportedAt: new Date().toISOString(), config: profile.config, entries: profile.entries }, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `声乐学习备份-${todayISO()}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('学习计划与记录已导出');
}

async function restoreBackup(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('备份文件过大');
    const value = JSON.parse(await file.text());
    if (value.format !== 'vocal-study-planner' || ![1, 2].includes(value.version)) throw new Error('请选择本网站导出的学习备份');
    const config = validateConfig(value.config); buildPlan(config);
    const entries = validateEntries(value.entries);
    if (!confirm(`备份包含 ${Object.keys(entries).length} 门课的记录，将恢复其中的记录和排期。是否继续？`)) return;
    const before = structuredClone(profile);
    const stamp = freshStamp();
    for (const [id, record] of Object.entries(entries)) { markPendingEntry(id); profile.entries[id] = { ...record, updatedAt: stamp }; }
    markPendingConfig();
    profile.config = config; profile.configUpdatedAt = stamp;
    persist(); render();
    if (!settingsDirty()) refreshSettingsForm();
    sync();
    notify('备份已恢复', () => {
      if (profile.configUpdatedAt !== stamp || Object.keys(entries).some(id => entry(id).updatedAt !== stamp)) { notify('恢复后已有新的修改，本次未撤销'); return; }
      const restored = freshStamp();
      for (const id of Object.keys(entries)) { markPendingEntry(id, 'undo'); profile.entries[id] = { ...(before.entries[id] || { status: 'pending', minutes: 0, note: '', title: '', history: [] }), updatedAt: restored }; }
      markPendingConfig('undo');
      profile.config = before.config; profile.configUpdatedAt = restored;
      persist(); render();
      if (!settingsDirty()) refreshSettingsForm();
      sync(); notify('已撤销备份恢复');
    });
    $('dataFeedback').textContent = '备份中的学习记录和排期已恢复';
  } catch (error) { $('dataFeedback').textContent = error instanceof SyntaxError ? '备份不是有效的 JSON 文件' : error.message; }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-open-settings')) openSettings();
  else if (button.dataset.close) closeDialog(button.dataset.close);
  else if (button.dataset.courseAction) {
    const id = button.closest('[data-lesson-id]').dataset.lessonId;
    if (button.dataset.courseAction === 'open') openLesson(id);
    else {
      const current = entry(id);
      const status = current.status === 'done' ? current.history.length || current.note.trim() ? 'learning' : 'pending' : 'done';
      commitEntry(id, { status }, status === 'done' ? '本课已完成' : '已取消完成，学习记录保留');
    }
  } else if (button.dataset.phaseToggle) {
    const id = button.dataset.phaseToggle;
    const open = button.getAttribute('aria-expanded') !== 'true';
    phaseExpansion.set(phaseExpansionKey(id), open);
    button.setAttribute('aria-expanded', String(open));
    $(`phase-${id}`).hidden = !open;
  } else if (button.dataset.courseLocate) {
    const id = button.dataset.courseLocate;
    if (closeDialog('lessonDialog')) locateCourse(id);
  } else if (button.hasAttribute('data-clear-search')) { clearFilters(); $('catalogSearch').focus(); }
  else if (button.hasAttribute('data-show-records')) {
    clearFilters(); $('catalogStatus').value = 'done'; renderCatalog();
    $('catalogView').scrollIntoView({ block: 'start', behavior: 'instant' }); $('catalogSearch').focus({ preventScroll: true });
  }
});

$('lessonDialogBody').addEventListener('input', updateLessonSaveButton);
$('saveLesson').onclick = () => saveLesson();
$('lessonComplete').onclick = () => saveLesson(true);
$('settingsForm').addEventListener('input', updateSettingsPreview);
$('settingsForm').onsubmit = applySettings;
$('connectForm').onsubmit = connectDevice;
$('copySyncCode').onclick = copyCode;
$('exportBackup').onclick = exportBackup;
$('restoreFile').onchange = restoreBackup;
$('syncNowBtn').onclick = () => sync({ pull: true, announce: true });
$('catalogSearch').oninput = renderCatalog;
$('catalogPhase').innerHTML = '<option value="all">全部阶段</option>' + PHASES.map(phase => `<option value="${phase.id}">阶段 ${phase.number} · ${escape(phase.title)}</option>`).join('');
$('catalogPhase').onchange = renderCatalog;
$('catalogStatus').onchange = renderCatalog;
$('locateNext').onclick = () => { const lesson = nextLesson(); if (lesson) locateCourse(lesson.id); };
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog.id); });
  dialog.addEventListener('close', moveNotice);
}
window.addEventListener('hashchange', () => { render(); readLocation(); });
window.addEventListener('online', () => sync({ pull: true }));
window.addEventListener('offline', () => { syncOnline = false; renderSyncStatus(); });
window.addEventListener('storage', event => {
  if (event.key !== PROFILE_PREFIX + studyKey || !event.newValue) return;
  try { mergeRemote(JSON.parse(event.newValue)); } catch {}
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync({ pull: true }); });
setInterval(() => { if (!document.hidden) sync({ pull: true }); }, 45000);
render(); readLocation(); persist(); sync({ pull: true });
