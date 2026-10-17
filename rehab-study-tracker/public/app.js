import {openJournalStore} from './storage.js';
import {BACKUP_MAX_BYTES,normalizeBackup,createBackup,buildImportOperations} from './backup.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const STORAGE_KEY = 'rehab-study-tracker.v1';
const icons = {
  search: '<circle cx="10.7" cy="10.7" r="6.7"/><path d="m16 16 4.5 4.5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="2.5" fill="currentColor" stroke="none"/>',
  external: '<path d="M14 4h6v6m0-6-9 9M10 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  checked: '<circle cx="12" cy="12" r="8"/><path d="m8 12 2.5 2.5L16 9"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M5 16v4h14v-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 14h10l1-14M10 10v6m4-6v6"/>',
  book: '<path d="M12 6C9 4 5 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-2-1-6-1-9 1Zm0 0v14"/>',
  journal: '<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M5 7H3m2 5H3m2 5H3m7-9h6m-6 4h6m-6 4h4"/>',
  neck: '<path d="M8 4c0 4 1.3 6 4 6s4-2 4-6M9 10v4l-5 3v3m11-10v4l5 3v3M8 20v-2m8 2v-2"/><path d="M8 4c2-2 6-2 8 0"/>',
  gait: '<circle cx="14" cy="4" r="2"/><path d="m12 8 3 4 4 1M12 8l-4 4H5m7-4-2 7-4 5m4-5 5 2 2 4"/>',
  back: '<path d="M8 4c2-1 6-1 8 0m-6 1 1 4-2 3 2 4-1 4M6 8l-2 4 2 8m12-12 2 4-2 8M14 5l-1 4 2 3-2 4 1 4"/>',
  knee: '<path d="m9 3-1 7 6 4-2 7m1-18-1 6 6 4-2 8"/><circle cx="13" cy="11" r="2.7"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.journal}</svg>`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fillIcons = (root = document) => $$('[data-icon]', root).forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
const keyPattern = /^[A-Za-z0-9_-]{32,96}$/;

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function newSyncKey() { return [...randomBytes(32)].map((b) => b.toString(16).padStart(2, '0')).join(''); }

let data;
let courseMap = new Map();
let sectionMap = new Map();
let lessonMap = new Map();
let store;
let persistence;
let activeCourseId = '37378';
let view = 'catalog';
let filter = 'all';
let query = '';
let searchTimer;
let syncPromise = null;
let syncState = 'syncing';
let lastSyncError = '';
let checkinContext;
let toastTimer;
let pendingImport = null;
let importRequestId = 0;
let importing = false;
const expanded = new Set();
const tabId = uuid();
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});

function validateStore(value) {
  if (!value || !keyPattern.test(value.syncKey) || !Array.isArray(value.records) || !Array.isArray(value.outbox)) throw new Error('本机训练记录格式异常，请先保留浏览器数据。');
}
async function commit(reducer, expectedKey = store.syncKey) {
  store = await persistence.update(expectedKey,reducer);
  return store;
}
function toast(message, actionLabel, action, error = false) {
  clearTimeout(toastTimer);
  $('#toastRegion').innerHTML = `<div class="toast${error ? ' error' : ''}"><span>${escapeHtml(message)}</span>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ''}</div>`;
  if (actionLabel) $('#toastRegion button').addEventListener('click', () => { $('#toastRegion').replaceChildren(); action(); }, {once:true});
  toastTimer = setTimeout(() => $('#toastRegion').replaceChildren(), actionLabel ? 10000 : 5000);
}
function status() {
  const element = $('#syncStatus');
  element.dataset.state = syncState;
  const pending = store?.outbox.reduce((sum,operation) => sum + (operation.kind === 'import' ? operation.payload.records.length : 1),0) || 0;
  element.textContent = syncState === 'syncing' ? '正在同步' : pending ? `${pending} 条待同步` : syncState === 'offline' ? '离线 · 记录保留在本机' : '记录已同步';
  element.title = lastSyncError || (pending ? '联网后会自动同步，当前记录已保存在本机。' : '使用相同同步码可在其他设备查看记录。');
}
async function api(path, options = {}, syncKey = store.syncKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(new URL(`api/${path}`, document.baseURI), {
      ...options,
      headers: {'Content-Type':'application/json',Authorization:`Bearer ${syncKey}`,...options.headers},
      signal:controller.signal,
      cache:'no-store',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof result.error === 'string' ? result.error : typeof result.message === 'string' ? result.message : `同步未完成（${response.status}）`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return result;
  } finally { clearTimeout(timer); }
}
function applyOutbox(records, outbox) {
  const result = new Map(records.map((record) => [record.id, record]));
  for (const operation of outbox) {
    if (operation.kind === 'create') {
      if (!result.has(operation.payload.id)) result.set(operation.payload.id, {...operation.payload,createdAt:operation.payload.occurredAt,deletedAt:null});
    } else if (operation.kind === 'import') {
      for (const record of operation.payload.records) if (!result.has(record.id)) result.set(record.id,record);
    } else if (operation.kind === 'delete') result.delete(operation.id);
    else if (operation.kind === 'restore' && operation.record) result.set(operation.id, operation.record);
  }
  return [...result.values()];
}
function sync() {
  if (syncPromise) return syncPromise;
  const syncKey = store.syncKey;
  syncState = 'syncing'; status();
  syncPromise = (async () => {
    let hasLock = false;
    try {
      hasLock = await persistence.syncLock(syncKey,tabId);
      if (!hasLock) { syncState = 'ready'; return; }
      const latest = await persistence.read();
      if (latest.syncKey !== syncKey) {
        syncState = 'offline';
        lastSyncError = '另一标签页已切换同步码，请刷新页面后继续。';
        return;
      }
      store = latest;
      while (store.syncKey === syncKey && store.outbox.length) {
        if (!await persistence.syncLock(syncKey,tabId)) return;
        const operation = store.outbox[0];
        let imported;
        if (operation.kind === 'create') await api('checkins', {method:'POST',body:JSON.stringify(operation.payload)}, syncKey);
        else if (operation.kind === 'delete') await api(`checkins/${operation.id}`, {method:'DELETE'}, syncKey);
        else if (operation.kind === 'restore') await api(`checkins/${operation.id}/restore`, {method:'POST'}, syncKey);
        else if (operation.kind === 'import') imported = await api('checkins/import',{method:'POST',body:JSON.stringify(operation.payload)},syncKey);
        else throw new Error('存在暂不支持的待同步记录，请刷新页面后重试。');
        if (store.syncKey !== syncKey) return;
        await commit((current) => {
          const outbox = current.outbox.filter((op) => op.opId !== operation.opId);
          if (!imported) return {...current,outbox};
          const records = new Map(current.records.map((record) => [record.id,record]));
          for (const record of imported.records) {
            if (record.deletedAt === null) records.set(record.id,record);
            else records.delete(record.id);
          }
          return {...current,outbox,records:applyOutbox([...records.values()],outbox)};
        },syncKey);
        if (imported?.conflicts.length) {
          const message = `${imported.conflicts.length} 条同编号记录已保留服务器原有内容。`;
          $('#backupFeedback').textContent = message;
          toast(message);
        }
      }
      const result = await api('checkins', {}, syncKey);
      if (store.syncKey !== syncKey) return;
      await commit((current) => ({...current, records:applyOutbox(result.records, current.outbox)}),syncKey);
      syncState = 'ready'; lastSyncError = '';
      render();
    } catch (error) {
      syncState = 'offline';
      lastSyncError = error.status ? error.message : '暂时无法连接服务器，记录仍保存在本机，稍后会自动重试。';
    } finally {
      if (hasLock) await persistence.syncLock(syncKey,tabId,true).catch(() => {});
      syncPromise = null;
      status();
    }
  })();
  return syncPromise;
}
function stats() {
  const lessons = new Map();
  const sections = new Map();
  const courses = new Map();
  for (const record of store.records) {
    courses.set(record.courseId, (courses.get(record.courseId) || 0) + 1);
    sections.set(record.sectionId, (sections.get(record.sectionId) || 0) + 1);
    for (const lessonId of record.lessonIds) lessons.set(lessonId, (lessons.get(lessonId) || 0) + 1);
  }
  return {lessons,sections,courses};
}
function renderNav(counts) {
  const courseIcons = ['neck','gait','back','knee'];
  $('#courseNav').innerHTML = data.courses.map((course, index) => `<button type="button" class="course-nav-button" data-course-id="${course.id}" ${course.id === activeCourseId ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(courseIcons[index])}</span><span><span class="nav-course-title">${escapeHtml(course.title)}</span><span class="nav-meta"><span>${course.nominalWeeks}周课程</span><span>· ${course.lessonCount}节</span>${counts.courses.get(course.id) ? `<span class="nav-practiced">${counts.courses.get(course.id)}次记录</span>` : ''}</span></span></button>`).join('');
}
function renderHeader(counts) {
  const course = courseMap.get(activeCourseId);
  const index = data.courses.indexOf(course);
  const practiced = course.sections.flatMap((s) => s.lessons).filter((l) => counts.lessons.has(l.id)).length;
  const times = counts.courses.get(course.id) || 0;
  $('#courseHeader').innerHTML = `<div><span class="eyebrow course-kicker">课程 ${String(index + 1).padStart(2,'0')}</span><h1>${escapeHtml(course.title)}</h1><p class="course-description"><span>${course.nominalWeeks}周课程</span><span class="separator">/</span><span>${course.sections.length}个训练分组</span><span class="separator">/</span><span>${course.lessonCount}节课程</span></p>${course.note ? `<details class="source-note"><summary>课程目录说明</summary><p>${escapeHtml(course.note)}</p></details>` : ''}</div><div class="course-stat"><div class="stat-number">${practiced}<small>/ ${course.lessonCount} 节</small></div><p class="stat-label">已练过${times ? ` · 共记录 ${times} 次` : ''}</p><progress value="${practiced}" max="${course.lessonCount}" aria-label="已练过${practiced}节，共${course.lessonCount}节"></progress></div>`;
  const historyCount = store.records.filter((r) => r.courseId === course.id).length;
  $('#historyCount').textContent = historyCount ? historyCount : '';
  $('#footerTotal').textContent = `4 门课程 · ${data.courses.reduce((sum,c) => sum + c.lessonCount,0).toLocaleString('zh-CN')} 节课`;
}
function lessonHtml(lesson, counts) {
  const times = counts.lessons.get(lesson.id) || 0;
  const minutes = Math.floor(lesson.duration / 60);
  const seconds = String(lesson.duration % 60).padStart(2,'0');
  return `<div class="lesson-row${times ? ' has-record' : ''}" data-lesson-id="${lesson.id}"><span class="lesson-status" title="${times ? `已练过${times}次` : '未练过'}">${icon(times ? 'checked' : 'circle')}</span><div class="lesson-copy"><div class="lesson-title">${escapeHtml(lesson.title)}</div><div class="lesson-meta"><span>${minutes}:${seconds} 视频</span>${times ? `<span class="lesson-repeat">已练 ${times} 次</span>` : '<span>未练过</span>'}<a class="lesson-source" href="${escapeHtml(lesson.url)}" target="_blank" rel="noopener noreferrer" aria-label="在B站打开${escapeHtml(lesson.title)}">去看课程${icon('external')}</a></div></div><button type="button" class="lesson-checkin" data-checkin-lesson="${lesson.id}" aria-label="记录${escapeHtml(lesson.title)}">${icon('plus')}打卡</button></div>`;
}
function sectionHtml(course, section, matchedLessons, counts, forceOpen = false) {
  const times = counts.sections.get(section.id) || 0;
  const practiced = section.lessons.filter((l) => counts.lessons.has(l.id)).length;
  const isOpen = forceOpen || expanded.has(section.id);
  const symbol = section.trainingDay ? String(section.trainingDay).padStart(2,'0') : icon('book');
  return `<article class="training-group" id="section-${section.id}" data-section-id="${section.id}"><div class="group-bar"><button class="group-toggle" type="button" data-toggle-section="${section.id}" aria-expanded="${isOpen}" aria-controls="lessons-${section.id}"><span class="group-symbol${section.trainingDay ? '' : ' theory'}${practiced ? ' practiced' : ''}">${symbol}</span><span class="group-heading"><span class="group-title">${escapeHtml(section.title)}</span><span class="group-meta"><span>${section.lessons.length} ${section.trainingDay ? '项动作' : '节课程'}</span>${practiced ? `<span class="practiced-label">练过 ${practiced} 项</span>` : '<span class="count-label">尚未练习</span>'}${times ? `<span>${times} 次打卡</span>` : ''}</span></span><span class="group-arrow">${icon('chevron')}</span></button><button type="button" class="group-checkin" data-checkin-section="${section.id}" aria-label="为${escapeHtml(section.title)}记录一组训练">${icon('plus')}整组打卡</button></div><div class="lesson-list" id="lessons-${section.id}" ${isOpen ? '' : 'hidden'}>${isOpen ? matchedLessons.map((lesson) => lessonHtml(lesson,counts)).join('') : ''}</div></article>`;
}
function emptyHtml(title, description, iconName = 'journal', reset = false) {
  return `<div class="empty-state"><div class="empty-icon">${icon(iconName)}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${reset ? '<button type="button" class="secondary-button" data-reset-filters>清除筛选</button>' : ''}</div>`;
}
function renderCatalog(counts = stats()) {
  const words = query.toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
  const searchCourses = words.length ? data.courses : [courseMap.get(activeCourseId)];
  let result = '';
  let totalLessons = 0;
  let totalSections = 0;
  const noteMatches = new Set(store.records.filter((record) => words.length && words.every((word) => record.note.toLocaleLowerCase('zh-CN').includes(word))).flatMap((record) => record.lessonIds));
  for (const course of searchCourses) {
    let groups = '';
    let courseCount = 0;
    for (const section of course.sections) {
      const matched = section.lessons.filter((lesson) => {
        const practiced = counts.lessons.has(lesson.id);
        if ((filter === 'practiced' && !practiced) || (filter === 'unpracticed' && practiced)) return false;
        const haystack = `${course.title} ${course.fullTitle} ${section.title} ${lesson.title}`.toLocaleLowerCase('zh-CN');
        return !words.length || words.every((word) => haystack.includes(word)) || noteMatches.has(lesson.id);
      });
      if (!matched.length) continue;
      totalSections++;
      courseCount += matched.length;
      groups += sectionHtml(course,section,matched,counts,words.length > 0 || filter !== 'all');
    }
    if (groups && words.length) result += `<div class="search-course-label"><span>${escapeHtml(course.title)}</span><small>${courseCount} 节匹配</small></div>`;
    result += groups;
    totalLessons += courseCount;
  }
  $('#catalogContent').innerHTML = result || emptyHtml('没有找到对应动作','试试其他关键词，或清除练习情况筛选。','search',true);
  $('#catalogSummary').innerHTML = `<span>${words.length ? `全课程搜索 · ${totalLessons} 节匹配` : `${totalSections} 个训练分组 · ${totalLessons} 节${filter === 'all' ? '课程' : filter === 'practiced' ? '练过的课程' : '未练过的课程'}`}</span>${query || filter !== 'all' ? '<button class="text-button" type="button" data-reset-filters>清除筛选</button>' : '<span>可按组或单节重复记录</span>'}`;
  $$('[data-filter]').forEach((button) => button.setAttribute('aria-pressed',String(button.dataset.filter === filter)));
}
function renderHistory() {
  const records = store.records.filter((record) => record.courseId === activeCourseId).sort((a,b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  const pendingIds = new Set(store.outbox.flatMap((op) => op.kind === 'create' ? [op.payload.id] : op.kind === 'import' ? op.payload.records.map((record) => record.id) : []));
  $('#historyContent').innerHTML = records.length ? records.map((record) => {
    const section = sectionMap.get(record.sectionId);
    return `<article class="history-record" data-record-id="${record.id}"><div class="record-heading"><span class="record-dot">${icon('check')}</span><div class="record-info"><button type="button" class="record-section" data-locate-section="${record.sectionId}">${escapeHtml(section?.title || '训练记录')}</button><span class="record-date"><time class="record-time" datetime="${escapeHtml(record.occurredAt)}">${escapeHtml(dateFormatter.format(new Date(record.occurredAt)))}</time> · ${record.lessonIds.length} 项内容${pendingIds.has(record.id) ? '<span class="pending-tag">待同步</span>' : ''}</span></div><button type="button" class="delete-record" data-delete-record="${record.id}" aria-label="删除这次打卡" title="删除这次打卡">${icon('trash')}</button></div>${record.note ? `<p class="record-note">${escapeHtml(record.note)}</p>` : ''}<details class="record-lessons"><summary>查看本次内容</summary><ol>${record.lessonIds.map((id) => `<li>${escapeHtml(lessonMap.get(id)?.title || id)}</li>`).join('')}</ol></details></article>`;
  }).join('') : emptyHtml('从第一次练习开始','每次打卡的时间、课程内容和备注，都会留在这里。');
}
function render() {
  if (!data || !store) return;
  const counts = stats();
  renderNav(counts);
  renderHeader(counts);
  renderCatalog(counts);
  renderHistory();
  $('#catalogPanel').hidden = view !== 'catalog';
  $('#historyPanel').hidden = view !== 'history';
  $('#catalogTab').setAttribute('aria-selected',String(view === 'catalog'));
  $('#historyTab').setAttribute('aria-selected',String(view === 'history'));
  $('#catalogTab').tabIndex = view === 'catalog' ? 0 : -1;
  $('#historyTab').tabIndex = view === 'history' ? 0 : -1;
  status();
}
function route() {
  const parts = location.hash.slice(1).split('/');
  activeCourseId = courseMap.has(parts[1]) ? parts[1] : data.courses[0].id;
  view = parts[0] === 'history' ? 'history' : 'catalog';
  const course = courseMap.get(activeCourseId);
  const target = sectionMap.get(parts[2]);
  if (target?.courseId === activeCourseId) expanded.add(target.id);
  else if (!course.sections.some((section) => expanded.has(section.id))) expanded.add(course.sections[0].id);
  render();
  if (target?.courseId === activeCourseId && view === 'catalog') requestAnimationFrame(() => $(`#section-${target.id}`)?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}));
}
function setView(next) {
  location.hash = `${next === 'history' ? 'history' : 'course'}/${activeCourseId}`;
}
function resetFilters() {
  query = ''; filter = 'all'; $('#searchInput').value = ''; renderCatalog();
}
function openCheckin(sectionId, lessonId) {
  const section = sectionMap.get(sectionId);
  if (!section) return;
  const course = courseMap.get(section.courseId);
  checkinContext = {sectionId,courseId:course.id,ownerKey:store.syncKey};
  $('#checkinCourse').textContent = course.title;
  $('#checkinSection').textContent = section.title;
  $('#checkinNote').value = '';
  $('#checkinError').textContent = '';
  $('#checkinLessons').innerHTML = section.lessons.map((lesson) => `<label class="checkin-option"><input type="checkbox" name="lessonId" value="${lesson.id}" ${!lessonId || lesson.id === lessonId ? 'checked' : ''}><span>${escapeHtml(lesson.title)}</span></label>`).join('');
  updateSelection();
  $('#checkinDialog').showModal();
}
function updateSelection() {
  const all = $$('input[name=lessonId]', $('#checkinDialog'));
  const checked = all.filter((input) => input.checked);
  $('#selectedCount').textContent = `已选 ${checked.length} / ${all.length} 项`;
  $('#saveCheckinButton').disabled = !checked.length;
  $('#toggleAllLessons').textContent = checked.length === all.length ? '取消全选' : '全选内容';
}
async function saveCheckin(event) {
  event.preventDefault();
  const lessonIds = $$('input[name=lessonId]:checked', $('#checkinDialog')).map((input) => input.value);
  if (!checkinContext || !lessonIds.length) return;
  const payload = {id:uuid(),sectionId:checkinContext.sectionId,courseId:checkinContext.courseId,lessonIds,note:$('#checkinNote').value,occurredAt:new Date().toISOString()};
  const button = $('#saveCheckinButton');
  button.disabled = true;
  try {
    await commit((current) => ({...current,records:[...current.records,{...payload,createdAt:payload.occurredAt,deletedAt:null}],outbox:[...current.outbox,{opId:uuid(),kind:'create',payload}]}),checkinContext.ownerKey);
  } catch (error) {
    $('#checkinError').textContent = error.message.includes('另一标签') ? error.message : '浏览器未能保存记录，请导出已有记录或释放存储空间后重试。备注和选择已保留。';
    button.disabled = false;
    return;
  }
  $('#checkinDialog').close();
  render();
  toast(`已记录这次训练 · ${lessonIds.length} 项内容`);
  void sync();
}
async function deleteRecord(id) {
  const record = store.records.find((item) => item.id === id);
  if (!record) return;
  const ownerKey = store.syncKey;
  try { await commit((current) => ({...current,records:current.records.filter((item) => item.id !== id),outbox:[...current.outbox,{opId:uuid(),kind:'delete',id}]})); }
  catch { toast('暂时无法保存修改，请稍后重试。',null,null,true); return; }
  render();
  toast('已删除这次打卡','撤销',async () => {
    if (store.syncKey !== ownerKey) return;
    try { await commit((current) => ({...current,records:current.records.some((item) => item.id === id) ? current.records : [...current.records,record],outbox:[...current.outbox,{opId:uuid(),kind:'restore',id,record}]})); }
    catch { toast('暂时无法恢复，请稍后重试。',null,null,true); return; }
    render(); toast('已恢复这次打卡'); void sync();
  });
  void sync();
}
async function switchKey(event) {
  event.preventDefault();
  const key = $('#otherSyncKey').value.trim();
  const error = $('#settingsError');
  error.textContent = '';
  if (!keyPattern.test(key)) { error.textContent = '请输入完整同步码（32–96位字母、数字、下划线或短横线）。'; return; }
  const button = $('#switchKeyButton');
  const sourceKey = store.syncKey;
  button.disabled = true;
  try {
    await sync();
    if (store.outbox.length) throw new Error('当前还有待同步的记录，请联网完成同步后再连接另一份记录。');
    const result = await api('checkins',{},key);
    await commit((current) => {
      if (current.outbox.length) throw new Error('当前还有待同步的记录，已保留原同步码，请同步后重试连接。');
      return {syncKey:key,records:result.records,outbox:[]};
    },sourceKey);
    $('#currentSyncKey').value = key;
    $('#otherSyncKey').value = '';
    clearImportPreview();
    syncState = 'ready'; lastSyncError = ''; $('#toastRegion').replaceChildren();
    render(); toast('已连接到这份训练记录');
  } catch (failure) { error.textContent = failure.status || failure.message.includes('待同步') ? failure.message : '连接未完成，当前训练记录保持不变，请稍后重试。'; }
  finally { button.disabled = false; }
}
async function exportRecords() {
  try {
    const ownerKey = store.syncKey;
    const snapshot = await persistence.read();
    if (snapshot.syncKey !== ownerKey) throw new Error('另一标签页已切换同步码，请刷新后导出。');
    const result = createBackup(snapshot.records,data,new Date().toISOString());
    let text = JSON.stringify(result,null,2);
    if (new TextEncoder().encode(text).length > BACKUP_MAX_BYTES) text = JSON.stringify(result);
    const url = URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url;
    a.download = `训练手记备份_${new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    $('#backupFeedback').textContent = `已导出四门课程中的 ${result.records.length} 条打卡记录。`;
    toast(`已导出 ${result.records.length} 条打卡记录`);
  } catch (error) {
    $('#backupFeedback').textContent = error.message;
    toast(error.message,null,null,true);
  }
}
function clearImportPreview() {
  importRequestId++;
  pendingImport = null;
  $('#importPreview').hidden = true;
  $('#confirmImportButton').disabled = false;
  $('#backupFeedback').textContent = '';
}
async function prepareImport(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || importing) return;
  clearImportPreview();
  const requestId = importRequestId;
  const ownerKey = store.syncKey;
  $('#backupFeedback').textContent = '正在检查备份文件…';
  try {
    if (file.size > BACKUP_MAX_BYTES) throw new Error('备份文件不能超过 16 MiB。');
    const value = normalizeBackup(JSON.parse(await file.text()),data);
    const snapshot = await persistence.read();
    if (requestId !== importRequestId) return;
    if (snapshot.syncKey !== ownerKey) throw new Error('同步码已切换，请重新选择备份文件。');
    const existing = new Set(snapshot.records.map((record) => record.id));
    const knownCount = value.records.filter((record) => existing.has(record.id)).length;
    const courseCounts = new Map();
    for (const record of value.records) courseCounts.set(record.courseId,(courseCounts.get(record.courseId) || 0) + 1);
    pendingImport = {records:value.records,ownerKey,filename:file.name,requestId};
    $('#importSummary').innerHTML = `<strong class="backup-filename">${escapeHtml(file.name)}</strong><p>共 ${value.records.length} 条记录，预计新增 ${value.records.length - knownCount} 条，已有 ${knownCount} 条。</p><ul>${data.courses.filter((course) => courseCounts.has(course.id)).map((course) => `<li><span>${escapeHtml(course.title)}</span><span>${courseCounts.get(course.id)} 条</span></li>`).join('')}</ul><p class="field-hint">已有同编号记录优先保留，原打卡时间不变。</p>`;
    $('#importPreview').hidden = false;
    $('#confirmImportButton').disabled = !value.records.length;
    $('#backupFeedback').textContent = value.records.length ? '检查完成，请确认合并导入。' : '备份中没有可导入的记录。';
  } catch (error) {
    if (requestId !== importRequestId) return;
    $('#backupFeedback').textContent = error instanceof SyntaxError ? '备份不是有效的 JSON 文件，当前记录未修改。' : error.message;
  }
}
async function confirmImport() {
  const preview = pendingImport;
  if (!preview || importing || !preview.records.length) return;
  importing = true;
  $('#confirmImportButton').disabled = true;
  $('#cancelImportButton').disabled = true;
  let report;
  try {
    const operations = buildImportOperations(preview.records).map((payload) => ({kind:'import',opId:uuid(),payload}));
    await commit((current) => {
      const records = new Map(current.records.map((record) => [record.id,record]));
      let added = 0;
      for (const record of preview.records) {
        if (!records.has(record.id)) { records.set(record.id,record); added++; }
      }
      report = {added,existing:preview.records.length - added};
      return {...current,records:[...records.values()],outbox:[...current.outbox,...operations]};
    },preview.ownerKey);
    clearImportPreview();
    render();
    const message = `已合并 ${preview.records.length} 条备份记录：新增 ${report.added} 条，保留已有 ${report.existing} 条。`;
    $('#backupFeedback').textContent = message;
    toast(message);
    void sync();
  } catch (error) {
    $('#backupFeedback').textContent = error.message;
    $('#confirmImportButton').disabled = false;
  } finally {
    importing = false;
    $('#cancelImportButton').disabled = false;
  }
}
async function copyKey() {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(store.syncKey);
    else {
      const input = document.createElement('textarea');
      input.value = store.syncKey; input.style.position = 'fixed'; input.style.opacity = '0';
      $('#settingsDialog').append(input); input.select();
      const copied = document.execCommand('copy'); input.remove();
      if (!copied) throw new Error('copy');
    }
    toast('同步码已复制');
  } catch {
    const input = $('#currentSyncKey'); input.type = 'text'; input.focus(); input.select();
    toast('已选中同步码，可手动复制');
  }
}
function bindEvents() {
  fillIcons(); $('#settingsButton').innerHTML = icon('settings');
  $('#courseNav').addEventListener('click',(event) => {
    const button = event.target.closest('[data-course-id]');
    if (!button) return;
    resetFilters(); location.hash = `${view === 'history' ? 'history' : 'course'}/${button.dataset.courseId}`;
  });
  $('#catalogTab').addEventListener('click',() => setView('catalog'));
  $('#historyTab').addEventListener('click',() => setView('history'));
  $$('.view-tabs button').forEach((button) => button.addEventListener('keydown',(event) => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'catalog' : event.key === 'End' ? 'history' : view === 'catalog' ? 'history' : 'catalog';
    setView(next); $(`#${next === 'catalog' ? 'catalogTab' : 'historyTab'}`).focus();
  }));
  $('#sourceLink').addEventListener('click',() => window.open(courseMap.get(activeCourseId).sourceUrl,'_blank','noopener,noreferrer'));
  $('#searchInput').addEventListener('input',(event) => {
    query = event.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => renderCatalog(),100);
  });
  $$('.filter-tabs button').forEach((button) => button.addEventListener('click',() => { filter = button.dataset.filter; renderCatalog(); }));
  $('#catalogPanel').addEventListener('click',(event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-reset-filters')) { resetFilters(); return; }
    if (target.dataset.checkinSection) { openCheckin(target.dataset.checkinSection); return; }
    if (target.dataset.checkinLesson) { const lesson = lessonMap.get(target.dataset.checkinLesson); openCheckin(lesson.sectionId,lesson.id); return; }
    if (target.dataset.toggleSection) {
      const id = target.dataset.toggleSection;
      const isOpen = target.getAttribute('aria-expanded') === 'true';
      if (isOpen) expanded.delete(id); else expanded.add(id);
      const section = sectionMap.get(id);
      const list = $(`#lessons-${id}`);
      if (!isOpen && !list.children.length) list.innerHTML = section.lessons.map((lesson) => lessonHtml(lesson,stats())).join('');
      list.hidden = isOpen;
      target.setAttribute('aria-expanded',String(!isOpen));
    }
  });
  $('#checkinForm').addEventListener('submit',saveCheckin);
  $('#checkinLessons').addEventListener('change',updateSelection);
  $('#toggleAllLessons').addEventListener('click',() => {
    const inputs = $$('input[name=lessonId]',$('#checkinDialog'));
    const all = inputs.every((input) => input.checked);
    inputs.forEach((input) => { input.checked = !all; }); updateSelection();
  });
  $('#historyContent').addEventListener('click',(event) => {
    const remove = event.target.closest('[data-delete-record]');
    if (remove) { deleteRecord(remove.dataset.deleteRecord); return; }
    const locate = event.target.closest('[data-locate-section]');
    if (locate) { resetFilters(); location.hash = `course/${activeCourseId}/${locate.dataset.locateSection}`; }
  });
  $('#settingsButton').addEventListener('click',() => {
    $('#currentSyncKey').type = 'password'; $('#currentSyncKey').value = store.syncKey; $('#settingsError').textContent = ''; $('#otherSyncKey').value = ''; $('#settingsDialog').showModal();
  });
  $('#copySyncKey').addEventListener('click',copyKey);
  $('#switchKeyForm').addEventListener('submit',switchKey);
  $('#exportRecordsButton').addEventListener('click',exportRecords);
  $('#settingsExportButton').addEventListener('click',exportRecords);
  $('#backupFile').addEventListener('change',prepareImport);
  $('#confirmImportButton').addEventListener('click',confirmImport);
  $('#cancelImportButton').addEventListener('click',() => { if (!importing) { clearImportPreview(); $('#backupFeedback').textContent = ''; } });
  $$('.close-dialog').forEach((button) => button.addEventListener('click',() => button.closest('dialog').close()));
  $$('dialog').forEach((dialog) => dialog.addEventListener('click',(event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }));
  window.addEventListener('hashchange',route);
  window.addEventListener('online',() => void sync());
  window.addEventListener('focus',() => { if (!document.hidden) void sync(); });
  document.addEventListener('visibilitychange',() => { if (!document.hidden) void sync(); });
  document.addEventListener('keydown',(event) => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
      event.preventDefault(); if (view !== 'catalog') setView('catalog'); $('#searchInput').focus();
    }
  });
  setInterval(() => { if (store.outbox.length && !document.hidden) void sync(); },15000);
}
async function init() {
  try {
    persistence = await openJournalStore({storageKey:STORAGE_KEY,initial:() => ({syncKey:newSyncKey(),records:[],outbox:[]}),validate:validateStore});
    store = await persistence.read();
    const response = await fetch(new URL('catalog.json',document.baseURI));
    if (!response.ok) throw new Error('课程目录加载失败，请刷新页面重试。');
    data = await response.json();
    for (const course of data.courses) {
      courseMap.set(course.id,course);
      for (const section of course.sections) {
        sectionMap.set(section.id,{...section,courseId:course.id});
        for (const lesson of section.lessons) lessonMap.set(lesson.id,{...lesson,courseId:course.id,sectionId:section.id});
      }
    }
    bindEvents();
    persistence.subscribe(async () => {
      const latest = await persistence.read();
      if (latest.syncKey !== store.syncKey) {
        toast('另一标签页已切换同步码，请刷新页面后继续。',null,null,true);
        return;
      }
      store = latest;
      render();
      if (store.outbox.length && navigator.onLine) void sync();
    });
    if (!location.hash) history.replaceState(null,'',`#course/${data.courses[0].id}`);
    route(); void sync();
  } catch (error) {
    $('#catalogContent').innerHTML = emptyHtml('暂时无法打开训练手记',error.message || '请刷新页面重试。');
    $('#syncStatus').textContent = '载入未完成';
  }
}
void init();
