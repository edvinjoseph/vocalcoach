// Gemini Live API voice session for the browser.
//
// Ported from momsalarm's useGeminiLive hook. The protocol and the call
// mechanics are the same (setup message, realtimeInput audio/text, toolCall ->
// toolResponse, the goodbye sequencing after the closing tool). Only the audio
// layer differs:
//   - mic: getUserMedia (echo cancellation on) -> AudioWorklet that downsamples
//     to 16 kHz mono PCM16 in 100 ms chunks -> realtimeInput.audio
//   - speaker: 24 kHz PCM16 chunks scheduled back to back on an AudioContext;
//     an `interrupted` message (user barged in) stops everything queued.
//
// AudioIO is created once per call inside the click handler that starts it,
// so both AudioContexts are allowed to run, and it is reused across redials.

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const IN_RATE = 16000; // Live API input: 16 kHz mono PCM16 little-endian
const OUT_RATE = 24000; // Live API output: 24 kHz mono PCM16
const SETUP_TIMEOUT_MS = 15000;
const IDLE_DEBOUNCE_MS = 300;
// After the closing tool: wait this long for a send-off to start, and never
// longer than the hard cap overall.
const GOODBYE_NO_REPLY_MS = 6000;
const GOODBYE_HARD_LIMIT_MS = 20000;

export class Pcm16Chunker {
  constructor(inputRate, emit) {
    this.ratio = inputRate / 16000;
    this.emit = emit;
    this.phase = 0;
    this.acc = 0;
    this.n = 0;
    this.out = new Int16Array(1600);
    this.len = 0;
  }

  push(samples) {
    for (const sample of samples) {
      this.acc += sample;
      this.n++;
      this.phase++;
      if (this.phase < this.ratio) continue;
      this.phase -= this.ratio;
      const value = Math.max(-1, Math.min(1, this.acc / this.n));
      this.acc = 0;
      this.n = 0;
      this.out[this.len++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.len === this.out.length) {
        this.emit(this.out.buffer);
        this.out = new Int16Array(1600);
        this.len = 0;
      }
    }
  }
}

const WORKLET_SRC = `
const Pcm16Chunker = ${Pcm16Chunker.toString()};
class MicDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.encoder = new Pcm16Chunker(sampleRate, (buffer) => {
      this.port.postMessage(buffer, [buffer]);
    });
  }
  process(inputs, outputs) {
    // Keep a pulled output without playing the user's microphone back to them.
    for (const channel of outputs[0] || []) channel.fill(0);
    const x = inputs[0] && inputs[0][0];
    if (x) this.encoder.push(x);
    return true;
  }
}
registerProcessor('mic-downsampler', MicDownsampler);
`;

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class PcmPlayer {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: OUT_RATE });
    this.next = 0;
    this.sources = new Set();
    this.speaking = false;
    this.idleTimer = null;
    this.onSpeakingChange = null;
  }

  play(b64) {
    // While the call is paused, new speech queues up and plays on resume.
    if (!this.held && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    const bytes = b64ToBytes(b64);
    const view = new DataView(bytes.buffer);
    const n = bytes.length >> 1;
    if (!n) return;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = view.getInt16(i * 2, true) / 32768;

    const buf = this.ctx.createBuffer(1, n, OUT_RATE);
    buf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.03, this.next);
    src.start(startAt);
    this.next = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this._scheduleIdle();
    };
    clearTimeout(this.idleTimer);
    this._set(true);
  }

  stop() {
    for (const s of this.sources) {
      s.onended = null;
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.next = 0;
    clearTimeout(this.idleTimer);
    this._set(false);
  }

  // The queue can drain mid-turn when the network stalls, so wait a moment
  // before calling it silence.
  _scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.sources.size) this._set(false);
    }, IDLE_DEBOUNCE_MS);
  }

  _set(v) {
    if (this.speaking === v) return;
    this.speaking = v;
    this.onSpeakingChange?.(v);
  }

  close() {
    this.stop();
    this.ctx.close().catch(() => {});
  }
}

/** Mic + speaker for one call. Construct it inside a user gesture. */
export class AudioIO {
  constructor() {
    this.player = new PcmPlayer();
    this.micCtx = new AudioContext();
    this.stream = null;
    this.node = null;
    this.source = null;
    this.onChunk = null; // set by LiveCall while a session is live
    this.onMicLevel = null;
    this.onMicState = null;
    this.onError = null;
    this.micState = 'starting';
    this.micFrames = 0;
    this.lastMicAt = 0;
    this.lastSentAt = 0;
    this.closed = false;
    this.muted = false; // the call screen's mute button: frames are still read, never sent
    this.captureId = 0;
    this.lastSignalAt = 0;
    this.untranscribedMs = 0;
    this.untranscribedSince = 0;
    this.micOptions = { deviceId: '', processing: true };
    this.micCtx.onstatechange = () => {
      if (!this.closed && this.micCtx.state !== 'running') this._setMicState('paused');
    };
  }

  resume() {
    this.player.held = false;
    // Call both resumes synchronously during the answer gesture, before permission prompts.
    return Promise.all([this.micCtx, this.player.ctx].map((ctx) =>
      ctx.state === 'running' ? Promise.resolve() : ctx.resume()));
  }

  /** Freeze the call in place: no mic frames are captured or sent, and queued speech holds. */
  suspend() {
    this.player.held = true;
    return Promise.all([this.micCtx, this.player.ctx].map((ctx) =>
      ctx.state === 'running' ? ctx.suspend().catch(() => {}) : Promise.resolve()));
  }

  startMic(options = {}) {
    if (this.node) return Promise.resolve();
    return this._openMic(options, true);
  }

  restartMic(options = this.micOptions) {
    return this._openMic(options, false);
  }

  /** The deviceId actually in use, which may differ from the one requested. */
  get currentDeviceId() {
    return this.track?.getSettings?.().deviceId || '';
  }

  async listMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
  }

  async _openMic(options, allowDefaultFallback) {
    if (this.closed) throw new DOMException('Call already ended', 'AbortError');
    const captureId = ++this.captureId;
    const next = { ...this.micOptions, ...options };
    // Resume during the gesture, before permission or device selection can take focus.
    const activation = this.resume();
    activation.catch(() => {});
    const request = () => navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: next.processing, noiseSuppression: next.processing,
        autoGainControl: next.processing, channelCount: 1,
        ...(next.deviceId ? { deviceId: { exact: next.deviceId } } : {}),
      },
    });
    let stream;
    try {
      try { stream = await request(); } catch (error) {
        // A saved headset may have been unplugged since the previous call.
        if (!allowDefaultFallback || !next.deviceId || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
        if (this.closed || captureId !== this.captureId) throw new DOMException('Call already ended', 'AbortError');
        next.deviceId = '';
        stream = await request();
      }
      const checkCurrent = () => {
        if (this.closed || captureId !== this.captureId) throw new DOMException('Microphone request cancelled', 'AbortError');
      };
      checkCurrent();
      await activation;
      await this.resume();
      checkCurrent();
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('No working microphone was found.');
      const source = this.micCtx.createMediaStreamSource(stream);
      // Keep the old input working until the replacement has permission and a source.
      clearInterval(this.watchdog);
      this.finishFirstFrame?.(false);
      const oldStream = this.stream;
      this._disconnectProcessor();
      this.stream = stream;
      this.track = track;
      this.source = source;
      this.micOptions = next;
      this.micFrames = 0;
      this.lastMicAt = this.lastSignalAt = this.lastSentAt = 0;
      this.untranscribedMs = this.untranscribedSince = 0;
      this.captureStartedAt = Date.now();
      this._setMicState('starting');
      this.onMicLevel?.(0);
      oldStream?.getTracks().forEach((oldTrack) => oldTrack.stop());
      track.addEventListener('ended', () => {
        if (!this.closed && this.track === track) {
          this._setMicState('disconnected');
          this.onError?.(new Error('Microphone disconnected. Choose another input or reconnect.'));
        }
      });
      track.addEventListener('mute', () => {
        if (!this.closed && this.track === track) this._setMicState('paused');
      });
      try { await this._startWorklet(); } catch (error) {
        checkCurrent();
        this._startFallback();
      }
      checkCurrent();
      if (!await this._waitForFrames(1800) && !this.closed && captureId === this.captureId && this.processorMode === 'worklet') this._startFallback();
      checkCurrent();
      if (!await this._waitForFrames(1800)) {
        checkCurrent();
        this._setMicState('stalled');
        throw new Error('No audio frames are reaching the app. Choose another microphone or reconnect.');
      }
      checkCurrent();
      this.watchdog = setInterval(() => {
        if (this.closed || this.micState === 'disconnected') return;
        if (this.micCtx.state !== 'running' || this.track.muted) return this._setMicState('paused');
        if (Date.now() - this.lastMicAt < 2000) return;
        if (this.processorMode === 'worklet') {
          try { this._startFallback(); this.lastMicAt = Date.now(); } catch (error) { this.onError?.(error); }
        } else if (this.micState !== 'stalled') {
          this._setMicState('stalled');
          this.onError?.(new Error('Microphone capture stopped. Choose another input or reconnect.'));
        }
      }, 1000);
    } catch (error) {
      if (stream && stream !== this.stream) stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  async _startWorklet() {
    if (!this.micCtx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet unavailable');
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try { await this.micCtx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    if (this.closed) throw new DOMException('Call already ended', 'AbortError');
    this.node = new AudioWorkletNode(this.micCtx, 'mic-downsampler', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    });
    this.processorMode = 'worklet';
    this.node.port.onmessage = (event) => this._receiveMic(event.data);
    this.node.onprocessorerror = () => {
      if (!this.closed) {
        try { this._startFallback(); } catch (error) { this.onError?.(error); }
      }
    };
    this.source.connect(this.node);
    this.node.connect(this.micCtx.destination);
  }

  _startFallback() {
    this._disconnectProcessor();
    const encoder = new Pcm16Chunker(this.micCtx.sampleRate, (buffer) => this._receiveMic(buffer));
    this.node = this.micCtx.createScriptProcessor(4096, 1, 1);
    this.processorMode = 'fallback';
    this.node.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      encoder.push(event.inputBuffer.getChannelData(0));
    };
    this.source.connect(this.node);
    this.node.connect(this.micCtx.destination);
  }

  _waitForFrames(timeout) {
    if (this.micFrames) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.finishFirstFrame = (received) => {
        clearTimeout(this.firstFrameTimer);
        this.finishFirstFrame = null;
        resolve(received);
      };
      this.firstFrameTimer = setTimeout(() => this.finishFirstFrame?.(false), timeout);
    });
  }

  _receiveMic(buffer) {
    if (this.closed || !buffer?.byteLength) return;
    this.micFrames++;
    this.lastMicAt = Date.now();
    this.finishFirstFrame?.(true);
    if (!this.muted) this.onChunk?.(buffer);
    const samples = new Int16Array(buffer);
    let energy = 0;
    for (const sample of samples) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / samples.length);
    if (rms >= 0.003) {
      this.lastSignalAt = this.lastMicAt;
      // Speaker echo is not evidence that the user's answer reached Gemini.
      if (!this.player.speaking && !this.track?.muted && !this.muted) {
        if (!this.untranscribedSince) this.untranscribedSince = this.lastMicAt;
        this.untranscribedMs += samples.length / (IN_RATE / 1000);
      }
    }
    this._setMicState(this.track?.muted ? 'paused' : 'active');
    this.onMicLevel?.(Math.min(1, rms * 8));
  }

  _setMicState(state) {
    if (this.micState === state) return;
    this.micState = state;
    this.onMicState?.(state);
  }

  _disconnectProcessor() {
    this.source?.disconnect();
    if (this.node?.port) this.node.port.onmessage = null;
    if (this.node) { this.node.onaudioprocess = null; this.node.onprocessorerror = null; this.node.disconnect(); }
    this.node = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.captureId++;
    clearInterval(this.watchdog);
    this.finishFirstFrame?.(false);
    this.onChunk = null;
    this.onMicLevel = null;
    this.onMicState = null;
    this.onError = null;
    this._disconnectProcessor();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micCtx.close().catch(() => {});
    this.player.close();
  }
}

/**
 * One WebSocket session. A dropped call makes a new LiveCall with the same
 * AudioIO.
 *
 * Options: apiKey, model, voice, systemPrompt, tools, audio (AudioIO), and the
 * callbacks onReady, onToolCall(name, args) -> { response, goodbye? },
 * onTranscript(role, text), onTurnComplete, onUserSpoke, onSpeakingChange(bool),
 * onDrop(code, reason, wasReady), onGoodbyeDone.
 */
export class LiveCall {
  constructor(opts) {
    this.o = opts;
    this.audio = opts.audio;
    this.ws = null;
    this.ready = false;
    this.intentional = false;
    this.goodbye = null; // { phase: 'awaiting' | 'playing' | 'done', t1, t2 }
    this.lastError = '';
    this.audio.player.onSpeakingChange = (v) => {
      this.o.onSpeakingChange?.(v);
      if (!v) this._maybeFinishGoodbye();
    };
  }

  connect() {
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.o.apiKey)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this.setupTimer = setTimeout(() => {
      if (!this.ready) {
        this.lastError = 'connection timed out';
        ws.close();
      }
    }, SETUP_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${this.o.model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voice } } },
          },
          systemInstruction: { parts: [{ text: this.o.systemPrompt }] },
          tools: [{ functionDeclarations: this.o.tools }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
              prefixPaddingMs: 300,
              silenceDurationMs: 700,
            },
          },
        },
      }));
    };

    ws.onmessage = (ev) => {
      let raw = ev.data;
      if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      if (typeof raw !== 'string' || raw[0] !== '{') return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this._handle(msg);
    };

    ws.onclose = (ev) => {
      clearTimeout(this.setupTimer);
      const wasReady = this.ready;
      this.ready = false;
      this.audio.onChunk = null;
      this.audio.player.stop();
      if (this.intentional) return;
      this.o.onDrop?.(ev.code, ev.reason || this.lastError, wasReady);
    };
  }

  disconnect() {
    this.intentional = true;
    clearTimeout(this.setupTimer);
    if (this.goodbye) {
      clearTimeout(this.goodbye.t1);
      clearTimeout(this.goodbye.t2);
      this.goodbye = null;
    }
    this.ready = false;
    this.audio.onChunk = null;
    this.audio.player.stop();
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  sendText(text) {
    this._send({ realtimeInput: { text } });
  }

  _send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  // Synchronous on purpose so audio chunks reach the player in arrival order.
  _handle(msg) {
    if (msg.setupComplete) {
      clearTimeout(this.setupTimer);
      this.ready = true;
      this.audio.onChunk = (buf) => {
        if (this._send({
          realtimeInput: { audio: { data: bytesToB64(new Uint8Array(buf)), mimeType: `audio/pcm;rate=${IN_RATE}` } },
        })) this.audio.lastSentAt = Date.now();
      };
      this.o.onReady?.();
      return;
    }

    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.audio.player.stop();

      const heard = sc.inputTranscription?.text;
      if (heard) {
        this.audio.untranscribedMs = this.audio.untranscribedSince = 0;
        this.o.onTranscript?.('user', heard);
        this.o.onUserSpoke?.();
      }
      const said = sc.outputTranscription?.text;
      if (said) this.o.onTranscript?.('coach', said);

      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.mimeType?.startsWith('audio/')) {
          this.audio.player.play(part.inlineData.data);
          if (this.goodbye?.phase === 'awaiting') this.goodbye.phase = 'playing';
        }
      }

      if (sc.turnComplete) {
        this.o.onTurnComplete?.();
        // Trap carried over from momsalarm: the turn that CONTAINS the closing
        // tool call ends with its own turnComplete before the send-off starts.
        // Only a turnComplete after send-off audio began means it's finished.
        if (this.goodbye?.phase === 'playing') {
          this.goodbye.phase = 'done';
          this._maybeFinishGoodbye();
        }
      }
    }

    if (msg.toolCall) {
      const functionResponses = [];
      let goodbye = false;
      for (const fc of msg.toolCall.functionCalls ?? []) {
        let result;
        try {
          result = this.o.onToolCall(fc.name, fc.args || {});
        } catch (err) {
          result = { response: { ok: false, error: String(err?.message || err) } };
        }
        functionResponses.push({ id: fc.id, name: fc.name, response: result.response });
        if (result.goodbye) goodbye = true;
      }
      this._send({ toolResponse: { functionResponses } });
      if (goodbye) this._beginGoodbye();
    }
  }

  _beginGoodbye() {
    if (this.goodbye) return;
    // The test is passed; stop sending the mic so the user (or echo) can't cut
    // the send-off short.
    this.audio.onChunk = null;
    this.goodbye = {
      phase: 'awaiting',
      t1: setTimeout(() => {
        if (this.goodbye?.phase === 'awaiting') {
          this.goodbye.phase = 'done';
          this._maybeFinishGoodbye();
        }
      }, GOODBYE_NO_REPLY_MS),
      t2: setTimeout(() => this._finishGoodbye(), GOODBYE_HARD_LIMIT_MS),
    };
  }

  _maybeFinishGoodbye() {
    if (this.goodbye?.phase === 'done' && !this.audio.player.speaking) this._finishGoodbye();
  }

  _finishGoodbye() {
    if (!this.goodbye) return;
    this.disconnect();
    this.o.onGoodbyeDone?.();
  }
}
