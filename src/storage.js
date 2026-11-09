// Thin localStorage wrappers. Storage can throw (private mode, blocked site
// data), so every read and write is guarded and falls back cleanly.

export function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore — the app still works for this session */
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'vocalcoach.settings.v1';

export const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';

const DEFAULT_SETTINGS = {
  apiKey: '',
  persona: 'mom',
  voice: '', // '' = the persona's own voice
  model: DEFAULT_MODEL,
  alarm: { time: '07:00', enabled: false, nextAt: null },
};

export function loadSettings() {
  const s = readJSON(SETTINGS_KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    alarm: { ...DEFAULT_SETTINGS.alarm, ...(s.alarm || {}) },
  };
}

export function saveSettings(settings) {
  writeJSON(SETTINGS_KEY, settings);
}

// ── Study days (for the streak) ─────────────────────────────────────────────

const DAYS_KEY = 'vocalcoach.studyDays.v1';

export function dayKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function recordStudyDay(date = new Date()) {
  const days = new Set(readJSON(DAYS_KEY, []));
  days.add(dayKey(date));
  writeJSON(DAYS_KEY, [...days].sort().slice(-400));
}

/** Consecutive study days ending today (or yesterday, if today isn't done yet). */
export function currentStreak(now = new Date()) {
  const days = new Set(readJSON(DAYS_KEY, []));
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
