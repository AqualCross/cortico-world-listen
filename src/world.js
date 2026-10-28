/**
 * 听觉 World。
 *
 * 一件事：把系统声音（或若干个应用的音频）切成语音块，作为事件送进 cortico
 * 事件流。每块事件正文说明时长与来源，附件是一段 16 kHz 单声道 WAV——
 * agent 想读文字时把附件句柄交给 `stt_transcribe`，这里**不做**转写。
 *
 * 每一路来源有自己的采集与切分器，切分方式按来源各自选（energy / silero /
 * firered）；参数仍共用一套。采集走 `loopback-capture`（Windows WASAPI）；
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
import { AED_LABELS, FireRedAedClassifier, aedModeOf, aedShouldDeliver, ensureFireRedAedModel } from './firered-aed.js';
import { FireRedSegmenter, ensureFireRedModel, fireRedModelState, loadOnnxRuntime } from './firered.js';
import { SileroSegmenter, ensureSileroModel, ensureSileroRuntime, modelState } from './silero.js';
import { ToolTextStore } from './tool-text.js';
import { Segmenter } from './vad.js';
import { encodeWav, formatKb, formatSeconds } from './wav.js';

const msg = (err) => (err instanceof Error ? err.message : String(err));
const asText = (value) => (typeof value === 'string' ? value.trim() : '');
const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const VAD_KINDS = new Set(['energy', 'silero', 'firered']);
const ALIVE_CHECK_MS = 2000;
/** 进程还在吗；没有权限打开也算在（EPERM）。 */
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};
const vadKindOf = (value, fallback) => (VAD_KINDS.has(value) ? value : fallback);
const normApp = (value) => String(value ?? '').trim().toLowerCase().replace(/\.exe$/i, '');

/** 全部工具的声明（不含 handler）；定义里的 describe 与 `tools()` 都取它。 */
export const LISTEN_TOOL_DECLS = [
  {
    name: 'listen_act',
    tags: ['act'],
    summary: {
      zh: '打开或关掉听觉：开始/停止监听系统声音或若干应用的音频。',
      en: 'Turn hearing on or off: start/stop listening to system audio or several applications.',
    },
    description: 'Turn the Hearing world on or off. "start" captures system audio or one or more applications and delivers speech chunks as events; "stop" ends it. Each chunk arrives as an event with a WAV attachment; hand its handle to stt_transcribe when you want the words.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: 'start = begin listening, stop = end it.' },
        source: { type: 'string', enum: ['system', 'apps'], description: 'Required for start unless apps is given: system audio or applications.' },
        apps: {
          type: 'array',
          items: { type: 'string' },
          description: 'For start with source=apps: process names or PID strings from listen_read action=source_list. Several entries listen to several applications at once; at least one is required.',
        },
        vad: { type: 'string', enum: ['energy', 'silero', 'firered'], description: 'For start with source=apps: segmentation for every application listed here. Defaults to each application\'s configured choice.' },
        minutes: { type: 'integer', description: 'For start only: auto-stop after this many minutes; 0 uses the configured value.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'listen_read',
    tags: ['read'],
    summary: {
      zh: '查询听觉：音频会话应用列表、监听状态或最近语音块。',
      en: 'Read Hearing information: applications with audio sessions, listening status or recent speech chunks.',
    },
    description: 'Read Hearing information without starting or stopping capture. source_list lists applications with Windows output audio sessions (including inactive sessions, not necessarily playing now), returning names, PIDs and window titles; use PID strings in listen_act action=start source=apps apps=[...]. status reads listening state, each source, counters, settings and last error. recent lists heard speech chunks and WAV attachment handles; hand a handle to stt_transcribe for text.',
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
  /** key（system / app:<pid>）→ 这一路的采集、切分与计数。 */
  #sources = new Map();
  /** 本轮里因进程退出而停掉的路；计数仍并入合计。 */
  #retired = [];
  #signature = '';
  #lastAliveAt = 0;
  #aed = null;
  #aedCreate = null;
  #chunks = null;
  #timer = null;
  #shipChain = Promise.resolve();
  #autoStopAt = 0;
  #emitTimes = [];
  #state = {
    listening: false,
    startedAt: '',
    lastChunkAt: '',
    lastError: '',
  };

  constructor(opts = {}) {
    this.id = ID;
    this.cfg = opts.cfg ?? { ...DEFAULTS };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.botDir = opts.botDir ?? process.cwd();
    this.packageDir = opts.packageDir ?? process.cwd();
    this.toolText = new ToolTextStore(LISTEN_TOOL_DECLS, { botDir: this.botDir, packageDir: this.packageDir, id: ID });
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
    this.#pidAlive = typeof opts.pidAlive === 'function' ? opts.pidAlive : pidAlive;
    this.#sileroLoad = typeof opts.silero?.loadSherpa === 'function' ? opts.silero.loadSherpa : undefined;
    this.#fetch = typeof opts.silero?.fetchImpl === 'function' ? opts.silero.fetchImpl : undefined;
    this.#aedCreate = typeof opts.aed?.create === 'function' ? opts.aed.create : null;
  }

  #now;
  #setInterval;
  #clearInterval;
  #createCapture;
  #captureStatus;
  #resolveApp;
  #listApps;
  #pidAlive;
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

  /** `worlds.listen.source`：system = 整个系统；apps = 一个或多个应用（旧值 app 视同 apps）。 */
  #sourceSetting() {
    const value = this.#str('source');
    return value === 'apps' || value === 'app' ? 'apps' : 'system';
  }

  /** 没有单独指定切分方式的来源用的类型：`worlds.listen.vad`。 */
  #vadDefault() {
    return vadKindOf(this.#str('vad'), 'energy');
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

  /** 块级三分类的当前模式：off / tag / voice。 */
  #aedMode() {
    return aedModeOf(this.#str('aedMode'));
  }

  /** 神经网络切分器的当前参数（热改由切分器自己重建生效）。 */
  #neuralConfig(kind = 'silero') {
    return {
      threshold: this.#num(kind === 'firered' ? 'fireredThreshold' : 'sileroThreshold', 0.1, 0.9),
      minSpeechMs: this.#num('minSpeechMs', 50, 2000),
      silenceMs: this.#num('silenceMs', 150, 5000),
      maxUtteranceMs: this.#num('maxUtteranceMs', 2000, 120000),
      minUtteranceMs: this.#num('minUtteranceMs', 100, 5000),
    };
  }

  /** 模型配置键：sileroModel / fireredModel。 */
  #modelCfgPath(kind = 'silero') {
    return this.#str(kind === 'firered' ? 'fireredModel' : 'sileroModel');
  }

  /** 模型的现状（同步看，不下载）。 */
  #modelState(kind = this.#vadDefault()) {
    if (kind === 'firered') {
      return fireRedModelState({
        cfgPath: this.#modelCfgPath('firered'),
        dataDir: this.dataDir,
        packageDir: this.packageDir,
        botDir: this.botDir,
      });
    }
    return modelState({
      cfgPath: this.#str('sileroModel'),
      dataDir: this.dataDir,
      packageDir: this.packageDir,
      botDir: this.botDir,
    });
  }

  /** 0.5.0 之前的单应用配置键，0.6 起由 `apps` 取代；读到时仍作为唯一目标。 */
  #legacyApp() {
    const value = this.cfg?.app;
    return typeof value === 'string' ? value.trim() : '';
  }

  /** `worlds.listen.apps`：逗号分隔；每项可写 `name=vad` 单独指定切分方式。 */
  #parseApps(raw) {
    const list = [];
    for (const part of String(raw ?? '').split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      const at = entry.indexOf('=');
      const app = at >= 0 ? entry.slice(0, at).trim() : entry;
      const vad = at >= 0 ? entry.slice(at + 1).trim().toLowerCase() : '';
      if (!app) continue;
      // 不认识的类型后缀留在名字里，让解析进程时把问题报出来，而不是静默改目标。
      list.push(at >= 0 && !VAD_KINDS.has(vad) ? { app: entry, vad: '' } : { app, vad });
    }
    return list;
  }

  /** 配置里的应用目标（补齐默认切分方式）。 */
  #configuredAppTargets() {
    const parsed = this.#parseApps(this.#raw('apps'));
    const list = parsed.length
      ? parsed
      : (this.#legacyApp() ? [{ app: this.#legacyApp(), vad: '' }] : []);
    return list.map(({ app, vad }) => ({ app, vad: vad || this.#vadDefault() }));
  }

  /** 按配置得到的目标清单；系统声音是一路，应用各自一路。 */
  #targetsFromConfig() {
    if (this.#sourceSetting() === 'system') return [{ source: 'system', vad: this.#vadDefault() }];
    return this.#configuredAppTargets().map(({ app, vad }) => ({ source: 'app', app, vad }));
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

  /** 事件的稳定过滤键：来源 + 应用。 */
  #senderKey(src) {
    const app = src.source === 'app' && src.app ? `:${src.app.toLowerCase()}` : '';
    return `listen:${src.source}${app}`;
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  envPromptVars() {
    return {};
  }

  tools() {
    return this.toolText.resolve().map((tool) => ({
      ...tool,
      handler: (args, ctx) => this.#runTool(tool.name, args ?? {}, ctx),
    }));
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
      '选择目标后调用 listen_act {"action":"start","source":"apps","apps":["<PID>"]}，可以给多个 PID 同时听。应用重启后请重新查询。',
    ].join('\n') };
  }

  async #toolListen(args) {
    const action = asText(args.action).toLowerCase();
    if (action === 'stop') {
      if (!this.#state.listening) return { text: '听觉已经关着。' };
      await this.#stopListening('tool');
      const s = this.#snapshot();
      return { text: `听觉关了。这阵子听到 ${s.chunks} 块语音（${s.delivered} 块送达，${s.archived} 块只归档，${s.failedEvents} 块事件写入失败，${s.dropped} 个碎片被丢）。` };
    }
    if (action !== 'start') {
      return { text: '[listen_act 没执行] action 要填 start 或 stop；不想听就别调用。', failed: true };
    }
    if (this.#str('control') === 'console') {
      return { text: '[listen_act 没执行] 现在设置成只允许使用者从控制台打开听觉（worlds.listen.control = console）。请他到控制台「听觉 → 来源」里勾选来源；你可以用 listen_read action=status 看状态。', failed: true };
    }
    const given = Array.isArray(args.apps)
      ? args.apps.map(asText).filter(Boolean)
      : asText(args.apps) ? String(args.apps).split(',').map((v) => v.trim()).filter(Boolean) : [];
    const sourceArg = asText(args.source).toLowerCase();
    let source = sourceArg === 'apps' || sourceArg === 'app'
      ? 'apps'
      : sourceArg === 'system' ? 'system' : '';
    if (!source && given.length) source = 'apps';
    if (!source) {
      return { text: '[listen_act 没执行] start 要说明听什么：source 填 system，或 source=apps 并在 apps 里给进程名 / PID。', failed: true };
    }
    if (source === 'apps' && !given.length) {
      return { text: '[listen_act 没执行] source=apps 要在 apps 里给至少一个进程名或 PID；可先用 listen_read action=source_list 查。', failed: true };
    }
    const vad = vadKindOf(asText(args.vad).toLowerCase(), '');
    const minutes = Number(args.minutes);
    const configured = this.#configuredAppTargets();
    const targets = source === 'system'
      ? [{ source: 'system', vad: this.#vadDefault() }]
      // 没有统一指定 vad 时，用同一个应用在配置里的选择。
      : given.map((app) => ({
        source: 'app',
        app,
        vad: vad || configured.find((item) => normApp(item.app) === normApp(app))?.vad || '',
      }));
    try {
      const s = await this.#startListening({
        targets,
        minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
      });
      const lines = [`听觉打开了：${s.target}。`];
      if (s.sources.length > 1) lines.push(`同时听 ${s.sources.length} 路，每路的语音块单独送达。`);
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
    lines.push(s.listening ? `听觉：${this.#text().stateListening(this.#snapshot().target)}。` : '听觉：没在听。');
    const items = this.#chunksFor().list(limit);
    if (!items.length) {
      lines.push('还没有听到语音块。要现在开始听，用 listen_act {"action":"start"}（若允许），或请使用者在控制台「听觉 → 来源」里勾选。');
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
    if (s.listening) {
      lines.push(`开始于：${s.startedAt}${s.autoStopAt ? ` · 自动停止：${s.autoStopAt}` : ''}`);
      for (const src of s.sources) {
        const bits = [
          src.target,
          formatSeconds(src.audioMs / 1000),
          src.vad,
          `${src.chunks} 块（送达 ${src.delivered}，归档 ${src.archived}${src.failedEvents ? `，事件失败 ${src.failedEvents}` : ''}${src.throttled ? `，限速 ${src.throttled}` : ''}${src.dropped ? `，碎片 ${src.dropped}` : ''}）`,
        ];
        if (src.lastError) bits.push(`错误：${src.lastError}`);
        lines.push(`· ${bits.join(' · ')}`);
      }
    }
    lines.push(`计数：${s.chunks} 块语音（送达 ${s.delivered}，归档 ${s.archived}，事件失败 ${s.failedEvents}，限速压掉 ${s.throttled}，碎片 ${s.dropped}）· 收帧 ${s.frames}（${formatSeconds(s.audioMs / 1000)}）。`);
    lines.push(`记录：${s.store.count} 块（${formatKb(s.store.totalBytes)}，重启也在；目录 ${s.store.dir}）。`);
    const kinds = new Set(s.sources.length ? s.sources.map((src) => src.vad) : [s.vad.kind]);
    if (s.sources.length) lines.push(`切分：${s.sources.map((src) => `${src.target}=${src.vad}`).join('、')}。`);
    for (const kind of kinds) {
      if (kind === 'silero' || kind === 'firered') {
        const model = this.#modelState(kind);
        const threshold = kind === 'firered'
          ? this.#num('fireredThreshold', 0.1, 0.9)
          : this.#num('sileroThreshold', 0.1, 0.9);
        lines.push(`${kind}：概率门限 ${threshold} · 模型 ${model.exists ? model.path : `还没下载（${model.path}）`}。`);
      } else {
        lines.push(`energy：门限 ${this.#num('thresholdDb', -80, -10)} dBFS · 起说 ${this.#num('minSpeechMs', 50, 2000)}ms · 收尾 ${this.#num('silenceMs', 150, 5000)}ms · 单块上限 ${this.#num('maxUtteranceMs', 2000, 120000)}ms。`);
      }
    }
    if (this.#aedMode() !== 'off') {
      const ready = s.listening && !this.#aed ? ' · 模型不可用' : '';
      lines.push(`区分：音乐/说话（${this.#aedMode()}${ready}）${this.#aedMode() === 'voice' ? '；纯音乐块只归档' : ''}。`);
    }
    lines.push(`可选目标：source=system 或 source=apps（apps 给一个或多个进程名 / PID，例如 ["chrome.exe","30064"]）。`);
    lines.push(s.module.ok ? '采集模块：可用（loopback-capture）。' : `采集模块：不可用——${s.module.error}`);
    if (s.lastError) lines.push(`最近错误：${s.lastError}`);
    return { text: lines.join('\n') };
  }

  // -------------------------------------------------------------------------
  // 采集生命周期
  // -------------------------------------------------------------------------

  /**
   * 开始监听；目标必须明确给出，不拿配置兜底。
   * @param {{targets: Array<{source: 'system'|'app', app?: string, vad?: string}>, minutes?: number}} opts
   */
  async #startListening(opts = {}) {
    const raw = Array.isArray(opts.targets)
      ? opts.targets.map((t) => ({
        source: t?.source === 'system' ? 'system' : 'app',
        app: asText(t?.app),
        vad: vadKindOf(asText(t?.vad), ''),
      }))
      : [];
    const targets = await this.#normalizeTargets(raw);
    const signature = targets.map((t) => `${t.key}:${t.vad}`).join('|');
    if (this.#state.listening) {
      if (signature === this.#signature) return this.#snapshot();
      await this.#stopListening('switch-target');
    }

    const moduleStatus = this.#captureStatus();
    if (!moduleStatus.ok) throw new Error(moduleStatus.error);

    const kinds = new Set(targets.map((t) => t.vad));
    let sileroRuntime = null;
    let sileroModelPath = '';
    if (kinds.has('silero')) {
      sileroRuntime = await ensureSileroRuntime({ dataDir: this.dataDir, load: this.#sileroLoad });
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
      sileroModelPath = model.path;
    }
    let fireredModel = null;
    if (kinds.has('firered')) {
      loadOnnxRuntime();
      fireredModel = await ensureFireRedModel({
        cfgPath: this.#modelCfgPath('firered'),
        dataDir: this.dataDir,
        packageDir: this.packageDir,
        botDir: this.botDir,
        fetchImpl: this.#fetch,
        timeoutMs: 180000,
        log: this.#host?.log,
      });
    }

    // 块级三分类是可选的：模型缺失/装不上只警告，不让监听失败。
    this.#aed = null;
    if (this.#aedMode() !== 'off') {
      try {
        if (this.#aedCreate) {
          this.#aed = await this.#aedCreate();
        } else {
          const aedModel = await ensureFireRedAedModel({
            cfgPath: this.#modelCfgPath('firered'),
            dataDir: this.dataDir,
            packageDir: this.packageDir,
            botDir: this.botDir,
            fetchImpl: this.#fetch,
            log: this.#host?.log,
          });
          this.#aed = await FireRedAedClassifier.create({
            modelPath: aedModel.path,
            cmvnPath: aedModel.cmvnPath,
          });
        }
      } catch (err) {
        this.#host?.log?.warn?.('听觉：音乐/说话区分不可用', { detail: msg(err) });
      }
    }

    const sources = [];
    const started = [];
    try {
      for (const t of targets) {
        const src = {
          key: t.key,
          source: t.source,
          app: t.app,
          pid: t.pid,
          target: t.label,
          vad: t.vad,
          capture: null,
          segmenter: null,
          frames: 0,
          audioMs: 0,
          chunks: 0,
          delivered: 0,
          archived: 0,
          failedEvents: 0,
          throttled: 0,
          dropped: 0,
          level: -100,
          active: false,
          lastError: '',
        };
        src.segmenter = await this.#createSegmenter(src, { sileroRuntime, sileroModelPath, fireredModel });
        const capture = this.#createCapture({
          onFrame: (frame) => this.#onFrame(src, frame),
          onStatus: (event) => this.#onCaptureStatus(src, event),
        });
        src.capture = capture;
        sources.push(src);
        capture.start(t.source === 'system' ? { source: 'system' } : { source: 'app', pid: t.pid });
        started.push(capture);
      }
    } catch (err) {
      for (const capture of started) {
        try {
          capture.stop();
        } catch {
          /* 起都起不来，停失败也不报了 */
        }
      }
      this.#aed = null;
      throw err;
    }

    const startedAtMs = this.#now();
    const minutesCfg = this.#num('autoStopMinutes', 0, 600);
    const minutes = opts.minutes ?? minutesCfg;
    this.#sources = new Map(sources.map((src) => [src.key, src]));
    this.#retired = [];
    this.#lastAliveAt = 0;
    this.#signature = signature;
    this.#autoStopAt = minutes > 0 ? startedAtMs + minutes * 60_000 : 0;
    this.#emitTimes = [];
    this.#state = {
      listening: true,
      startedAt: this.#iso(startedAtMs),
      lastChunkAt: '',
      lastError: '',
    };
    this.#timer = this.#setInterval(() => this.#tick(), 250);
    this.#host?.log?.info?.('听觉开始监听', {
      sources: sources.map((src) => ({
        target: src.target,
        app: src.app,
        pid: src.pid,
        vad: src.vad,
        // 两种切分器的门限单位不同：概率 vs dBFS。
        ...(src.vad === 'silero'
          ? { sileroThreshold: this.#num('sileroThreshold', 0.1, 0.9) }
          : src.vad === 'firered'
            ? { fireredThreshold: this.#num('fireredThreshold', 0.1, 0.9) }
            : { thresholdDb: this.#num('thresholdDb', -80, -10) }),
      })),
      wake: this.#str('wake'),
      control: this.#str('control'),
    });
    this.#broadcast({ t: 'state', state: this.#snapshot() });
    return this.#snapshot();
  }

  /** 目标清单 → 可开始的来源（解析应用 PID、合并重复 PID、补齐切分方式）。 */
  async #normalizeTargets(raw) {
    const out = [];
    const seen = new Set();
    for (const t of raw) {
      if (t.source === 'system') {
        if (out.length) throw new Error('系统声音已经包含所有应用：系统声音与应用不能一起选。');
        out.push({
          key: 'system',
          source: 'system',
          app: '',
          pid: 0,
          label: this.#text().targetSystem,
          vad: vadKindOf(t.vad, this.#vadDefault()),
        });
        continue;
      }
      if (out.some((s) => s.source === 'system')) {
        throw new Error('系统声音已经包含所有应用：系统声音与应用不能一起选。');
      }
      const wanted = asText(t.app);
      if (!wanted) {
        throw new Error('按应用采集需要应用：进程名（如 chrome.exe）或 PID。可在控制台「听觉 → 来源」里勾选，或调用 listen_read action=source_list。');
      }
      const info = await this.#resolveApp(wanted);
      const pid = Number(info.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`应用「${wanted}」解析出的 PID 不合形状。`);
      if (seen.has(pid)) continue;
      seen.add(pid);
      const app = String(info.name || wanted).replace(/\.exe$/i, '');
      out.push({
        key: `app:${pid}`,
        source: 'app',
        app,
        pid,
        label: this.#text().targetApp(app),
        vad: vadKindOf(t.vad, this.#vadDefault()),
      });
    }
    if (!out.length) {
      throw new Error('没有可监听的目标：选系统声音，或至少一个应用（控制台「听觉 → 来源」里勾选，或 listen_read action=source_list 查 PID）。');
    }
    return out;
  }

  /** 每一路自己的切分器；silero 共用运行组件、firered 各建一个会话。 */
  async #createSegmenter(src, resources) {
    if (src.vad === 'silero') {
      return new SileroSegmenter({
        modelPath: resources.sileroModelPath,
        sampleRate: SAMPLE_RATE,
        frameMs: FRAME_MS,
        loadSherpa: () => resources.sileroRuntime,
        now: this.#now,
        log: this.#host?.log,
        ...this.#neuralConfig('silero'),
      });
    }
    if (src.vad === 'firered') {
      return FireRedSegmenter.create({
        modelPath: resources.fireredModel.path,
        cmvnPath: resources.fireredModel.cmvnPath,
        sampleRate: SAMPLE_RATE,
        frameMs: FRAME_MS,
        now: this.#now,
        log: this.#host?.log,
        ...this.#neuralConfig('firered'),
        onUtterance: (u) => this.#queueShip(u, src),
        onError: (err) => this.#setError(`切分出错：${msg(err)}`, src),
      });
    }
    return new Segmenter(this.#vadConfig(), FRAME_MS);
  }

  async #stopListening(reason) {
    if (this.#timer) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    const sources = [...this.#sources.values()];
    for (const src of sources) {
      const capture = src.capture;
      src.capture = null;
      if (capture) capture.stop();
    }
    for (const src of sources) {
      const segmenter = src.segmenter;
      src.segmenter = null;
      if (!segmenter) continue;
      try {
        const tail = segmenter.flush();
        const list = tail && typeof tail.then === 'function' ? await tail : tail;
        for (const u of Array.isArray(list) ? list : (list ? [list] : [])) this.#queueShip(u, src);
        src.dropped = segmenter.dropped;
      } catch (err) {
        this.#setError(`收尾时切分出错：${msg(err)}`, src);
      }
    }
    this.#aed = null;
    if (!this.#state.listening) return this.#snapshot();
    const agg = this.#aggregate();
    this.#state.listening = false;
    this.#autoStopAt = 0;
    this.#signature = '';
    for (const src of sources) {
      src.level = -100;
      src.active = false;
    }
    this.#host?.log?.info?.('听觉停止监听', { reason, chunks: agg.chunks });
    this.#broadcast({ t: 'state', state: this.#snapshot() });
    await this.#shipChain;
    return this.#snapshot();
  }

  #tick() {
    const now = this.#now();
    for (const src of this.#sources.values()) {
      const segmenter = src.segmenter;
      if (!segmenter) continue;
      try {
        segmenter.configure(src.vad === 'energy' ? this.#vadConfig() : this.#neuralConfig(src.vad));
        src.dropped = segmenter.dropped;
        if (segmenter.async) segmenter.tick(now);
        else for (const u of segmenter.tick(now)) this.#queueShip(u, src);
        src.level = segmenter.level;
        src.active = segmenter.active;
      } catch (err) {
        this.#setError(`切分出错：${msg(err)}`, src);
        void this.#stopListening('segmenter-error').catch(() => {});
        return;
      }
    }
    this.#checkAlive(now);
    if (this.#autoStopAt && now >= this.#autoStopAt) {
      void this.#stopListening('auto-stop').catch((err) => this.#setError(msg(err)));
    }
  }

  /** 应用进程退出：停掉这一路；全部退出就结束本轮。系统声音不查。 */
  #checkAlive(now) {
    if (!this.#state.listening) return;
    if (now - this.#lastAliveAt < ALIVE_CHECK_MS) return;
    this.#lastAliveAt = now;
    const gone = [];
    for (const src of this.#sources.values()) {
      if (src.source !== 'app' || !src.pid) continue;
      let alive = true;
      try {
        alive = this.#pidAlive(src.pid) !== false;
      } catch {
        alive = false;
      }
      if (!alive) gone.push(src);
    }
    if (!gone.length) return;
    void this.#retireSources(gone).catch((err) => this.#setError(msg(err)));
  }

  async #retireSources(gone) {
    const tasks = [];
    for (const src of gone) {
      if (!this.#sources.has(src.key)) continue;
      this.#sources.delete(src.key);
      this.#retired.push(src);
      const capture = src.capture;
      src.capture = null;
      if (capture) {
        try {
          capture.stop();
        } catch (err) {
          this.#onCaptureStatus(src, { type: 'stop-error', detail: msg(err) });
        }
      }
      const segmenter = src.segmenter;
      src.segmenter = null;
      src.level = -100;
      src.active = false;
      this.#host?.log?.info?.('听觉：来源进程已退出，停止这一路', { target: src.target, pid: src.pid });
      if (!segmenter) continue;
      tasks.push((async () => {
        try {
          const tail = segmenter.flush();
          const list = tail && typeof tail.then === 'function' ? await tail : tail;
          for (const u of Array.isArray(list) ? list : (list ? [list] : [])) this.#queueShip(u, src);
          src.dropped = segmenter.dropped;
        } catch (err) {
          this.#setError(`收尾时切分出错：${msg(err)}`, src);
        }
      })());
    }
    await Promise.all(tasks);
    this.#signature = [...this.#sources.values()].map((src) => `${src.key}:${src.vad}`).join('|');
    if (!this.#sources.size && this.#state.listening) {
      await this.#stopListening('sources-exited');
      return;
    }
    this.#broadcast({ t: 'state', state: this.#snapshot() });
  }

  #onFrame(src, frame) {
    const segmenter = src.segmenter;
    if (!segmenter || !src.capture) return;
    src.frames += 1;
    src.audioMs += FRAME_MS;
    const now = this.#now();
    try {
      if (segmenter.async) segmenter.push(frame, now);
      else for (const u of segmenter.push(frame, now)) this.#queueShip(u, src);
      src.dropped = segmenter.dropped;
      src.level = segmenter.level;
      src.active = segmenter.active;
    } catch (err) {
      this.#setError(`切分出错：${msg(err)}`, src);
      void this.#stopListening('segmenter-error').catch(() => {});
      return;
    }
  }

  #onCaptureStatus(src, event) {
    if (event?.type === 'stop-error') {
      this.#host?.log?.warn?.('听觉：停止采集时报了错', { target: src.target, detail: event.detail });
    }
  }

  #aggregate() {
    const list = [...this.#retired, ...this.#sources.values()];
    const sum = (key) => list.reduce((total, src) => total + (Number(src[key]) || 0), 0);
    return {
      frames: sum('frames'),
      audioMs: sum('audioMs'),
      chunks: sum('chunks'),
      delivered: sum('delivered'),
      archived: sum('archived'),
      failedEvents: sum('failedEvents'),
      throttled: sum('throttled'),
      dropped: sum('dropped'),
    };
  }

  #queueShip(u, src) {
    this.#shipChain = this.#shipChain
      .then(() => this.#shipChunk(u, src))
      .catch((err) => this.#setError(msg(err), src));
  }

  #setError(detail, src = null) {
    const stamp = `${new Date(this.#now()).toISOString()} ${detail}`;
    if (src) src.lastError = stamp;
    this.#state.lastError = stamp;
    this.#host?.log?.warn?.('听觉出错', { detail, target: src?.target ?? '' });
    this.#broadcast({ t: 'error', message: detail, key: src?.key ?? '' });
  }

  // -------------------------------------------------------------------------
  // 送达：一块 = 一个事件（正文 + WAV 附件）
  // -------------------------------------------------------------------------

  async #shipChunk(u, src) {
    const now = this.#now();
    const wake = this.#str('wake') === 'record' ? 'record' : 'notify';
    const throttled = wake === 'notify' && this.#rateBlocked(now);
    let aed = null;
    if (this.#aed) {
      try {
        aed = await this.#aed.classify(u.pcm);
      } catch (err) {
        this.#host?.log?.warn?.('听觉：音乐/说话区分失败', { detail: msg(err) });
      }
    }
    const aedMode = this.#aedMode();
    const voiceFiltered = !aedShouldDeliver(aedMode, aed);
    const deliver = wake === 'notify' && !throttled && !voiceFiltered;

    const bytes = encodeWav(u.pcm, SAMPLE_RATE);
    const seconds = u.durationMs / 1000;
    const targetLabel = src.target;
    const forced = u.forced ? ' · 说得太长被切开' : '';
    const aedTag = aed ? ` · ${AED_LABELS[aed.label] ?? aed.label}` : '';
    const body = `听到一段语音：${seconds.toFixed(1)} 秒（${targetLabel}${forced}${aedTag}）`;
    // Both segmenters return an absolute wall-clock timestamp.
    const startedAt = new Date(u.startAt).toISOString();
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const at = new Date(now).toISOString();

    let handle = '';
    let eventSaved = false;
    let deliveryError = '';
    try {
      if (voiceFiltered) {
        // 纯音乐块：不投事件、不唤醒，但照常进记录。
        eventSaved = true;
      } else {
        if (!this.#host?.pushEvent) throw new Error('事件宿主不可用');
        const envelope = await this.#host.pushEvent({
          type: EVENT_TYPE,
          source: this.id,
          senderKey: this.#senderKey(src),
          ts: at,
          text: body,
          meta: {
            source: src.source,
            app: src.app,
            pid: src.pid,
            durationMs: u.durationMs,
            startedAt,
            peakDb: Math.round(u.peakDb * 10) / 10,
            forced: u.forced,
            throttled,
            ...(aed ? { aed: { label: aed.label, speech: aed.speech, singing: aed.singing, music: aed.music, voice: aed.voice } } : {}),
          },
          blobs: [{
            bytes,
            mime: 'audio/wav',
            name: `listen-${stamp}.wav`,
            fallbackText: `一段 ${seconds.toFixed(1)} 秒的语音（${targetLabel}${aedTag}）`,
          }],
        }, { deliver, trigger: 'debounce' });
        handle = envelope?.blobs?.[0]?.handle ?? '';
        eventSaved = true;
        if (deliver) this.#emitTimes.push(now);
      }
    } catch (err) {
      deliveryError = msg(err);
      this.#setError(`事件没送出去：${deliveryError}`, src);
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
        source: src.source,
        app: src.app,
        target: targetLabel,
        handle,
        forced: u.forced,
        peakDb: Math.round(u.peakDb * 10) / 10,
        aedLabel: aed?.label ?? '',
        delivered: deliver && eventSaved,
        deliveryError,
      });
    } catch (err) {
      this.#setError(`记进仓库失败：${msg(err)}`, src);
    }

    src.chunks += 1;
    if (!eventSaved) src.failedEvents += 1;
    else if (deliver) src.delivered += 1;
    else src.archived += 1;
    if (throttled) src.throttled += 1;
    this.#state.lastChunkAt = at;
    if (item && this.#bool('pushToConsole')) {
      this.#broadcast({ t: 'chunk', chunk: item, count: this.#chunksFor().count });
    }
    return item;
  }

  /** 每 60 秒最多即时投递多少块（所有来源共用一个额度）；超出只归档。 */
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
    const sources = [...this.#sources.values()].map((src) => ({
      key: src.key,
      source: src.source,
      app: src.app,
      pid: src.pid,
      target: src.target,
      vad: src.vad,
      frames: src.frames,
      audioMs: src.audioMs,
      chunks: src.chunks,
      delivered: src.delivered,
      archived: src.archived,
      failedEvents: src.failedEvents,
      throttled: src.throttled,
      dropped: src.dropped,
      level: src.level,
      active: src.active,
      lastError: src.lastError,
    }));
    const agg = this.#aggregate();
    const singleApp = sources.length === 1 && sources[0].source === 'app' ? sources[0] : null;
    const configured = this.#targetsFromConfig();
    return {
      listening: this.#state.listening,
      source: this.#sourceSetting(),
      target: sources.map((src) => src.target).join('、'),
      app: singleApp?.app ?? '',
      pid: singleApp?.pid ?? 0,
      startedAt: this.#state.startedAt,
      autoStopAt: this.#autoStopAt ? this.#iso(this.#autoStopAt) : '',
      ...agg,
      lastChunkAt: this.#state.lastChunkAt,
      lastError: this.#state.lastError,
      sources,
      selection: {
        source: this.#sourceSetting(),
        vad: this.#vadDefault(),
        apps: configured.filter((t) => t.source === 'app').map((t) => ({ app: t.app, vad: t.vad })),
      },
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
      aed: { mode: this.#aedMode(), ready: Boolean(this.#aed) },
      vad: {
        kind: this.#vadDefault(),
        ...this.#vadConfig(),
        sileroThreshold: this.#num('sileroThreshold', 0.1, 0.9),
        fireredThreshold: this.#num('fireredThreshold', 0.1, 0.9),
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
    // 0 路 = 停着，1 路 = 那一路的切分方式（与单来源时一致），多路才显示数量。
    const stateValue = !s.listening
      ? t.off
      : s.sources.length > 1
        ? t.lanes(s.sources.length)
        : (s.sources[0]?.vad ?? t.off);
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: s.listening ? 'online' : (ok ? 'offline' : 'error'),
        hint: s.listening ? t.stateListening(s.target) : (ok ? t.stateIdle : t.stateError(s.module.error)),
      }],
      badges: [
        { label: t.badgeState, value: stateValue, tone: s.listening ? 'on' : 'off' },
        { label: t.badgeChunks, value: String(s.store.count), tone: s.store.count ? 'on' : 'off' },
        { label: t.badgeTarget, value: s.listening ? s.target : '—', tone: s.listening ? 'on' : 'off' },
      ],
      panels: [
        { id: 'chunks', title: t.panelChunksTitle, description: t.panelChunksDesc, getMethods: ['list'] },
        { id: 'status', title: t.panelStatusTitle, description: t.panelStatusDesc, getMethods: ['state'] },
        { id: 'tools', title: t.panelToolsTitle, getMethods: ['list'] },
      ],
      config: [configGroup(language)],
      promptDocs: [{
        key: `worlds.${ID}.env`,
        title: t.promptTitle,
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
    if (panel === 'tools') {
      switch (method) {
        case 'list': return this.toolText.read();
        case 'save': return this.toolText.save(list[0] ?? {});
        case 'reset': return this.toolText.reset(list[0] ?? {});
        default: throw new Error(`未知面板方法：tools.${method}`);
      }
    }
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
          if (list[0] !== 'silero' && list[0] !== 'firered' && list[0] !== 'energy') throw new Error('未知听觉模块');
          if (this.#state.listening) throw new Error('请先停止监听再切换听觉模块。');
          const onProgress = (stage) => this.#broadcast({ t: 'module-progress', stage });
          if (list[0] === 'silero') {
            await ensureSileroRuntime({ dataDir: this.dataDir, load: this.#sileroLoad, onProgress });
            await ensureSileroModel({ cfgPath: this.#str('sileroModel'), dataDir: this.dataDir,
              packageDir: this.packageDir, botDir: this.botDir, fetchImpl: this.#fetch, log: this.#host?.log, onProgress });
            onProgress('ready');
          } else if (list[0] === 'firered') {
            loadOnnxRuntime();
            await ensureFireRedModel({ cfgPath: this.#modelCfgPath('firered'), dataDir: this.dataDir,
              packageDir: this.packageDir, botDir: this.botDir, fetchImpl: this.#fetch, log: this.#host?.log });
            onProgress('ready');
          }
          return { ok: true };
        }
        case 'fetchModel': {
          const kind = this.#vadDefault();
          const model = kind === 'firered'
            ? await ensureFireRedModel({
              cfgPath: this.#modelCfgPath('firered'),
              dataDir: this.dataDir,
              packageDir: this.packageDir,
              botDir: this.botDir,
              fetchImpl: this.#fetch,
              timeoutMs: this.#num('timeoutMs', 10000, 900000),
              log: this.#host?.log,
            })
            : await ensureSileroModel({
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

  /** 面板的开始：目标清单（每路 source / app / vad）由面板给出。 */
  async #invokeStart([targets, minutes]) {
    const list = Array.isArray(targets)
      ? targets.filter((t) => t && typeof t === 'object' && !Array.isArray(t))
      : [];
    const s = await this.#startListening({
      targets: list,
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
      source: this.#sourceSetting(),
      apps: this.#configuredAppTargets().length,
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
