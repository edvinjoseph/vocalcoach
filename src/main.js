import './style.css';
import { loadDeck, saveDeck, resetDeck, pickSessionWords, applyResult, addWord, removeWord, dueLabel, isDue, MAX_BOX } from './deck.js';
import { createSession, grade, isPassed, allDone, remaining, currentFocus } from './session.js';
import { PERSONAS, VOICES, TOOLS, buildPrompt, openingCue, nudgeCue, RESUME_CUE } from './prompt.js';
import { AudioIO, LiveCall } from './live.js';
import { Ringer, nextOccurrence } from './ringer.js';
import { loadSettings, saveSettings, recordStudyDay, currentStreak, DEFAULT_MODEL } from './storage.js';

const TITLE = 'VocalCoach';
const HARD_STOP_MS = 10 * 60 * 1000; // like momsalarm: no call runs forever
const SILENCE_MS = 15000;
const REDIAL_DELAY_MS = 2000;
const ALARM_CATCH_UP_MS = 15 * 60 * 1000;

const $app = document.getElementById('app');
const $dialog = document.getElementById('settings');
const $form = document.getElementById('settings-form');

const ringer = new Ringer();
let deck = loadDeck();
let settings = loadSettings();
let view = 'home'; // 'home' | 'ring' | 'call' | 'summary'
let call = null;
let summary = null;
let testAlarmAt = null;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const persona = () => PERSONAS[settings.persona] || PERSONAS.mom;

// Any tap unlocks audio, so a later alarm can ring without a fresh gesture.
document.addEventListener('pointerdown', () => ringer.unlock());

function render() {
  if (view === 'ring') renderRing();
  else if (view === 'call') renderCall();
  else if (view === 'summary') renderSummary();
  else renderHome();
}

// ── Home ────────────────────────────────────────────────────────────────────

function boxDots(box) {
  return Array.from({ length: MAX_BOX }, (_, i) => `<i class="${i < box ? 'on' : ''}"></i>`).join('');
}

function alarmLabel() {
  const a = settings.alarm;
  if (!a.enabled || !a.nextAt) return 'Off';
  const d = new Date(a.nextAt);
  const today = new Date();
  const when = d.toDateString() === today.toDateString() ? 'today' : 'tomorrow';
  return `Rings ${when} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function renderHome() {
  const now = Date.now();
  const p = persona();
  const preview = pickSessionWords(deck, now, 'practice');
  const dueCount = deck.filter((w) => isDue(w, now)).length;
  const newCount = deck.filter((w) => w.box === 0).length;
  const sorted = [...deck].sort((a, b) => {
    const rank = (w) => (isDue(w, now) ? 0 : w.box === 0 ? 1 : 2);
    return rank(a) - rank(b) || a.dueAt - b.dueAt || a.word.localeCompare(b.word);
  });

  $app.innerHTML = `
    <header class="top">
      <div class="brand"><span class="logo" aria-hidden="true"></span>VocalCoach</div>
      <button class="icon-btn" data-action="settings" aria-label="Settings">⚙</button>
    </header>

    ${settings.apiKey ? '' : `<div class="banner">Add your Gemini API key in <button class="link" data-action="settings">Settings</button> to start a call.</div>`}

    <section class="card hero">
      <div class="hero-row">
        <div>
          <div class="eyebrow">Today</div>
          <div class="big">${dueCount} due · ${newCount} new</div>
        </div>
        <div class="streak" title="Days in a row with a finished call">🔥 ${currentStreak()}</div>
      </div>
      <p class="muted">${esc(p.name)} will quiz you on: <strong>${preview.map((w) => esc(w.word)).join(', ')}</strong></p>
      <button class="btn primary wide" data-action="practice">📞 Start practice call</button>
      <p class="muted small">For each word you'll say it from its meaning, then use it in your own sentence.</p>
    </section>

    <section class="card">
      <div class="eyebrow">Wake-up call</div>
      <p class="muted small">At this time ${esc(p.name)} calls you. It keeps ringing until you pick up, and the call doesn't end until you've passed your words. Keep this tab open.</p>
      <div class="row">
        <input type="time" id="alarm-time" value="${settings.alarm.time}" aria-label="Alarm time" />
        <label class="switch"><input type="checkbox" id="alarm-enabled" ${settings.alarm.enabled ? 'checked' : ''} /><span>On</span></label>
      </div>
      <div class="muted small">${alarmLabel()}</div>
      <button class="btn wide" data-action="test-alarm" ${testAlarmAt ? 'disabled' : ''}>${testAlarmAt ? 'Ringing in a few seconds…' : 'Test: ring in 10 seconds'}</button>
    </section>

    <section class="card">
      <div class="eyebrow">Your words (${deck.length})</div>
      <form id="add-form" class="add-form">
        <input name="word" placeholder="Word" required autocomplete="off" />
        <input name="definition" placeholder="Meaning (short)" required autocomplete="off" />
        <input name="example" placeholder="Example sentence (optional)" autocomplete="off" />
        <button class="btn" type="submit">Add word</button>
      </form>
      <p class="muted small">During a call you can also say "add the word …".</p>
      <ul class="words">
        ${sorted.map((w) => `
          <li>
            <div class="w-main">
              <div class="w-word">${esc(w.word)}</div>
              <div class="w-def">${esc(w.definition)}</div>
            </div>
            <div class="w-meta">
              <span class="boxes" title="Box ${w.box} of ${MAX_BOX}">${boxDots(w.box)}</span>
              <span class="due ${isDue(w, now) ? 'is-due' : ''}">${dueLabel(w, now)}</span>
              <button class="icon-btn small" data-action="delete" data-id="${w.id}" aria-label="Delete ${esc(w.word)}">✕</button>
            </div>
          </li>`).join('')}
      </ul>
    </section>`;
}

// ── Ringing ─────────────────────────────────────────────────────────────────

function ring() {
  if (view === 'call' || view === 'ring') return;
  view = 'ring';
  ringer.start();
  document.title = '📞 Incoming call · VocalCoach';
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`${persona().name} is calling`, { body: 'Time to wake up and pass your words.', requireInteraction: true });
    }
  } catch { /* notifications are optional */ }
  render();
}

function renderRing() {
  const p = persona();
  $app.innerHTML = `
    <div class="ring">
      <div class="avatar ringing" aria-hidden="true">${p.emoji}</div>
      <div class="ring-name">${esc(p.name)}</div>
      <div class="muted">is calling…</div>
      <button class="btn answer" data-action="answer">Answer</button>
      <p class="muted small">There's no decline button. That's the point.</p>
    </div>`;
}

// ── Call ────────────────────────────────────────────────────────────────────

async function startCall(mode) {
  if (call) return;
  if (!settings.apiKey) {
    openSettings('Add your Gemini API key to start a call.');
    return;
  }
  const words = pickSessionWords(deck, Date.now(), mode);
  if (!words.length) {
    alert('Add a few words first.');
    return;
  }

  // Created synchronously inside the click, so its AudioContexts may run.
  const audio = new AudioIO();
  const c = {
    mode,
    persona: persona(),
    session: createSession(words, mode),
    audio,
    live: null,
    status: 'Starting…',
    transcript: [],
    startedAt: Date.now(),
    lastActivity: Date.now(),
    lastNudge: 0,
    speaking: false,
    ended: false,
    everReady: false,
    setupFailures: 0,
    endAccepted: false,
    recap: '',
  };
  call = c;
  view = 'call';
  render();

  try {
    await audio.startMic();
  } catch (err) {
    endCall(c, 'error', `Microphone unavailable: ${err?.message || err}`);
    return;
  }
  dial(c);
  c.tick = setInterval(() => tick(c), 1000);
}

function dial(c) {
  if (c.ended) return;
  const resumed = c.everReady;
  setStatus(c, resumed ? 'Calling back…' : 'Calling…');
  c.live = new LiveCall({
    apiKey: settings.apiKey,
    model: settings.model || DEFAULT_MODEL,
    voice: settings.voice || c.persona.voice,
    systemPrompt: buildPrompt({ persona: c.persona, mode: c.mode, session: c.session, now: new Date(), resumed }),
    tools: TOOLS,
    audio: c.audio,
    onReady: () => {
      c.everReady = true;
      c.setupFailures = 0;
      c.lastActivity = Date.now();
      setStatus(c, 'On the line');
      c.live.sendText(resumed ? RESUME_CUE : openingCue(c.mode, c.session));
    },
    onToolCall: (name, args) => handleTool(c, name, args),
    onTranscript: (role, text) => addCaption(c, role, text),
    onTurnComplete: () => closeBubble(c),
    onUserSpoke: () => { c.lastActivity = Date.now(); },
    onSpeakingChange: (sp) => {
      c.speaking = sp;
      if (!sp) c.lastActivity = Date.now();
      updateLiveBits(c);
    },
    onDrop: (code, reason, wasReady) => handleDrop(c, code, reason, wasReady),
    onGoodbyeDone: () => endCall(c, 'passed'),
  });
  c.live.connect();
}

function handleDrop(c, code, reason, wasReady) {
  if (c.ended) return;
  if (c.endAccepted) {
    endCall(c, 'passed');
    return;
  }
  if (!wasReady) {
    c.setupFailures += 1;
    if (c.setupFailures >= 3) {
      endCall(c, 'error', `Couldn't reach Gemini (code ${code}${reason ? `: ${reason}` : ''}). Check your API key and model in Settings.`);
      return;
    }
  }
  setStatus(c, 'Line dropped, calling back…');
  setTimeout(() => dial(c), REDIAL_DELAY_MS);
}

function handleTool(c, name, args) {
  if (name === 'grade_word') {
    const task = args.task === 'recall' || args.task === 'sentence' ? args.task : null;
    if (!task) return { response: { ok: false, error: 'task must be "recall" or "sentence"' } };
    const item = grade(c.session, args.word, task, args.correct === true);
    if (!item) {
      return {
        response: {
          ok: false,
          error: `"${args.word}" is not one of today's words`,
          todays_words: c.session.items.map((i) => i.word),
        },
      };
    }
    addEvent(c, `${item.word} · ${task === 'recall' ? 'said the word' : 'own sentence'} ${args.correct ? '✓' : '✗'}${args.note ? ` · ${args.note}` : ''}`, args.correct);
    renderProgress(c);
    return {
      response: { ok: true, word: item.word, word_passed: isPassed(item), remaining: remaining(c.session), all_done: allDone(c.session) },
    };
  }

  if (name === 'end_call') {
    if (!allDone(c.session)) {
      return {
        response: { ok: false, result: 'rejected', reason: 'Not every word is passed yet. Keep going.', remaining: remaining(c.session) },
      };
    }
    c.endAccepted = true;
    c.recap = String(args.recap || '');
    setStatus(c, 'All words passed! 🎉');
    return { response: { ok: true, result: 'call_ending', instruction: 'Give your short send-off now.' }, goodbye: true };
  }

  if (name === 'add_word') {
    const r = addWord(deck, args);
    if (!r.ok) return { response: { ok: false, error: r.error } };
    saveDeck(deck);
    addEvent(c, `Added "${r.word.word}" to your deck`, true);
    return { response: { ok: true, added: r.word.word } };
  }

  return { response: { ok: false, error: `Unknown tool ${name}` } };
}

function tick(c) {
  if (c.ended) return;
  const elapsed = Date.now() - c.startedAt;
  const $t = document.getElementById('call-timer');
  if ($t) $t.textContent = `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}`;
  if (elapsed >= HARD_STOP_MS) {
    endCall(c, 'timeout');
    return;
  }
  // Relentless nudges: quiet line, coach not talking, and no nudge recently.
  const now = Date.now();
  if (c.live?.ready && !c.speaking && !c.endAccepted && now - c.lastActivity > SILENCE_MS && now - c.lastNudge > SILENCE_MS) {
    c.lastNudge = now;
    c.lastActivity = now;
    c.live.sendText(nudgeCue(currentFocus(c.session)));
  }
}

function endCall(c, outcome, detail = '') {
  if (c.ended) return;
  c.ended = true;
  clearInterval(c.tick);
  c.live?.disconnect();
  c.audio.close();

  // An alarm you escape from counts as failed for every word left. Otherwise
  // only words you actually attempted are rescheduled.
  const forfeit = c.mode === 'alarm' && (outcome === 'hungup' || outcome === 'timeout');
  const now = Date.now();
  const results = [];
  for (const it of c.session.items) {
    const w = deck.find((d) => d.id === it.id);
    if (!w) continue;
    const passed = isPassed(it);
    const firstTry = passed && it.misses === 0;
    const touched = passed || it.attempts > 0 || forfeit;
    const before = w.box;
    if (touched) applyResult(w, passed, firstTry, now);
    results.push({ word: it.word, passed, firstTry, touched, before, after: w.box, next: dueLabel(w, now) });
  }
  saveDeck(deck);
  if (outcome === 'passed') recordStudyDay();

  summary = { outcome, detail, recap: c.recap, results, persona: c.persona, mode: c.mode };
  call = null;
  view = 'summary';
  document.title = TITLE;
  render();
}

function setStatus(c, text) {
  c.status = text;
  const $s = document.getElementById('call-status');
  if ($s && call === c) $s.textContent = text;
}

function addCaption(c, role, text) {
  const last = c.transcript[c.transcript.length - 1];
  if (last && last.role === role && !last.closed) last.text += text;
  else c.transcript.push({ role, text });
  renderCaptions(c);
}

function closeBubble(c) {
  const last = c.transcript[c.transcript.length - 1];
  if (last && last.role === 'coach') last.closed = true;
}

function addEvent(c, text, good) {
  c.transcript.push({ role: 'event', text, good, closed: true });
  renderCaptions(c);
}

function renderCall() {
  const c = call;
  $app.innerHTML = `
    <div class="call">
      <div class="call-head">
        <div class="avatar" id="avatar" aria-hidden="true">${c.persona.emoji}</div>
        <div class="call-who">
          <div class="call-name">${esc(c.persona.name)}${c.mode === 'alarm' ? ' · wake-up call' : ''}</div>
          <div class="call-status" id="call-status">${esc(c.status)}</div>
        </div>
        <div class="call-timer" id="call-timer">0:00</div>
      </div>
      <div class="progress" id="progress"></div>
      <div class="captions" id="captions" aria-live="polite"></div>
      <div class="call-foot">
        <div class="mic" id="mic"><span class="dot"></span><span id="mic-label">Mic on</span></div>
        ${c.mode === 'alarm'
          ? '<button class="link danger small" data-action="hangup">Emergency hang-up (counts as failed)</button>'
          : '<button class="btn danger" data-action="hangup">Hang up</button>'}
      </div>
    </div>`;
  renderProgress(c);
  renderCaptions(c);
  updateLiveBits(c);
}

function renderProgress(c) {
  const $p = document.getElementById('progress');
  if (!$p || call !== c) return;
  const focus = currentFocus(c.session);
  $p.innerHTML = c.session.items
    .map((i) => `
      <div class="chip ${isPassed(i) ? 'done' : ''} ${focus === i ? 'focus' : ''}">
        <span class="chip-word">${esc(i.word)}${i.isNew ? ' <em>new</em>' : ''}</span>
        <span class="chip-steps">
          <span class="${i.recall ? 'ok' : ''}" title="Say the word from its meaning">say it ${i.recall ? '✓' : '·'}</span>
          <span class="${i.sentence ? 'ok' : ''}" title="Use it in your own sentence">use it ${i.sentence ? '✓' : '·'}</span>
        </span>
      </div>`)
    .join('');
}

function renderCaptions(c) {
  const $c = document.getElementById('captions');
  if (!$c || call !== c) return;
  const items = c.transcript.slice(-40);
  $c.innerHTML = items.length
    ? items
        .map((t) =>
          t.role === 'event'
            ? `<div class="event ${t.good ? 'good' : 'bad'}">${esc(t.text)}</div>`
            : `<div class="bubble ${t.role}"><span class="who">${t.role === 'user' ? 'You' : esc(c.persona.name)}</span>${esc(t.text.trim())}</div>`)
        .join('')
    : '<div class="muted small center">Captions appear here.</div>';
  $c.scrollTop = $c.scrollHeight;
}

function updateLiveBits(c) {
  if (call !== c) return;
  document.getElementById('avatar')?.classList.toggle('speaking', c.speaking);
  const $label = document.getElementById('mic-label');
  if ($label) $label.textContent = c.endAccepted ? 'Mic off' : c.speaking ? `${c.persona.name} is talking (you can interrupt)` : 'Listening…';
  document.getElementById('mic')?.classList.toggle('off', c.endAccepted);
}

// ── Summary ─────────────────────────────────────────────────────────────────

function renderSummary() {
  const s = summary;
  const titles = {
    passed: s.mode === 'alarm' ? "You're up, and you passed 🎉" : 'Nice work 🎉',
    hungup: 'Call ended early',
    timeout: 'Time ran out',
    error: 'The call failed',
  };
  $app.innerHTML = `
    <section class="card summary">
      <div class="eyebrow">${esc(s.persona.name)} · ${s.mode === 'alarm' ? 'wake-up call' : 'practice'}</div>
      <h1>${titles[s.outcome] || 'Call ended'}</h1>
      ${s.detail ? `<p class="error">${esc(s.detail)}</p>` : ''}
      ${s.recap ? `<p class="recap">"${esc(s.recap)}"</p>` : ''}
      <ul class="results">
        ${s.results.map((r) => `
          <li>
            <span class="r-word">${esc(r.word)}</span>
            <span class="r-res ${r.passed ? (r.firstTry ? 'good' : 'ok') : r.touched ? 'bad' : ''}">
              ${r.passed ? (r.firstTry ? 'First try' : 'Got there') : r.touched ? 'Not yet' : 'Not reached'}
            </span>
            <span class="muted small">${r.touched ? `box ${r.before} → ${r.after} · next: ${r.next}` : 'unchanged'}</span>
          </li>`).join('')}
      </ul>
      <button class="btn primary wide" data-action="home">Done</button>
    </section>`;
}

// ── Settings ────────────────────────────────────────────────────────────────

function openSettings(note = '') {
  document.getElementById('settings-note').textContent = note;
  $form.persona.innerHTML = Object.entries(PERSONAS)
    .map(([id, p]) => `<option value="${id}">${p.emoji} ${esc(p.name)}: ${esc(p.blurb)}</option>`)
    .join('');
  $form.voice.innerHTML = `<option value="">Coach's own voice</option>` + VOICES.map((v) => `<option>${v}</option>`).join('');
  $form.apiKey.value = settings.apiKey;
  $form.persona.value = settings.persona;
  $form.voice.value = settings.voice;
  $form.model.value = settings.model || DEFAULT_MODEL;
  $dialog.showModal();
}

$dialog.addEventListener('close', () => {
  if ($dialog.returnValue !== 'save') return;
  settings.apiKey = $form.apiKey.value.trim();
  settings.persona = $form.persona.value;
  settings.voice = $form.voice.value;
  settings.model = $form.model.value.trim() || DEFAULT_MODEL;
  saveSettings(settings);
  render();
});

$form.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="reset-deck"]') && confirm('Reset the deck to the starter words? Your progress will be lost.')) {
    deck = resetDeck();
    $dialog.close();
    render();
  }
});

// ── Events ──────────────────────────────────────────────────────────────────

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'settings') openSettings();
  else if (action === 'practice') startCall('practice');
  else if (action === 'answer') {
    ringer.stop();
    document.title = TITLE;
    view = 'home';
    startCall('alarm').then(() => { if (!call && view === 'home') render(); });
  } else if (action === 'hangup') {
    if (call) endCall(call, 'hungup');
  } else if (action === 'home') {
    view = 'home';
    render();
  } else if (action === 'test-alarm') {
    ringer.unlock();
    testAlarmAt = Date.now() + 10000;
    render();
  } else if (action === 'delete') {
    const w = deck.find((x) => x.id === el.dataset.id);
    if (w && confirm(`Remove "${w.word}" from your deck?`)) {
      removeWord(deck, w.id);
      saveDeck(deck);
      render();
    }
  }
});

$app.addEventListener('change', (e) => {
  if (e.target.id !== 'alarm-time' && e.target.id !== 'alarm-enabled') return;
  const time = document.getElementById('alarm-time').value || '07:00';
  const enabled = document.getElementById('alarm-enabled').checked;
  settings.alarm = { time, enabled, nextAt: enabled ? nextOccurrence(time, Date.now()) : null };
  saveSettings(settings);
  if (enabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  render();
});

$app.addEventListener('submit', (e) => {
  if (e.target.id !== 'add-form') return;
  e.preventDefault();
  const f = e.target;
  const r = addWord(deck, { word: f.word.value, definition: f.definition.value, example: f.example.value });
  if (!r.ok) {
    alert(r.error);
    return;
  }
  saveDeck(deck);
  render();
});

// ── Alarm clock (runs while the tab is open) ────────────────────────────────

setInterval(() => {
  if (view === 'call' || view === 'ring') return;
  const now = Date.now();
  if (testAlarmAt && now >= testAlarmAt) {
    testAlarmAt = null;
    ring();
    return;
  }
  const a = settings.alarm;
  if (a.enabled && a.nextAt && now >= a.nextAt) {
    const late = now - a.nextAt;
    settings.alarm = { ...a, nextAt: nextOccurrence(a.time, now) };
    saveSettings(settings);
    // A tab that slept through the alarm by a lot shouldn't ring hours later.
    if (late < ALARM_CATCH_UP_MS) ring();
    else if (view === 'home') render();
  }
}, 1000);

// Re-render the home screen when the day rolls over or the tab comes back, so
// "due" labels stay current.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && view === 'home') render();
});

render();
