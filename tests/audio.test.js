import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { AudioIO, LiveCall, Pcm16Chunker } from '../src/live.js';
import { Ringer } from '../src/ringer.js';

function audioRuntime(t, { worklet = true, emitFrames = true, failWorklet = false, pendingPermission = false } = {}) {
  const originals = new Map();
  const replace = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const contexts = [];
  let workletSource;
  let permissionResolve;
  let stopped = false;
  const track = { readyState: 'live', muted: false, addEventListener() {}, stop() { stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  replace('navigator', { mediaDevices: { getUserMedia: () => pendingPermission ? new Promise((resolve) => { permissionResolve = resolve; }) : Promise.resolve(stream) } });
  replace('AudioContext', class {
    state = 'suspended';
    sampleRate = 48000;
    destination = {};
    constructor() {
      contexts.push(this);
      this.audioWorklet = worklet ? { addModule: async (url) => {
        workletSource = await (await fetch(url)).text();
        if (failWorklet) throw new Error('Worklet failed');
      } } : null;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      return {
        connect() {
          queueMicrotask(() => {
            for (let i = 0; i < 2; i++) this.onaudioprocess?.({
              outputBuffer: { getChannelData: () => new Float32Array(4096) },
              inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) },
            });
          });
        }, disconnect() {},
      };
    }
  });
  replace('AudioWorkletNode', class {
    port = {};
    connect() {
      if (emitFrames) queueMicrotask(() => this.port.onmessage?.({ data: new Int16Array(1600).fill(4000).buffer }));
    }
    disconnect() {}
  });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { contexts, source: () => workletSource, stopped: () => stopped, grant: () => permissionResolve(stream) };
}

test('capture resumes both audio contexts before waiting for microphone permission', async (t) => {
  const runtime = audioRuntime(t);
  const audio = new AudioIO();
  t.after(() => audio.close());
  const started = audio.startMic();
  assert.deepEqual(runtime.contexts.map((ctx) => ctx.state), ['running', 'running']);
  await started;
  assert.equal(audio.processorMode, 'worklet');
  assert.equal(audio.micState, 'active');
  assert.ok(audio.micFrames > 0);
});

test('failed or unavailable worklets fall back to microphone capture on the main thread', async (t) => {
  for (const options of [{ worklet: false }, { failWorklet: true }]) {
    await t.test(JSON.stringify(options), async (t) => {
      audioRuntime(t, options);
      const audio = new AudioIO();
      t.after(() => audio.close());
      await audio.startMic();
      assert.equal(audio.processorMode, 'fallback');
      assert.equal(audio.micState, 'active');
      assert.ok(audio.micFrames > 0);
    });
  }
});

test('a stalled worklet automatically falls back instead of displaying false listening status', async (t) => {
  audioRuntime(t, { emitFrames: false });
  const audio = new AudioIO();
  t.after(() => audio.close());
  await audio.startMic();
  assert.equal(audio.processorMode, 'fallback');
  assert.ok(audio.micFrames > 0);
});

test('hanging up during a permission prompt stops tracks granted afterward', async (t) => {
  const runtime = audioRuntime(t, { pendingPermission: true });
  const audio = new AudioIO();
  const started = audio.startMic();
  audio.close();
  runtime.grant();
  await assert.rejects(started, { name: 'AbortError' });
  assert.equal(runtime.stopped(), true);
});

test('the worklet also runs after production minification and keeps microphone playback silent', async (t) => {
  const runtime = audioRuntime(t);
  const source = await fs.readFile(new URL('../src/live.js', import.meta.url), 'utf8');
  const built = await transform(source, { minify: true, format: 'esm', target: 'es2022' });
  const { AudioIO: ProductionAudio } = await import(`data:text/javascript;base64,${Buffer.from(built.code).toString('base64')}`);
  const audio = new ProductionAudio();
  t.after(() => audio.close());
  await audio.startMic();
  let Processor;
  const chunks = [];
  vm.runInNewContext(runtime.source(), {
    sampleRate: 48000,
    AudioWorkletProcessor: class { port = { postMessage: (data) => chunks.push(data) }; },
    registerProcessor(name, implementation) { assert.equal(name, 'mic-downsampler'); Processor = implementation; },
  });
  const processor = new Processor();
  const output = new Float32Array(4800).fill(1);
  processor.process([[new Float32Array(4800).fill(0.25)]], [[output]]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].byteLength, 3200);
  assert.ok(output.every((value) => value === 0));
});

test('PCM encoding keeps duration, amplitude and signed samples at common input rates', () => {
  for (const rate of [16000, 44100, 48000]) {
    const chunks = [];
    const encoder = new Pcm16Chunker(rate, (buffer) => chunks.push(new Int16Array(buffer)));
    for (let i = 0; i < rate; i += 128) encoder.push(new Float32Array(Math.min(128, rate - i)).fill(-0.5));
    const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    assert.ok(count >= 14400 && count <= 16000, `one second at ${rate} Hz`);
    assert.ok(chunks.every((chunk) => chunk.every((sample) => sample === -16384)));
  }
});

test('LiveCall sends microphone frames only after setup and records successful audio delivery', (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  t.after(() => { globalThis.WebSocket = original; });
  const sent = [];
  const transcripts = [];
  const audio = { player: { stop() {} }, onChunk: null, lastSentAt: 0 };
  const live = new LiveCall({ audio, onTranscript: (...args) => transcripts.push(args) });
  live.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  assert.equal(audio.onChunk, null);
  live._handle({ setupComplete: {} });
  const pcm = new Int16Array([12000, -12000]);
  audio.onChunk(pcm.buffer);
  assert.equal(sent[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual([...Buffer.from(sent[0].realtimeInput.audio.data, 'base64')], [...new Uint8Array(pcm.buffer)]);
  assert.ok(audio.lastSentAt > 0);
  live._handle({ serverContent: { inputTranscription: { text: 'Hello' } } });
  assert.deepEqual(transcripts, [['user', 'Hello']]);
});

test('the softer ringtone cancels every scheduled note when the call is answered', (t) => {
  const original = globalThis.AudioContext;
  const notes = [];
  globalThis.AudioContext = class {
    state = 'running'; currentTime = 0; destination = {};
    createOscillator() {
      const note = { frequency: {}, stops: [], connect: () => ({ connect() {} }), start() {}, stop(time) { this.stops.push(time); } };
      notes.push(note);
      return note;
    }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  };
  t.after(() => { globalThis.AudioContext = original; });
  const ringer = new Ringer();
  ringer.start();
  assert.equal(notes.length, 8);
  assert.equal(notes[0].type, 'sine');
  assert.equal(notes[0].frequency.value, 523.25);
  ringer.stop();
  assert.equal(ringer.timer, null);
  assert.equal(ringer.oscillators.size, 0);
  assert.ok(notes.every((note) => note.stops.at(-1) === undefined));
});
