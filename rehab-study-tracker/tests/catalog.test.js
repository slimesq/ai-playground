import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { catalog, courses, sections, lessons } from '../catalog.js';

test('all four official course catalogs retain their full lesson and chapter counts', () => {
  assert.equal(catalog.version, 1);
  assert.equal(catalog.source, '蛋壳健康-杨帆');
  assert.deepEqual(catalog.courses.map(course => [course.id, course.nominalWeeks,
    course.declaredCount, course.lessonCount, course.sections.length]), [
    ['37378', 4, 196, 196, 28],
    ['27460', 4, 190, 190, 28],
    ['24429', 6, 441, 441, 38],
    ['21198', 4, 185, 258, 31],
  ]);
  const allLessons = catalog.courses.flatMap(course => course.sections.flatMap(section => section.lessons));
  assert.equal(allLessons.length, 1085);
  assert.equal(new Set(allLessons.map(lesson => lesson.id)).size, 1085);
  assert.equal(courses.size, 4);
  assert.equal(sections.size, 125);
  assert.equal(lessons.size, 1085);
});

test('official source snapshot preserves every title, duration, link, order, and chapter assignment', () => {
  // Verified against the 2026-10-16 source export and its official section
  // episode_ids. Hash chapter content, not display labels or editorial notes.
  const sourceDigests = {
    '37378': '0b511a1063532077c56b56428a69115ff808a9da1484d9fca06b0e296bfbf33e',
    '27460': 'a796bb3308f14bfa58e02369679d91ccad604711ee4ac2424a0dff6faa83e276',
    '24429': 'b30d8061902f1bc2a1d3e31f51895897f155562f6dfd870152f891e323cb42c4',
    '21198': '511a77d8e1c8e339336098ea19d3c311e3b68c011d2035abb987c803761bb4a6',
  };
  for (const course of catalog.courses) {
    assert.equal(createHash('sha256').update(JSON.stringify(course.sections)).digest('hex'),
      sourceDigests[course.id], `${course.title}: official lesson catalog must remain intact`);
  }
});

test('lookup maps retain string IDs and exact course/section parents for every lesson', () => {
  for (const course of catalog.courses) {
    assert.equal(typeof course.id, 'string');
    assert.equal(courses.get(course.id).courseId, course.id);
    assert.equal(course.sourceUrl, `https://www.bilibili.com/cheese/play/ss${course.id}`);
    assert.equal(course.sections.reduce((count, section) => count + section.lessons.length, 0), course.lessonCount);
    for (const section of course.sections) {
      assert.equal(typeof section.id, 'string');
      assert.ok(section.lessons.length > 0, 'empty default chapters are omitted');
      assert.equal(sections.get(section.id).courseId, course.id);
      assert.equal(sections.get(section.id).sectionId, section.id);
      for (const lesson of section.lessons) {
        assert.equal(typeof lesson.id, 'string');
        assert.equal(lessons.get(lesson.id).courseId, course.id);
        assert.equal(lessons.get(lesson.id).sectionId, section.id);
        assert.equal(lessons.get(lesson.id).title, lesson.title);
        assert.ok(Number.isInteger(lesson.duration) && lesson.duration >= 0);
        assert.equal(lesson.url, `https://www.bilibili.com/cheese/play/ep${lesson.id}`);
      }
    }
  }
  assert.equal(lessons.has('unknown'), false);
  assert.equal(sections.has('unknown'), false);
});

test('back rehabilitation follows official training chapters, never video title suffixes', () => {
  const back = courses.get('24429');
  assert.equal(back.sections[0].title, '训练日1');
  assert.equal(back.sections[0].trainingDay, 1);
  assert.equal(back.sections[0].lessons[0].id, '840388');
  assert.equal(back.sections[0].lessons[0].title, '腹式呼吸3');
  assert.equal(lessons.get('840388').sectionId, '122014');
  assert.deepEqual(back.sections.slice(8, 11).map(section => section.title), ['训练课9', '训练课10', '训练课11']);
  assert.deepEqual(back.sections.map(section => section.trainingDay), Array.from({ length: 38 }, (_, index) => index + 1));
  assert.equal(back.nominalWeeks, 6);
  assert.match(back.note, /38/);
});

test('knee rehabilitation retains default, theory, assessment, and all 28 training chapters', () => {
  const knee = courses.get('21198');
  assert.deepEqual(knee.sections.slice(0, 3).map(section =>
    [section.id, section.title, section.trainingDay, section.lessons.length]), [
    ['104996', '默认章节', null, 16],
    ['105000', '理论课', null, 16],
    ['105001', '自我评估课', null, 4],
  ]);
  assert.equal(knee.sections[3].title, '动作训练课：第1天');
  assert.equal(knee.sections[8].title, '运动训练课：第6天');
  assert.deepEqual(knee.sections.slice(0, 2).map(section =>
    [section.lessons[0].id, section.lessons[0].title]), [
    ['723119', '1. 找到肌肉发力感'],
    ['805884', '1.找到肌肉发力感'],
  ], 'similar content in the default and theory chapters remains separate original videos');
  assert.deepEqual(knee.sections.slice(3).map(section => section.trainingDay),
    Array.from({ length: 28 }, (_, index) => index + 1));
  assert.equal(knee.sections.slice(3).reduce((sum, section) => sum + section.lessons.length, 0), 222);
  assert.equal(knee.declaredCount, 185);
  assert.equal(knee.lessonCount, 258);
  assert.match(knee.note, /185.*258/);
});
