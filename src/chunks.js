/**
 * 语音块仓库：一个目录 + 一份 index.json，每块一个 WAV 文件。
 *
 * 和 TTS 世界的「语音仓库」同一套做法：本进程写、索引常驻内存、落盘走
 * 「写临时文件再 rename」；索引坏了或文件被外部删了不抛错，静默当空/跳过。
 *
 * 与 TTS 的一点不同：每条记录带一个递增的 `seq`，面板与 `listen_recent`
 * 用它编号；重启后从现存记录接下去数（清空后从 1 重来）。
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const INDEX_FILE = 'index.json';
const VERSION = 1;

const pad = (n, width = 2) => String(n).padStart(width, '0');

function stampOf(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function newId() {
  return randomBytes(4).toString('hex');
}

function intOf(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function numOf(value, fallback = -100) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class Chunks {
  #items = [];
  #loaded = false;
  #nextSeq = 1;

  /** @param {{dir: string, keep?: number}} opts */
  constructor(opts = {}) {
    this.dir = String(opts.dir ?? '.');
    this.keep = intOf(opts.keep, 200);
  }

  get indexFile() {
    return join(this.dir, INDEX_FILE);
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  get count() {
    this.#load();
    return this.#items.length;
  }

  get totalBytes() {
    this.#load();
    return this.#items.reduce((sum, item) => sum + intOf(item.bytes), 0);
  }

  get totalDurationMs() {
    this.#load();
    return this.#items.reduce((sum, item) => sum + intOf(item.durationMs), 0);
  }

  /** 最新在前；limit 0 或缺省给全部。 */
  list(limit = 0) {
    this.#load();
    const n = intOf(limit);
    return (n > 0 ? this.#items.slice(0, n) : this.#items).map((item) => ({ ...item }));
  }

  get(ref) {
    this.#load();
    const key = String(ref ?? '').trim();
    if (!key) return null;
    const lower = key.toLowerCase();
    const item = this.#items.find((it) => it.id === lower
      || it.file.toLowerCase() === lower
      || it.path.toLowerCase() === lower
      || it.path.toLowerCase() === resolve(key).toLowerCase());
    return item ? { ...item } : null;
  }

  /** 存一块并返回记录；`bytes` 是 Buffer/Uint8Array。 */
  add(entry) {
    this.#load();
    this.ensure();
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
    const now = new Date();
    const id = newId();
    const file = `${stampOf(now)}-${id}.wav`;
    const path = join(this.dir, file);
    writeFileSync(path, bytes);
    const item = {
      id,
      seq: this.#nextSeq,
      file,
      path,
      mime: String(entry.mime ?? 'audio/wav'),
      bytes: bytes.length,
      durationMs: intOf(entry.durationMs),
      startedAt: String(entry.startedAt ?? ''),
      at: String(entry.at ?? now.toISOString()),
      source: String(entry.source ?? ''),
      app: String(entry.app ?? ''),
      target: String(entry.target ?? ''),
      handle: String(entry.handle ?? ''),
      forced: Boolean(entry.forced),
      peakDb: numOf(entry.peakDb),
      delivered: entry.delivered !== false,
      deliveryError: String(entry.deliveryError ?? ''),
    };
    this.#nextSeq = item.seq + 1;
    this.#items.unshift(item);
    this.#prune();
    this.#save();
    return { ...item };
  }

  remove(ref) {
    this.#load();
    const item = this.get(ref);
    if (!item) return false;
    this.#items = this.#items.filter((it) => it.id !== item.id);
    this.#unlink(item.path);
    this.#save();
    return true;
  }

  clear() {
    this.#load();
    const removed = this.#items.length;
    for (const item of this.#items) this.#unlink(item.path);
    this.#items = [];
    this.#nextSeq = 1;
    this.#save();
    return removed;
  }

  summary(limit = 60) {
    this.#load();
    const n = Math.max(1, intOf(limit, 60));
    return {
      dir: this.dir,
      indexFile: this.indexFile,
      keep: this.keep,
      count: this.#items.length,
      totalBytes: this.totalBytes,
      totalDurationMs: this.totalDurationMs,
      items: this.list(Math.min(n, this.#items.length)),
    };
  }

  #unlink(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* 文件已经不在了，或者被别的程序占着；索引照删。 */
    }
  }

  #prune() {
    if (!this.keep || this.#items.length <= this.keep) return;
    const dropped = this.#items.splice(this.keep);
    for (const item of dropped) this.#unlink(item.path);
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    const file = this.indexFile;
    if (!existsSync(file)) {
      this.#items = [];
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      parsed = null;
    }
    const raw = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(raw)) {
      this.#items = [];
      return;
    }
    const items = [];
    let maxSeq = 0;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') continue;
      const path = typeof entry.path === 'string' && isAbsolute(entry.path)
        ? entry.path
        : join(this.dir, entry.file);
      let bytes = intOf(entry.bytes);
      try {
        if (!existsSync(path)) continue;
        bytes = statSync(path).size;
      } catch {
        continue;
      }
      const seq = intOf(entry.seq);
      items.push({
        id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
        seq,
        file: entry.file,
        path,
        mime: String(entry.mime ?? 'audio/wav'),
        bytes,
        durationMs: intOf(entry.durationMs),
        startedAt: String(entry.startedAt ?? ''),
        at: String(entry.at ?? new Date().toISOString()),
        source: String(entry.source ?? ''),
        app: String(entry.app ?? ''),
        target: String(entry.target ?? ''),
        handle: String(entry.handle ?? ''),
        forced: Boolean(entry.forced),
        peakDb: numOf(entry.peakDb),
        delivered: entry.delivered !== false,
        deliveryError: String(entry.deliveryError ?? ''),
      });
      if (seq > maxSeq) maxSeq = seq;
    }
    this.#items = items;
    this.#nextSeq = maxSeq + 1;
    const before = items.length;
    this.#prune();
    if (this.#items.length !== before) this.#save();
  }

  #save() {
    try {
      this.ensure();
      const body = JSON.stringify({ version: VERSION, items: this.#items }, null, 2);
      const tmp = `${this.indexFile}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.indexFile);
    } catch {
      /* 磁盘写不进去时不挡采集；下一次成功写入会覆盖。 */
    }
  }
}
