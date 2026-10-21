/**
 * 能量门限的语音切分（VAD）：把连续的采集帧切成一块块「有人在说」的音频。
 *
 * 纯逻辑，不碰声卡：判据全是可调参数，这样测试可以直接喂帧。
 *
 * 这一层的形状由采集端决定：WASAPI 环回只在有声音时送包（全静音的包在
 * 原生侧就被丢掉了），所以「说完了吗」不能只数静音帧——必须在墙上时钟上
 * 有 `tick()`：一段时间没有新帧同样算静音。
 *
 * 状态机：
 * - 闲置：留一小段 preRoll（门限之前的那几帧）；连续超过门限累计到
 *   `minSpeechMs` 才算开口。
 * - 说中：攒帧；静音（低于门限的帧，或没有帧）到 `silenceMs` 收尾；
 *   攒满 `maxUtteranceMs` 强切，然后接着收下一段。
 * - 短于 `minUtteranceMs` 的片段丢掉。
 */

/** 一帧的 RMS 电平（dBFS）；全零帧记 -100 而不是 -Infinity。 */
export function rmsDb(frame) {
  if (!frame || frame.length === 0) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frame.length);
  return rms <= 1e-5 ? -100 : Math.max(-100, 20 * Math.log10(rms));
}

/** 帧的峰值电平（dBFS）。 */
export function peakDb(frame) {
  if (!frame || frame.length === 0) return -100;
  let peak = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = Math.abs(frame[i]);
    if (v > peak) peak = v;
  }
  return peak <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peak / 32768));
}

function concat(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/**
 * @typedef {object} Utterance
 * @property {Int16Array} pcm 单声道 PCM16
 * @property {number} startAt 第一帧的墙上时钟时间戳（毫秒，与 push 的 atMs 同基准）
 * @property {number} durationMs 实际音频时长（毫秒）
 * @property {boolean} forced 因为说得太长被强切，而不是自然收尾
 * @property {number} peakDb 这一块的峰值电平
 */

/**
 * @typedef {object} SegmentConfig
 * @property {number} thresholdDb 「有人在说」的电平门限（dBFS）
 * @property {number} minSpeechMs 连续超过门限多久才算开口
 * @property {number} silenceMs 静音多久算一块说完
 * @property {number} maxUtteranceMs 一块最长多久，到点强切
 * @property {number} preRollMs 开口之前再多带多久
 * @property {number} minUtteranceMs 短于这个的片段丢掉
 */

export class Segmenter {
  /** @param {SegmentConfig} cfg @param {number} frameMs 帧长（毫秒） */
  constructor(cfg, frameMs) {
    this.cfg = cfg;
    this.frameMs = frameMs;
    this.preRoll = [];
    this.collected = [];
    this.speaking = false;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.startAt = 0;
    this.lastFrameAt = -1;
    this.lastDb = -100;
    /** 太短被丢掉的片段数（给控制台看）。 */
    this.dropped = 0;
  }

  /** 热改参数：不打断正在收的这一块。 */
  configure(cfg) {
    this.cfg = cfg;
  }

  /** 最近一帧的电平（dBFS）；控制台的电平条读它。 */
  get level() {
    return this.lastDb;
  }

  /** 此刻是否正在收一块。 */
  get active() {
    return this.speaking;
  }

  /** 手上这块攒了多久的音频（毫秒）。 */
  get heldMs() {
    return this.collected.length * this.frameMs;
  }

  /**
   * 喂一帧，拿回这一帧结束时切出来的完整语音块（通常是空的）。
   * @param {Int16Array} frame
   * @param {number} atMs 这一帧到达的墙上时钟（毫秒，任意基准）
   * @returns {Utterance[]}
   */
  push(frame, atMs) {
    const db = rmsDb(frame);
    this.lastDb = db;
    const loud = db >= this.cfg.thresholdDb;
    const out = [];

    // 久违的帧（安静期没有包送来）：把上辈子的计数清掉。
    if (this.lastFrameAt >= 0 && atMs - this.lastFrameAt > this.cfg.silenceMs) {
      this.aboveMs = 0;
    }
    this.lastFrameAt = atMs;

    if (!this.speaking) {
      this.preRoll.push(frame);
      const keep = Math.max(1, Math.ceil(this.cfg.preRollMs / this.frameMs));
      while (this.preRoll.length > keep) this.preRoll.shift();
      this.aboveMs = loud ? this.aboveMs + this.frameMs : 0;
      if (this.aboveMs >= this.cfg.minSpeechMs) {
        // 开口：preRoll + 刚才攒的都算进来。
        this.speaking = true;
        this.belowMs = 0;
        this.collected = [...this.preRoll];
        this.preRoll = [];
        this.startAt = atMs - (this.collected.length - 1) * this.frameMs;
      }
      return out;
    }

    this.collected.push(frame);
    this.belowMs = loud ? 0 : this.belowMs + this.frameMs;

    if (this.belowMs >= this.cfg.silenceMs) {
      const done = this.finish(false);
      if (done) out.push(done);
    } else if (this.heldMs >= this.cfg.maxUtteranceMs) {
      const done = this.finish(true);
      if (done) out.push(done);
      // 强切之后照旧在「说中」：下一段从这里接着收。
      this.speaking = true;
      this.collected = [];
      this.belowMs = 0;
      this.startAt = atMs + this.frameMs;
    }
    return out;
  }

  /**
   * 墙上时钟的静音检查：没有新帧也算静音。
   * @param {number} nowMs
   * @returns {Utterance[]}
   */
  tick(nowMs) {
    const out = [];
    if (this.speaking && this.lastFrameAt >= 0 && nowMs - this.lastFrameAt >= this.cfg.silenceMs) {
      const done = this.finish(false);
      if (done) out.push(done);
    } else if (!this.speaking && this.aboveMs > 0 && this.lastFrameAt >= 0 && nowMs - this.lastFrameAt > this.cfg.silenceMs) {
      // 起说判定中途没了下文（咳嗽被掐断）：清掉，别攒到下辈子。
      this.aboveMs = 0;
    }
    return out;
  }

  /** 停止采集时把手上这块交出来（够长的话）。 */
  flush() {
    const done = this.speaking ? this.finish(false) : null;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.preRoll = [];
    return done;
  }

  /** 交出手上这块。太短返回 null（音频丢掉，计进 dropped）。 */
  finish(forced) {
    const frames = this.collected;
    this.collected = [];
    this.speaking = false;
    this.aboveMs = 0;
    const durationMs = frames.length * this.frameMs;
    if (durationMs < this.cfg.minUtteranceMs) {
      this.dropped += 1;
      return null;
    }
    return {
      pcm: concat(frames),
      startAt: this.startAt,
      durationMs,
      forced,
      peakDb: this.peakOf(frames),
    };
  }

  /** 一组帧的峰值（dBFS）。 */
  peakOf(frames) {
    let peak = -100;
    for (const frame of frames) {
      const db = peakDb(frame);
      if (db > peak) peak = db;
    }
    return peak;
  }
}
