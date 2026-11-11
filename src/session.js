// One call's progress. Each word has to clear two tasks:
//   recall   — the coach gives the meaning, the user has to SAY the word
//   sentence — the user uses the word correctly in a sentence of their own
// Both are productive tasks on purpose: recognising a word doesn't build the
// ability to use it. The coach reports every answer via the grade_word tool;
// this module is the source of truth, and end_call is refused until every
// word is passed.

export function createSession(words, mode) {
  return {
    mode,
    startedAt: Date.now(),
    items: words.map((w) => ({
      id: w.id,
      word: w.word,
      definition: w.definition,
      example: w.example || '',
      isNew: (w.box || 0) === 0,
      recall: false,
      sentence: false,
      attempts: 0,
      misses: 0,
      points: 0,
    })),
  };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

export function findItem(session, word) {
  const n = norm(word);
  if (!n) return null;
  const exact = session.items.find((i) => norm(i.word) === n);
  if (exact || n.length < 4) return exact ?? null;
  // The model sometimes reports an inflected form ("procrastinating").
  return session.items.find((i) => n.startsWith(norm(i.word).slice(0, -1))) ?? null;
}

export const isPassed = (item) => item.recall && item.sentence;

export const score = (session) => session.items.reduce((sum, i) => sum + (i.points || 0), 0);

export const allDone = (session) => session.items.every(isPassed);

export const currentFocus = (session) => session.items.find((i) => !isPassed(i)) ?? null;

// Guess the Word: a guess on clue 1, 2 or 3 scores 3, 2 or 1; a second round
// after the word was revealed scores 1.
export function grade(session, word, task, correct, clues = 1) {
  const item = findItem(session, word);
  if (!item) return null;
  item.attempts += 1;
  if (correct && task === 'recall' && !item.recall) {
    item.points = item.misses ? 1 : Math.max(1, 4 - Math.min(3, Math.max(1, Number(clues) || 1)));
  }
  if (correct) item[task] = true;
  else item.misses += 1;
  return item;
}

export function remaining(session) {
  return session.items
    .filter((i) => !isPassed(i))
    .map((i) => ({
      word: i.word,
      still_needs: [!i.recall && 'recall', !i.sentence && 'sentence'].filter(Boolean),
    }));
}

export function progressLines(session) {
  return session.items.map((i) => {
    const r = i.recall ? 'recall done' : 'recall not yet';
    const s = i.sentence ? 'sentence done' : 'sentence not yet';
    return `- ${i.word}: ${r}, ${s}${i.misses ? ` (${i.misses} miss${i.misses === 1 ? '' : 'es'})` : ''}`;
  });
}
