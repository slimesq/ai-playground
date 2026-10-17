import { readFileSync } from 'node:fs';

// Keep the browser and server on the same unmodified official chapter catalog.
export const catalog = JSON.parse(readFileSync(new URL('./public/catalog.json', import.meta.url), 'utf8'));
export const courses = new Map();
export const sections = new Map();
export const lessons = new Map();

function insertUnique(map, entry) {
  if (typeof entry.id !== 'string' || !entry.id || map.has(entry.id)) {
    throw new Error(`Invalid or duplicate catalog ID: ${entry.id}`);
  }
  map.set(entry.id, Object.freeze(entry));
}

for (const course of catalog.courses) {
  insertUnique(courses, { ...course, courseId: course.id });
  let lessonCount = 0;
  for (const section of course.sections) {
    insertUnique(sections, { ...section, courseId: course.id, sectionId: section.id });
    for (const lesson of section.lessons) {
      insertUnique(lessons, { ...lesson, courseId: course.id, sectionId: section.id });
      lessonCount++;
    }
  }
  if (lessonCount !== course.lessonCount) {
    throw new Error(`Catalog lesson count mismatch for course ${course.id}`);
  }
}
