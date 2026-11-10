import './style.css';
import homeScreenImage from './assets/ios-home-screen.webp';
import { wireAnswerSlider } from './answer-slider.js';
import { cancelFindingsReveal, isShowingFindings, revealFindings, showDemo } from './findings.js';
import { loadDeck, saveDeck, resetDeck, pickSessionWords, applyResult, addWord, removeWord, dueLabel, isDue } from './deck.js';
import { createSession, grade, isPassed, allDone, remaining, currentFocus } from './session.js';
import { PERSONAS, VOICES, TOOLS, buildPrompt, openingCue, nudgeCue, RESUME_CUE } from './prompt.js';
import { AudioIO, LiveCall } from './live.js';
import { Ringer, nextOccurrence } from './ringer.js';
import { icons } from './icons.js';
import { effectiveKey, BUILT_IN_KEY, loadSettings, saveSettings, recordStudyDay, currentStreak, DEFAULT_MODEL } from './storage.js';

const TITLE = 'VocalCoach';
const HARD_STOP_MS = 10 * 60 * 1000; // like momsalarm: no call runs forever
const SILENCE_MS = 15000;
const REDIAL_DELAY_MS = 2000;
const ALARM_CATCH_UP_MS = 15 * 60 * 1000;
const INCOMING_DELAY_MS = 1800;

const $app = document.getElementById('app');
const $phone = document.getElementById('phone');
const $screen = document.getElementById('screen');

const ringer = new Ringer();
let deck = loadDeck();
let settings = loadSettings();
let view = 'launcher'; // 'launcher' | 'home' | 'ring' | 'call' | 'summary'
let call = null;
let summary = null;
let testAlarmAt = null;
let tab = 'today'; // 'today' | 'words' | 'alarm' | 'settings'
let editing = false; // Words tab edit mode
let adding = false; // Add-word sheet
let introTimer = null;
let introPending = false;
let resumeIntro = false;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const persona = () => PERSONAS[settings.persona] || PERSONAS.mom;

// Any tap unlocks audio, so a later alarm can ring without a fresh gesture.
document.addEventListener('pointerdown', () => {
  ringer.unlock();
  if (call && !call.ended) call.audio.resume().catch(() => {});
});

let renderedView = null;

function render() {
  if (view !== 'summary') cancelFindingsReveal();
  $phone.classList.toggle('launcher', view === 'launcher');
  $screen.classList.toggle('launcher', view === 'launcher');
  $phone.classList.toggle('ringing', view === 'ring');
  $screen.classList.toggle('ringing', view === 'ring');
  $screen.classList.toggle('incall', view === 'call');
  if (view !== renderedView) $screen.querySelector('#app').scrollTop = 0;
  renderedView = view;
  if (view === 'launcher') renderLauncher();
  else if (view === 'ring') renderRing();
  else if (view === 'call') renderCall();
  else if (view === 'summary') renderSummary();
  else renderHome();
}

// The opening is a real iOS Home Screen image before the call arrives.
function renderLauncher() {
  $app.innerHTML = `
    <div class="launcher-screen">
      <img src="${homeScreenImage}" alt="iOS Home Screen" class="launcher-image" fetchpriority="high" draggable="false" />
    </div>`;
}

function cancelIncomingDemo() {
  clearTimeout(introTimer);
  introTimer = null;
  introPending = false;
  resumeIntro = false;
}

function startIncomingDemo() {
  if (introPending || view !== 'launcher' || isShowingFindings()) return;
  if (document.hidden) {
    resumeIntro = true;
    render();
    return;
  }
  resumeIntro = false;
  ringer.unlock();
  introPending = true;
  render();
  introTimer = setTimeout(() => {
    introTimer = null;
    introPending = false;
    if (view !== 'launcher' || isShowingFindings()) return;
    if (document.hidden) {
      resumeIntro = true;
      render();
    }
    else ring();
  }, INCOMING_DELAY_MS);
}

// ── Home ────────────────────────────────────────────────────────────────────

function alarmLabel() {
  const a = settings.alarm;
  if (!a.enabled || !a.nextAt) return 'Off';
  const d = new Date(a.nextAt);
  const when = d.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow';
  return `Rings ${when} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

const TABS = [
  ['today', 'Today', () => icons.calendar(25)],
  ['words', 'Words', () => icons.book(25)],
  ['alarm', 'Alarm', () => icons.alarm(25)],
  ['settings', 'Settings', () => icons.gear(25)],
];

function tabBar() {
  return `<nav class="tabbar" aria-label="Tabs">${TABS.map(([id, label, icon]) =>
    `<button class="tab" data-action="tab" data-tab="${id}" ${tab === id ? 'aria-current="page"' : ''}>${icon()}<span>${label}</span></button>`).join('')}</nav>`;
}

function todayTab() {
  const now = Date.now();
  const p = persona();
  const preview = pickSessionWords(deck, now, 'practice');
  const dueCount = deck.filter((w) => isDue(w, now)).length;
  const newCount = deck.filter((w) => w.box === 0).length;
  const streak = currentStreak();
  const date = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return `
    <div class="eyebrow-date">${esc(date)}</div>
    <h1 class="large-title">Today</h1>

    <div class="group-title">Next call</div>
    <div class="group">
      <div class="row">
        <div class="avatar" aria-hidden="true">${esc(p.name.replace(/^Ms\.\s*/, '').charAt(0))}</div>
        <div class="row-main"><div class="row-title strong">${esc(p.name)}</div><div class="row-sub">Practice call</div></div>
      </div>
      ${preview.map((w) => `
        <div class="row">
          <div class="row-main"><div class="row-title">${esc(w.word)}</div></div>
          <span class="word-tag ${w.box === 0 ? 'new' : ''}">${w.box === 0 ? 'New' : 'Review'}</span>
        </div>`).join('')}
    </div>
    <button class="btn-fill" data-action="practice">${icons.phone(20)} Call me about these</button>
    <div class="group-foot">${effectiveKey(settings)
      ? `${esc(p.name)} gives you the meaning. You say the word, then use it in a sentence of your own.`
      : 'Add your Gemini API key in Settings to start a call.'}</div>

    <div class="group-title">Progress</div>
    <div class="group">
      <div class="row"><span>To review</span><span class="row-trail">${dueCount}</span></div>
      <div class="row"><span>New words</span><span class="row-trail">${newCount}</span></div>
      <div class="row"><span>Day streak</span><span class="row-trail">${streak}</span></div>
    </div>`;
}

function wordsTab() {
  const now = Date.now();
  const sorted = [...deck].sort((a, b) => {
    const rank = (w) => (isDue(w, now) ? 0 : w.box === 0 ? 1 : 2);
    return rank(a) - rank(b) || a.dueAt - b.dueAt || a.word.localeCompare(b.word);
  });
  return `
    <div class="nav">
      <button class="text-btn ${editing ? 'bold' : ''}" data-action="edit">${editing ? 'Done' : 'Edit'}</button>
      <button class="circle-btn" data-action="add-open" aria-label="Add a word">${icons.plus(20)}</button>
    </div>
    <h1 class="large-title">Words</h1>
    <div class="group">
      ${sorted.map((w) => `
        <div class="row">
          ${editing ? `<button class="minus" data-action="delete" data-id="${w.id}" aria-label="Remove ${esc(w.word)}"></button>` : ''}
          <div class="row-main"><div class="row-title">${esc(w.word)}</div><div class="row-sub">${esc(w.definition)}</div></div>
          <span class="row-trail small ${isDue(w, now) ? 'due' : ''}">${dueLabel(w, now)}</span>
        </div>`).join('')}
    </div>
    <div class="group-foot">${deck.length} words. In a call you can also say "add the word …".</div>`;
}

function alarmTab() {
  const p = persona();
  return `
    <h1 class="large-title" style="padding-top:14px">Alarm</h1>
    <div class="group">
      <div class="row"><span class="row-label">Time</span><input class="time-pill" type="time" id="alarm-time" value="${settings.alarm.time}" aria-label="Alarm time" /></div>
      <div class="row"><label for="alarm-enabled" style="flex:1">Wake-up call</label><input class="switch" type="checkbox" id="alarm-enabled" ${settings.alarm.enabled ? 'checked' : ''} /></div>
    </div>
    <div class="group-foot">${alarmLabel()}. ${esc(p.name)} rings at this time and keeps ringing. The call only ends once you've passed your words. Keep this page open.</div>
    <div class="group-title"></div>
    <div class="group">
      <div class="row"><button class="row-btn" data-action="test-alarm" ${testAlarmAt ? 'disabled' : ''}>${testAlarmAt ? 'Ringing in a few seconds…' : 'Test the alarm'}</button></div>
    </div>`;
}

function settingsTab() {
  const p = persona();
  return `
    <h1 class="large-title" style="padding-top:14px">Settings</h1>
    <div class="group-title">Coach</div>
    <div class="group">
      <div class="row"><div class="seg" role="radiogroup" aria-label="Coach">
        ${Object.entries(PERSONAS).map(([id, x]) => `<button role="radio" aria-checked="${settings.persona === id}" data-action="persona" data-id="${id}">${esc(x.name)}</button>`).join('')}
      </div></div>
      <div class="row">
        <span class="row-label">Voice</span>
        <select data-setting="voice" aria-label="Voice">
          <option value="">${esc(p.name)}'s own</option>
          ${VOICES.map((v) => `<option ${settings.voice === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="group-foot">${esc(p.blurb)}.</div>

    <div class="group-title">Gemini</div>
    <div class="group">
      <div class="row"><span class="row-label">API key</span><input type="password" data-setting="apiKey" value="${esc(settings.apiKey)}" placeholder="${BUILT_IN_KEY ? 'Built in' : 'Required'}" autocomplete="off" spellcheck="false" /></div>
      <div class="row"><span class="row-label">Model</span><input type="text" data-setting="model" value="${esc(settings.model || DEFAULT_MODEL)}" spellcheck="false" /></div>
    </div>
    <div class="group-foot">${BUILT_IN_KEY ? 'This site has a built-in key. Enter your own only if you want to use yours instead. It is stored only in this browser.' : 'Stored only in this browser.'}</div>

    <div class="group-title"></div>
    <div class="group"><div class="row"><button class="row-btn red" data-action="reset-deck">Reset word deck</button></div></div>`;
}

function addSheet() {
  return `
    <div class="scrim" data-action="add-close"></div>
    <form class="sheet" id="add-form" role="dialog" aria-label="New word">
      <div class="sheet-bar">
        <button type="button" class="text-btn" data-action="add-close">Cancel</button>
        <span class="sheet-title">New Word</span>
        <button type="submit" class="text-btn bold">Add</button>
      </div>
      <div class="group-title"></div>
      <div class="group">
        <div class="row"><span class="row-label">Word</span><input type="text" name="word" required autocomplete="off" autocapitalize="none" placeholder="ephemeral" /></div>
        <div class="row"><span class="row-label">Meaning</span><input type="text" name="definition" required autocomplete="off" placeholder="Short, plain English" /></div>
        <div class="row"><span class="row-label">Example</span><input type="text" name="example" autocomplete="off" placeholder="Optional" /></div>
      </div>
    </form>`;
}

function renderHome() {
  const body = { today: todayTab, words: wordsTab, alarm: alarmTab, settings: settingsTab }[tab]();
  $app.innerHTML = `<div data-enter-tab>${body}</div>${tabBar()}${adding ? addSheet() : ''}`;
  if (adding) $app.querySelector('input[name=word]')?.focus();
}

// ── Ringing ─────────────────────────────────────────────────────────────────

function ring() {
  if (isShowingFindings() || view === 'call' || view === 'ring') return;
  cancelIncomingDemo();
  view = 'ring';
  ringer.start();
  document.title = 'Incoming call, VocalCoach';
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`${persona().name} is calling`, { body: 'Time to wake up and pass your words.', requireInteraction: true });
    }
  } catch { /* notifications are optional */ }
  render();
  $app.querySelector('#answer-slider')?.focus({ preventScroll: true });
}

function answerIncomingCall() {
  if (view !== 'ring' || call) return;
  ringer.stop();
  document.title = TITLE;
  view = 'home';
  startCall('alarm').then(() => { if (!call && view === 'home') render(); });
}

function renderRing() {
  const p = persona();
  $app.innerHTML = `
    <div class="ring" role="alertdialog" aria-modal="true" aria-label="${esc(p.name)} is calling">
      <h1 class="ring-name">${esc(p.name)}</h1>
      <div class="ring-sub">VocalCoach audio…</div>
      <div class="ring-actions">
        <div class="answer-control">
          <span class="answer-caption" aria-hidden="true">slide to answer</span>
          <input class="answer-input" id="answer-slider" type="range" min="0" max="100" step="1" value="0" aria-label="Slide to answer" />
          <span class="answer-symbol" aria-hidden="true">${icons.phone(30)}</span>
        </div>
      </div>
      <p class="ring-note">Allow microphone access when asked.</p>
    </div>`;
  wireAnswerSlider($app.querySelector('#answer-slider'), answerIncomingCall);
}

// ── Call ────────────────────────────────────────────────────────────────────

async function startCall(mode) {
  if (call) return;
  cancelIncomingDemo();
  if (!effectiveKey(settings)) {
    tab = 'settings';
    view = 'home';
    render();
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
    micLevel: 0,
    recap: '',
  };
  call = c;
  view = 'call';
  audio.onMicState = () => updateLiveBits(c);
  audio.onMicLevel = (level) => { c.micLevel = level; updateLiveBits(c); };
  audio.onError = (error) => endCall(c, 'error', `Microphone unavailable: ${error.message}`);
  render();

  try {
    await audio.startMic();
  } catch (err) {
    endCall(c, 'error', `Microphone unavailable: ${err?.message || err}`);
    return;
  }
  if (c.ended) return;
  dial(c);
  c.tick = setInterval(() => tick(c), 1000);
}

function dial(c) {
  if (c.ended) return;
  const resumed = c.everReady;
  setStatus(c, resumed ? 'Calling back…' : 'Calling…');
  c.live = new LiveCall({
    apiKey: effectiveKey(settings),
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
      updateLiveBits(c);
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
    setStatus(c, 'All words passed');
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
  updateLiveBits(c);
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
  if (outcome !== 'error') revealFindings(1200);
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
      <div class="ios-head">
        <div class="call-name">${esc(c.persona.name)}</div>
        <div class="call-timer" id="call-timer">0:00</div>
        <div class="call-status" id="call-status">${esc(c.status)}</div>
      </div>
      <div class="focus" id="focus"></div>
      <div class="voice" id="voice" aria-hidden="true">${'<i></i>'.repeat(28)}</div>
      <div class="captions" id="captions" aria-live="polite"></div>
      <div class="mic-status">
        <span class="mic-signal" id="mic-signal" aria-hidden="true">${'<i></i>'.repeat(5)}</span>
        <span class="mic-label" id="mic-label">Connecting microphone…</span>
      </div>
      <button class="end" data-action="hangup" aria-label="${c.mode === 'alarm' ? 'Hang up (counts as failed)' : 'Hang up'}">${icons.phoneDown(32)}</button>
      ${c.mode === 'alarm' ? '<div class="end-note">Hanging up counts as failed</div>' : ''}
    </div>`;
  renderProgress(c);
  renderCaptions(c);
  updateLiveBits(c);
}

// The word being worked on stays masked as blanks until the user has said it,
// otherwise showing it would give away the recall question.
const blanks = (word) => word.replace(/[a-z]/gi, '_').split('').join(' ');

function renderProgress(c) {
  const $f = document.getElementById('focus');
  if (!$f || call !== c) return;
  const focus = currentFocus(c.session);
  const done = c.session.items.filter(isPassed).length;
  const total = c.session.items.length;
  const shown = focus || c.session.items[c.session.items.length - 1];
  $f.innerHTML = `
    <div class="focus-word ${shown.recall ? 'revealed' : ''}" aria-label="${shown.recall ? esc(shown.word) : 'Word to say, ' + shown.word.length + ' letters'}">
      ${shown.recall ? esc(shown.word) : esc(blanks(shown.word))}
    </div>
    <div class="steps">
      <span class="${shown.recall ? 'ok' : ''}">${shown.recall ? icons.check(14) : ''}Said it</span>
      <span class="${shown.sentence ? 'ok' : ''}">${shown.sentence ? icons.check(14) : ''}Used it in a sentence</span>
    </div>
    <div class="tally-line">${done} of ${total} words passed</div>`;
}

function renderCaptions(c) {
  const $c = document.getElementById('captions');
  if (!$c || call !== c) return;
  const items = c.transcript.slice(-30);
  $c.innerHTML = items.length
    ? items
        .map((t) =>
          t.role === 'event'
            ? `<div class="event ${t.good ? 'good' : 'bad'}">${esc(t.text)}</div>`
            : `<p class="line ${t.role}">${esc(t.text.trim())}</p>`)
        .join('')
    : '<p class="line empty">Captions appear here as you talk.</p>';
  $c.scrollTop = $c.scrollHeight;
}

function updateLiveBits(c) {
  if (call !== c) return;
  document.getElementById('voice')?.classList.toggle('speaking', c.speaking);
  document.getElementById('mic-signal')?.style.setProperty('--mic-level', String(c.endAccepted || c.audio.micState !== 'active' ? 0 : c.micLevel));
  const $label = document.getElementById('mic-label');
  if ($label) {
    $label.textContent = c.endAccepted ? 'Mic off'
      : c.audio.micState === 'paused' ? 'Microphone paused. Tap to resume.'
      : c.audio.micState !== 'active' ? 'Connecting microphone…'
      : !c.live?.ready ? 'Connecting to coach…'
      : Date.now() - c.audio.lastSentAt > 1500 ? 'Waiting for microphone audio…'
      : c.speaking ? `${c.persona.name} is talking. You can interrupt.` : 'Listening…';
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

function renderSummary() {
  const s = summary;
  const titles = {
    passed: s.mode === 'alarm' ? "You're up, and you passed" : 'Nice work',
    hungup: 'Call ended early',
    timeout: 'Time ran out',
    error: 'The call failed',
  };
  $app.innerHTML = `
    <section class="summary">
      <div class="eyebrow-date" style="padding-top:14px">${esc(s.persona.name)}, ${s.mode === 'alarm' ? 'wake-up call' : 'practice call'}</div>
      <h1 class="large-title">${titles[s.outcome] || 'Call ended'}</h1>
      ${s.detail ? `<div class="error-card">${esc(s.detail)}</div>` : ''}
      <div class="group">
        ${s.results.map((r) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${esc(r.word)}</div>
              <div class="row-sub">${r.touched ? `Box ${r.before} to ${r.after}. Next: ${esc(r.next)}` : 'Unchanged'}</div>
            </div>
            <span class="${r.passed ? (r.firstTry ? 'res-good' : 'res-ok') : r.touched ? 'res-bad' : 'res-ok'}">${r.passed ? (r.firstTry ? 'First try' : 'Passed') : r.touched ? 'Not yet' : 'Not reached'}</span>
          </div>`).join('')}
      </div>
      ${s.recap ? `<div class="group-foot">${esc(s.recap)}</div>` : ''}
      <button class="btn-fill" data-action="home">Done</button>
    </section>`;
}

// ── Events ──────────────────────────────────────────────────────────────────

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'tab') {
    tab = el.dataset.tab;
    editing = false;
    adding = false;
    render();
    $app.scrollTop = 0;
  } else if (action === 'practice') startCall('practice');
  else if (action === 'hangup') {
    if (call) endCall(call, 'hungup');
  } else if (action === 'home') {
    if (view === 'summary' && summary?.outcome !== 'error') {
      revealFindings();
      return;
    }
    view = 'home';
    tab = 'today';
    render();
  } else if (action === 'test-alarm') {
    ringer.unlock();
    testAlarmAt = Date.now() + 10000;
    render();
  } else if (action === 'edit') {
    editing = !editing;
    render();
  } else if (action === 'add-open') {
    adding = true;
    render();
  } else if (action === 'add-close') {
    adding = false;
    render();
  } else if (action === 'delete') {
    removeWord(deck, el.dataset.id);
    saveDeck(deck);
    render();
  } else if (action === 'persona') {
    settings.persona = el.dataset.id;
    saveSettings(settings);
    render();
  } else if (action === 'reset-deck') {
    if (confirm('Reset the deck to the starter words? Your progress will be lost.')) {
      deck = resetDeck();
      render();
    }
  }
});

$app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.setting) {
    const v = t.value.trim();
    if (t.dataset.setting === 'model') settings.model = v || DEFAULT_MODEL;
    else settings[t.dataset.setting] = v;
    saveSettings(settings);
    return;
  }
  if (t.id !== 'alarm-time' && t.id !== 'alarm-enabled') return;
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
  adding = false;
  render();
});

// ── Alarm clock (runs while the tab is open) ────────────────────────────────

setInterval(() => {
  if (isShowingFindings() || view === 'call' || view === 'ring') return;
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
  if (document.hidden && view === 'launcher' && introPending) {
    cancelIncomingDemo();
    resumeIntro = true;
    render();
  }
  if (!document.hidden && view === 'launcher' && resumeIntro) startIncomingDemo();
  if (!document.hidden && view === 'home') render();
});

// ── The phone frame ─────────────────────────────────────────────────────────

const $fit = document.getElementById('fit');
const $clock = document.getElementById('clock');
const PHONE_W = 414;
const PHONE_H = 868;

function fitPhone() {
  if (window.matchMedia('(max-width: 520px)').matches) {
    $phone.style.transform = '';
    return;
  }
  const s = Math.min(1, (window.innerHeight - 64) / PHONE_H, (window.innerWidth - 64) / PHONE_W);
  $fit.style.width = `${PHONE_W * s}px`;
  $fit.style.height = `${PHONE_H * s}px`;
  $phone.style.transform = `scale(${s})`;
}
window.addEventListener('resize', fitPhone);
fitPhone();

document.getElementById('replay-demo').addEventListener('click', () => {
  showDemo();
  cancelIncomingDemo();
  ringer.stop();
  summary = null;
  view = 'launcher';
  tab = 'today';
  editing = false;
  adding = false;
  testAlarmAt = null;
  render();
  startIncomingDemo();
});

function tickClock() {
  $clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}
tickClock();
setInterval(tickClock, 10000);

// Show the Home Screen briefly, then bring in the incoming call automatically.
document.title = TITLE;
startIncomingDemo();
