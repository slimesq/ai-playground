export const SYNC_BODY_LIMIT = 160 * 1024;
export const MAX_HISTORY_BYTES = 96 * 1024;
export const MAX_NOTE_LENGTH = 4000;

const COURSE_ID = /^(?:s1-(?:0[1-9]|1[0-4])|s[234]-(?:0[1-9]|1[0-9]|20))$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export function normalizeJournalTimestamp(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new Error('学习记录时间须为有效的 ISO 日期时间。');
  const [, year, month, day, hour, minute, second, , zone] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  const parsed = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
    || !Number.isFinite(parsed.getTime()) || !/^\d{4}-/.test(parsed.toISOString())) throw new Error('学习记录时间须为有效的 ISO 日期时间。');
  return parsed.toISOString();
}

function legacyId(courseId, updatedAt, note) {
  // A stable identifier preserves the same old note across reload, backup and sync.
  // This is an identifier only; server conflict versions use SHA-256 separately.
  const bytes = encoder.encode(JSON.stringify([courseId, updatedAt, note]));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `legacy-${courseId}-${hash.toString(16).padStart(16, '0')}`;
}

export function normalizeHistory(courseId, record) {
  if (!COURSE_ID.test(courseId) || !record || typeof record !== 'object' || Array.isArray(record)) throw new Error('学习记录历史格式不正确。');
  let source;
  if (Object.hasOwn(record, 'history')) {
    if (!Array.isArray(record.history)) throw new Error('学习记录历史须为数组。');
    source = record.history;
  } else {
    if (typeof record.note !== 'string' || record.note.length > MAX_NOTE_LENGTH) throw new Error('每次学习记录最多 4000 字。');
    if (!record.note.length) return [];
    const createdAt = normalizeJournalTimestamp(record.updatedAt);
    source = [{ id: legacyId(courseId, createdAt, record.note), createdAt, note: record.note, legacy: true }];
  }
  const ids = new Set();
  const legacyPattern = new RegExp(`^legacy-${courseId}-[a-f0-9]{16}$`);
  const history = source.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'createdAt', 'note', 'legacy'].includes(key))
      || typeof item.id !== 'string' || !UUID.test(item.id) && !(item.legacy === true && legacyPattern.test(item.id))
      || typeof item.note !== 'string' || item.note.length > MAX_NOTE_LENGTH
      || Object.hasOwn(item, 'legacy') && item.legacy !== true) throw new Error('学习记录历史包含无效的编号或内容。');
    const id = item.id.toLowerCase();
    if (ids.has(id)) throw new Error('学习记录历史包含重复编号。');
    ids.add(id);
    return { id, createdAt: normalizeJournalTimestamp(item.createdAt), note: item.note, ...(item.legacy === true ? { legacy: true } : {}) };
  });
  if (encoder.encode(JSON.stringify(history)).byteLength > MAX_HISTORY_BYTES) throw new Error('本课程历史记录过大，本次内容尚未保存，请先导出备份。');
  return history;
}
