/**
 * FireRedVAD 流式切分器（可选）：小红书开源的 DFSMN VAD，16k、10ms 一帧，
 * 输入是 80 维 kaldi fbank（CMVN 后），模型约 2.3MB，Apache-2.0。
 *
 * 与 Sherpa 的两套 VAD 不同，这里直接跑 ONNX：`onnxruntime-node` 是可选的运行时，
 * 前端（fbank + CMVN）在本包 `fbank.js` 里，后处理照官方 StreamVadPostprocessor 移植。
 *
 * 推理是异步的（onnxruntime-node 只有 async run），所以切分器用回调交付：
 * `push()` 只入队，结果通过 `onUtterance` 出来；`tick()`/`flush()` 也排在同一个队列里，
 * 保证顺序。World 对异步切分器走回调路径。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { KaldiFbank, applyCmvn, cmvnFromMatrix, parseCmvnMatrix } from './fbank.js';
import { peakDb, rmsDb } from './vad.js';

const require = createRequire(import.meta.url);

const FRAME_SHIFT = 160; // 10ms @ 16k
const FRAME_MS = 10;
const CACHE_SHAPE = [8, 1, 128, 19];
const CACHE_SIZE = CACHE_SHAPE.reduce((a, b) => a * b, 1);

/** 官方仓库里的流式模型（带 cache 的反向输入/输出）。 */
export const FIRERED_MODEL_URL = 'https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/fireredvad_stream_vad_with_cache.onnx';
export const FIRERED_CMVN_URL = 'https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/cmvn.ark';
export const FIRERED_MODEL_FILE = 'fireredvad_stream_vad_with_cache.onnx';
export const FIRERED_CMVN_FILE = 'cmvn.ark';
export const FIRERED_MODEL_MIN_BYTES = 1_000_000;
export const FIRERED_CMVN_MIN_BYTES = 500;

/** 加载 ONNX 运行时；失败时讲清楚可选依赖与重启。 */
export function loadOnnxRuntime() {
  try {
    return require('onnxruntime-node');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`载入 onnxruntime-node 失败：${detail}。FireRed 切分需要它；请在扩展目录里安装依赖（pnpm install）后重启应用，或改用 silero / energy。`);
  }
}

/** 缓存目录：`<dataDir>/listen/firered/`。 */
export function cacheDir(dataDir) {
  return join(dataDir ?? '.', 'listen', 'firered');
}

/**
 * 同步看模型在不在。配置路径按 onnx 文件解，cmvn.ark 必须与它同目录。
 * @returns {{kind: 'firered', path: string, cmvnPath: string, source: string, exists: boolean, sizeBytes: number}}
 */
export function fireRedModelState({ cfgPath, dataDir, packageDir, botDir } = {}) {
  const cfg = typeof cfgPath === 'string' && cfgPath.trim()
    ? (isAbsolute(cfgPath.trim()) ? cfgPath.trim() : resolve(botDir ?? '.', cfgPath.trim()))
    : '';
  const check = (dir, source) => {
    const onnx = join(dir, FIRERED_MODEL_FILE);
    const cmvn = join(dir, FIRERED_CMVN_FILE);
    try {
      const o = statSync(onnx);
      const c = statSync(cmvn);
      if (o.isFile() && c.isFile() && o.size >= FIRERED_MODEL_MIN_BYTES && c.size >= FIRERED_CMVN_MIN_BYTES) {
        return { kind: 'firered', path: onnx, cmvnPath: cmvn, source, exists: true, sizeBytes: o.size + c.size };
      }
    } catch {
      /* 缺文件 */
    }
    return null;
  };
  if (cfg) {
    const onnx = cfg.toLowerCase().endsWith('.onnx') ? cfg : join(cfg, FIRERED_MODEL_FILE);
    const cmvn = join(dirname(onnx), FIRERED_CMVN_FILE);
    try {
      const o = statSync(onnx);
      const c = statSync(cmvn);
      if (o.isFile() && c.isFile()) return { kind: 'firered', path: onnx, cmvnPath: cmvn, source: 'config', exists: true, sizeBytes: o.size + c.size };
    } catch {
      /* 不在就不在 */
    }
    return { kind: 'firered', path: onnx, cmvnPath: cmvn, source: 'config-missing', exists: false, sizeBytes: 0 };
  }
  return check(cacheDir(dataDir), 'cache')
    ?? (packageDir ? check(join(packageDir, 'assets', 'firered'), 'package') : null)
    ?? { kind: 'firered', path: join(cacheDir(dataDir), FIRERED_MODEL_FILE), cmvnPath: join(cacheDir(dataDir), FIRERED_CMVN_FILE), source: 'cache-missing', exists: false, sizeBytes: 0 };
}

export function writeAtomic(target, bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
}

export async function downloadFile(url, { fetchImpl, timeoutMs, minBytes, label }) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  let res;
  try {
    res = await doFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`下载 ${label} 失败（${detail}）：${url}`);
  }
  if (!res || !res.ok) throw new Error(`下载 ${label} 失败：HTTP ${res?.status ?? '?'}（${url}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) throw new Error(`下载到的 ${label} 只有 ${buf.length} 字节，不像真文件（${url}）`);
  return buf;
}

/**
 * 确保两个模型文件都在：配置目录 → 缓存 → 包内资产 → 下载。
 * @returns {Promise<{path: string, cmvnPath: string, source: string, exists: true, sizeBytes: number}>}
 */
export async function ensureFireRedModel({
  cfgPath,
  dataDir,
  packageDir,
  botDir,
  fetchImpl,
  timeoutMs = 180000,
  log,
} = {}) {
  const state = fireRedModelState({ cfgPath, dataDir, packageDir, botDir });
  if (state.exists) return state;
  if (state.source === 'config-missing') {
    throw new Error(`worlds.listen.fireredModel 指的模型不在：${state.path}（同目录下还需要 ${FIRERED_CMVN_FILE}）。改配置、清掉它，或在控制台「来源」页选一下 firered 重新准备。`);
  }
  const dir = cacheDir(dataDir);
  log?.info?.('听觉：开始下载 FireRed 模型', { dir });
  const onnx = await downloadFile(FIRERED_MODEL_URL, { fetchImpl, timeoutMs, minBytes: FIRERED_MODEL_MIN_BYTES, label: 'FireRed 模型' });
  const cmvn = await downloadFile(FIRERED_CMVN_URL, { fetchImpl, timeoutMs, minBytes: FIRERED_CMVN_MIN_BYTES, label: 'FireRed CMVN' });
  writeAtomic(join(dir, FIRERED_MODEL_FILE), onnx);
  writeAtomic(join(dir, FIRERED_CMVN_FILE), cmvn);
  log?.info?.('听觉：FireRed 模型已下载', { dir, bytes: onnx.length + cmvn.length });
  return {
    kind: 'firered',
    path: join(dir, FIRERED_MODEL_FILE),
    cmvnPath: join(dir, FIRERED_CMVN_FILE),
    source: 'download',
    exists: true,
    sizeBytes: onnx.length + cmvn.length,
  };
}

/** 官方 StreamVadPostprocessor 的移植：平滑、概率门限、最短语音/静音、最长段。 */
export class StreamVadPostprocessor {
  constructor({ smoothWindowSize = 5, threshold = 0.5, padStartFrame = 5, minSpeechFrame = 8, maxSpeechFrame = 2000, minSilenceFrame = 20 } = {}) {
    this.smoothWindowSize = Math.max(1, smoothWindowSize);
    this.threshold = threshold;
    this.padStartFrame = Math.max(this.smoothWindowSize, padStartFrame);
    this.minSpeechFrame = minSpeechFrame;
    this.maxSpeechFrame = maxSpeechFrame;
    this.minSilenceFrame = minSilenceFrame;
    this.reset();
  }

  reset() {
    this.frameCount = 0;
    this.window = [];
    this.windowSum = 0;
    this.state = 0; // 0 silence, 1 possible speech, 2 speech, 3 possible silence
    this.speechCnt = 0;
    this.silenceCnt = 0;
    this.hitMax = false;
    this.lastStartFrame = -1;
    this.lastEndFrame = -1;
  }

  get active() {
    return this.state === 2 || this.state === 3;
  }

  #smooth(prob) {
    if (this.smoothWindowSize <= 1) return prob;
    this.window.push(prob);
    this.windowSum += prob;
    if (this.window.length > this.smoothWindowSize) this.windowSum -= this.window.shift();
    return this.windowSum / this.window.length;
  }

  /** @returns {{isStart: boolean, isEnd: boolean, startFrame: number, endFrame: number}} */
  process(rawProb) {
    this.frameCount += 1;
    const smoothed = this.#smooth(rawProb);
    const isSpeech = smoothed >= this.threshold;
    const result = { isStart: false, isEnd: false, startFrame: -1, endFrame: -1 };

    if (this.hitMax) {
      result.isStart = true;
      result.startFrame = this.frameCount;
      this.lastStartFrame = result.startFrame;
      this.hitMax = false;
    }

    if (this.state === 0) {
      if (isSpeech) {
        this.state = 1;
        this.speechCnt += 1;
      } else {
        this.silenceCnt += 1;
        this.speechCnt = 0;
      }
    } else if (this.state === 1) {
      if (isSpeech) {
        this.speechCnt += 1;
        if (this.speechCnt >= this.minSpeechFrame) {
          this.state = 2;
          result.isStart = true;
          result.startFrame = Math.max(
            1,
            this.frameCount - this.speechCnt + 1 - this.padStartFrame,
            this.lastEndFrame + 1,
          );
          this.lastStartFrame = result.startFrame;
          this.silenceCnt = 0;
        }
      } else {
        this.state = 0;
        this.silenceCnt = 1;
        this.speechCnt = 0;
      }
    } else if (this.state === 2) {
      this.speechCnt += 1;
      if (isSpeech) {
        this.silenceCnt = 0;
        if (this.speechCnt >= this.maxSpeechFrame) {
          this.hitMax = true;
          this.speechCnt = 0;
          result.isEnd = true;
          result.endFrame = this.frameCount;
          result.startFrame = this.lastStartFrame;
          this.lastStartFrame = -1;
          this.lastEndFrame = result.endFrame;
        }
      } else {
        this.state = 3;
        this.silenceCnt += 1;
      }
    } else {
      this.speechCnt += 1;
      if (isSpeech) {
        this.state = 2;
        this.silenceCnt = 0;
        if (this.speechCnt >= this.maxSpeechFrame) {
          this.hitMax = true;
          this.speechCnt = 0;
          result.isEnd = true;
          result.endFrame = this.frameCount;
          result.startFrame = this.lastStartFrame;
          this.lastStartFrame = -1;
          this.lastEndFrame = result.endFrame;
        }
      } else {
        this.silenceCnt += 1;
        if (this.silenceCnt >= this.minSilenceFrame) {
          this.state = 0;
          result.isEnd = true;
          result.endFrame = this.frameCount;
          result.startFrame = this.lastStartFrame;
          this.lastEndFrame = result.endFrame;
          this.lastStartFrame = -1;
          this.speechCnt = 0;
        }
      }
    }
    return result;
  }
}

/**
 * FireRed 流式切分器。异步：`push()` 入队，结果经 `onUtterance` 回调出来。
 */
export class FireRedSegmenter {
  static async create(opts = {}) {
    if (!opts.modelPath) throw new Error('FireRed 切分器需要模型路径。');
    if (!opts.cmvnPath) throw new Error('FireRed 切分器需要 cmvn.ark。');
    const ort = opts.ort ?? loadOnnxRuntime();
    const session = opts.session ?? await ort.InferenceSession.create(opts.modelPath);
    const cmvn = cmvnFromMatrix(parseCmvnMatrix(readFileSync(opts.cmvnPath)));
    return new FireRedSegmenter({ ...opts, ort, session, cmvn });
  }

  constructor(opts) {
    this.kind = 'firered';
    this.async = true;
    this.onUtterance = typeof opts.onUtterance === 'function' ? opts.onUtterance : null;
    this.onError = typeof opts.onError === 'function' ? opts.onError : null;
    this.frameMs = Number(opts.frameMs) || 20;
    this.sampleRate = Number(opts.sampleRate) || 16000;
    this.minUtteranceMs = Number(opts.minUtteranceMs) || 400;
    this.#minSpeechMs = Number(opts.minSpeechMs) || 400;
    this.silenceMs = Number(opts.silenceMs) || 600;
    this.maxUtteranceMs = Number(opts.maxUtteranceMs) || 15000;
    this.threshold = Number(opts.threshold) || 0.5;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.log = opts.log;
    this.#ort = opts.ort;
    this.#session = opts.session;
    this.#cmvn = opts.cmvn;
    this.#fbank = new KaldiFbank();
    this.#post = this.#postFor();
    this.#caches = new Float32Array(CACHE_SIZE);
    this.dropped = 0;
    this.lastDb = -100;
    this.lastFrameAt = -1;
    this.quietFlushed = true;
    this.#chain = Promise.resolve();
  }

  #ort;
  #session;
  #cmvn;
  #fbank;
  #post;
  #caches;
  #minSpeechMs = 400;
  #chain;
  #pcm = [];
  #anchors = [];
  #samplesFed = 0;
  #frameOffset = 0;
  #segStart = -1;
  #active = false;

  get level() {
    return this.lastDb;
  }

  get active() {
    return this.#active;
  }

  #postFor() {
    return new StreamVadPostprocessor({
      smoothWindowSize: 5,
      threshold: this.threshold,
      padStartFrame: 5,
      minSpeechFrame: Math.max(1, Math.round(Number(this.#minSpeechMs ?? 400) / FRAME_MS)),
      maxSpeechFrame: Math.max(1, Math.round(this.maxUtteranceMs / FRAME_MS)),
      minSilenceFrame: Math.max(1, Math.round(this.silenceMs / FRAME_MS)),
    });
  }

  #bufferSamples() {
    return Math.max(30, Math.ceil(this.maxUtteranceMs / 1000) + 10) * this.sampleRate;
  }

  /** 热改参数：变了就清空流状态（模型本体不变）。 */
  configure(next) {
    if (!next || typeof next !== 'object') return;
    const threshold = Math.min(Math.max(Number(next.threshold ?? this.threshold) || 0.5, 0.1), 0.9);
    const minSpeechMs = Math.min(Math.max(Number(next.minSpeechMs ?? 400), 50), 2000);
    const silenceMs = Math.min(Math.max(Number(next.silenceMs ?? this.silenceMs), 150), 5000);
    const maxUtteranceMs = Math.min(Math.max(Number(next.maxUtteranceMs ?? this.maxUtteranceMs), 2000), 120000);
    const minUtteranceMs = Math.min(Math.max(Number(next.minUtteranceMs ?? this.minUtteranceMs), 100), 5000);
    if (threshold === this.threshold && minSpeechMs === this.#minSpeechMs
      && silenceMs === this.silenceMs && maxUtteranceMs === this.maxUtteranceMs
      && minUtteranceMs === this.minUtteranceMs) return;
    this.threshold = threshold;
    this.#minSpeechMs = minSpeechMs;
    this.silenceMs = silenceMs;
    this.maxUtteranceMs = maxUtteranceMs;
    this.minUtteranceMs = minUtteranceMs;
    this.#chain = this.#chain.then(() => {
      this.#post = this.#postFor();
      this.#resetStream();
    }).catch((err) => this.#fail(err));
  }

  /**
   * 喂一帧 16k PCM16。异步推理，这一帧的结果稍后经 `onUtterance` 交付。
   */
  push(frame, atMs) {
    if (!frame || !frame.length) return;
    this.lastDb = rmsDb(frame);
    if (!this.#anchors.length || atMs - this.lastFrameAt > this.frameMs * 2) {
      this.#anchors.push({ sample: this.#samplesFed, at: atMs - (frame.length / this.sampleRate) * 1000 });
    }
    const oldest = this.#samplesFed - this.#bufferSamples();
    while (this.#anchors.length > 1 && this.#anchors[1].sample <= oldest) this.#anchors.shift();
    this.lastFrameAt = atMs;
    this.quietFlushed = false;

    this.#pcm.push({ start: this.#samplesFed, pcm: Int16Array.from(frame) });
    this.#samplesFed += frame.length;

    const feats = this.#fbank.accept(frame);
    if (!feats.length) return;
    for (const feat of feats) applyCmvn(feat, this.#cmvn, feat);
    const data = new Float32Array(feats.length * 80);
    feats.forEach((feat, i) => data.set(feat, i * 80));
    this.#chain = this.#chain.then(() => this.#infer(data, feats.length)).catch((err) => this.#fail(err));
  }

  async #infer(data, frames) {
    const feat = new this.#ort.Tensor('float32', data, [1, frames, 80]);
    const caches = new this.#ort.Tensor('float32', this.#caches, CACHE_SHAPE);
    const out = await this.#session.run({ feat, caches_in: caches });
    this.#caches = Float32Array.from(out.caches_out.data);
    const probs = out.probs.data;
    for (let i = 0; i < probs.length; i += 1) this.#onProb(probs[i]);
  }

  #onProb(prob) {
    const r = this.#post.process(prob);
    if (r.isStart) this.#segStart = r.startFrame;
    if (r.isEnd) {
      const start = r.startFrame > 0 ? r.startFrame : this.#segStart;
      this.#emit(start, r.endFrame, (r.endFrame - start) >= Math.round(this.maxUtteranceMs / FRAME_MS));
      this.#segStart = -1;
    }
    this.#active = this.#post.active;
    // 按「已处理」位置修剪，而不是「已喂入」；推理落后时不丢还没切出来的段。
    const processed = (this.#frameOffset + this.#post.frameCount) * FRAME_SHIFT;
    const keepFrom = processed - this.#bufferSamples();
    while (this.#pcm.length && this.#pcm[0].start + this.#pcm[0].pcm.length <= keepFrom) this.#pcm.shift();
    while (this.#anchors.length > 1 && this.#anchors[1].sample <= keepFrom) this.#anchors.shift();
  }

  #emit(startFrame, endFrame, forced) {
    if (startFrame <= 0 || endFrame <= startFrame) return;
    const startSample = (this.#frameOffset + startFrame - 1) * FRAME_SHIFT;
    const endSample = (this.#frameOffset + endFrame) * FRAME_SHIFT;
    const pcm = this.#slice(startSample, endSample);
    if (!pcm.length) return;
    const durationMs = (pcm.length / this.sampleRate) * 1000;
    if (durationMs < this.minUtteranceMs) {
      this.dropped += 1;
      return;
    }
    const anchor = this.#anchors.findLast((a) => a.sample <= startSample);
    const startAt = anchor
      ? anchor.at + ((startSample - anchor.sample) / this.sampleRate) * 1000
      : this.now() - (this.#samplesFed - startSample) / this.sampleRate * 1000;
    this.onUtterance?.({
      pcm,
      startAt,
      durationMs,
      forced: Boolean(forced),
      peakDb: peakDb(pcm),
    });
  }

  #slice(startSample, endSample) {
    const a = Math.max(0, Math.round(startSample));
    const b = Math.max(a, Math.round(endSample));
    const out = new Int16Array(Math.max(0, b - a));
    let at = 0;
    for (const chunk of this.#pcm) {
      const cs = chunk.start;
      const ce = cs + chunk.pcm.length;
      if (ce <= a || cs >= b) continue;
      const from = Math.max(a, cs) - cs;
      const to = Math.min(b, ce) - cs;
      out.set(chunk.pcm.subarray(from, to), at);
      at += to - from;
    }
    return at === out.length ? out : out.subarray(0, at);
  }

  #resetStream() {
    this.#frameOffset += this.#fbank.frameCount;
    this.#fbank.reset();
    this.#post.reset();
    this.#caches = new Float32Array(CACHE_SIZE);
    this.#segStart = -1;
    this.#active = false;
  }

  #fail(err) {
    const detail = err instanceof Error ? err.message : String(err);
    this.log?.warn?.('听觉：FireRed 推理出错', { detail });
    try {
      this.onError?.(err);
    } catch {
      /* 回调自己出错就吞掉 */
    }
    this.#resetStream();
  }

  /** 没有新帧时的墙上时钟收尾；与 Silero 同一个语义。 */
  tick(nowMs) {
    if (this.quietFlushed || this.lastFrameAt < 0) return;
    if (nowMs - this.lastFrameAt < this.silenceMs) return;
    this.quietFlushed = true;
    this.#chain = this.#chain.then(() => {
      if (this.#segStart > 0) {
        this.#emit(this.#segStart, this.#fbank.frameCount, false);
      }
      this.#resetStream();
    }).catch((err) => this.#fail(err));
  }

  /** 停止时把手上这段交出来；异步，等队列清空。 */
  flush() {
    this.#chain = this.#chain.then(() => {
      if (this.#segStart > 0) {
        this.#emit(this.#segStart, this.#fbank.frameCount, false);
      }
      this.#resetStream();
    }).catch((err) => this.#fail(err));
    return this.#chain.then(() => []);
  }
}

