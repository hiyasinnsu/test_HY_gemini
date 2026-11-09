/**
 * audio.js
 *
 * Web Audio API だけで動作する、外部音声ファイル不要の SE / BGM エンジン。
 *
 * - 初回のユーザー操作 (pointerdown / keydown / touchstart) で AudioContext を生成・resume する。
 * - iOS Safari 向けに無音バッファを 1 回再生してオーディオをアンロックする。
 * - SE は短いオシレータ / ノイズバーストで合成し、連打間隔と同時発音数を制限する。
 * - BGM は 16 分音符単位のルックアヘッドスケジューラでオシレータを自動演奏する。
 *
 * 使い方:
 *   import audio from './audio.js';
 *   audio.init();                      // タップ/キー入力のハンドラ内で呼ぶ
 *   audio.playShoot();
 *   audio.startBgm('stage');           // 'stage' | 'boss'
 *   audio.pauseBgm(); audio.resumeBgm(); audio.stopBgm();
 *   audio.setVolume('bgm', 0.4);
 *   audio.toggleMute();
 */

const EPS = 0.0001;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mtof = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const nowMs = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** 'x' の位置を 16 分音符 tick の配列にする。 */
const ticks = (pattern) => {
  const out = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === 'x') out.push(i);
  }
  return out;
};

/** コード構成音 (ルートからの半音)。 */
const CHORD_TONES = {
  min: [0, 3, 7, 12, 15, 19, 24],
  maj: [0, 4, 7, 12, 16, 19, 24],
};

/**
 * BGM パターン。
 * bass / arp は 16 分音符ごとの値 (null は休符)。bass はルートからの半音、
 * arp は CHORD_TONES のインデックス。lead は [tick, MIDI ノート, 長さ(tick)]。
 */
const TRACKS = {
  stage: {
    bpm: 138,
    chords: [
      { root: 45, type: 'min' }, // Am
      { root: 41, type: 'maj' }, // F
      { root: 48, type: 'maj' }, // C
      { root: 43, type: 'maj' }, // G
      { root: 45, type: 'min' }, // Am
      { root: 41, type: 'maj' }, // F
      { root: 48, type: 'maj' }, // C
      { root: 40, type: 'maj' }, // E
    ],
    kick: ticks('x...x...x...x.x.'),
    snare: ticks('....x.......x...'),
    hat: ticks('.x.x.x.x.x.x.x.x'),
    openHat: ticks('.......x........'),
    bass: [0, null, 0, 12, null, 0, 7, null, 0, null, 12, null, 7, null, 12, 7],
    arp: [0, 2, 4, 2, 5, 4, 2, 4, 0, 2, 4, 6, 5, 4, 2, 1],
    arpOctave: 24,
    bassWave: 'sawtooth',
    arpWave: 'triangle',
    leadWave: 'square',
    lead: [
      [[0, 81, 2], [2, 79, 2], [4, 76, 4], [8, 72, 2], [10, 74, 2], [12, 76, 4]],
      [[0, 77, 2], [2, 76, 2], [4, 72, 4], [8, 69, 2], [10, 72, 2], [12, 74, 4]],
      [[0, 79, 2], [2, 76, 2], [4, 72, 4], [8, 76, 2], [10, 79, 2], [12, 81, 4]],
      [[0, 79, 2], [2, 77, 2], [4, 74, 4], [6, 71, 2], [8, 74, 2], [10, 77, 2], [12, 79, 4]],
      [[0, 84, 2], [2, 81, 2], [4, 79, 4], [8, 76, 2], [10, 79, 2], [12, 81, 4]],
      [[0, 81, 2], [2, 79, 2], [4, 77, 4], [8, 72, 2], [10, 74, 2], [12, 77, 4]],
      [[0, 79, 2], [2, 76, 2], [4, 79, 4], [8, 84, 2], [10, 81, 2], [12, 79, 4]],
      [[0, 80, 2], [2, 83, 2], [4, 80, 4], [8, 76, 2], [10, 71, 2], [12, 76, 4]],
    ],
    pad: true,
    drone: false,
    gates: { bass: 1.5, arp: 1.15, lead: 0.95 },
    gains: {
      kick: 0.46,
      snare: 0.13,
      hat: 0.032,
      openHat: 0.03,
      bass: 0.115,
      arp: 0.022,
      lead: 0.042,
      pad: 0.011,
    },
  },
  boss: {
    bpm: 174,
    chords: [
      { root: 38, type: 'min' }, // Dm
      { root: 34, type: 'maj' }, // Bb
      { root: 43, type: 'min' }, // Gm
      { root: 45, type: 'maj' }, // A
    ],
    kick: ticks('x.x.x.x.x.x.x.xx'),
    snare: ticks('....x.......x..x'),
    hat: ticks('xxxxxxxxxxxxxxxx'),
    openHat: ticks('.......x.......x'),
    bass: [0, null, 0, 12, 0, null, 12, 0, 0, 6, null, 12, 0, null, 12, 6],
    arp: [0, 1, 2, 4, 3, 2, 4, 5, 0, 1, 2, 4, 5, 6, 5, 3],
    arpOctave: 24,
    bassWave: 'sawtooth',
    arpWave: 'sawtooth',
    leadWave: 'square',
    lead: [
      [[0, 74, 2], [3, 77, 2], [6, 80, 2], [10, 79, 2], [12, 77, 2], [14, 74, 2]],
      [[0, 70, 2], [3, 74, 2], [6, 77, 2], [10, 76, 2], [12, 74, 2], [14, 70, 2]],
      [[0, 67, 2], [3, 70, 2], [6, 74, 2], [10, 73, 2], [12, 70, 2], [14, 67, 2]],
      [[0, 69, 2], [3, 73, 2], [6, 76, 2], [10, 75, 2], [12, 73, 2], [14, 71, 2]],
    ],
    pad: false,
    drone: true,
    gates: { bass: 0.95, arp: 0.85, lead: 0.9 },
    gains: {
      kick: 0.38,
      snare: 0.11,
      hat: 0.016,
      openHat: 0.022,
      bass: 0.095,
      arp: 0.019,
      lead: 0.034,
      drone: 0.045,
    },
  },
};

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.isUnlocked = false;
    this.isMuted = false;

    /** 同時発音数の上限 (モバイルでのリソース枯渇防止)。 */
    this.maxSfxVoices = 32;
    this.maxBgmVoices = 40;

    this.bgmTrack = null;
    this.bgmPlaying = false;
    this.bgmPaused = false;

    this._vol = { master: 0.8, bgm: 0.5, sfx: 0.85 };
    this._sfxVoices = new Set();
    this._bgmVoices = new Set();
    this._lastSfxAt = new Map();
    this._lastWarningAt = -Infinity;
    this._lastDefeatAt = -Infinity;

    this._graphReady = false;
    this._unsupported = false;
    this._disposed = false;
    this._silentUnlockDone = false;
    this._resumePromise = null;
    this._autoSuspended = false;

    this._bgmTrack = null;
    this._bgmStep = 0;
    this._bgmNextTime = 0;
    this._bgmTotalSteps = 0;
    this._timer = null;
    this._fadeTimer = null;
    this._dyingBgm = null;
    this._pendingBgm = null;

    // グローバルなアンロックリスナーは init()/resume()/startBgm() で遅延登録する。
    // モジュール読み込み時に生成される予備インスタンスが AudioContext を
    // 作ってしまわないようにするため、ここでは登録しない。
  }

  get supported() {
    return !this._unsupported;
  }

  get context() {
    return this.ctx;
  }

  // -------------------------------------------------------------------------
  // 初期化 / アンロック
  // -------------------------------------------------------------------------

  /**
   * AudioContext を生成し、可能なら resume する。
   * 必ずユーザー操作 (タップ / キー入力) のイベントハンドラ内から呼ぶこと。
   * @returns {Promise<boolean>} 再生可能になったか
   */
  init() {
    this._installGlobalListeners();
    return this.resume();
  }

  /**
   * 一時停止した AudioContext を再開する。初回はコンテキストを生成する。
   * @returns {Promise<boolean>}
   */
  resume() {
    if (this._disposed) return Promise.resolve(false);
    this._installGlobalListeners();
    this._ensureContext();
    if (!this.ctx || !this._graphReady) return Promise.resolve(false);

    if (this.ctx.state === 'running') {
      this.isUnlocked = true;
      this._flushPendingBgm();
      return Promise.resolve(true);
    }

    this._playSilentUnlock();

    if (this._resumePromise) return this._resumePromise;
    const ctx = this.ctx;
    this._resumePromise = Promise.resolve()
      .then(() => ctx.resume())
      .then(() => {
        const ok = ctx.state === 'running';
        if (ok) {
          this.isUnlocked = true;
          this._flushPendingBgm();
        }
        return ok;
      })
      .catch(() => false)
      .then((ok) => {
        this._resumePromise = null;
        return ok;
      });
    return this._resumePromise;
  }

  _ensureContext() {
    if (this.ctx || this._unsupported || typeof window === 'undefined') return this.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      this._unsupported = true;
      return null;
    }
    let ctx = null;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      try {
        ctx = new Ctor();
      } catch (e2) {
        this._unsupported = true;
        return null;
      }
    }
    this.ctx = ctx;
    try {
      this._buildGraph();
    } catch (e) {
      this._graphReady = false;
    }
    return this.ctx;
  }

  _buildGraph() {
    const ctx = this.ctx;

    this._master = ctx.createGain();
    this._master.gain.value = this.isMuted ? 0 : this._vol.master;

    this._compressor = ctx.createDynamicsCompressor();
    try {
      this._compressor.threshold.value = -14;
      this._compressor.knee.value = 24;
      this._compressor.ratio.value = 6;
      this._compressor.attack.value = 0.004;
      this._compressor.release.value = 0.25;
    } catch (e) {
      /* 古い実装ではプロパティが揃っていないことがある */
    }

    this._sfxBus = ctx.createGain();
    this._sfxBus.gain.value = this._vol.sfx;

    this._bgmBus = ctx.createGain();
    this._bgmBus.gain.value = this._vol.bgm;

    this._bgmFade = ctx.createGain();
    this._bgmFade.gain.value = 1;

    this._duck = ctx.createGain();
    this._duck.gain.value = 1;

    this._sfxBus.connect(this._master);
    this._bgmBus.connect(this._bgmFade);
    this._bgmFade.connect(this._duck);
    this._duck.connect(this._master);
    this._master.connect(this._compressor);
    this._compressor.connect(ctx.destination);

    this._noiseBuffer = this._createNoiseBuffer();
    this._graphReady = true;

    ctx.onstatechange = () => {
      if (this.ctx !== ctx) return;
      if (ctx.state === 'running') {
        this.isUnlocked = true;
        this._flushPendingBgm();
      }
    };
  }

  _createNoiseBuffer() {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * 1.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let smooth = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      smooth += 0.08 * (white - smooth);
      const value = white * 0.65 + smooth * 1.4;
      data[i] = value > 1 ? 1 : value < -1 ? -1 : value;
    }
    return buffer;
  }

  /** iOS Safari のアンロック用に無音バッファを再生する。 */
  _playSilentUnlock() {
    if (!this.ctx || this._silentUnlockDone) return;
    try {
      const ctx = this.ctx;
      const buffer = ctx.createBuffer(1, 1, Math.max(8000, ctx.sampleRate));
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        try {
          source.disconnect();
        } catch (e) {
          /* noop */
        }
      };
      source.start(0);
      this._silentUnlockDone = true;
    } catch (e) {
      /* unlock 失敗時は次の操作で再試行する */
    }
  }

  _installGlobalListeners() {
    if (typeof window === 'undefined') return;
    if (!this._unlockHandler) {
      this._unlockHandler = () => {
        if (this._disposed) return;
        if (this.ctx && this.ctx.state === 'running') return;
        this.resume();
      };
      this._unlockEvents = ['pointerdown', 'keydown', 'touchstart'];
      for (const eventName of this._unlockEvents) {
        window.addEventListener(eventName, this._unlockHandler, { passive: true, capture: true });
      }
    }
    if (!this._visibilityHandler && typeof document !== 'undefined') {
      this._visibilityHandler = () => this._handleVisibility();
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }
  }

  _handleVisibility() {
    if (!this.ctx || this._disposed || typeof document === 'undefined') return;
    if (document.hidden) {
      if (this.ctx.state === 'running') {
        this._autoSuspended = true;
        this.ctx.suspend().catch(() => {});
      }
    } else if (this._autoSuspended) {
      this._autoSuspended = false;
      this.resume();
    }
  }

  // -------------------------------------------------------------------------
  // 音量 / ミュート
  // -------------------------------------------------------------------------

  _volumeKey(type) {
    const key = String(type == null ? '' : type).toLowerCase();
    if (key === 'master' || key === 'all') return 'master';
    if (key === 'bgm' || key === 'music') return 'bgm';
    if (key === 'sfx' || key === 'se' || key === 'effect' || key === 'sound') return 'sfx';
    return null;
  }

  /**
   * @param {'master'|'bgm'|'music'|'sfx'|'se'} type
   * @param {number} value 0..1
   * @returns {boolean}
   */
  setVolume(type, value) {
    const key = this._volumeKey(type);
    if (!key || typeof value !== 'number' || !Number.isFinite(value)) return false;
    const volume = clamp(value, 0, 1);
    this._vol[key] = volume;
    if (!this.ctx || !this._graphReady) return true;

    const t = this.ctx.currentTime;
    if (key === 'master') {
      if (!this.isMuted) this._rampGain(this._master, volume, t);
    } else if (key === 'bgm') {
      this._rampGain(this._bgmBus, volume, t);
    } else {
      this._rampGain(this._sfxBus, volume, t);
    }
    return true;
  }

  getVolume(type) {
    const key = this._volumeKey(type);
    return key ? this._vol[key] : null;
  }

  toggleMute() {
    return this.setMuted(!this.isMuted);
  }

  setMuted(muted) {
    this.isMuted = !!muted;
    if (this.ctx && this._master) {
      const t = this.ctx.currentTime;
      const param = this._master.gain;
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(this.isMuted ? 0 : this._vol.master, t + 0.03);
    }
    return this.isMuted;
  }

  _rampGain(node, value, t) {
    if (!node) return;
    const param = node.gain;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.setTargetAtTime(value, t, 0.03);
  }

  // -------------------------------------------------------------------------
  // 発音制御
  // -------------------------------------------------------------------------

  _ctxRunning() {
    return !!(
      this.ctx &&
      this._graphReady &&
      this.ctx.state === 'running' &&
      !this._autoSuspended &&
      !this._disposed
    );
  }

  _now() {
    return this.ctx.currentTime + 0.002;
  }

  _sfxAllowed(key, throttleMs) {
    if (!this._ctxRunning() || this.isMuted) return false;
    if (this._sfxVoices.size >= this.maxSfxVoices) return false;
    const now = nowMs();
    const last = this._lastSfxAt.get(key);
    if (last != null && now - last < throttleMs) return false;
    this._lastSfxAt.set(key, now);
    return true;
  }

  _busNode(bus) {
    return bus === 'bgm' ? this._bgmBus : this._sfxBus;
  }

  /**
   * 発音ノードを管理し、再生終了時に下流ノードも含めて切断する。
   * 切断しないと、入力の無い gain / filter がバスに接続されたまま残り、
   * 長時間プレイでノードが蓄積する。
   */
  _trackVoice(node, isBgm, extraNodes) {
    const set = isBgm ? this._bgmVoices : this._sfxVoices;
    set.add(node);
    node.onended = () => {
      set.delete(node);
      try {
        node.disconnect();
      } catch (e) {
        /* noop */
      }
      if (extraNodes) {
        for (const extra of extraNodes) {
          try {
            extra.disconnect();
          } catch (e) {
            /* noop */
          }
        }
      }
    };
  }

  _playOsc(options = {}) {
    const ctx = this.ctx;
    const bus = options.bus === 'bgm' ? 'bgm' : 'sfx';
    const busNode = this._busNode(bus);
    if (!ctx || !busNode) return null;

    const set = bus === 'bgm' ? this._bgmVoices : this._sfxVoices;
    const max = bus === 'bgm' ? this.maxBgmVoices : this.maxSfxVoices;
    if (set.size >= max) return null;

    const type = options.type || 'sine';
    const freq = Math.max(1, options.freq || 440);
    const endFreq = options.endFreq == null ? null : Math.max(1, options.endFreq);
    const dur = Math.max(0.015, options.dur == null ? 0.2 : options.dur);
    const gain = Math.max(EPS, options.gain == null ? 0.1 : options.gain);
    const attack = Math.max(0.001, options.attack == null ? 0.004 : options.attack);
    const when = Math.max(
      ctx.currentTime + 0.001,
      options.when == null ? ctx.currentTime + 0.002 : options.when
    );
    const end = when + dur;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    if (endFreq != null && endFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(endFreq, end);
    }
    if (options.detune) osc.detune.setValueAtTime(options.detune, when);

    const amp = ctx.createGain();
    const attackTime = Math.min(attack, dur * 0.5);
    amp.gain.setValueAtTime(EPS, when);
    amp.gain.exponentialRampToValueAtTime(gain, when + attackTime);
    amp.gain.exponentialRampToValueAtTime(EPS, end);

    let output = osc;
    if (options.filterType) {
      const filter = ctx.createBiquadFilter();
      filter.type = options.filterType;
      filter.Q.value = options.q == null ? 0.8 : options.q;
      filter.frequency.setValueAtTime(
        Math.max(20, options.cutoff == null ? 2400 : options.cutoff),
        when
      );
      if (options.cutoffTo != null) {
        filter.frequency.exponentialRampToValueAtTime(
          Math.max(20, options.cutoffTo),
          end
        );
      }
      osc.connect(filter);
      output = filter;
    }

    output.connect(amp);
    amp.connect(busNode);
    osc.start(when);
    osc.stop(end + 0.03);
    const extraNodes = output === osc ? [amp] : [output, amp];
    this._trackVoice(osc, bus === 'bgm', extraNodes);
    return osc;
  }

  _playNoise(options = {}) {
    const ctx = this.ctx;
    const bus = options.bus === 'bgm' ? 'bgm' : 'sfx';
    const busNode = this._busNode(bus);
    if (!ctx || !busNode || !this._noiseBuffer) return null;

    const set = bus === 'bgm' ? this._bgmVoices : this._sfxVoices;
    const max = bus === 'bgm' ? this.maxBgmVoices : this.maxSfxVoices;
    if (set.size >= max) return null;

    const dur = Math.max(0.015, options.dur == null ? 0.2 : options.dur);
    const gain = Math.max(EPS, options.gain == null ? 0.1 : options.gain);
    const attack = Math.max(0.001, options.attack == null ? 0.002 : options.attack);
    const when = Math.max(
      ctx.currentTime + 0.001,
      options.when == null ? ctx.currentTime + 0.002 : options.when
    );
    const end = when + dur;

    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    source.loop = true;
    if (options.rate && options.rate !== 1) source.playbackRate.value = options.rate;

    let output = source;
    if (options.filterType) {
      const filter = ctx.createBiquadFilter();
      filter.type = options.filterType;
      filter.Q.value = options.q == null ? 0.8 : options.q;
      filter.frequency.setValueAtTime(
        Math.max(20, options.cutoff == null ? 3000 : options.cutoff),
        when
      );
      if (options.cutoffTo != null) {
        filter.frequency.exponentialRampToValueAtTime(
          Math.max(20, options.cutoffTo),
          end
        );
      }
      source.connect(filter);
      output = filter;
    }

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(EPS, when);
    amp.gain.exponentialRampToValueAtTime(gain, when + Math.min(attack, dur * 0.5));
    amp.gain.exponentialRampToValueAtTime(EPS, end);

    output.connect(amp);
    amp.connect(busNode);
    source.start(when, Math.random() * 0.4);
    source.stop(end + 0.03);
    const extraNodes = output === source ? [amp] : [output, amp];
    this._trackVoice(source, bus === 'bgm', extraNodes);
    return source;
  }

  /** 爆発などで BGM を一瞬下げる (サイドチェイン風)。 */
  _duckBgm(level, duration) {
    if (!this.ctx || !this._graphReady || !this._duck) return;
    const t = this.ctx.currentTime;
    const target = clamp(level, 0.05, 1);
    const param = this._duck.gain;
    const release = Math.max(0.1, duration);
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(target, t + 0.05);
    param.setValueAtTime(target, t + release * 0.55);
    param.linearRampToValueAtTime(1, t + release);
  }

  // -------------------------------------------------------------------------
  // 効果音 (SE)
  // -------------------------------------------------------------------------

  /** 自機ショット: 軽快な高音パルス。 */
  playShoot() {
    if (!this._sfxAllowed('shoot', 42)) return false;
    const t = this._now();
    this._playOsc({
      type: 'square',
      freq: 1500,
      endFreq: 540,
      when: t,
      dur: 0.075,
      gain: 0.05,
      attack: 0.001,
      filterType: 'lowpass',
      cutoff: 5200,
      cutoffTo: 1800,
      q: 0.8,
    });
    this._playOsc({
      type: 'triangle',
      freq: 2400,
      endFreq: 1200,
      when: t,
      dur: 0.045,
      gain: 0.028,
      attack: 0.001,
    });
    return true;
  }

  /** 敵命中: 短いクリック / 打撃音。 */
  playHit() {
    if (!this._sfxAllowed('hit', 26)) return false;
    const t = this._now();
    this._playNoise({
      when: t,
      dur: 0.045,
      gain: 0.1,
      filterType: 'bandpass',
      cutoff: 2800,
      cutoffTo: 1200,
      q: 1.2,
      rate: 1.2,
    });
    this._playOsc({
      type: 'square',
      freq: 340,
      endFreq: 150,
      when: t,
      dur: 0.045,
      gain: 0.055,
      attack: 0.001,
      filterType: 'lowpass',
      cutoff: 3000,
    });
    return true;
  }

  /**
   * 爆発: フィルタ付きノイズ + 周波数スイープ。
   * @param {boolean} isLarge
   */
  playExplosion(isLarge = false) {
    const large = !!isLarge;
    if (!this._sfxAllowed(large ? 'explosion-large' : 'explosion-small', large ? 110 : 55)) {
      return false;
    }
    const t = this._now();
    if (large) {
      this._playNoise({
        when: t,
        dur: 0.95,
        gain: 0.34,
        filterType: 'lowpass',
        cutoff: 3200,
        cutoffTo: 70,
        q: 1.0,
        rate: 0.8,
      });
      this._playOsc({
        type: 'sine',
        freq: 120,
        endFreq: 26,
        when: t,
        dur: 0.65,
        gain: 0.26,
        attack: 0.004,
      });
      this._playNoise({
        when: t,
        dur: 0.16,
        gain: 0.14,
        filterType: 'highpass',
        cutoff: 900,
        cutoffTo: 300,
        q: 0.7,
      });
    } else {
      this._playNoise({
        when: t,
        dur: 0.36,
        gain: 0.24,
        filterType: 'lowpass',
        cutoff: 2400,
        cutoffTo: 180,
        q: 0.9,
        rate: 1.1,
      });
      this._playOsc({
        type: 'triangle',
        freq: 190,
        endFreq: 50,
        when: t,
        dur: 0.25,
        gain: 0.1,
        attack: 0.003,
      });
    }
    return true;
  }

  /** グレイズ: キラキラした高音クリスタルチャイム。 */
  playGraze() {
    if (!this._sfxAllowed('graze', 30)) return false;
    const t = this._now();
    this._playOsc({
      type: 'triangle',
      freq: 2093,
      when: t,
      dur: 0.1,
      gain: 0.035,
      attack: 0.001,
    });
    this._playOsc({
      type: 'sine',
      freq: 3136,
      when: t + 0.015,
      dur: 0.16,
      gain: 0.024,
      attack: 0.001,
    });
    this._playOsc({
      type: 'sine',
      freq: 4186,
      when: t + 0.03,
      dur: 0.09,
      gain: 0.012,
      attack: 0.001,
    });
    return true;
  }

  /** アイテム取得: 上昇 2 音アルペジオ。 */
  playItem() {
    if (!this._sfxAllowed('item', 45)) return false;
    const t = this._now();
    this._playOsc({
      type: 'triangle',
      freq: mtof(84),
      when: t,
      dur: 0.12,
      gain: 0.06,
      attack: 0.002,
    });
    this._playOsc({
      type: 'triangle',
      freq: mtof(91),
      when: t + 0.075,
      dur: 0.24,
      gain: 0.07,
      attack: 0.002,
    });
    this._playOsc({
      type: 'sine',
      freq: mtof(96),
      when: t + 0.075,
      dur: 0.2,
      gain: 0.02,
      attack: 0.002,
    });
    return true;
  }

  /** ボム発動: 大轟音 + 周波数スイープ爆発。 */
  playBomb() {
    if (!this._sfxAllowed('bomb', 260)) return false;
    const t = this._now();
    this._duckBgm(0.25, 1.5);
    this._playNoise({
      when: t,
      dur: 1.45,
      gain: 0.36,
      filterType: 'lowpass',
      cutoff: 6500,
      cutoffTo: 55,
      q: 1.1,
      rate: 0.75,
    });
    this._playOsc({
      type: 'sawtooth',
      freq: 320,
      endFreq: 32,
      when: t,
      dur: 1.1,
      gain: 0.14,
      attack: 0.004,
      filterType: 'lowpass',
      cutoff: 1800,
      cutoffTo: 260,
      q: 4,
    });
    this._playOsc({
      type: 'sine',
      freq: 130,
      endFreq: 24,
      when: t,
      dur: 1.0,
      gain: 0.3,
      attack: 0.006,
    });
    this._playNoise({
      when: t,
      dur: 0.2,
      gain: 0.2,
      filterType: 'bandpass',
      cutoff: 1500,
      cutoffTo: 300,
      q: 0.8,
    });
    this._playOsc({
      type: 'square',
      freq: 95,
      endFreq: 30,
      when: t,
      dur: 0.3,
      gain: 0.08,
      attack: 0.002,
      filterType: 'lowpass',
      cutoff: 900,
    });
    return true;
  }

  /** 被弾撃破: クラシック STG 風の下降音。 */
  playPlayerDeath() {
    if (!this._sfxAllowed('death', 400)) return false;
    const t = this._now();
    this._playOsc({
      type: 'sawtooth',
      freq: 880,
      endFreq: 80,
      when: t,
      dur: 0.95,
      gain: 0.12,
      attack: 0.004,
      filterType: 'lowpass',
      cutoff: 3200,
      cutoffTo: 180,
      q: 2,
    });
    this._playOsc({
      type: 'square',
      freq: 440,
      endFreq: 55,
      when: t + 0.04,
      dur: 1.0,
      gain: 0.05,
      attack: 0.004,
      filterType: 'lowpass',
      cutoff: 1800,
      cutoffTo: 120,
    });
    this._playNoise({
      when: t,
      dur: 0.35,
      gain: 0.09,
      filterType: 'bandpass',
      cutoff: 2200,
      cutoffTo: 250,
      q: 0.7,
      rate: 0.9,
    });
    return true;
  }

  /** ボス出現警告: 周期的な警告ビープ。 */
  playWarning() {
    if (!this._ctxRunning() || this.isMuted) return false;
    const now = nowMs();
    if (now - this._lastWarningAt < 1800) return false;
    this._lastWarningAt = now;

    const t = this._now();
    for (let i = 0; i < 4; i += 1) {
      const when = t + i * 0.34;
      this._playOsc({
        type: 'square',
        freq: 1046.5,
        when,
        dur: 0.09,
        gain: 0.085,
        attack: 0.003,
        filterType: 'lowpass',
        cutoff: 3600,
        q: 0.8,
      });
      this._playOsc({
        type: 'square',
        freq: 784,
        when: when + 0.1,
        dur: 0.12,
        gain: 0.075,
        attack: 0.003,
        filterType: 'lowpass',
        cutoff: 2800,
        q: 0.8,
      });
    }
    return true;
  }

  /** ボス撃破 / クリアファンファーレ。 */
  playBossDefeat() {
    if (!this._ctxRunning() || this.isMuted) return false;
    const now = nowMs();
    if (now - this._lastDefeatAt < 900) return false;
    this._lastDefeatAt = now;

    const t = this._now();
    this._duckBgm(0.35, 2.2);

    const melody = [
      [0.0, 72, 0.14],
      [0.14, 76, 0.14],
      [0.28, 79, 0.14],
      [0.42, 84, 0.34],
      [0.82, 79, 0.12],
      [0.95, 81, 0.12],
      [1.08, 84, 0.6],
    ];
    for (const [offset, midi, dur] of melody) {
      this._playOsc({
        type: 'triangle',
        freq: mtof(midi),
        when: t + offset,
        dur,
        gain: 0.07,
        attack: 0.006,
        filterType: 'lowpass',
        cutoff: 6000,
        q: 0.6,
      });
    }

    this._playOsc({
      type: 'sawtooth',
      freq: mtof(36),
      when: t,
      dur: 0.4,
      gain: 0.08,
      attack: 0.01,
      filterType: 'lowpass',
      cutoff: 700,
    });
    this._playOsc({
      type: 'sawtooth',
      freq: mtof(43),
      when: t + 0.42,
      dur: 0.38,
      gain: 0.08,
      attack: 0.01,
      filterType: 'lowpass',
      cutoff: 700,
    });
    this._playOsc({
      type: 'sawtooth',
      freq: mtof(36),
      when: t + 1.08,
      dur: 0.85,
      gain: 0.09,
      attack: 0.01,
      filterType: 'lowpass',
      cutoff: 800,
    });

    for (const midi of [72, 76, 79, 84]) {
      this._playOsc({
        type: 'triangle',
        freq: mtof(midi),
        when: t + 1.08,
        dur: 0.9,
        gain: 0.026,
        attack: 0.012,
        filterType: 'lowpass',
        cutoff: 5000,
      });
    }

    this._playNoise({
      when: t + 0.42,
      dur: 0.5,
      gain: 0.05,
      filterType: 'highpass',
      cutoff: 4500,
      cutoffTo: 7000,
      q: 0.5,
    });
    this._playNoise({
      when: t + 1.08,
      dur: 0.7,
      gain: 0.06,
      filterType: 'highpass',
      cutoff: 3800,
      cutoffTo: 6500,
      q: 0.5,
    });
    return true;
  }

  /** 敵弾の発射音。プレイヤー音より低く小さめ。 */
  playEnemyShot() {
    if (!this._sfxAllowed('enemy-shot', 70)) return false;
    const t = this._now();
    this._playOsc({
      type: 'square',
      freq: 760,
      endFreq: 380,
      when: t,
      dur: 0.06,
      gain: 0.028,
      attack: 0.001,
      filterType: 'lowpass',
      cutoff: 2600,
      cutoffTo: 1200,
      q: 0.8,
    });
    return true;
  }

  /** レーザー系の効果音。 */
  playLaser() {
    if (!this._sfxAllowed('laser', 150)) return false;
    const t = this._now();
    this._playOsc({
      type: 'sawtooth',
      freq: 1600,
      endFreq: 260,
      when: t,
      dur: 0.18,
      gain: 0.038,
      attack: 0.002,
      filterType: 'lowpass',
      cutoff: 3200,
      cutoffTo: 700,
      q: 3,
    });
    this._playOsc({
      type: 'square',
      freq: 900,
      endFreq: 180,
      when: t,
      dur: 0.15,
      gain: 0.018,
      attack: 0.002,
    });
    return true;
  }

  /**
   * 名前ベースの効果音ディスパッチ。
   * enemy.js / player.js の汎用アダプタ (playSE / play) から呼ばれる。
   * @param {string} name
   * @returns {boolean}
   */
  playSE(name) {
    const key = String(name == null ? '' : name).toLowerCase();
    switch (key) {
      case 'shot':
      case 'shoot':
      case 'player_shot':
        return this.playShoot();
      case 'enemy_shot':
      case 'enemyshot':
        return this.playEnemyShot();
      case 'hit':
      case 'enemy_hit':
      case 'boss_hit':
        return this.playHit();
      case 'graze':
        return this.playGraze();
      case 'item':
        return this.playItem();
      case 'bomb':
      case 'player_bomb':
        return this.playBomb();
      case 'death':
      case 'player_death':
      case 'player_hit':
        return this.playPlayerDeath();
      case 'warning':
      case 'boss_phase':
      case 'alert':
        return this.playWarning();
      case 'boss_die':
      case 'boss_defeat':
      case 'clear':
        return this.playBossDefeat() || this.playExplosion(true);
      case 'enemy_die':
      case 'explosion':
      case 'explosion_small':
        return this.playExplosion(false);
      case 'explosion_large':
      case 'big_explosion':
        return this.playExplosion(true);
      case 'laser':
        return this.playLaser();
      default:
        return false;
    }
  }

  /** playSE のエイリアス。 */
  play(name) {
    return this.playSE(name);
  }

  /** playSE のエイリアス。 */
  playSound(name) {
    return this.playSE(name);
  }

  // -------------------------------------------------------------------------
  // BGM
  // -------------------------------------------------------------------------

  _normalizeTrack(trackName) {
    const key = String(trackName == null ? '' : trackName).toLowerCase();
    if (key === 'stage' || key === 'stage1' || key === 'game' || key === 'battle') {
      return 'stage';
    }
    if (key === 'boss' || key === 'boss1' || key === 'bossfight') return 'boss';
    return TRACKS[key] ? key : null;
  }

  /**
   * @param {'stage'|'boss'} trackName
   * @returns {boolean} 再生開始を受け付けたか
   */
  startBgm(trackName = 'stage') {
    const name = this._normalizeTrack(trackName);
    if (!name) return false;

    this.bgmTrack = name;
    this.bgmPaused = false;

    if (!this._ctxRunning()) {
      this._installGlobalListeners();
      this._pendingBgm = { action: 'start', name };
      if (this.ctx) this.resume();
      return true;
    }

    this._pendingBgm = null;
    return this._startBgmScheduler(name, false);
  }

  /** BGM を停止し、次回は先頭から再生する。 */
  stopBgm() {
    const wasActive = this.bgmPlaying || this.bgmPaused || !!this._pendingBgm;
    this._pendingBgm = null;
    this._stopBgmTimer();
    this._fadeOutBgm(0.05);
    this.bgmPlaying = false;
    this.bgmPaused = false;
    this.bgmTrack = null;
    this._bgmStep = 0;
    return wasActive;
  }

  /** BGM を一時停止する (次回 resumeBgm で続きから)。 */
  pauseBgm() {
    if (!this.bgmPlaying) {
      if (this._pendingBgm && this._pendingBgm.action === 'start') {
        this._pendingBgm = null;
        this.bgmTrack = null;
        this.bgmPaused = false;
        return false;
      }
      return false;
    }
    this._stopBgmTimer();
    this._fadeOutBgm(0.04);
    this.bgmPlaying = false;
    this.bgmPaused = true;
    return true;
  }

  /** 一時停止した BGM を再開する。 */
  resumeBgm() {
    if (!this.bgmTrack) return false;
    if (this.bgmPlaying) return true;
    if (!this.bgmPaused) return false;

    if (!this._ctxRunning()) {
      this._pendingBgm = { action: 'resume', name: this.bgmTrack };
      if (this.ctx) this.resume();
      return true;
    }
    return this._startBgmScheduler(this.bgmTrack, true);
  }

  _startBgmScheduler(name, preserveStep) {
    const track = TRACKS[name];
    if (!track || !this._ctxRunning()) return false;

    this._stopBgmTimer();
    this._resetBgmAudio();

    this._bgmTrack = name;
    this.bgmTrack = name;
    this._bgmTotalSteps = track.chords.length * 16;
    if (!preserveStep) this._bgmStep = 0;
    this._bgmNextTime = this.ctx.currentTime + 0.08;
    this.bgmPlaying = true;
    this.bgmPaused = false;

    this._timer = setInterval(() => this._bgmTick(), 25);
    this._bgmTick();
    return true;
  }

  _stopBgmTimer() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** BGM バスを所定の音量に戻し、停止待ちの声を止める。 */
  _resetBgmAudio() {
    this._cancelBgmFade();
    for (const source of this._bgmVoices) {
      try {
        source.stop();
      } catch (e) {
        /* noop */
      }
    }
    this._bgmVoices.clear();
    if (this._bgmFade && this.ctx) {
      const t = this.ctx.currentTime;
      const param = this._bgmFade.gain;
      param.cancelScheduledValues(t);
      param.setValueAtTime(1, t);
    }
  }

  _cancelBgmFade() {
    if (this._fadeTimer !== null) {
      clearTimeout(this._fadeTimer);
      this._fadeTimer = null;
    }
    if (this._dyingBgm) {
      for (const source of this._dyingBgm) {
        try {
          source.stop();
        } catch (e) {
          /* noop */
        }
      }
      this._dyingBgm = null;
    }
  }

  _fadeOutBgm(fade) {
    if (!this.ctx || !this._bgmFade) return;
    this._cancelBgmFade();
    const t = this.ctx.currentTime;
    const param = this._bgmFade.gain;
    param.cancelScheduledValues(t);
    param.setValueAtTime(Math.max(EPS, param.value), t);
    param.linearRampToValueAtTime(EPS, t + fade);

    const voices = Array.from(this._bgmVoices);
    this._bgmVoices.clear();
    this._dyingBgm = voices;
    this._fadeTimer = setTimeout(() => {
      this._fadeTimer = null;
      for (const source of voices) {
        try {
          source.stop();
        } catch (e) {
          /* noop */
        }
      }
      if (this._dyingBgm === voices) this._dyingBgm = null;
    }, fade * 1000 + 60);
  }

  _bgmTick() {
    if (!this.bgmPlaying || !this._bgmTrack || !this._ctxRunning()) return;
    const track = TRACKS[this._bgmTrack];
    if (!track) return;

    const now = this.ctx.currentTime;
    const horizon = now + 0.16;
    if (this._bgmNextTime < now) this._bgmNextTime = now + 0.02;

    let guard = 0;
    while (this._bgmNextTime < horizon && guard < 32) {
      this._scheduleStep(this._bgmStep, this._bgmNextTime);
      this._bgmNextTime += 60 / track.bpm / 4;
      this._bgmStep = (this._bgmStep + 1) % this._bgmTotalSteps;
      guard += 1;
    }
  }

  _scheduleStep(step, time) {
    const track = TRACKS[this._bgmTrack];
    if (!track) return;

    const stepDur = 60 / track.bpm / 4;
    const bar = Math.floor(step / 16) % track.chords.length;
    const tick = step % 16;
    const chord = track.chords[bar];
    const gates = track.gates || {};
    const gains = track.gains;
    const t = Math.max(time, this.ctx.currentTime + 0.005);

    if (track.kick.includes(tick)) this._bgmKick(t, gains.kick);
    if (track.snare.includes(tick)) this._bgmSnare(t, gains.snare);
    if (track.hat.includes(tick)) this._bgmHat(t, gains.hat, false);
    if (track.openHat.includes(tick)) this._bgmHat(t, gains.openHat, true);

    const bassOffset = track.bass[tick];
    if (bassOffset != null) {
      const bassGate = gates.bass == null ? 1.4 : gates.bass;
      this._bgmNote({
        t,
        midi: chord.root + bassOffset,
        dur: stepDur * bassGate,
        gain: gains.bass,
        type: track.bassWave,
        cutoff: 900,
        cutoffTo: 220,
        q: 5,
      });
    }

    const arpIndex = track.arp[tick];
    if (arpIndex != null && arpIndex >= 0) {
      const tones = CHORD_TONES[chord.type] || CHORD_TONES.min;
      const note = chord.root + track.arpOctave + tones[arpIndex % tones.length];
      const arpGate = gates.arp == null ? 1.1 : gates.arp;
      this._bgmNote({
        t,
        midi: note,
        dur: stepDur * arpGate,
        gain: gains.arp,
        type: track.arpWave,
        cutoff: track.arpWave === 'sawtooth' ? 2200 : 4500,
        cutoffTo: 1200,
        q: 2,
      });
    }

    const leadEvents = track.lead && track.lead[bar];
    if (leadEvents) {
      const leadGate = gates.lead == null ? 0.95 : gates.lead;
      for (const event of leadEvents) {
        if (event[0] === tick) {
          this._bgmNote({
            t,
            midi: event[1],
            dur: event[2] * stepDur * leadGate,
            gain: gains.lead,
            type: track.leadWave,
            cutoff: 2800,
            cutoffTo: 1400,
            q: 1,
          });
        }
      }
    }

    if (tick === 0) {
      const barDur = stepDur * 16 * 0.98;
      const tones = CHORD_TONES[chord.type] || CHORD_TONES.min;
      if (track.pad) {
        this._bgmPad(
          t,
          [
            chord.root + 12,
            chord.root + 12 + tones[1],
            chord.root + 12 + tones[2],
            chord.root + 24,
          ],
          barDur,
          gains.pad,
          'triangle'
        );
      }
      if (track.drone) {
        this._bgmPad(t, [chord.root, chord.root + 12], barDur, gains.drone, 'sawtooth');
      }
    }
  }

  _bgmKick(t, gain) {
    this._playOsc({
      type: 'sine',
      freq: 155,
      endFreq: 44,
      when: t,
      dur: 0.23,
      gain,
      attack: 0.003,
      bus: 'bgm',
    });
  }

  _bgmSnare(t, gain) {
    this._playNoise({
      when: t,
      dur: 0.15,
      gain,
      filterType: 'bandpass',
      cutoff: 1900,
      cutoffTo: 900,
      q: 0.7,
      bus: 'bgm',
    });
    this._playOsc({
      type: 'triangle',
      freq: 210,
      endFreq: 130,
      when: t,
      dur: 0.08,
      gain: gain * 0.45,
      attack: 0.001,
      bus: 'bgm',
    });
  }

  _bgmHat(t, gain, open) {
    this._playNoise({
      when: t,
      dur: open ? 0.14 : 0.035,
      gain,
      filterType: 'highpass',
      cutoff: 7600,
      cutoffTo: 6500,
      q: 0.7,
      bus: 'bgm',
    });
  }

  _bgmNote({ t, midi, dur, gain, type, cutoff, cutoffTo, q }) {
    this._playOsc({
      type,
      freq: mtof(midi),
      when: t,
      dur,
      gain,
      attack: 0.004,
      filterType: 'lowpass',
      cutoff,
      cutoffTo,
      q,
      bus: 'bgm',
    });
  }

  _bgmPad(t, midis, dur, gain, type) {
    if (!this.ctx || !this._bgmBus) return;
    if (this._bgmVoices.size + midis.length > this.maxBgmVoices) return;

    const ctx = this.ctx;
    const attack = Math.min(0.35, dur * 0.25);
    for (const midi of midis) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(mtof(midi), t);
      osc.detune.setValueAtTime(Math.random() * 8 - 4, t);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.6;
      filter.frequency.setValueAtTime(type === 'sawtooth' ? 620 : 2000, t);

      const amp = ctx.createGain();
      amp.gain.setValueAtTime(EPS, t);
      amp.gain.linearRampToValueAtTime(gain, t + attack);
      amp.gain.setValueAtTime(gain, t + dur * 0.75);
      amp.gain.linearRampToValueAtTime(EPS, t + dur);

      osc.connect(filter);
      filter.connect(amp);
      amp.connect(this._bgmBus);
      osc.start(t);
      osc.stop(t + dur + 0.03);
      this._trackVoice(osc, true, [filter, amp]);
    }
  }

  _flushPendingBgm() {
    if (!this._pendingBgm || !this._ctxRunning()) return;
    const pending = this._pendingBgm;
    this._pendingBgm = null;
    if (pending.action === 'start') {
      this._startBgmScheduler(pending.name, false);
    } else if (pending.action === 'resume' && this.bgmPaused) {
      this._startBgmScheduler(pending.name, true);
    }
  }

  // -------------------------------------------------------------------------
  // 後始末
  // -------------------------------------------------------------------------

  /** タイマーと AudioContext を解放する。以降このインスタンスは使わない。 */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._pendingBgm = null;
    this._stopBgmTimer();
    this._cancelBgmFade();

    for (const source of this._bgmVoices) {
      try {
        source.stop();
      } catch (e) {
        /* noop */
      }
    }
    for (const source of this._sfxVoices) {
      try {
        source.stop();
      } catch (e) {
        /* noop */
      }
    }
    this._bgmVoices.clear();
    this._sfxVoices.clear();

    if (typeof window !== 'undefined' && this._unlockHandler) {
      for (const eventName of this._unlockEvents) {
        window.removeEventListener(eventName, this._unlockHandler, true);
      }
      this._unlockHandler = null;
    }
    if (typeof document !== 'undefined' && this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    if (this.ctx) {
      try {
        this.ctx.close();
      } catch (e) {
        /* noop */
      }
    }
    this.ctx = null;
    this._graphReady = false;
    this.bgmPlaying = false;
    this.bgmPaused = false;
    this.bgmTrack = null;
    this.isUnlocked = false;
  }
}

export const audio = new AudioManager();

export default audio;
