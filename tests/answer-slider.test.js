import test from 'node:test';
import assert from 'node:assert/strict';
import { wireAnswerSlider } from '../src/answer-slider.js';

function slider() {
  const events = {};
  const style = new Map();
  let answers = 0;
  const input = {
    value: '0', clientWidth: 300,
    closest: () => ({ style: { setProperty: (key, value) => style.set(key, value) } }),
    setAttribute() {},
    addEventListener: (name, handler) => { events[name] = handler; },
  };
  wireAnswerSlider(input, () => answers++);
  return { input, events, style, answers: () => answers };
}

test('a partial slide resets without answering', () => {
  const s = slider();
  s.input.value = '60';
  s.events.input();
  assert.equal(s.style.get('--answer-offset'), '139.2px');
  s.events.change();
  assert.equal(s.input.value, '0');
  assert.equal(s.answers(), 0);
});

test('a completed slide answers once and disables the control', () => {
  const s = slider();
  s.input.value = '97';
  s.events.change();
  s.events.change();
  assert.equal(s.answers(), 1);
  assert.equal(s.input.disabled, true);
});

test('keyboard users can answer with Enter or Space', () => {
  for (const key of ['Enter', ' ']) {
    const s = slider();
    let prevented = false;
    s.events.keydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(s.answers(), 1);
  }
});

test('an interrupted drag does not answer the call', () => {
  const s = slider();
  s.input.value = '100';
  s.events.pointercancel();
  s.events.change();
  assert.equal(s.answers(), 0);
});
