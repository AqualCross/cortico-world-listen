/**
 * 采集：把系统声音或某个应用的音频变成 16 kHz 单声道 PCM16 的 20ms 帧。
 *
 * 原生件是 `loopback-capture`（N-API，预编译；Windows 上系统环回用
 * WASAPI loopback，按应用用进程树 loopback）。原始包是 48 kHz 立体声
 * 16-bit PCM；这里做「立体声 → 单声道 → 48k → 16k（3:1 盒式平均）→
 * 切帧」，全部按样本对齐，不丢整帧。
 *
 * 有件事属于采集端的脾气：全静音的包在原生侧就被丢掉了（低于 -70 dBFS
 * 不回调）。所以「安静」表现为「没有帧」；切分的收尾靠墙上时钟，见 vad.js。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const SRC_RATE = 48000;
export const SRC_CHANNELS = 2;
export const OUT_RATE = 16000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (OUT_RATE * FRAME_MS) / 1000; // 320
const DECIMATE = SRC_RATE / OUT_RATE; // 3

/** 加载原生件；失败时把「装没装、能不能载」讲成人话。 */
export function loadCaptureModule() {
  if (process.platform !== 'win32') {
    throw new Error('听觉目前只在 Windows 上可用（系统环回 / 按应用都走 WASAPI）。');
  }
  try {
    return require('loopback-capture');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`载入 loopback-capture 失败：${detail}。请在扩展目录里安装依赖（pnpm install）后重启应用。`);
  }
}

/** 原生件能不能载（给状态页与工具回执看），结果缓存。 */
let moduleProbe = null;
export function captureModuleStatus() {
  if (!moduleProbe) {
    try {
      loadCaptureModule();
      moduleProbe = { ok: true, error: '' };
    } catch (err) {
      moduleProbe = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return moduleProbe;
}

/** Int16Array 拼接。 */
function joinInt16(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class Capturer {
  #impl = null;
  #srcCarry = new Int16Array(0);
  #monoCarry = new Int16Array(0);
  #onFrame;
  #onStatus;

  /**
   * @param {object} opts
   * @param {(frame: Int16Array) => void} opts.onFrame 20ms / 320 样本的 16k 单声道帧
   * @param {(event: {type: string, detail?: string}) => void} [opts.onStatus] 采集端的边角状态
   */
  constructor({ onFrame, onStatus } = {}) {
    if (typeof onFrame !== 'function') throw new Error('Capturer 需要 onFrame 回调。');
    this.#onFrame = onFrame;
    this.#onStatus = typeof onStatus === 'function' ? onStatus : () => {};
  }

  get running() {
    return this.#impl !== null;
  }

  /**
   * 开始采集。
   * @param {{source: 'system'} | {source: 'app', pid: number}} target
   */
  start(target) {
    if (this.#impl) throw new Error('已经在采集了：先 stop。');
    const mod = loadCaptureModule();
    const impl = new mod.LoopbackCapture();
    const cb = (buf) => this.#ingest(buf);
    if (target?.source === 'app') {
      const pid = Number(target.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('按应用采集需要有效的 PID。');
      impl.start(pid, true, cb);
    } else {
      impl.startSystemAudio(cb);
    }
    this.#impl = impl;
  }

  stop() {
    const impl = this.#impl;
    this.#impl = null;
    this.#srcCarry = new Int16Array(0);
    this.#monoCarry = new Int16Array(0);
    if (!impl) return;
    try {
      impl.stop();
    } catch (err) {
      // 已经停了或进入错误态时 stop 可能抛；这里不再翻上去，只报一声。
      this.#onStatus({ type: 'stop-error', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 一块原生 PCM（48k 立体声 interleaved）→ 若干 16k 单声道帧。 */
  #ingest(buf) {
    if (!this.#impl) return; // stop 之后迟到的包丢掉
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    if (!pcm.length) return;

    // 攒原始样本：跨包对齐，不丢 3 的余数。
    const src = this.#srcCarry.length ? joinInt16([this.#srcCarry, pcm]) : pcm;
    const usable = Math.floor(src.length / (DECIMATE * SRC_CHANNELS)) * (DECIMATE * SRC_CHANNELS);
    const outCount = usable / (DECIMATE * SRC_CHANNELS);
    if (outCount > 0) {
      const mono = new Int16Array(outCount);
      for (let i = 0; i < outCount; i += 1) {
        let sum = 0;
        const base = i * DECIMATE * SRC_CHANNELS;
        for (let j = 0; j < DECIMATE; j += 1) {
          const k = base + j * SRC_CHANNELS;
          sum += src[k] + src[k + 1];
        }
        mono[i] = Math.max(-32768, Math.min(32767, Math.round(sum / (DECIMATE * SRC_CHANNELS))));
      }
      this.#srcCarry = src.length > usable ? src.slice(usable) : new Int16Array(0);
      this.#monoCarry = this.#monoCarry.length ? joinInt16([this.#monoCarry, mono]) : mono;
    } else {
      this.#srcCarry = src.slice();
    }

    // 切 320 样本的帧；余数留到下一包。
    while (this.#monoCarry.length >= FRAME_SAMPLES) {
      const frame = this.#monoCarry.slice(0, FRAME_SAMPLES);
      this.#monoCarry = this.#monoCarry.slice(FRAME_SAMPLES);
      this.#onFrame(frame);
    }
  }
}
