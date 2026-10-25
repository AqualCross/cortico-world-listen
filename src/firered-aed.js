/**
 * FireRed AED：对切出来的一块音频做「说话 / 唱歌 / 音乐」区分（非流式）。
 *
 * 用的是同一个 `cmvn.ark` 和同一套 fbank；模型 `fireredvad_aed.onnx` 约 2.4MB。
 * 只在块落盘后跑一次，所以不进实时断句链路，只用于打标签或过滤纯音乐块。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { KaldiFbank, applyCmvn, cmvnFromMatrix, parseCmvnMatrix } from './fbank.js';
import {
  FIRERED_CMVN_FILE,
  FIRERED_CMVN_MIN_BYTES,
  FIRERED_CMVN_URL,
  downloadFile,
  loadOnnxRuntime,
  writeAtomic,
} from './firered.js';

export const FIRERED_AED_URL = 'https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/fireredvad_aed.onnx';
export const FIRERED_AED_FILE = 'fireredvad_aed.onnx';
export const FIRERED_AED_MIN_BYTES = 1_000_000;

/** 每类的判定门限（取自官方 inference_aed.sh）。 */
const SPEECH_TH = 0.4;
const SINGING_TH = 0.5;
const MUSIC_TH = 0.5;
/** 人声帧占比低于这个数，整块按音乐处理。 */
const VOICE_FLOOR = 0.1;

/** 快照/事件里给人看的中文标签。 */
export const AED_LABELS = Object.freeze({ speech: '说话', singing: '唱歌', music: '音乐' });

/** `worlds.listen.aedMode`：off / tag / voice。 */
export function aedModeOf(value) {
  return value === 'voice' || value === 'tag' ? value : 'off';
}

/** voice 模式下纯音乐块只归档、不投递；其余模式都投递。 */
export function aedShouldDeliver(mode, cls) {
  return mode !== 'voice' || !cls || cls.label !== 'music';
}

function dirOf(cfgPath, botDir) {
  const raw = typeof cfgPath === 'string' ? cfgPath.trim() : '';
  if (!raw) return '';
  const abs = isAbsolute(raw) ? raw : resolve(botDir ?? '.', raw);
  return raw.toLowerCase().endsWith('.onnx') ? dirname(abs) : abs;
}

/**
 * 同步看 AED 模型在不在：配置目录 → 缓存 → 包内资产。
 * @returns {{path: string, cmvnPath: string, source: string, exists: boolean, sizeBytes: number}}
 */
export function fireRedAedState({ cfgPath, dataDir, packageDir, botDir } = {}) {
  const check = (dir, source) => {
    try {
      const model = join(dir, FIRERED_AED_FILE);
      const cmvn = join(dir, FIRERED_CMVN_FILE);
      const o = statSync(model);
      const c = statSync(cmvn);
      if (!o.isFile() || !c.isFile()) return null;
      return { path: model, cmvnPath: cmvn, source, exists: true, sizeBytes: o.size + c.size };
    } catch {
      return null;
    }
  };
  const custom = dirOf(cfgPath, botDir);
  if (custom) {
    const hit = check(custom, 'config');
    if (hit) return hit;
  }
  const cache = join(dataDir ?? '.', 'listen', 'firered');
  const local = check(cache, 'cache');
  if (local) return local;
  if (packageDir) {
    const packed = check(join(packageDir, 'assets', 'firered'), 'package');
    if (packed) return packed;
  }
  return { path: join(cache, FIRERED_AED_FILE), cmvnPath: join(cache, FIRERED_CMVN_FILE), source: 'missing', exists: false, sizeBytes: 0 };
}

/** 需要 AED 时确保模型与 cmvn 都在；缺就下载到缓存。 */
export async function ensureFireRedAedModel({
  cfgPath,
  dataDir,
  packageDir,
  botDir,
  fetchImpl,
  timeoutMs = 180000,
  log,
} = {}) {
  const state = fireRedAedState({ cfgPath, dataDir, packageDir, botDir });
  if (state.exists) return state;
  const custom = dirOf(cfgPath, botDir);
  if (custom) {
    throw new Error(`worlds.listen.fireredModel 所在目录里没有 ${FIRERED_AED_FILE}（同目录还需要 ${FIRERED_CMVN_FILE}）。把它放进去，或清掉 fireredModel 让插件下载到缓存。`);
  }
  const dir = join(dataDir ?? '.', 'listen', 'firered');
  log?.info?.('听觉：开始下载 FireRed AED 模型', { dir });
  const model = await downloadFile(FIRERED_AED_URL, { fetchImpl, timeoutMs, minBytes: FIRERED_AED_MIN_BYTES, label: 'FireRed AED 模型' });
  writeAtomic(join(dir, FIRERED_AED_FILE), model);
  let hasCmvn = false;
  try {
    hasCmvn = readFileSync(join(dir, FIRERED_CMVN_FILE)).length >= FIRERED_CMVN_MIN_BYTES;
  } catch {
    hasCmvn = false;
  }
  if (!hasCmvn) {
    const cmvn = await downloadFile(FIRERED_CMVN_URL, { fetchImpl, timeoutMs, minBytes: FIRERED_CMVN_MIN_BYTES, label: 'FireRed CMVN' });
    writeAtomic(join(dir, FIRERED_CMVN_FILE), cmvn);
  }
  log?.info?.('听觉：FireRed AED 模型已下载', { dir, bytes: model.length });
  return fireRedAedState({ cfgPath: '', dataDir, packageDir, botDir });
}

/** 块级三分类；只读一帧 PCM16 的 16k 音频。 */
export class FireRedAedClassifier {
  static async create({ modelPath, cmvnPath, ort, session } = {}) {
    if (!modelPath) throw new Error('FireRed AED 需要模型路径。');
    if (!cmvnPath) throw new Error('FireRed AED 需要 cmvn.ark。');
    const runtime = ort ?? loadOnnxRuntime();
    const sess = session ?? await runtime.InferenceSession.create(modelPath);
    const cmvn = cmvnFromMatrix(parseCmvnMatrix(readFileSync(cmvnPath)));
    return new FireRedAedClassifier({ ort: runtime, session: sess, cmvn });
  }

  constructor({ ort, session, cmvn }) {
    this.#ort = ort;
    this.#session = session;
    this.#cmvn = cmvn;
  }

  #ort;
  #session;
  #cmvn;

  /**
   * @param {Int16Array} pcm 16k 单声道
   * @returns {Promise<{label: 'speech'|'singing'|'music', speech: number, singing: number, music: number, voice: number}>}
   */
  async classify(pcm) {
    const fbank = new KaldiFbank();
    const frames = [];
    for (let i = 0; i < pcm.length; i += 320) {
      for (const f of fbank.accept(pcm.subarray(i, i + 320))) frames.push(applyCmvn(f, this.#cmvn));
    }
    if (!frames.length) return { label: 'music', speech: 0, singing: 0, music: 0, voice: 0 };
    const flat = new Float32Array(frames.length * 80);
    frames.forEach((f, i) => flat.set(f, i * 80));
    const out = await this.#session.run({
      feat: new this.#ort.Tensor('float32', flat, [1, frames.length, 80]),
    });
    const probs = out.probs.data;
    let speech = 0;
    let singing = 0;
    let music = 0;
    let voice = 0;
    for (let i = 0; i < frames.length; i += 1) {
      const s = probs[i * 3];
      const g = probs[i * 3 + 1];
      const m = probs[i * 3 + 2];
      if (s >= SPEECH_TH) speech += 1;
      if (g >= SINGING_TH) singing += 1;
      if (m >= MUSIC_TH) music += 1;
      if (s >= SPEECH_TH || g >= SINGING_TH) voice += 1;
    }
    const n = frames.length;
    const ratios = {
      speech: speech / n,
      singing: singing / n,
      music: music / n,
      voice: voice / n,
    };
    const label = ratios.voice < VOICE_FLOOR ? 'music' : (ratios.singing > ratios.speech ? 'singing' : 'speech');
    return {
      label,
      speech: Math.round(ratios.speech * 1000) / 1000,
      singing: Math.round(ratios.singing * 1000) / 1000,
      music: Math.round(ratios.music * 1000) / 1000,
      voice: Math.round(ratios.voice * 1000) / 1000,
    };
  }
}
