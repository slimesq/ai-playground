export const BACKUP_MAX_BYTES = 16 * 1024 * 1024;

const FORMAT = 'rehab-study-tracker';
const RECORD_FIELDS = ['id', 'courseId', 'sectionId', 'lessonIds', 'note', 'occurredAt', 'createdAt', 'deletedAt'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_MAX_BYTES = 96 * 1024;
const DEFAULT_BATCH_BYTES = 88 * 1024;
const encoder = new TextEncoder();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value) {
  let text;
  try { text = JSON.stringify(value); }
  catch { throw new Error('备份不是有效的 JSON 数据。'); }
  if (typeof text !== 'string') throw new Error('备份不是有效的 JSON 数据。');
  return encoder.encode(text).length;
}

function timestamp(value) {
  if (typeof value !== 'string') throw new Error('记录时间须为带时区的 ISO 日期。');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('记录时间须为带时区的 ISO 日期。');
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error('记录时间无效。');
  }
  const canonical = new Date(value).toISOString();
  if (!/^\d{4}-/.test(canonical)) throw new Error('记录时间无效。');
  return canonical;
}

function catalogIndex(catalog) {
  if (!isObject(catalog) || !Array.isArray(catalog.courses)) throw new Error('课程目录无效。');
  const courses = new Set();
  const sections = new Map();
  const lessons = new Map();
  for (const course of catalog.courses) {
    courses.add(course.id);
    for (const section of course.sections) {
      sections.set(section.id, course.id);
      for (const lesson of section.lessons) lessons.set(lesson.id, { courseId: course.id, sectionId: section.id });
    }
  }
  return { courses, sections, lessons };
}

function validateRecord(value, index) {
  if (!isObject(value) || Object.keys(value).length !== RECORD_FIELDS.length
    || RECORD_FIELDS.some(field => !Object.hasOwn(value, field))) {
    throw new Error('备份中的学习记录字段不完整或包含额外字段。');
  }
  if (typeof value.id !== 'string' || !UUID.test(value.id)) throw new Error('记录编号须为有效的 UUID。');
  const { courseId, sectionId, note } = value;
  if (typeof courseId !== 'string' || !index.courses.has(courseId)
    || typeof sectionId !== 'string' || index.sections.get(sectionId) !== courseId) {
    throw new Error('备份中的课程与章节不匹配。');
  }
  if (!Array.isArray(value.lessonIds) || !value.lessonIds.length
    || value.lessonIds.some(id => typeof id !== 'string'
      || index.lessons.get(id)?.courseId !== courseId || index.lessons.get(id)?.sectionId !== sectionId)) {
    throw new Error('备份中的课程内容不属于所选章节。');
  }
  if (typeof note !== 'string' || note.length > 2000 || note.includes('\u0000')) {
    throw new Error('学习记录须为不超过 2000 字的文本。');
  }
  if (value.deletedAt !== null) throw new Error('备份只能包含当前有效的学习记录。');
  return {
    id: value.id.toLowerCase(), courseId, sectionId,
    lessonIds: [...new Set(value.lessonIds)], note,
    occurredAt: timestamp(value.occurredAt), createdAt: timestamp(value.createdAt), deletedAt: null,
  };
}

export function normalizeRecord(record, catalog) {
  return validateRecord(record, catalogIndex(catalog));
}

function normalizeRecords(records, catalog) {
  if (!Array.isArray(records)) throw new Error('备份缺少有效的学习记录列表。');
  const index = catalogIndex(catalog);
  const unique = new Map();
  const signatures = new Map();
  for (const input of records) {
    const record = validateRecord(input, index);
    // Record IDs identify a specific check-in. Different IDs must remain
    // separate even if their content and both timestamps are identical.
    const signature = JSON.stringify({ ...record, lessonIds: [...record.lessonIds].sort() });
    if (unique.has(record.id)) {
      if (signatures.get(record.id) !== signature) throw new Error('备份中同一记录编号对应了不同内容或时间。');
    } else {
      unique.set(record.id, record);
      signatures.set(record.id, signature);
    }
  }
  return [...unique.values()];
}

export function normalizeBackup(value, catalog) {
  if (!isObject(value) || value.format !== FORMAT || ![1, 2].includes(value.version)) {
    throw new Error('请选择训练手记导出的有效备份文件。');
  }
  if (jsonBytes(value) > BACKUP_MAX_BYTES) throw new Error('备份文件不能超过 16 MiB。');
  if (!Number.isInteger(value.catalogVersion) || value.catalogVersion < 1) throw new Error('备份的课程目录版本无效。');
  const exportedAt = timestamp(value.exportedAt);
  const records = normalizeRecords(value.records, catalog);
  // Version 1's queue is diagnostic metadata, not data to replay. Restore
  // only records and never return sync keys, deletes, restores, or outboxes.
  return { format: FORMAT, version: value.version, exportedAt, catalogVersion: value.catalogVersion, records };
}

export function createBackup(records, catalog, exportedAt) {
  return normalizeBackup({ format: FORMAT, version: 2, exportedAt, catalogVersion: catalog.version, records }, catalog);
}

export function buildImportOperations(records, maxBytes = DEFAULT_BATCH_BYTES) {
  if (!Array.isArray(records)) throw new Error('导入记录列表无效。');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > REQUEST_MAX_BYTES) {
    throw new Error('导入批次大小须在 1 至 98304 字节之间。');
  }
  const operations = [];
  const emptySize = jsonBytes({ records: [] });
  let batch = [];
  let size = emptySize;
  for (const record of records) {
    const recordSize = jsonBytes(record);
    if (emptySize + recordSize > maxBytes) throw new Error('单条记录超过导入批次大小。');
    if (batch.length && (batch.length === 100 || size + 1 + recordSize > maxBytes)) {
      operations.push({ records: batch });
      batch = [];
      size = emptySize;
    }
    size += recordSize + (batch.length ? 1 : 0);
    batch.push(record);
  }
  if (batch.length) operations.push({ records: batch });
  return operations;
}
