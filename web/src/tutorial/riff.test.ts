// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { riffProblem } from './riff';
import { COURSE } from './chapters';
import { formatCourse, validateShape } from './course-schema';

// The tutorial has no Riff button (D-663); a step's stored `riff` is still course data: it loads, validates and is saved.
describe('stored riffs', () => {
  it('refuses a riff of the wrong shape', () => {
    expect(riffProblem({ name: 'x', bpm: 120, beats: 4, notes: [[0, 1, 60, 100]] })).toBe('');
    expect(riffProblem({ name: 'x', bpm: 120, beats: 4, notes: [[4, 1, 60, 100]] })).toMatch('outside');
    expect(riffProblem({ name: 'x', bpm: 120, beats: 4, notes: [] })).toMatch('notes');
  });
  it('a course with a riff keeps its shape and puts the riff on one line', () => {
    const course = structuredClone(COURSE);
    course.chapters[0].steps[0].riff = { name: 'a.mid', bpm: 90, beats: 4, notes: [[0, 1, 60, 100]] };
    validateShape(course);
    expect(formatCourse(course)).toContain('"riff": {"name":"a.mid","bpm":90,"beats":4,"notes":[[0,1,60,100]]}');
    course.chapters[0].steps[0].riff.bpm = 1;
    expect(() => validateShape(course)).toThrow('tempo');
  });
});
