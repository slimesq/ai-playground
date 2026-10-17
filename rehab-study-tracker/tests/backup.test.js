import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog } from '../catalog.js';
import {
  BACKUP_MAX_BYTES, normalizeRecord, normalizeBackup, createBackup, buildImportOperations,
} from '../public/backup.js';

const encoder = new TextEncoder();
const byteSize = value => encoder.encode(JSON.stringify(value)).length;
const exportedAt = '2026-10-16T15:22:33.456Z';
const makeId = index => `fbe2690d-1234-4abc-8def-${String(index).padStart(12, '0')}`;

function record(overrides = {}, course = catalog.courses[0], section = course.sections[0]) {
  return {
    id: makeId(1), courseId: course.id, sectionId: section.id,
    lessonIds: section.lessons.slice(0, 2).map(lesson => lesson.id),
    note: '  完成一轮\n记录原感受 🌱  ', occurredAt: '2026-10-15T12:34:56.123Z',
    createdAt: '2026-10-16T14:00:01.005Z', deletedAt: null, ...overrides,
  };
}

function backup(records = [record()], overrides = {}) {
  return { format: 'rehab-study-tracker', version: 2, exportedAt, catalogVersion: catalog.version, records, ...overrides };
}

test('v1 and v2 exports round trip all course records, original IDs, both times, and exact notes', () => {
  const original = catalog.courses.map((course, index) => record({ id: makeId(index + 1) }, course));
  for (const version of [1, 2]) {
    const input = backup(original, { version });
    const before = JSON.stringify(input);
    const normalized = normalizeBackup(JSON.parse(before), catalog);
    assert.deepEqual(normalized.records, original);
    const exported = createBackup(normalized.records, catalog, exportedAt);
    assert.deepEqual(exported, backup(original));
    assert.deepEqual(normalizeBackup(JSON.parse(JSON.stringify(exported)), catalog).records, original);
    assert.equal(JSON.stringify(input), before, 'normalization must not mutate the source backup');
    assert.deepEqual(Object.keys(exported).sort(), ['catalogVersion', 'exportedAt', 'format', 'records', 'version']);
  }
});

test('every real section and lesson is accepted only with its own course and section', () => {
  for (const course of catalog.courses) {
    for (const section of course.sections) {
      const input = record({ lessonIds: section.lessons.map(lesson => lesson.id) }, course, section);
      assert.deepEqual(normalizeRecord(input, catalog), input);
      const otherCourse = catalog.courses.find(item => item.id !== course.id);
      assert.throws(() => normalizeRecord({ ...input, courseId: otherCourse.id }, catalog), /课程与章节/);
      const otherSection = course.sections.find(item => item.id !== section.id);
      assert.throws(() => normalizeRecord({ ...input, lessonIds: [otherSection.lessons[0].id] }, catalog), /所选章节/);
    }
  }
});

test('UUIDs, timestamps, and lesson arrays normalize without losing values or original selection order', () => {
  const input = record({ id: makeId(7).toUpperCase(), occurredAt: '2026-10-16T23:00:00+08:00',
    createdAt: '2026-10-16T11:00:01.5-04:00' });
  input.lessonIds = [input.lessonIds[1], input.lessonIds[0], input.lessonIds[1]];
  const normalized = normalizeRecord(input, catalog);
  assert.equal(normalized.id, makeId(7));
  assert.equal(normalized.occurredAt, '2026-10-16T15:00:00.000Z');
  assert.equal(normalized.createdAt, '2026-10-16T15:00:01.500Z');
  assert.deepEqual(normalized.lessonIds, input.lessonIds.slice(0, 2));
  assert.equal(input.lessonIds.length, 3);
  assert.equal(normalized.note, input.note);
  assert.equal(normalizeRecord(record({ occurredAt: '2000-02-29T00:00:00Z' }), catalog).occurredAt, '2000-02-29T00:00:00.000Z');
});

test('same-ID duplicates collapse only when all normalized content and times match; separate check-ins remain', () => {
  const first = record();
  const reordered = record({ id: first.id.toUpperCase(), lessonIds: [...first.lessonIds].reverse(),
    occurredAt: '2026-10-15T20:34:56.123+08:00' });
  const repeatedCheckin = record({ id: makeId(2) });
  assert.deepEqual(normalizeBackup(backup([first, reordered, repeatedCheckin]), catalog).records, [first, repeatedCheckin]);
  for (const change of [
    { note: '另一条内容' }, { createdAt: '2026-10-16T14:00:02.005Z' },
    { occurredAt: '2026-10-15T12:34:57.123Z' }, { lessonIds: first.lessonIds.slice(0, 1) },
  ]) {
    const input = backup([first, record(change)]);
    const before = JSON.stringify(input);
    assert.throws(() => normalizeBackup(input, catalog), /同一记录编号/);
    assert.equal(JSON.stringify(input), before);
  }
});

test('malformed records and dates reject the complete backup instead of recovering a partial subset', () => {
  const original = record();
  const invalid = [null, [], {}, ...Object.keys(original).map(key => {
    const copy = { ...original }; delete copy[key]; return copy;
  }), ...[
    { unknown: true }, { id: 'not-a-uuid' }, { id: '00000000-0000-0000-0000-000000000000' },
    { courseId: Number(original.courseId) }, { courseId: 'missing' }, { sectionId: 'missing' },
    { lessonIds: [] }, { lessonIds: ['missing'] }, { lessonIds: [Number(original.lessonIds[0])] },
    { lessonIds: original.lessonIds.join(',') }, { note: null }, { note: 'x'.repeat(2001) },
    { note: '开头\u0000结尾' }, { deletedAt: '2026-10-16T12:00:00Z' }, { deletedAt: false },
  ].map(change => ({ ...original, ...change }))];
  for (const date of [
    null, 123, '2026-10-16', '2026-10-16T10:00:00', '2026-2-01T00:00:00Z',
    '2026-02-29T10:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
    '2026-00-16T00:00:00Z', '2026-13-16T00:00:00Z', '2026-10-00T00:00:00Z',
    '2026-10-16T24:00:00Z', '2026-10-16T00:60:00Z', '2026-10-16T00:00:60Z',
    '2026-10-16T10:00:00+24:00', '2026-10-16T10:00:00+08:60', '2026-10-16T10:00:00Zjunk',
    '2026-10-16T10:00:00.1234Z', '9999-12-31T23:59:59-23:59',
  ]) {
    invalid.push(record({ occurredAt: date }), record({ createdAt: date }));
  }
  for (const input of invalid) {
    assert.throws(() => normalizeBackup(backup([record({ id: makeId(2) }), input]), catalog));
  }
});

test('other-site formats and oversized backups are rejected, while old queue metadata is never replayed', () => {
  for (const value of [null, [], {}, backup([], { format: 'vocal-study-planner' }),
    backup([], { version: 3 }), backup([], { version: '1' }), backup(null),
    backup([], { exportedAt: 'bad' }), backup([], { catalogVersion: null })]) {
    assert.throws(() => normalizeBackup(value, catalog));
  }
  const active = record();
  const input = backup([active], { version: 1, syncKey: 'do-not-import-this-secret',
    pendingOperations: [{ kind: 'delete', id: active.id }, { kind: 'restore', id: makeId(2) },
      { kind: 'create', payload: record({ id: makeId(3) }) }], outbox: [{ destructive: true }] });
  const normalized = normalizeBackup(input, catalog);
  assert.deepEqual(normalized.records, [active]);
  for (const field of ['syncKey', 'pendingOperations', 'outbox']) assert.equal(Object.hasOwn(normalized, field), false);
  assert.deepEqual(createBackup(normalized.records, catalog, exportedAt), backup([active]));
  assert.equal(BACKUP_MAX_BYTES, 16 * 1024 * 1024);
  assert.throws(() => normalizeBackup(backup([], { ignoredMetadata: '中'.repeat(Math.ceil(BACKUP_MAX_BYTES / 3)) }), catalog), /16 MiB/);
});

test('UTF-8 import batches preserve all records, stay below byte limits, and carry no internal operations', () => {
  const records = Array.from({ length: 73 }, (_, index) => record({ id: makeId(index + 1), note: '康复🌱'.repeat(400) }));
  const batches = buildImportOperations(records);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap(batch => batch.records), records);
  for (const batch of batches) {
    assert.deepEqual(Object.keys(batch), ['records']);
    assert.ok(batch.records.length > 0 && batch.records.length <= 100);
    assert.ok(byteSize(batch) <= 88 * 1024);
    assert.ok(byteSize(batch) <= 96 * 1024);
  }
  const compact = Array.from({ length: 205 }, (_, index) => record({ id: makeId(index + 1), note: '' }));
  assert.deepEqual(buildImportOperations(compact).map(batch => batch.records.length), [100, 100, 5]);
  assert.deepEqual(buildImportOperations([]), []);
});

test('batch sizing includes JSON wrappers, commas, and escaped characters at exact boundaries', () => {
  const a = record({ note: '\n"\\\t中文🌱'.repeat(30) });
  const b = record({ id: makeId(2), note: a.note });
  const twoRecordBytes = byteSize({ records: [a, b] });
  assert.equal(buildImportOperations([a, b], twoRecordBytes).length, 1);
  assert.equal(buildImportOperations([a, b], twoRecordBytes - 1).length, 2);
  assert.throws(() => buildImportOperations([a], byteSize({ records: [a] }) - 1), /单条记录/);
  for (const limit of [0, -1, 1.5, 96 * 1024 + 1, NaN, '4096']) {
    assert.throws(() => buildImportOperations([a], limit));
  }
  assert.throws(() => buildImportOperations(null));
});
