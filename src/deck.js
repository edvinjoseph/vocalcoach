// The word deck and its Leitner-box schedule.
//
// box 0      = new, never studied
// box 1..6   = reviewed; due BOX_DAYS[box] days after the last review
// A word passed first try in a call moves up one box. Anything else (a miss,
// even if they got it later in the same call) drops it back to box 1, so it
// comes back tomorrow. Due dates are aligned to local midnight so a morning
// alarm catches everything due "today".

import { readJSON, writeJSON } from './storage.js';

const DECK_KEY = 'vocalcoach.deck.v1';
const DAY = 24 * 60 * 60 * 1000;

export const BOX_DAYS = [0, 1, 2, 4, 8, 16, 32];
export const MAX_BOX = BOX_DAYS.length - 1;

const SEED = [
  ['ephemeral', 'lasting for a very short time', 'The excitement was ephemeral; by lunch everyone had forgotten.'],
  ['ubiquitous', 'found everywhere', 'Phones are so ubiquitous that you rarely see a public payphone now.'],
  ['candid', 'honest and direct, even when it is uncomfortable', 'Thanks for being candid about what went wrong.'],
  ['meticulous', 'very careful about small details', 'She kept meticulous notes of every experiment.'],
  ['pragmatic', 'dealing with things in a practical, realistic way', 'We took a pragmatic approach and fixed the biggest problem first.'],
  ['resilient', 'able to recover quickly from difficulty', 'Kids are resilient; he was laughing again an hour later.'],
  ['ambiguous', 'having more than one possible meaning', 'The email was ambiguous, so I asked what she meant.'],
  ['eloquent', 'speaking or writing clearly and persuasively', 'He gave an eloquent speech at his sister\'s wedding.'],
  ['frugal', 'careful not to waste money', 'Being frugal for a year let me pay off my loan.'],
  ['tenacious', 'refusing to give up', 'The tenacious reporter called every day until she got an answer.'],
  ['serendipity', 'a lucky discovery made by chance', 'Meeting my co-founder on a delayed train was pure serendipity.'],
  ['procrastinate', 'to delay doing something you should do', 'I always procrastinate on my taxes until the last week.'],
  ['benevolent', 'kind and wanting to help others', 'A benevolent neighbour paid for the street party.'],
  ['scrutinize', 'to examine something very closely', 'The editor will scrutinize every number in the report.'],
  ['lucid', 'clear and easy to understand; or thinking clearly', 'Even at 2 a.m. her explanation was lucid.'],
  ['mundane', 'ordinary and not interesting', 'I find mundane chores like folding laundry oddly relaxing.'],
  ['gregarious', 'enjoying the company of other people', 'My gregarious uncle knows everyone at the market by name.'],
  ['nonchalant', 'calm and relaxed, as if you do not care', 'He was nonchalant about missing the bus, as if he had planned it.'],
  ['quirky', 'unusual in an interesting or charming way', 'The cafe has quirky chairs that all came from different flea markets.'],
  ['vivid', 'very bright, clear or detailed', 'I still have a vivid memory of my first day at school.'],
  ['ominous', 'suggesting that something bad is going to happen', 'The ominous clouds made us pack up the picnic early.'],
  ['whimsical', 'playful and fanciful, in an unusual way', 'Her whimsical drawings have cats wearing tiny hats.'],
  ['diligent', 'working carefully and with steady effort', 'A diligent student, he reviewed his notes every evening.'],
  ['obsolete', 'no longer used because something newer exists', 'Fax machines are almost obsolete in most offices.'],
  ['skeptical', 'not easily convinced; having doubts', 'I was skeptical when the ad promised six-pack abs in a week.'],
  ['spontaneous', 'done on impulse, without planning', 'We took a spontaneous trip to the beach on Sunday.'],
  ['nostalgia', 'a warm, wistful feeling for the past', 'That old cartoon theme fills me with nostalgia.'],
  ['zealous', 'full of strong energy and enthusiasm for something', 'The zealous fan painted his whole face in team colours.'],
  ['aloof', 'distant and not friendly or involved', 'The new cat stayed aloof for a week before sitting on my lap.'],
  ['futile', 'having no chance of success', 'Trying to keep the toddler clean at dinner was futile.'],
  ['impeccable', 'perfect, with no mistakes', 'Her timing was impeccable; she arrived as the cake came out.'],
  ['inevitable', 'certain to happen and impossible to avoid', 'With two dogs in the house, mud on the floor is inevitable.'],
  ['lethargic', 'tired and without energy', 'I feel lethargic after a big lunch.'],
  ['mediocre', 'only average, not very good', 'The film was mediocre, but the popcorn was great.'],
  ['notorious', 'famous for something bad', 'That corner is notorious for traffic jams.'],
  ['oblivious', 'not aware of what is happening around you', 'He was oblivious to the dog stealing his sandwich.'],
  ['peculiar', 'strange or unusual', 'There was a peculiar smell coming from the fridge.'],
  ['reluctant', 'unwilling and slow to do something', 'She was reluctant to get out of her warm bed.'],
  ['tranquil', 'calm and peaceful', 'The lake was tranquil at sunrise.'],
  ['versatile', 'able to be used in many different ways', 'A good knife is the most versatile tool in the kitchen.'],
];

const norm = (s) => String(s || '').trim().toLowerCase();

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let idCounter = 0;
const newId = () => `w${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function makeWord(word, definition, example = '') {
  return { id: newId(), word, definition, example, box: 0, dueAt: 0, lastReviewed: null, history: [] };
}

export function loadDeck() {
  const deck = readJSON(DECK_KEY, null);
  if (Array.isArray(deck) && deck.length) {
    // Decks saved before the word list grew pick up the new starter words.
    const have = new Set(deck.map((w) => norm(w.word)));
    const missing = SEED.filter(([w]) => !have.has(norm(w)));
    if (missing.length) {
      deck.push(...missing.map(([w, d, e]) => makeWord(w, d, e)));
      saveDeck(deck);
    }
    return deck;
  }
  const seeded = SEED.map(([w, d, e]) => makeWord(w, d, e));
  saveDeck(seeded);
  return seeded;
}

export function saveDeck(deck) {
  writeJSON(DECK_KEY, deck);
}

export function resetDeck() {
  const seeded = SEED.map(([w, d, e]) => makeWord(w, d, e));
  saveDeck(seeded);
  return seeded;
}


/** Adds a word in place. Returns { ok, word } or { ok:false, error }. */
export function addWord(deck, { word, definition, example }) {
  const w = String(word || '').trim();
  const d = String(definition || '').trim();
  if (!w || !d) return { ok: false, error: 'A word and a definition are both required.' };
  if (deck.some((x) => norm(x.word) === norm(w))) return { ok: false, error: `"${w}" is already in the deck.` };
  const entry = makeWord(w, d, String(example || '').trim());
  deck.push(entry);
  return { ok: true, word: entry };
}

export function removeWord(deck, id) {
  const i = deck.findIndex((w) => w.id === id);
  if (i >= 0) deck.splice(i, 1);
}

const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const isDue = (w, now) => w.box > 0 && w.dueAt <= now;

/**
 * Words for one call. Due reviews first (most overdue first), topped up with
 * new words. Alarm calls are shorter than practice calls: being woken up
 * should take a few minutes, not twenty.
 */
export function pickSessionWords(deck, now, mode) {
  const cap = mode === 'alarm' ? 3 : 5;
  const maxNew = mode === 'alarm' ? 1 : 2;

  const due = deck.filter((w) => isDue(w, now)).sort((a, b) => a.dueAt - b.dueAt);
  const picked = due.slice(0, cap);
  // New words come in a random order so every call plays different words.
  const fresh = shuffle(deck.filter((w) => w.box === 0));
  for (const w of fresh) {
    if (picked.length >= cap || picked.filter((p) => p.box === 0).length >= maxNew) break;
    picked.push(w);
  }

  // Nothing due and nothing new: still give the alarm something to test, using
  // the words studied longest ago.
  if (!picked.length) {
    return [...deck].sort((a, b) => (a.lastReviewed ?? 0) - (b.lastReviewed ?? 0)).slice(0, 2);
  }
  return picked;
}

/** Applies one call's outcome to a word (mutates it). */
export function applyResult(w, passed, firstTry, now) {
  w.box = passed && firstTry ? Math.min(w.box + 1, MAX_BOX) : 1;
  w.dueAt = startOfDay(now) + BOX_DAYS[w.box] * DAY;
  w.lastReviewed = now;
  w.history = [...(w.history || []), { at: now, passed, firstTry }].slice(-30);
}

export function dueLabel(w, now) {
  if (w.box === 0) return 'New';
  if (w.dueAt <= now) return 'Due now';
  const days = Math.round((w.dueAt - startOfDay(now)) / DAY);
  if (days <= 1) return 'Tomorrow';
  return `In ${days} days`;
}
