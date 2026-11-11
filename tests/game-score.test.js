import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, grade, score } from '../src/session.js';

const words = ['vivid', 'aloof', 'futile'].map((word, i) => ({ id: String(i), word, definition: 'x', box: 0 }));

test('fewer clues score more, and a word revealed after a miss scores 1', () => {
  const s = createSession(words, 'practice');
  grade(s, 'vivid', 'recall', true, 1);
  grade(s, 'aloof', 'recall', true, 3);
  grade(s, 'futile', 'recall', false, 3);
  grade(s, 'futile', 'recall', true, 1);
  assert.deepEqual(s.items.map((i) => i.points), [3, 1, 1]);
  grade(s, 'vivid', 'sentence', true);
  grade(s, 'vivid', 'recall', true, 1);
  assert.equal(score(s), 5);
});
