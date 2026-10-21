/**
 * 听觉 World。
 *
 * 一件事：把系统声音（或某个应用的音频）切成语音块，作为事件送进 cortico
 * 事件流。每块事件正文说明时长与来源，附件是一段 16 kHz 单声道 WAV——
 * agent 想读文字时把附件句柄交给 `stt_transcribe`，这里**不做**转写。
 *
 * 采集走 `loopback-capture`（Windows WASAPI）；切分走本包的能量门限 VAD；
 * 事件走 `host.pushEvent`（附件由 Core 落成 `log:` 句柄）。不联网、不要密钥。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listApps as listAppsDefault, resolveApp as resolveAppDefault } from './apps.js';
import { Capturer, captureModuleStatus } from './capture.js';
import { Chunks } from './chunks.js';
import { DEFAULTS, EVENT_TYPE, FRAME_MS, ID, SAMPLE_RATE, configGroup, text } from './config.js';
import { SileroSegmenter, ensureSileroModel, ensureSileroRuntime, modelState } from './silero.js';
import { Segmenter } from './vad.js';
import { encodeWav, formatKb, formatSeconds } from './wav.js';

const msg = (err) => (err instanceof Error ? err.message : String(err));
const asText = (value) => (typeof value === 'string' ? value.trim() : '');
const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 全部工具的声明（不含 handler）；定义里的 describe 与 `tools()` 都取它。 */
export const LISTEN_TOOL_DECLS = [
  {
    name: 'listen_act',
    tags: ['act'],
    description: 'Turn the Hearing world on or off. "start" begins capturing system audio (or one application) and delivers speech chunks as events; "stop" ends it. Each chunk arrives as an event with a WAV attachment; hand its handle to stt_transcribe when you want the words.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: 'start = begin listening, stop = end it.' },
        source: { type: 'string', enum: ['system', 'app'], description: 'For start only: overrides the configured source, system audio or one application.' },
        app: { type: 'string', description: 'For start with source=app: process name or PID string from listen_read action=source_list. Defaults to the configured application.' },
        minutes: { type: 'integer', description: 'For start only: auto-stop after this many minutes; 0 uses the configured value.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'listen_read',
    tags: ['read'],
    description: 'Read Hearing information without starting or stopping capture. source_list lists applications with Windows output audio sessions (including inactive sessions, not necessarily playing now), returning names, PIDs and window titles; use a PID string as app in listen_act action=start source=app. status reads listening state, target, counters, settings and last error. recent lists heard speech chunks and WAV attachment handles; hand a handle to stt_transcribe for text.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['source_list', 'status', 'recent'], description: 'source_list = applications with audio sessions; status = hearing status; recent = recent speech chunks.' },
        limit: { type: 'integer', description: 'For recent only: how many chunks to list (1-50); default 10.' },
      },
      required: ['action'],
    },
  },
];

export class ListenWorld {
  #host = null;
  #streams = new Set();
  #capture = null;
  #segmenter = null;
  #vadKind = '';
  #sileroPath = '';
  #chunks = null;
  #timer = null;
  #shipChain = Promise.resolve();
  #autoStopAt = 0;
  #emitTimes = [];
  #lastLevelAt = 0;
  #state = {
    listening: false,
    source: '',
    target: '',
    app: '',
    pid: 0,
    startedAt: '',
    frames: 0,
    audioMs: 0,
    chunks: 0,
    delivered: 0,
    archived: 0,
    failedEvents: 0,
    dropped: 0,
    throttled: 0,
    lastChunkAt: '',
    lastError: '',
  };

  constructor(opts = {}) {
    this.id = ID;
    this.cfg = opts.cfg ?? { ...DEFAULTS };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.botDir = opts.botDir ?? process.cwd();
    this.packageDir = opts.packageDir ?? process.cwd();
    this.language = 'zh';
    this.#now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.#setInterval = opts.timers?.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearInterval = opts.timers?.clearInterval ?? ((t) => clearInterval(t));
    this.#createCapture = typeof opts.createCapture === 'function'
      ? opts.createCapture
      : (o) => new Capturer(o);
    this.#captureStatus = typeof opts.captureStatus === 'function' ? opts.captureStatus : captureModuleStatus;
    this.#resolveApp = typeof opts.resolveApp === 'function' ? opts.resolveApp : resolveAppDefault;
    this.#listApps = typeof opts.listApps === 'function' ? opts.listApps : listAppsDefault;
    this.#sileroLoad = typeof opts.silero?.loadSherpa === 'function' ? opts.silero.loadSherpa : undefined;
    this.#fetch = typeof opts.silero?.fetchImpl === 'function' ? opts.silero.fetchImpl : undefined;
  }

  #now;
  #setInterval;
  #clearInterval;
  #createCapture;
  #captureStatus;
  #resolveApp;
  #listApps;
  #sileroLoad;
  #fetch;

  // -------------------------------------------------------------------------
  // 配置：config.json 的段被 WebUI 热改，每次用时现读
  // -------------------------------------------------------------------------

  #raw(key) {
    const value = this.cfg?.[key];
    return value === undefined || value === null ? DEFAULTS[key] : value;
  }

  #str(key) {
    const value = this.#raw(key);
    const s = typeof value === 'string' ? value.trim() : '';
    return s || String(DEFAULTS[key] ?? '');
  }

  #num(key, min, max) {
    const n = Number(this.#raw(key));
    if (!Number.isFinite(n)) return Number(DEFAULTS[key]) || min;
    return Math.min(Math.max(n, min), max);
  }

  #bool(key) {
    const value = this.#raw(key);
    return typeof value === 'boolean' ? value : Boolean(DEFAULTS[key]);
  }

  #text(language = this.language) {
    return text(language);
  }

  /** `worlds.listen.source`：system = 整个系统；app = 某个应用。 */
  #source() {
    return this.#str('source') === 'app' ? 'app' : 'system';
  }

  #vadConfig() {
    return {
      thresholdDb: this.#num('thresholdDb', -80, -10),
      minSpeechMs: this.#num('minSpeechMs', 50, 2000),
      silenceMs: this.#num('silenceMs', 150, 5000),
      maxUtteranceMs: this.#num('maxUtteranceMs', 2000, 120000),
      preRollMs: this.#num('preRollMs', 0, 1000),
      minUtteranceMs: this.#num('minUtteranceMs', 100, 5000),
    };
  }

  /** `worlds.listen.vad`：energy（默认，零依赖）或 silero（神经网络，需要模型）。 */
  #vadKindSetting() {
    return this.#str('vad') === 'silero' ? 'silero' : 'energy';
  }

  /** silero 的当前参数（热改由切分器自己重建生效）。 */
  #sileroConfig() {
    return {
      threshold: this.#num('sileroThreshold', 0.1, 0.9),
      minSpeechMs: this.#num('minSpeechMs', 50, 2000),
      silenceMs: this.#num('silenceMs', 150, 5000),
      maxUtteranceMs: this.#num('maxUtteranceMs', 2000, 120000),
      minUtteranceMs: this.#num('minUtteranceMs', 100, 5000),
    };
  }

  /** 模型的现状（同步看，不下载）。 */
  #modelState() {
    return modelState({
      cfgPath: this.#str('sileroModel'),
      dataDir: this.dataDir,
      packageDir: this.packageDir,
      botDir: this.botDir,
    });
  }

  /** 记录根目录：配置了就用配置的（相对路径按 bot 目录解析），否则 <dataDir>/listen。 */
  dir() {
    const raw = String(this.#raw('saveDir') ?? '').trim();
    if (!raw) return join(this.dataDir, 'listen');
    return isAbsolute(raw) ? raw : resolve(this.botDir, raw);
  }

  /** 语音块仓库：目录或保留条数变了就换一个实例（配置热改即时生效）。 */
  #chunksFor() {
    const dir = this.dir();
    const keep = this.#num('keep', 0, 5000);
    if (!this.#chunks || this.#chunks.dir !== dir) this.#chunks = new Chunks({ dir, keep });
    else this.#chunks.keep = keep;
    return this.#chunks;
  }

  /** 目标文案：系统声音 / 应用 Chrome。 */
  #targetLabel() {
    const s = this.#state;
    if (!s.listening) return '';
    if (s.source === 'app') return this.#text().targetApp(s.app || `PID ${s.pid}`);
    return this.#text().targetSystem;
  }

  /** 事件的稳定过滤键：来源 + 应用。 */
  #senderKey() {
    const s = this.#state;
    const app = s.source === 'app' && s.app ? `:${s.app.toLowerCase()}` : '';
    return `listen:${s.source || 'system'}${app}`;
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  envPromptVars() {
    return {};
  }

  tools() {
    return LISTEN_TOOL_DECLS.map((decl) => ({ ...decl, handler: (args, ctx) => this.#runTool(decl.name, args ?? {}, ctx) }));
  }

  async #runTool(name, args, ctx) {
    try {
      switch (name) {
        case 'listen_act': return await this.#toolListen(args);
        case 'listen_read': {
          switch (asText(args.action)) {
            case 'source_list': return await this.#toolList();
            case 'status': return this.#toolStatus();
            case 'recent': return this.#toolRecent(args);
            default: return { text: '[listen_read 没执行] action 要填 source_list、status 或 recent。', failed: true };
          }
        }
        default: return { text: `[${name} 没执行] 不认识这个工具。`, failed: true };
      }
    } catch (err) {
      this.#setError(msg(err));
      return { text: `[${name} 失败] ${msg(err)}`, failed: true };
    }
  }

  async #toolList() {
    const apps = await this.#listApps();
    if (!apps.length) return { text: '当前没有找到有音频会话的应用。尚未建立音频会话的软件不会列出；已知进程名或 PID 时仍可传给 listen_act。' };
    return { text: [
      '有音频会话的应用（含暂时未播放的会话，不代表当前正在发声）：',
      ...apps.map(({ name, pid, title }) => JSON.stringify({ name, pid, title })),
      '选择目标后调用 listen_act {"action":"start","source":"app","app":"<PID>"}，app 填上面的 PID 字符串。应用重启后请重新查询。',
    ].join('\n') };
  }

  async #toolListen(args) {
    const action = asText(args.action).toLowerCase();
    if (action === 'stop') {
      if (!this.#state.listening) return { text: '听觉已经关着。' };
      const s = this.#state;
      await this.#stopListening('tool');
      return { text: `听觉关了。这阵子听到 ${s.chunks} 块语音（${s.delivered} 块送达，${s.archived} 块只归档，${s.failedEvents} 块事件写入失败，${s.dropped} 个碎片被丢）。` };
    }
    if (action !== 'start') {
      return { text: '[listen_act 没执行] action 要填 start 或 stop；不想听就别调用。', failed: true };
    }
    if (this.#str('control') === 'console') {
      return { text: '[listen_act 没执行] 现在设置成只允许使用者从控制台打开听觉（worlds.listen.control = console）。请他到控制台「听觉 → 状态」里点「开始监听」；你可以用 listen_read action=status 看状态。', failed: true };
    }
    const source = asText(args.source) || this.#source();
    if (source !== 'system' && source !== 'app') {
      return { text: `[listen_act 没执行] source 只能是 system 或 app，给的是「${source}」。`, failed: true };
    }
    const app = asText(args.app) || this.#str('app');
    const minutes = Number(args.minutes);
    try {
      const s = await this.#startListening({
        source,
        app,
        minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
      });
      const lines = [`听觉打开了：${this.#text().stateListening(s.target)}。`];
      lines.push('语音块会作为事件送来（每块带一段 WAV 附件）；需要文字时把附件的 log: 句柄交给 stt_transcribe，不必每块都转。');
      if (s.wake === 'record') lines.push('当前是「只归档」：事件不唤醒你，用 listen_read action=recent 取最近的块。');
      if (s.autoStopAt) lines.push(`约 ${Math.round((new Date(s.autoStopAt).getTime() - this.#now()) / 60000)} 分钟后自动停止。`);
      return { text: lines.join('\n') };
    } catch (err) {
      return { text: `[listen_act 失败] ${msg(err)}`, failed: true };
    }
  }

  #toolRecent(args) {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const s = this.#state;
    const lines = [];
    lines.push(s.listening ? `听觉：${this.#text().stateListening(this.#targetLabel())}。` : '听觉：没在听。');
    const items = this.#chunksFor().list(limit);
    if (!items.length) {
      lines.push('还没有听到语音块。要现在开始听，用 listen_act {"action":"start"}（若允许），或请使用者在控制台「听觉 → 状态」里打开。');
      return { text: lines.join('\n') };
    }
    for (const item of items) {
      const bits = [
        `#${item.seq}`,
        this.#clock(item.at),
        formatSeconds(item.durationMs / 1000),
        item.target,
        item.handle || '（附件已不在）',
      ];
      if (item.forced) bits.push('被强切');
      if (item.deliveryError) bits.push(`事件写入失败：${item.deliveryError}`);
      else if (!item.delivered) bits.push('只归档');
      lines.push(bits.join(' · '));
    }
    lines.push('想要文字：把上面的 log: 句柄交给 stt_transcribe，例如 {"audio":"log:…wav"}。');
    return { text: lines.join('\n') };
  }

  #toolStatus() {
    const s = this.#snapshot();
    const lines = [];
    lines.push(s.listening ? `听觉：${this.#text().stateListening(s.target)}（${s.wake === 'record' ? '只归档' : '即时送达'}）。` : '听觉：没在听。');
    if (s.listening) lines.push(`开始于：${s.startedAt}${s.autoStopAt ? ` · 自动停止：${s.autoStopAt}` : ''}`);
    lines.push(`计数：${s.chunks} 块语音（送达 ${s.delivered}，归档 ${s.archived}，事件失败 ${s.failedEvents}，限速压掉 ${s.throttled}，碎片 ${s.dropped}）· 收帧 ${s.frames}（${formatSeconds(s.audioMs / 1000)}）。`);
    lines.push(`记录：${s.store.count} 块（${formatKb(s.store.totalBytes)}，重启也在；目录 ${s.store.dir}）。`);
    if (s.vad.kind === 'silero') {
      lines.push(`切分：silero（概率门限 ${s.vad.sileroThreshold}）· 起说 ${s.vad.minSpeechMs}ms · 收尾 ${s.vad.silenceMs}ms · 单块上限 ${s.vad.maxUtteranceMs}ms。`);
      lines.push(s.model.exists
        ? `模型：${s.model.path}（${Math.round(s.model.sizeBytes / 1024)} KB）。`
        : `模型：还没下载（${s.model.path}）——到控制台「听觉 → 状态」获取，或设置 worlds.listen.sileroModel。`);
    } else {
      lines.push(`切分：energy · 门限 ${s.vad.thresholdDb} dBFS · 起说 ${s.vad.minSpeechMs}ms · 收尾 ${s.vad.silenceMs}ms · 单块上限 ${s.vad.maxUtteranceMs}ms。`);
    }
    lines.push(`可选目标：source=system 或 source=app（app 填进程名或 PID，例如 chrome.exe）。`);
    lines.push(s.module.ok ? '采集模块：可用（loopback-capture）。' : `采集模块：不可用——${s.module.error}`);
    if (s.lastError) lines.push(`最近错误：${s.lastError}`);
    return { text: lines.join('\n') };
  }

  // -------------------------------------------------------------------------
  // 采集生命周期
  // -------------------------------------------------------------------------

  /**
   * 开始监听。
   * @param {{source?: 'system'|'app', app?: string, minutes?: number}} opts
   */
  async #startListening(opts = {}) {
    const source = opts.source === 'app' || opts.source === 'system' ? opts.source : this.#source();
    let appLabel = '';
    let pid = 0;
    let target = { source };

    if (this.#state.listening) {
      const s = this.#state;
      const wantedRaw = asText(opts.app) || this.#str('app');
      const sameApp = source === 'app'
        ? wantedRaw.replace(/\.exe$/i, '').toLowerCase() === s.app.toLowerCase()
        : true;
      if (s.source === source && sameApp) return this.#snapshot();
      await this.#stopListening('switch-target');
    }

    if (source === 'app') {
      const wanted = asText(opts.app) || this.#str('app');
      if (!wanted) {
        throw new Error('按应用采集需要应用：进程名（如 chrome.exe）或 PID。可在控制台「听觉 → 状态」里刷新应用列表并选择。');
      }
      const info = await this.#resolveApp(wanted);
      pid = info.pid;
      appLabel = String(info.name || wanted).replace(/\.exe$/i, '');
      target = { source: 'app', pid, name: info.name, title: info.title };
    }

    const moduleStatus = this.#captureStatus();
    if (!moduleStatus.ok) throw new Error(moduleStatus.error);

    const kind = this.#vadKindSetting();
    let segmenter;
    if (kind === 'silero') {
      const runtime = await ensureSileroRuntime({ dataDir: this.dataDir, load: this.#sileroLoad });
      // 模型可能在缓存里、也可能要下载一次；拿不到就带着方向报错（不静默退能量）。
      const model = await ensureSileroModel({
        cfgPath: this.#str('sileroModel'),
        dataDir: this.dataDir,
        packageDir: this.packageDir,
        botDir: this.botDir,
        fetchImpl: this.#fetch,
        timeoutMs: 60000,
        log: this.#host?.log,
      });
      segmenter = new SileroSegmenter({
        modelPath: model.path,
        sampleRate: SAMPLE_RATE,
        frameMs: FRAME_MS,
        loadSherpa: () => runtime,
        now: this.#now,
        log: this.#host?.log,
        ...this.#sileroConfig(),
      });
      this.#sileroPath = model.path;
    } else {
      segmenter = new Segmenter(this.#vadConfig(), FRAME_MS);
      this.#sileroPath = '';
    }
    this.#vadKind = kind;

    const capture = this.#createCapture({
      onFrame: (frame) => this.#onFrame(frame),
      onStatus: (event) => this.#onCaptureStatus(event),
    });
    try {
      capture.start(target);
    } catch (err) {
      try {
        capture.stop();
      } catch {
        /* 起都起不来，停失败也不报了 */
      }
      throw err;
    }

    const startedAtMs = this.#now();
    const minutesCfg = this.#num('autoStopMinutes', 0, 600);
    const minutes = opts.minutes ?? minutesCfg;
    this.#capture = capture;
    this.#segmenter = segmenter;
    this.#autoStopAt = minutes > 0 ? startedAtMs + minutes * 60_000 : 0;
    this.#emitTimes = [];
    this.#state = {
      listening: true,
      source,
      target: source === 'app' ? this.#text().targetApp(appLabel || `PID ${pid}`) : this.#text().targetSystem,
      app: appLabel,
      pid,
      startedAt: this.#iso(startedAtMs),
      frames: 0,
      audioMs: 0,
      chunks: 0,
      delivered: 0,
      archived: 0,
      failedEvents: 0,
      dropped: 0,
      throttled: 0,
      lastChunkAt: '',
      lastError: '',
    };
    this.#timer = this.#setInterval(() => this.#tick(), 250);
    this.#host?.log?.info?.('听觉开始监听', { source, app: appLabel, pid });
    this.#broadcast({ t: 'state', state: this.#snapshot() });
    return this.#snapshot();
  }

  async #stopListening(reason) {
    if (this.#timer) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    const capture = this.#capture;
    const segmenter = this.#segmenter;
    this.#capture = null;
    this.#segmenter = null;
    if (capture) capture.stop();
    if (segmenter) {
      try {
        const tail = segmenter.flush();
        for (const u of Array.isArray(tail) ? tail : (tail ? [tail] : [])) this.#queueShip(u);
        this.#state.dropped = segmenter.dropped;
      } catch (err) {
        this.#setError(`收尾时切分出错：${msg(err)}`);
      }
    }
    if (!this.#state.listening) return this.#snapshot();
    this.#state.listening = false;
    this.#autoStopAt = 0;
    this.#host?.log?.info?.('听觉停止监听', { reason, chunks: this.#state.chunks });
    this.#broadcast({ t: 'state', state: this.#snapshot() });
    await this.#shipChain;
    return this.#snapshot();
  }

  #tick() {
    const now = this.#now();
    const segmenter = this.#segmenter;
    if (!segmenter) return;
    try {
      segmenter.configure(this.#vadKind === 'silero' ? this.#sileroConfig() : this.#vadConfig());
      this.#state.dropped = segmenter.dropped;
      for (const u of segmenter.tick(now)) this.#queueShip(u);
    } catch (err) {
      this.#setError(`切分出错：${msg(err)}`);
      void this.#stopListening('segmenter-error').catch(() => {});
      return;
    }
    if (this.#autoStopAt && now >= this.#autoStopAt) {
      void this.#stopListening('auto-stop').catch((err) => this.#setError(msg(err)));
    }
  }

  #onFrame(frame) {
    const segmenter = this.#segmenter;
    if (!segmenter) return;
    this.#state.frames += 1;
    this.#state.audioMs += FRAME_MS;
    const now = this.#now();
    try {
      for (const u of segmenter.push(frame, now)) this.#queueShip(u);
      this.#state.dropped = segmenter.dropped;
    } catch (err) {
      this.#setError(`切分出错：${msg(err)}`);
      void this.#stopListening('segmenter-error').catch(() => {});
      return;
    }
    if (this.#bool('pushToConsole') && now - this.#lastLevelAt >= 100) {
      this.#lastLevelAt = now;
      this.#broadcast({ t: 'level', db: Math.round(segmenter.level * 10) / 10, active: segmenter.active });
    }
  }

  #onCaptureStatus(event) {
    if (event?.type === 'stop-error') {
      this.#host?.log?.warn?.('听觉：停止采集时报了错', { detail: event.detail });
    }
  }

  #queueShip(u) {
    this.#shipChain = this.#shipChain
      .then(() => this.#shipChunk(u))
      .catch((err) => this.#setError(msg(err)));
  }

  #setError(detail) {
    this.#state.lastError = `${new Date(this.#now()).toISOString()} ${detail}`;
    this.#host?.log?.warn?.('听觉出错', { detail });
    this.#broadcast({ t: 'error', message: detail });
  }

  // -------------------------------------------------------------------------
  // 送达：一块 = 一个事件（正文 + WAV 附件）
  // -------------------------------------------------------------------------

  async #shipChunk(u) {
    const now = this.#now();
    const wake = this.#str('wake') === 'record' ? 'record' : 'notify';
    const throttled = wake === 'notify' && this.#rateBlocked(now);
    const deliver = wake === 'notify' && !throttled;

    const bytes = encodeWav(u.pcm, SAMPLE_RATE);
    const seconds = u.durationMs / 1000;
    const targetLabel = this.#state.source === 'app'
      ? this.#text().targetApp(this.#state.app || `PID ${this.#state.pid}`)
      : this.#text().targetSystem;
    const forced = u.forced ? ' · 说得太长被切开' : '';
    const body = `听到一段语音：${seconds.toFixed(1)} 秒（${targetLabel}${forced}）`;
    // Both segmenters return an absolute wall-clock timestamp.
    const startedAt = new Date(u.startAt).toISOString();
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const at = new Date(now).toISOString();

    let handle = '';
    let eventSaved = false;
    let deliveryError = '';
    try {
      if (!this.#host?.pushEvent) throw new Error('事件宿主不可用');
      const envelope = await this.#host.pushEvent({
        type: EVENT_TYPE,
        source: this.id,
        senderKey: this.#senderKey(),
        ts: at,
        text: body,
        meta: {
          source: this.#state.source,
          app: this.#state.app,
          pid: this.#state.pid,
          durationMs: u.durationMs,
          startedAt,
          peakDb: Math.round(u.peakDb * 10) / 10,
          forced: u.forced,
          throttled,
        },
        blobs: [{
          bytes,
          mime: 'audio/wav',
          name: `listen-${stamp}.wav`,
          fallbackText: `一段 ${seconds.toFixed(1)} 秒的语音（${targetLabel}）`,
        }],
      }, { deliver, trigger: 'debounce' });
      handle = envelope?.blobs?.[0]?.handle ?? '';
      eventSaved = true;
      if (deliver) this.#emitTimes.push(now);
    } catch (err) {
      deliveryError = msg(err);
      this.#setError(`事件没送出去：${deliveryError}`);
    }

    // 记录进仓库：每块一个 WAV 文件 + 索引；写不进去只记错，不挡采集。
    let item = null;
    try {
      item = this.#chunksFor().add({
        bytes,
        mime: 'audio/wav',
        durationMs: u.durationMs,
        startedAt,
        at,
        source: this.#state.source,
        app: this.#state.app,
        target: targetLabel,
        handle,
        forced: u.forced,
        peakDb: Math.round(u.peakDb * 10) / 10,
        delivered: deliver && eventSaved,
        deliveryError,
      });
    } catch (err) {
      this.#setError(`记进仓库失败：${msg(err)}`);
    }

    this.#state.chunks += 1;
    if (!eventSaved) this.#state.failedEvents += 1;
    else if (deliver) this.#state.delivered += 1;
    else this.#state.archived += 1;
    if (throttled) this.#state.throttled += 1;
    this.#state.lastChunkAt = at;
    if (item && this.#bool('pushToConsole')) {
      this.#broadcast({ t: 'chunk', chunk: item, count: this.#chunksFor().count });
    }
    return item;
  }

  /** 每 60 秒最多即时投递多少块；超出只归档。 */
  #rateBlocked(now) {
    const cap = this.#num('maxEventsPerMinute', 0, 600);
    if (!cap) return false;
    const cutoff = now - 60_000;
    this.#emitTimes = this.#emitTimes.filter((t) => t > cutoff);
    return this.#emitTimes.length >= cap;
  }

  #clock(iso) {
    try {
      return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
      return iso;
    }
  }

  #iso(ms) {
    return new Date(ms).toISOString();
  }

  // -------------------------------------------------------------------------
  // WebUI
  // -------------------------------------------------------------------------

  #snapshot() {
    const s = this.#state;
    return {
      listening: s.listening,
      source: s.source,
      target: s.target,
      app: s.app,
      pid: s.pid,
      startedAt: s.startedAt,
      autoStopAt: this.#autoStopAt ? this.#iso(this.#autoStopAt) : '',
      frames: s.frames,
      audioMs: s.audioMs,
      chunks: s.chunks,
      delivered: s.delivered,
      archived: s.archived,
      failedEvents: s.failedEvents,
      dropped: s.dropped,
      throttled: s.throttled,
      lastChunkAt: s.lastChunkAt,
      lastError: s.lastError,
      wake: this.#str('wake'),
      control: this.#str('control'),
      maxEventsPerMinute: this.#num('maxEventsPerMinute', 0, 600),
      store: {
        dir: this.dir(),
        indexFile: this.#chunksFor().indexFile,
        keep: this.#num('keep', 0, 5000),
        count: this.#chunksFor().count,
        totalBytes: this.#chunksFor().totalBytes,
        totalDurationMs: this.#chunksFor().totalDurationMs,
      },
      vad: {
        kind: this.#state.listening ? this.#vadKind : this.#vadKindSetting(),
        ...this.#vadConfig(),
        sileroThreshold: this.#num('sileroThreshold', 0.1, 0.9),
      },
      model: this.#modelState(),
      module: captureModuleStatus(),
      node: process.version,
      platform: process.platform,
    };
  }

  webUi(language = 'zh') {
    this.language = language === 'en' ? 'en' : 'zh';
    const t = this.#text();
    const s = this.#snapshot();
    const ok = s.module.ok;
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: s.listening ? 'online' : (ok ? 'offline' : 'error'),
        hint: s.listening ? t.stateListening(s.target) : (ok ? t.stateIdle : t.stateError(s.module.error)),
      }],
      badges: [
        { label: t.badgeState, value: s.listening ? s.vad.kind : t.off, tone: s.listening ? 'on' : 'off' },
        { label: t.badgeChunks, value: String(s.store.count), tone: s.store.count ? 'on' : 'off' },
        { label: t.badgeTarget, value: s.listening ? s.target : '—', tone: s.listening ? 'on' : 'off' },
      ],
      panels: [
        { id: 'chunks', title: t.panelChunksTitle, description: t.panelChunksDesc, getMethods: ['list'] },
        { id: 'status', title: t.panelStatusTitle, description: t.panelStatusDesc, getMethods: ['state'] },
      ],
      config: [configGroup(language)],
      promptDocs: [{
        key: `worlds.${ID}.env`,
        title: t.label,
        path: ENV_PROMPT,
        role: 'envPrompt',
        vars: [],
      }],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => this.stream(panel, socket),
    };
  }

  async invoke(panel, method, args = []) {
    const list = Array.isArray(args) ? args : [args];
    if (panel === 'chunks') {
      switch (method) {
        case 'list': return this.#listChunks(list[0]);
        case 'clear': return this.#clearChunks();
        case 'remove': return this.#removeChunk(list[0]);
        case 'preview': return this.#previewChunk(list[0]);
        case 'openFolder': return this.#openFolder();
        default: throw new Error(`未知面板方法：chunks.${method}`);
      }
    }
    if (panel === 'status') {
      switch (method) {
        case 'state': return this.#snapshot();
        case 'start': return this.#invokeStart(list);
        case 'stop': {
          await this.#stopListening('console');
          return { ok: true, state: this.#snapshot() };
        }
        case 'apps': return { apps: await this.#listApps() };
        case 'model': return { model: this.#modelState() };
        case 'prepareModule': {
          if (list[0] !== 'silero' && list[0] !== 'energy') throw new Error('未知听觉模块');
          if (this.#state.listening) throw new Error('请先停止监听再切换听觉模块。');
          if (list[0] === 'silero') {
            const onProgress = (stage) => this.#broadcast({ t: 'module-progress', stage });
            await ensureSileroRuntime({ dataDir: this.dataDir, load: this.#sileroLoad, onProgress });
            await ensureSileroModel({ cfgPath: this.#str('sileroModel'), dataDir: this.dataDir,
              packageDir: this.packageDir, botDir: this.botDir, fetchImpl: this.#fetch, log: this.#host?.log, onProgress });
            onProgress('ready');
          }
          return { ok: true };
        }
        case 'fetchModel': {
          const model = await ensureSileroModel({
            cfgPath: this.#str('sileroModel'),
            dataDir: this.dataDir,
            packageDir: this.packageDir,
            botDir: this.botDir,
            fetchImpl: this.#fetch,
            timeoutMs: 300000,
            log: this.#host?.log,
          });
          return { ok: true, model };
        }
        default: throw new Error(`未知面板方法：status.${method}`);
      }
    }
    throw new Error(`未知面板：${panel}`);
  }

  async #invokeStart([source, app, minutes]) {
    const s = await this.#startListening({
      source: source === 'app' || source === 'system' ? source : undefined,
      app: asText(app) || undefined,
      minutes: Number(minutes) > 0 ? Number(minutes) : undefined,
    });
    return { ok: true, state: s };
  }

  #listChunks(limit) {
    const n = Math.min(Math.max(Number(limit) || 60, 1), 500);
    const store = this.#chunksFor().summary(n);
    return { state: this.#snapshot(), ...store };
  }

  #clearChunks() {
    const removed = this.#chunksFor().clear();
    this.#broadcast({ t: 'cleared' });
    return { ok: true, removed, ...this.#chunksFor().summary(60) };
  }

  #removeChunk(ref) {
    const ok = this.#chunksFor().remove(ref);
    if (ok) this.#broadcast({ t: 'removed', id: asText(String(ref ?? '')) });
    return { ok, ...this.#chunksFor().summary(60) };
  }

  /** 试听：读仓库里那份自己的 WAV 文件（$file 交给框架按路径送字节）。 */
  #previewChunk(ref) {
    const item = this.#chunksFor().get(ref);
    if (!item) throw new Error('找不到这块语音。');
    let stat = null;
    try {
      stat = statSync(item.path);
    } catch {
      throw new Error('音频文件不在了（被手动删过？）。');
    }
    const sha256 = createHash('sha256').update(readFileSync(item.path)).digest('hex');
    return { $file: { mime: item.mime, path: item.path, bytes: stat.size, sha256 } };
  }

  /** 在资源管理器里打开记录目录。 */
  #openFolder() {
    const dir = this.dir();
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不出来也让面板看到路径 */
    }
    if (process.platform !== 'win32') return { ok: false, dir, detail: '只会在 Windows 上打开资源管理器' };
    try {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, dir };
    } catch (err) {
      return { ok: false, dir, detail: msg(err) };
    }
  }

  stream(panel, socket) {
    if (panel !== 'chunks' && panel !== 'status') {
      try {
        socket.close(`未知面板：${panel}`);
      } catch {
        /* ignore */
      }
      return;
    }
    const peer = {
      panel,
      send: (frame) => {
        try {
          if (socket.open) socket.send(JSON.stringify(frame));
        } catch {
          /* 连接断了就算了，面板会自己重连。 */
        }
      },
    };
    this.#streams.add(peer);
    try {
      socket.onClose(() => this.#streams.delete(peer));
      socket.onMessage(() => { /* 面板只用 HTTP 请求，回帧不处理。 */ });
    } catch {
      /* 宿主实现不支持回调也不影响单向推送。 */
    }
    peer.send({ t: 'ready', count: this.#chunksFor().count });
    peer.send({ t: 'state', state: this.#snapshot() });
  }

  #broadcast(frame) {
    for (const peer of this.#streams) peer.send(frame);
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(host) {
    this.#host = host;
    try {
      this.#chunksFor().ensure();
    } catch (err) {
      this.#host?.log?.warn?.('听觉：记录目录建不出来', { err: msg(err) });
    }
    this.#host?.log?.info?.('听觉已就绪', {
      platform: process.platform,
      module: captureModuleStatus().ok ? '可用' : '不可用',
      source: this.#source(),
      control: this.#str('control'),
      wake: this.#str('wake'),
      dir: this.dir(),
      records: this.#chunksFor().count,
    });
  }

  async stop() {
    await this.#stopListening('world-stop');
    this.#streams.clear();
    this.#host = null;
  }
}
