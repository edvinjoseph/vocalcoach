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

const WORKLET_SRC = `
class MicDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${IN_RATE};
    this.phase = 0; this.acc = 0; this.n = 0;
    this.size = ${IN_RATE / 10};
    this.out = new Int16Array(this.size); this.len = 0;
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    for (let i = 0; i < x.length; i++) {
      // Box-filter decimation: average the input samples that fall into each
      // output sample. Crude, but a fine low-pass for speech.
      this.acc += x[i]; this.n++; this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let s = this.acc / this.n; this.acc = 0; this.n = 0;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.out[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.len === this.size) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(this.size); this.len = 0;
        }
      }
    }
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
    if (this.ctx.state === 'suspended') this.ctx.resume();
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
    this.onChunk = null; // set by LiveCall while a session is live
  }

  async startMic() {
    if (this.node) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (this.micCtx.state === 'suspended') await this.micCtx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await this.micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.micCtx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.micCtx, 'mic-downsampler');
    this.node.port.onmessage = (e) => this.onChunk?.(e.data);
    // A muted path to the destination keeps the worklet being pulled in every browser.
    const mute = this.micCtx.createGain();
    mute.gain.value = 0;
    src.connect(this.node).connect(mute).connect(this.micCtx.destination);
  }

  close() {
    this.onChunk = null;
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
      this.audio.onChunk = (buf) =>
        this._send({
          realtimeInput: { audio: { data: bytesToB64(new Uint8Array(buf)), mimeType: `audio/pcm;rate=${IN_RATE}` } },
        });
      this.o.onReady?.();
      return;
    }

    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.audio.player.stop();

      const heard = sc.inputTranscription?.text;
      if (heard) {
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
