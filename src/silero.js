/**
 * Silero VAD 切分器（可选）：用 sherpa-onnx-node 里的 silero 模型分辨「人在说」与
 * 其它声音（音乐、提示音、正弦测试音）。比能量门限贵一点，也准得多。
 *
 * 模型是 `silero_vad.onnx`（约 0.6MB，MIT 许可）：配置路径 → 缓存 → 自动下载（也可
 * 放一份在 `assets/silero_vad.onnx`）。下载失败时错误信息会说明三条来路。
 *
 * 与能量切分器同一个形状：`push(frame, atMs)` / `tick(nowMs)` / `flush()` /
 * `configure(next)`；区别只在 `flush()` 返回数组（内部可能排着不止一段），
 * World 两边都认。
 *
 * 模型的脾气：它按自己的窗口与静音时长判定；收尾在「有静音帧」时由它自己做，
 * 而 WASAPI 环回在安静时根本没有帧——所以 `tick()` 用墙上时钟兜底：安静够久就
 * `flush()` 把手上这段交出来。
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { rmsDb } from './vad.js';

const require = createRequire(import.meta.url);

/** Prepare the optional runtime without modifying the extension's installation. */
export async function ensureSileroRuntime({ dataDir, load = loadSherpa, onProgress = () => {} } = {}) {
  onProgress('checking-runtime');
  try { return load(); } catch { /* Try the private runtime before installing. */ }
  const dir = join(dataDir, 'listen', 'runtime');
  const localRequire = createRequire(join(dir, 'package.json'));
  try { return localRequire('sherpa-onnx-node'); } catch { /* Not installed yet. */ }
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'app', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ...String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
      .map((p) => join(p, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ];
  const cli = candidates.find((p) => p && existsSync(p));
  if (!cli) throw new Error('找不到包管理器，无法自动安装 Silero 运行组件。请安装扩展的可选依赖后重试。');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), '{"private":true}');
  const pnpm = cli.endsWith('pnpm.cjs');
  onProgress('installing-runtime');
  await new Promise((resolveInstall, reject) => {
    const child = spawn(process.execPath, [cli, ...(pnpm ? ['add', '--dir', dir] : ['install', '--prefix', dir]), 'sherpa-onnx-node@^1.13.8'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let output = '';
    const collect = (b) => { output = (output + b.toString()).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => { child.kill(); reject(new Error('安装 Silero 运行组件超时，请重试。')); }, 300000);
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveInstall();
      else reject(new Error(`安装 Silero 运行组件失败：${output}`));
    });
  });
  return localRequire('sherpa-onnx-node');
}

/** 官方发布里的 silero 模型（sherpa-onnx 的 asr-models 资产）。 */
export const SILERO_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';

/** 缓存/下载文件的最小合理体积；比它小多半是下载了个错误页面。 */
export const MODEL_MIN_BYTES = 100_000;

const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);

/** 加载原生件；失败时把「装没装、版本对不对」讲成人话。 */
export function loadSherpa() {
  try {
    return require('sherpa-onnx-node');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`载入 sherpa-onnx-node 失败：${detail}。请在扩展目录里安装依赖（pnpm install）后重启应用；只用能量门限（vad: energy）不需要它。`);
  }
}

/** 配置里的 sileroModel：绝对路径；相对路径按 bot 目录解。 */
export function resolveModelPath(raw, botDir) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  return isAbsolute(s) ? s : resolve(botDir ?? '.', s);
}

/** 缓存位置：`<dataDir>/listen/silero_vad.onnx`。 */
export function cacheModelPath(dataDir) {
  return join(dataDir ?? '.', 'listen', 'silero_vad.onnx');
}

/**
 * 同步看模型在哪、在不在。不下载、不加载。
 * 判据：配置路径只要存在就算数（是不是真模型交给 sherpa 说话）；缓存与包内资产要求
 * 体积下限（防半个文件）。
 * @returns {{path: string, source: 'config'|'cache'|'package'|'cache-missing'|'config-missing', exists: boolean, sizeBytes: number}}
 */
export function modelState({ cfgPath, dataDir, packageDir, botDir } = {}) {
  const cfg = resolveModelPath(cfgPath, botDir);
  if (cfg) {
    let exists = false;
    let sizeBytes = 0;
    try {
      const st = statSync(cfg);
      if (st.isFile()) {
        exists = true;
        sizeBytes = st.size;
      }
    } catch {
      /* 不在就不在 */
    }
    return { path: cfg, source: exists ? 'config' : 'config-missing', exists, sizeBytes };
  }
  const cache = cacheModelPath(dataDir);
  try {
    const st = statSync(cache);
    if (st.isFile() && st.size >= MODEL_MIN_BYTES) return { path: cache, source: 'cache', exists: true, sizeBytes: st.size };
  } catch {
    /* 没有缓存 */
  }
  if (packageDir) {
    const asset = join(packageDir, 'assets', 'silero_vad.onnx');
    try {
      const st = statSync(asset);
      if (st.isFile() && st.size >= MODEL_MIN_BYTES) return { path: asset, source: 'package', exists: true, sizeBytes: st.size };
    } catch {
      /* 没有资产 */
    }
  }
  return { path: cache, source: 'cache-missing', exists: false, sizeBytes: 0 };
}

/**
 * 确保能拿到模型：已有就返回；配置路径缺了就报错（不替用户下载到别处）；
 * 缓存缺失时按需下载（原子写：临时文件 → 改名）。
 * @returns {Promise<{path: string, source: 'config'|'cache'|'package'|'download', exists: true, sizeBytes: number}>}
 */
export async function ensureSileroModel({
  cfgPath,
  dataDir,
  packageDir,
  botDir,
  fetchImpl,
  timeoutMs = 120000,
  allowDownload = true,
  minBytes = MODEL_MIN_BYTES,
  log,
  onProgress = () => {},
} = {}) {
  onProgress('checking-model');
  const state = modelState({ cfgPath, dataDir, packageDir, botDir });
  if (state.exists) return state;
  const cfg = resolveModelPath(cfgPath, botDir);
  if (cfg) {
    throw new Error(`worlds.listen.sileroModel 指的模型不在：${cfg}。改配置、清掉它，或在控制台「状态」页获取模型。`);
  }
  const target = cacheModelPath(dataDir);
  if (!allowDownload) {
    throw new Error(`silero 模型还没下载（缓存位置：${target}）。到控制台「听觉 → 状态」点「获取 Silero 模型」，或设置 worlds.listen.sileroModel 指向本地文件。`);
  }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  onProgress('downloading-model');
  let buf;
  try {
    const res = await doFetch(SILERO_MODEL_URL, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`下载 silero 模型失败（${detail}）。可以：改 worlds.listen.sileroModel 指向本地的 silero_vad.onnx（${SILERO_MODEL_URL}），或在控制台「状态」页重试。`);
  }
  if (buf.length < minBytes) {
    throw new Error(`下载到的 silero 模型只有 ${buf.length} 字节，不像真模型（${SILERO_MODEL_URL}）。`);
  }
  onProgress('saving-model');
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, buf);
    renameSync(tmp, target);
  } catch (err) {
    throw new Error(`silero 模型写不进缓存目录：${err instanceof Error ? err.message : String(err)}`);
  }
  log?.info?.('听觉：silero 模型已下载', { path: target, bytes: buf.length });
  return { path: target, source: 'download', exists: true, sizeBytes: buf.length };
}

/** 一组 float 样本的峰值（dBFS）。 */
function peakOfFloat(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peak));
}

/**
 * Silero 切分器；接口与能量版 Segmenter 相同（flush 返回数组）。
 */
export class SileroSegmenter {
  #vad = null;
  #signature = '';
  #samplesFed = 0;
  #clockAnchors = [];

  constructor(opts = {}) {
    this.sampleRate = Number(opts.sampleRate) || 16000;
    this.frameMs = Number(opts.frameMs) || 20;
    this.modelPath = String(opts.modelPath ?? '');
    if (!this.modelPath) throw new Error('Silero 切分器需要模型路径。');
    this.threshold = clamp(opts.threshold ?? 0.5, 0.1, 0.9);
    this.minSpeechMs = clamp(opts.minSpeechMs ?? 200, 50, 2000);
    this.silenceMs = clamp(opts.silenceMs ?? 600, 150, 5000);
    this.maxUtteranceMs = clamp(opts.maxUtteranceMs ?? 15000, 2000, 120000);
    this.minUtteranceMs = clamp(opts.minUtteranceMs ?? 400, 100, 5000);
    this.load = typeof opts.loadSherpa === 'function' ? opts.loadSherpa : loadSherpa;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.log = opts.log;

    this.dropped = 0;
    this.lastDb = -100;
    this.lastFrameAt = -1;
    this.quietFlushed = true;
    this.#create();
  }

  get kind() {
    return 'silero';
  }

  /** 最近一帧的电平（dBFS）；控制台的电平条读它。 */
  get level() {
    return this.lastDb;
  }

  /** 此刻是否正在说。 */
  get active() {
    try {
      return this.#vad.isDetected();
    } catch {
      return false;
    }
  }

  #bufferSeconds() {
    return Math.max(30, Math.ceil(this.maxUtteranceMs / 1000) + 10);
  }

  #create() {
    const sherpa = this.load();
    if (typeof sherpa?.Vad !== 'function') throw new Error('sherpa-onnx-node 里没有 Vad：版本不符或不完整。');
    this.#vad = new sherpa.Vad({
      sileroVad: {
        model: this.modelPath,
        threshold: this.threshold,
        minSilenceDuration: this.silenceMs / 1000,
        minSpeechDuration: this.minSpeechMs / 1000,
        maxSpeechDuration: this.maxUtteranceMs / 1000,
        windowSize: 512,
      },
      sampleRate: this.sampleRate,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    }, this.#bufferSeconds());
    // 段的 start 是「从 VAD 建起来到现在喂过的样本数」；用它把墙上时钟映射回来。
    this.baseAt = this.now();
    this.#samplesFed = 0;
    this.#clockAnchors = [];
    this.#signature = this.#signatureOf();
  }

  #signatureOf() {
    return [
      this.modelPath,
      this.threshold,
      this.minSpeechMs,
      this.silenceMs,
      this.maxUtteranceMs,
      this.sampleRate,
    ].join('|');
  }

  /**
   * 热改参数：变了就重建 VAD（模型会重载，短暂空档）。模型路径的改动在下次开始
   * 监听时生效，这里不动。
   */
  configure(next) {
    if (!next || typeof next !== 'object') return;
    const threshold = clamp(next.threshold ?? this.threshold, 0.1, 0.9);
    const minSpeechMs = clamp(next.minSpeechMs ?? this.minSpeechMs, 50, 2000);
    const silenceMs = clamp(next.silenceMs ?? this.silenceMs, 150, 5000);
    const maxUtteranceMs = clamp(next.maxUtteranceMs ?? this.maxUtteranceMs, 2000, 120000);
    const minUtteranceMs = clamp(next.minUtteranceMs ?? this.minUtteranceMs, 100, 5000);
    this.minUtteranceMs = minUtteranceMs;
    const signature = [this.modelPath, threshold, minSpeechMs, silenceMs, maxUtteranceMs, this.sampleRate].join('|');
    if (signature === this.#signature) return;
    this.threshold = threshold;
    this.minSpeechMs = minSpeechMs;
    this.silenceMs = silenceMs;
    this.maxUtteranceMs = maxUtteranceMs;
    this.#create();
    this.log?.info?.('听觉：silero 参数变了，切分器已重建', { threshold, minSpeechMs, silenceMs, maxUtteranceMs });
  }

  /**
   * 喂一帧（16k 单声道 PCM16），拿回这一帧之后完整的一段或多段。
   * @returns {Array<{pcm: Int16Array, startAt: number, durationMs: number, forced: boolean, peakDb: number}>}
   */
  push(frame, atMs) {
    this.lastDb = rmsDb(frame);
    // Capture omits silent packets; anchor resumed audio to the wall clock.
    if (!this.#clockAnchors.length || atMs - this.lastFrameAt > this.frameMs * 2) {
      this.#clockAnchors.push({ sample: this.#samplesFed, at: atMs - frame.length / this.sampleRate * 1000 });
    }
    const oldest = this.#samplesFed - this.#bufferSeconds() * this.sampleRate;
    while (this.#clockAnchors.length > 1 && this.#clockAnchors[1].sample <= oldest) this.#clockAnchors.shift();
    this.lastFrameAt = atMs;
    this.quietFlushed = false;
    const f32 = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) f32[i] = frame[i] / 32768;
    this.#vad.acceptWaveform(f32);
    this.#samplesFed += frame.length;
    return this.#drain();
  }

  /**
   * 墙上时钟的静音检查：安静够久（原生侧根本不会送静音帧）就把手上这段收尾。
   * @returns {Array<Utterance>}
   */
  tick(nowMs) {
    const out = [];
    if (!this.quietFlushed && this.lastFrameAt >= 0 && nowMs - this.lastFrameAt >= this.silenceMs) {
      this.#vad.flush();
      out.push(...this.#drain());
      this.quietFlushed = true;
    }
    return out;
  }

  /** 停止采集时把手上这段（或几段）交出来；返回数组。 */
  flush() {
    const out = [];
    try {
      this.#vad.flush();
      out.push(...this.#drain());
    } catch (err) {
      this.log?.warn?.('听觉：silero 收尾时出错', { detail: err instanceof Error ? err.message : String(err) });
    }
    return out;
  }

  #drain() {
    const out = [];
    while (!this.#vad.isEmpty()) {
      const seg = this.#vad.front();
      this.#vad.pop();
      const samples = seg?.samples;
      if (!samples || !samples.length) continue;
      const durationMs = (samples.length / this.sampleRate) * 1000;
      if (durationMs < this.minUtteranceMs) {
        this.dropped += 1;
        continue;
      }
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) {
        const v = samples[i];
        pcm[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
      }
      const startSamples = Number(seg?.start) || 0;
      const anchor = this.#clockAnchors.findLast((a) => a.sample <= startSamples);
      out.push({
        pcm,
        startAt: anchor
          ? anchor.at + (startSamples - anchor.sample) / this.sampleRate * 1000
          : this.baseAt + (startSamples / this.sampleRate) * 1000,
        durationMs,
        // 够到单块上限的多半是 silero 在 maxSpeechDuration 处强切的。
        forced: durationMs >= this.maxUtteranceMs - this.frameMs,
        peakDb: peakOfFloat(samples),
      });
    }
    return out;
  }
}

export const __test = { clamp, peakOfFloat };
