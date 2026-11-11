import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { icons } from '../src/icons.js';
import { wireAnswerSlider } from '../src/answer-slider.js';
import { createSession, currentFocus, isPassed, score } from '../src/session.js';

test('automatic call, slide to answer, microphone captions, deck and replay work together', async () => {
  const nodes = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let microphoneStarts = 0;
  let activeLive;
  let answerInput;
  const word = { id: 'one', word: 'candid', definition: 'honest and direct', box: 0 };

  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      dataset: {}, attrs: {}, listeners: {}, style: { setProperty() {} },
      classList: { toggle() {} },
      setAttribute(key, value) { this.attrs[key] = value; },
      removeAttribute(key) { delete this.attrs[key]; },
      addEventListener(event, listener) { this.listeners[event] = listener; },
      focus() {},
      querySelector(selector) {
        if (selector === '#answer-slider') {
          answerInput ??= {
            value: '0', clientWidth: 300, listeners: {},
            closest: () => ({ style: { setProperty() {} } }), setAttribute() {}, focus() {},
            addEventListener(event, listener) { this.listeners[event] = listener; },
          };
          return answerInput;
        }
        return node(selector === '#app' ? 'app' : selector);
      },
    });
    return nodes.get(id);
  }
  Object.defineProperty(node('app'), 'innerHTML', {
    get() { return this.html ?? ''; },
    set(html) { this.html = html; answerInput = null; },
  });
  node('stage').dataset.phase = 'demo';
  class AudioIO {
    micState = 'active';
    lastSentAt = Date.now();
    resume() { return Promise.resolve(); }
    startMic() { microphoneStarts++; return Promise.resolve(); }
    close() {}
  }
  class LiveCall {
    constructor(options) { this.options = options; activeLive = this; }
    connect() { this.ready = true; this.options.onReady(); }
    sendText() {}
    disconnect() {}
  }
  class Ringer { start() {} stop() {} unlock() {} }
  const context = vm.createContext({
    console, Date, String, Math, Set, Array, Object, RegExp,
    icons, wireAnswerSlider, createSession, currentFocus, isPassed, score, AudioIO, LiveCall, Ringer,
    homeScreenImage: 'home.webp',
    findingsHtml: await fs.readFile(new URL('../deliverables/vocalcoach-findings.html', import.meta.url), 'utf8'),
    document: { title: '', hidden: false, getElementById: node, addEventListener() {} },
    window: { innerHeight: 900, innerWidth: 1440, matchMedia: () => ({ matches: false }), addEventListener() {} },
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
    loadDeck: () => [word], loadSettings: () => ({ persona: 'mom', alarm: { enabled: false } }),
    PERSONAS: { mom: { name: 'Mom', voice: 'Aoede' } }, effectiveKey: () => 'test-key',
    DEFAULT_MODEL: 'test-model',
    pickSessionWords: () => [word], buildPrompt: () => '', openingCue: () => '', TOOLS: [],
    saveDeck() {}, recordStudyDay() {}, applyResult() {}, dueLabel: () => 'Tomorrow',
  });
  const stripImports = (source) => source.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(stripImports(await fs.readFile(new URL('../src/findings.js', import.meta.url), 'utf8')), context);
  vm.runInContext(stripImports(await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8')), context);
  const advance = (delay) => {
    const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay);
    timers.delete(id);
    timer.fn();
  };

  assert.ok(node('app').innerHTML.includes('iOS Home Screen'));
  assert.ok(!node('app').innerHTML.includes('Start demo'));
  advance(1800);
  assert.ok(node('app').innerHTML.includes('slide to answer'));
  assert.ok(!node('app').innerHTML.includes('Decline'));
  answerInput.value = '50';
  answerInput.listeners.change();
  assert.equal(microphoneStarts, 0);
  answerInput.value = '100';
  answerInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(microphoneStarts, 1);
  assert.ok(node('app').innerHTML.includes('data-action="hangup"'));
  assert.ok(!node('app').innerHTML.includes('ios-grid'));
  assert.ok(!node('app').innerHTML.includes('Mute microphone'));
  activeLive.options.onTranscript('user', 'A candid conversation helped us.');
  assert.ok(node('captions').innerHTML.includes('A candid conversation helped us.'));
  activeLive.options.onGoodbyeDone();
  advance(400);
  assert.equal(node('stage').dataset.phase, 'findings');
  node('replay-demo').listeners.click();
  assert.equal(node('stage').dataset.phase, 'demo');
  assert.ok(node('app').innerHTML.includes('iOS Home Screen'));
  advance(1800);
  assert.ok(node('app').innerHTML.includes('slide to answer'));
});
