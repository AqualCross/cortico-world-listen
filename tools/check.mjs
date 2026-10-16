#!/usr/bin/env node
/**
 * 离线检查：不联网、不碰安装目录、不加载原生件。跑法：node tools/check.mjs
 *
 * 覆盖：清单与声明 / 工具声明 / 配置组路径 / WAV 工具 / 语音切分状态机
 * （preRoll、起说、收尾、强切、墙上时钟收尾）/ World 整条链（假采集、假宿主、
 * 假时钟）/ 事件正文与附件 / 限速与只归档 / 应用解析纯函数 / WebUI bundle。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'listen-check-'));

let passed = 0;
let failed = 0;
let warned = 0;

const ok = (line) => { passed++; console.log(`  ok    ${line}`); };
const bad = (line) => { failed++; console.log(`  FAIL  ${line}`); };
const hint = (line) => { warned++; console.log(`  提醒  ${line}`); };

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? '不相等'}：${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
}

/** 键序无关的 JSON 形态：对比 describe.json 与代码里的声明。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;
const config = await import(pathToFileURL(join(pkgDir, 'src', 'config.js')).href);
const wav = await import(pathToFileURL(join(pkgDir, 'src', 'wav.js')).href);
const vad = await import(pathToFileURL(join(pkgDir, 'src', 'vad.js')).href);
const silero = await import(pathToFileURL(join(pkgDir, 'src', 'silero.js')).href);
const apps = await import(pathToFileURL(join(pkgDir, 'src', 'apps.js')).href);
const chunksMod = await import(pathToFileURL(join(pkgDir, 'src', 'chunks.js')).href);
const worldMod = await import(pathToFileURL(join(pkgDir, 'src', 'world.js')).href);

const { ListenWorld } = worldMod;

// ---------------------------------------------------------------------------
// 测试件：帧、假采集、假宿主、假时钟
// ---------------------------------------------------------------------------

/** 一个 20ms 帧（320 样本）的正弦；db 是峰值电平（dBFS）。 */
function frame(db, frameMs = 20, sampleRate = 16000) {
  const n = (sampleRate * frameMs) / 1000;
  const out = new Int16Array(n);
  if (db <= -99) return out; // 全零
  const amp = 10 ** (db / 20);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amp * 32767);
  return out;
}

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

function makeTimers() {
  const cbs = new Set();
  return {
    setInterval: (fn) => { cbs.add(fn); return fn; },
    clearInterval: (fn) => { cbs.delete(fn); },
    /** 跑一遍所有登记的定时器回调（把时间前进之后用）。 */
    run: () => { for (const fn of [...cbs]) fn(); },
    get size() { return cbs.size; },
  };
}

let rigSeq = 0;

/**
 * 造一个世界：假采集（手动喂帧）、假宿主（记事件）、假时钟、假定时器。
 * 每次调用给一份独立的 dataDir——记录会落盘，共用目录会让用例互相看见。
 */
function makeWorld(overrides = {}, opts = {}) {
  rigSeq += 1;
  const clock = makeClock();
  const timers = makeTimers();
  const events = [];
  const host = {
    pushEvent: async (e, o) => {
      events.push({ e, o });
      return { blobs: [{ handle: `log:test${events.length}.wav` }], cursor: events.length };
    },
    blob: (handle) => (opts.blobs?.[handle] ? { bytes: opts.blobs[handle], mime: 'audio/wav' } : null),
    log: { info: () => {}, warn: () => {} },
  };
  let capture = null;
  const createCapture = ({ onFrame }) => {
    capture = {
      target: null,
      stopped: false,
      start(target) { this.target = target; },
      stop() { this.stopped = true; },
      feed(pcm) { onFrame(pcm); },
    };
    return capture;
  };
  const cfg = { ...def.defaults(), enabled: true, ...overrides };
  const world = new ListenWorld({
    cfg,
    dataDir: opts.dataDir ?? join(scratch, 'data', `rig-${rigSeq}`),
    botDir: join(scratch, 'bot'),
    packageDir: pkgDir,
    now: clock.now,
    timers: { setInterval: timers.setInterval, clearInterval: timers.clearInterval },
    createCapture,
    captureStatus: () => ({ ok: true, error: '' }),
    resolveApp: opts.resolveApp ?? (async (target) => ({ pid: 4242, name: String(target), title: '', numeric: false })),
    listApps: opts.listApps ?? (async () => [{ name: 'chrome', pid: 4242, title: 'example' }]),
    silero: opts.silero,
  });
  return {
    world,
    host,
    events,
    clock,
    timers,
    capture: () => capture,
    feedFrames: (db, count, advance = true) => {
      for (let i = 0; i < count; i += 1) {
        const f = frame(db);
        if (advance) clock.advance(20);
        capture.feed(f);
      }
    },
  };
}

/** 让挂起的 promise 链跑完（shipChain 这类）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 假 sherpa 模块：照 `Vad` 的真接口演，行为脚本化——
 * 收够 5 帧（1600 样本）排一段 400ms；flush() 再补一段 100ms（只补一次）。
 */
function makeFakeSherpa() {
  const state = { constructions: 0, last: null, instances: [] };
  class FakeVad {
    constructor(config, bufferSeconds) {
      this.config = config;
      this.bufferSeconds = bufferSeconds;
      this.accepted = 0;
      this.queue = [];
      this.scripted = false;
      this.flushedTail = false;
      state.constructions += 1;
      state.last = this;
      state.instances.push(this);
    }

    acceptWaveform(f32) {
      this.accepted += f32.length;
      if (!this.scripted && this.accepted >= 1600) {
        this.scripted = true;
        this.queue.push({ start: 0, samples: new Float32Array(6400).fill(0.5) }); // 400ms
      }
    }

    isEmpty() { return this.queue.length === 0; }
    front() { return this.queue[0]; }
    pop() { this.queue.shift(); }
    isDetected() { return this.queue.length > 0; }

    flush() {
      if (!this.flushedTail) {
        this.flushedTail = true;
        this.queue.push({ start: this.accepted, samples: new Float32Array(1600).fill(0.25) }); // 100ms
      }
    }

    reset() {}
    clear() {}
  }
  return { module: { Vad: FakeVad }, state };
}

const toolOf = (world, name) => {
  const tool = world.tools().find((t) => t.name === name);
  assert(tool, `找不到工具 ${name}`);
  return tool;
};

/** 起一段语音再收尾：开口 10 帧，停顿 30 帧；返回喂完之后的时钟。 */
async function speakOnce(rig, { loudDb = -20, quietDb = -60, speechFrames = 12 } = {}) {
  rig.feedFrames(quietDb, 16); // preRoll 背景
  rig.feedFrames(loudDb, speechFrames); // 开口
  rig.feedFrames(quietDb, 30); // 收尾静音（600ms）
}

try {
  // -------------------------------------------------------------------------
  console.log('清单与声明');

  check('package.json 的 cortico 段与 webUiClient', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    eq(manifest.name, 'cortico-world-listen', 'name');
    eq(manifest.cortico?.kind, 'world', 'kind');
    eq(manifest.cortico?.api, 6, 'api');
    eq(manifest.cortico?.displayName, '听觉', 'displayName');
    assert(typeof manifest.cortico?.webUiClient === 'string' && manifest.cortico.webUiClient, '缺 webUiClient');
    assert(existsSync(join(pkgDir, manifest.cortico.webUiClient)), 'webUiClient 文件不在包里');
    eq(manifest.cortico?.describe, 'describe.json', 'describe');
    assert(existsSync(join(pkgDir, 'describe.json')), 'describe.json 不在包里');
    assert(Array.isArray(manifest.files) && manifest.files.includes('describe.json'), 'files 缺 describe.json');
    assert(Array.isArray(manifest.keywords) && manifest.keywords.includes('cortico-world'), 'keywords 缺 cortico-world');
  });

  check('CHANGELOG.md 有当前版本的一节', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const src = readFileSync(join(pkgDir, 'CHANGELOG.md'), 'utf8');
    const version = String(manifest.version ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert(new RegExp(`^##\\s*\\[?${version}\\]?`, 'm').test(src), `CHANGELOG.md 缺 ## ${manifest.version} 一节`);
    assert(Array.isArray(manifest.files) && manifest.files.includes('CHANGELOG.md'), 'files 缺 CHANGELOG.md');
  });

  check('默认导出是 WorldDefinition', () => {
    eq(def.id, 'listen', 'id');
    eq(def.label, '听觉', 'label');
    const defaults = def.defaults();
    eq(defaults.enabled, false, 'enabled 默认 false');
    eq(defaults.source, 'system', 'source 默认');
    eq(defaults.wake, 'notify', 'wake 默认');
    eq(defaults.control, 'console-and-agent', 'control 默认');
    eq(defaults.keep, 200, 'keep 默认');
    eq(defaults.saveDir, '', 'saveDir 默认');
    if (process.platform === 'win32') {
      try {
        def.preflight();
      } catch (err) {
        hint(`preflight 没过（多半是没装依赖）：${err?.message ?? err}`);
      }
    } else {
      let threw = false;
      try {
        def.preflight();
      } catch {
        threw = true;
      }
      assert(threw, '非 Windows 上 preflight 应当抛错');
    }
  });

  check('describe 与 describe.json 一致，实例工具都在声明里', () => {
    assert(def.describe && Array.isArray(def.describe.tools) && def.describe.tools.length === 3, '定义缺 describe.tools');
    assert(Array.isArray(def.describe.events) && def.describe.events.length === 1, '定义缺 describe.events');
    const file = JSON.parse(readFileSync(join(pkgDir, 'describe.json'), 'utf8'));
    // 与框架的导出形状一致：工具 + 事件 + 环境提示词模板原文。
    const world = mod.listenDefinition.create({ cfg: def.defaults(), dataDir: scratch, botDir: scratch, packageDir: pkgDir });
    const docs = (world.webUi('zh').promptDocs ?? []).filter((doc) => doc.role === 'envPrompt' && existsSync(doc.path));
    const prompts = docs.map((doc) => ({
      key: doc.key,
      title: doc.title,
      ...(doc.role ? { role: doc.role } : {}),
      content: readFileSync(doc.path, 'utf8'),
    }));
    const expected = JSON.parse(JSON.stringify({
      tools: def.describe.tools,
      events: def.describe.events,
      ...(prompts.length ? { prompts } : {}),
    }));
    eq(stable(file), stable(expected), 'describe.json 与代码里的 describe 不一致');
    eq(file.events[0].type, 'listen.chunk', 'describe 事件名');
    eq(file.events[0].trigger, 'debounce', 'describe 事件 trigger');
    const names = new Set(file.tools.map((t) => t.name));
    for (const tool of world.tools()) {
      assert(names.has(tool.name), `工具 ${tool.name} 不在 describe.tools 里`);
    }
  });

  check('配置组与默认值一一对应，且都在 worlds.listen 段内', () => {
    const group = config.configGroup('zh');
    const paths = Object.keys(group.schema.properties);
    for (const path of paths) {
      assert(path.startsWith('worlds.listen.'), `配置路径不在 worlds.listen：${path}`);
      const short = path.slice('worlds.listen.'.length);
      assert(Object.hasOwn(config.DEFAULTS, short), `配置 ${short} 没有默认值`);
    }
    for (const short of Object.keys(config.DEFAULTS)) {
      assert(paths.includes(`worlds.listen.${short}`), `默认值 ${short} 没有进 schema`);
    }
  });

  // -------------------------------------------------------------------------
  console.log('WAV 工具');

  check('编码 → 读回：时长、采样率、单声道、位深', () => {
    const samples = new Int16Array(16000 * 1.5).fill(1000);
    const bytes = wav.encodeWav(samples, 16000);
    const info = wav.wavInfo(bytes);
    assert(info, '读不回来');
    eq(info.channels, 1, '声道');
    eq(info.bits, 16, '位深');
    eq(info.sampleRate, 16000, '采样率');
    assert(Math.abs(info.seconds - 1.5) < 0.001, `时长：${info.seconds}`);
    eq(wav.formatSeconds(1.5), '1.5 秒', '时长文案');
    eq(wav.formatKb(2048), '2.0 KB', 'KB 文案');
  });

  check('认不出的字节给 null', () => {
    eq(wav.wavInfo(Buffer.from('not a wav at all')), null, '文本不是 wav');
    eq(wav.wavInfo(Buffer.alloc(0)), null, '空缓冲');
  });

  // -------------------------------------------------------------------------
  console.log('语音切分状态机');

  const VAD = { thresholdDb: -42, minSpeechMs: 200, silenceMs: 600, maxUtteranceMs: 15000, preRollMs: 320, minUtteranceMs: 400 };

  check('preRoll + 起说 + 收尾：一块的长度与起点', () => {
    const seg = new vad.Segmenter(VAD, 20);
    let t = 1000;
    const out = [];
    for (let i = 0; i < 16; i += 1) out.push(...seg.push(frame(-60), (t += 20)));
    for (let i = 0; i < 10; i += 1) out.push(...seg.push(frame(-20), (t += 20)));
    eq(seg.active, true, '10 帧（200ms）后应当开口');
    eq(out.length, 0, '开口本身不交货');
    for (let i = 0; i < 29; i += 1) out.push(...seg.push(frame(-60), (t += 20)));
    eq(out.length, 0, '静音不满 600ms 不能收尾');
    out.push(...seg.push(frame(-60), (t += 20)));
    eq(out.length, 1, '静音满 600ms 应当收尾');
    const u = out[0];
    // 开口发生在第 26 帧（16 静 + 10 响）；手上那段的第 11 帧起被 preRoll 保留（上限 16 帧）。
    const kept = 16; // 第 11..26 帧
    const tail = 30; // 收尾静音全部收进这块
    eq(u.durationMs, (kept + tail) * 20, '时长（preRoll + 收尾静音）');
    eq(u.forced, false, '自然收尾');
    assert(Math.abs(u.peakDb + 20) < 1, `峰值：${u.peakDb}`);
    eq(u.startAt, 1000 + 11 * 20, '起点是被保留的第一帧的到达时刻');
  });

  check('没有新帧也能收尾：tick 按墙上时钟完结', () => {
    const seg = new vad.Segmenter(VAD, 20);
    let t = 0;
    const out = [];
    for (let i = 0; i < 24; i += 1) out.push(...seg.push(frame(-20), (t += 20)));
    eq(seg.active, true, '应当开口');
    let done = seg.tick(t + VAD.silenceMs - 20);
    eq(done.length, 0, '静音不满不能收');
    done = seg.tick(t + VAD.silenceMs);
    eq(done.length, 1, '静音到点应当收');
    eq(done[0].durationMs, 24 * 20, '手上 24 帧全部交出来');
    eq(seg.tick(t + 10_000).length, 0, '收过就不再收');
  });

  check('太短的片段丢掉，计进 dropped', () => {
    const seg = new vad.Segmenter({ ...VAD, minSpeechMs: 100 }, 20);
    let t = 0;
    for (let i = 0; i < 8; i += 1) seg.push(frame(-20), (t += 20)); // 开口在 100ms
    const done = seg.tick(t + 10_000);
    eq(done.length, 0, '短片段不该交货');
    eq(seg.dropped, 1, 'dropped 记数');
  });

  check('说得太长强切，然后接着收下一段', () => {
    const seg = new vad.Segmenter({ ...VAD, preRollMs: 0, minSpeechMs: 100, maxUtteranceMs: 1000, minUtteranceMs: 100 }, 20);
    let t = 0;
    const out = [];
    for (let i = 0; i < 60; i += 1) out.push(...seg.push(frame(-20), (t += 20)));
    eq(out.length >= 1, true, '应当强切出至少一块');
    eq(out[0].forced, true, '第一块是被强切的');
    assert(out[0].durationMs >= 1000, `强切块够长：${out[0].durationMs}`);
    eq(seg.active, true, '强切后照旧在说');
    const tail = seg.tick(t + 10_000);
    eq(tail.length, 1, '收尾把剩下的交出来');
    eq(tail[0].forced, false, '第二块是自然收尾');
  });

  check('久违的帧重置起说计数，不会跨缝隙攒出假开口', () => {
    const seg = new vad.Segmenter(VAD, 20);
    let t = 0;
    for (let i = 0; i < 6; i += 1) seg.push(frame(-20), (t += 20)); // aboveMs=120，不够 200
    eq(seg.active, false, '还没开口');
    seg.tick(t + 10_000); // 长时间没有帧
    for (let i = 0; i < 6; i += 1) seg.push(frame(-20), (t += 20));
    eq(seg.active, false, '缝隙之后的 6 帧不该接上之前的计数');
    for (let i = 0; i < 6; i += 1) seg.push(frame(-20), (t += 20));
    eq(seg.active, true, '再攒 6 帧才开口');
  });

  // -------------------------------------------------------------------------
  console.log('按应用解析（纯函数）');

  check('chooseRoot：优先没有同名父进程的根，再优先有窗口标题', () => {
    const rows = [
      { pid: 10, parent: 2, title: '' },
      { pid: 20, parent: 10, title: '' },
      { pid: 30, parent: 20, title: 'Chrome' },
    ];
    eq(apps.chooseRoot(rows)?.pid, 10, '根是 10');
    const withTitleRoot = [
      { pid: 10, parent: 2, title: '' },
      { pid: 11, parent: 2, title: 'Chrome' },
      { pid: 20, parent: 10, title: '' },
    ];
    eq(apps.chooseRoot(withTitleRoot)?.pid, 11, '根里挑带标题的');
    eq(apps.chooseRoot([]), null, '空表给 null');
    eq(apps.chooseRoot([{ pid: 5, parent: 1, title: '' }])?.pid, 5, '单进程直接用');
  });

  // -------------------------------------------------------------------------
  console.log('Silero 模型解析');

  await checkAsync('模型位置：配置路径优先，其次缓存，缺失如实报告', () => {
    const dataDir = join(scratch, 'model-data');
    const custom = join(scratch, 'custom-models', 'silero_vad.onnx');
    mkdirSync(dirname(custom), { recursive: true });
    writeFileSync(custom, Buffer.alloc(2000));
    const st1 = silero.modelState({ cfgPath: custom, dataDir, botDir: scratch });
    eq(st1.exists, true, '配置路径存在');
    eq(st1.source, 'config', '来源是配置');
    eq(st1.path, custom, '路径');
    const st2 = silero.modelState({ cfgPath: '', dataDir, botDir: scratch });
    eq(st2.exists, false, '没有缓存');
    eq(st2.source, 'cache-missing', '来源是缺缓存');
    eq(st2.path, join(dataDir, 'listen', 'silero_vad.onnx'), '缺缓存时给出将来要下的位置');
  });

  await checkAsync('ensure：下载到缓存（原子写）、伪响应拦下、失败带方向', async () => {
    const dataDir = join(scratch, 'model-download');
    // 下载成功
    const bytes = Buffer.alloc(150_000, 7);
    const model = await silero.ensureSileroModel({
      cfgPath: '',
      dataDir,
      fetchImpl: async (url, opts) => {
        assert(String(url) === silero.SILERO_MODEL_URL, `URL：${url}`);
        assert(opts?.signal, '带超时信号');
        return new Response(bytes);
      },
    });
    eq(model.source, 'download', '来源是下载');
    assert(existsSync(model.path), '文件落盘');
    eq(model.sizeBytes, bytes.length, '字节数');
    const st = silero.modelState({ cfgPath: '', dataDir });
    eq(st.source, 'cache', '下载后缓存可见');
    eq(st.sizeBytes, bytes.length, '缓存字节数');

    // 伪响应（太小）拦下
    let small = null;
    try {
      await silero.ensureSileroModel({ cfgPath: '', dataDir: join(scratch, 'model-small'), fetchImpl: async () => new Response(Buffer.alloc(100)) });
    } catch (err) {
      small = err;
    }
    assert(small && small.message.includes('不像真模型'), `小文件应拦下：${small?.message}`);

    // 网络失败：错误里有 URL 与出路
    let offline = null;
    try {
      await silero.ensureSileroModel({ cfgPath: '', dataDir: join(scratch, 'model-offline'), fetchImpl: async () => { throw new Error('offline'); } });
    } catch (err) {
      offline = err;
    }
    assert(offline && offline.message.includes(silero.SILERO_MODEL_URL), `失败提示要含 URL：${offline?.message}`);
    assert(offline.message.includes('sileroModel'), '失败提示要给出路');

    // 配置路径不在：不下载、直接报
    let missingCfg = null;
    try {
      await silero.ensureSileroModel({ cfgPath: join(scratch, 'nope.onnx'), dataDir });
    } catch (err) {
      missingCfg = err;
    }
    assert(missingCfg && missingCfg.message.includes('sileroModel'), `配置缺失要报：${missingCfg?.message}`);
  });

  // -------------------------------------------------------------------------
  console.log('Silero 切分器（假 sherpa）');

  const SILERO_OPTS = {
    threshold: 0.5,
    minSpeechMs: 200,
    silenceMs: 600,
    maxUtteranceMs: 15000,
    minUtteranceMs: 400,
  };

  check('配置传给原生件；一段的转换与映射', () => {
    const fake = makeFakeSherpa();
    let t = 1000;
    const seg = new silero.SileroSegmenter({
      modelPath: 'C:/models/silero_vad.onnx',
      loadSherpa: () => fake.module,
      now: () => t,
      ...SILERO_OPTS,
    });
    const cfg = fake.state.last.config;
    eq(cfg.sileroVad.model, 'C:/models/silero_vad.onnx', 'model');
    eq(cfg.sileroVad.threshold, 0.5, 'threshold');
    eq(cfg.sileroVad.minSilenceDuration, 0.6, 'minSilenceDuration');
    eq(cfg.sileroVad.minSpeechDuration, 0.2, 'minSpeechDuration');
    eq(cfg.sileroVad.maxSpeechDuration, 15, 'maxSpeechDuration');
    eq(cfg.sampleRate, 16000, 'sampleRate');
    assert(fake.state.last.bufferSeconds >= 30, '环形缓冲够大');

    let out = [];
    for (let i = 0; i < 5; i += 1) {
      t += 20;
      out = out.concat(seg.push(frame(-20), t));
    }
    eq(out.length, 1, '第 5 帧交出一段');
    eq(out[0].pcm.length, 6400, '样本数');
    assert(Math.abs(out[0].durationMs - 400) < 0.01, `时长：${out[0].durationMs}`);
    eq(out[0].startAt, 1000, '起点映射到墙上时钟');
    assert(Math.abs(out[0].peakDb + 6.02) < 0.2, `峰值：${out[0].peakDb}`);
    eq(out[0].forced, false, '不强切');
    eq(seg.kind, 'silero', 'kind');
  });

  check('太短的段丢掉，计进 dropped', () => {
    const fake = makeFakeSherpa();
    const seg = new silero.SileroSegmenter({
      modelPath: 'x',
      loadSherpa: () => fake.module,
      now: () => 0,
      ...SILERO_OPTS,
      minUtteranceMs: 5000,
    });
    let out = [];
    for (let i = 0; i < 5; i += 1) out = out.concat(seg.push(frame(-20), i * 20));
    eq(out.length, 0, '短段不交货');
    eq(seg.dropped, 1, 'dropped 记数');
  });

  check('tick 按墙上时钟收尾；quietFlushed 只收一次', () => {
    const fake = makeFakeSherpa();
    let t = 0;
    const seg = new silero.SileroSegmenter({
      modelPath: 'x',
      loadSherpa: () => fake.module,
      now: () => t,
      ...SILERO_OPTS,
      minUtteranceMs: 100,
    });
    for (let i = 0; i < 5; i += 1) { t += 20; seg.push(frame(-20), t); } // 400ms 那段已交
    eq(seg.tick(t + 599).length, 0, '安静不满不能收');
    const out = seg.tick(t + 600);
    eq(out.length, 1, '安静到点收尾');
    assert(Math.abs(out[0].durationMs - 100) < 0.01, `尾段 100ms：${out[0].durationMs}`);
    eq(seg.tick(t + 5000).length, 0, '收过就不再收');
    // 新帧来了重新武装
    t += 20;
    seg.push(frame(-20), t);
    eq(seg.quietFlushed, false, '新帧复位 quietFlushed');
  });

  check('参数热改：变了重建原生件，没变不动', () => {
    const fake = makeFakeSherpa();
    const seg = new silero.SileroSegmenter({
      modelPath: 'x',
      loadSherpa: () => fake.module,
      now: () => 0,
      ...SILERO_OPTS,
    });
    eq(fake.state.constructions, 1, '初次构造');
    seg.configure({ ...SILERO_OPTS });
    eq(fake.state.constructions, 1, '没变不重建');
    seg.configure({ ...SILERO_OPTS, threshold: 0.7 });
    eq(fake.state.constructions, 2, 'threshold 变了重建');
    eq(fake.state.last.config.sileroVad.threshold, 0.7, '新参数传下去');
    seg.configure({ ...SILERO_OPTS, threshold: 0.7, minSpeechMs: 300 });
    eq(fake.state.constructions, 3, 'minSpeechMs 变了重建');
  });

  check('flush 返回数组（0 或多段都行）', () => {
    const fake = makeFakeSherpa();
    const seg = new silero.SileroSegmenter({
      modelPath: 'x',
      loadSherpa: () => fake.module,
      now: () => 0,
      ...SILERO_OPTS,
      minUtteranceMs: 100,
    });
    let out = seg.flush();
    assert(Array.isArray(out), '是数组');
    eq(out.length, 1, '假件补的 100ms 尾段');
    eq(seg.flush().length, 0, '再 flush 不给重复的');
  });

  // -------------------------------------------------------------------------
  console.log('语音块仓库');

  check('入库、索引、编号、裁剪、删除、清空、坏索引容错', () => {
    const dir = join(scratch, 'records');
    const store = new chunksMod.Chunks({ dir, keep: 2 });
    const bytes = (n) => Buffer.alloc(n, 1);
    const a = store.add({ bytes: bytes(10), durationMs: 100, at: '2026-01-01T00:00:00Z', handle: 'log:a.wav' });
    const b = store.add({ bytes: bytes(20), durationMs: 200 });
    const c = store.add({ bytes: bytes(30), durationMs: 300 });
    eq(store.count, 2, 'keep=2 后的条数');
    eq(a.seq, 1, '第一块 seq');
    eq(c.seq, 3, '第三块 seq');
    assert(!store.list().some((i) => i.id === a.id), '最旧的被裁掉');
    assert(!existsSync(a.path), '被裁掉的文件也删了');
    assert(existsSync(b.path), '留下的文件还在');
    eq(store.totalBytes, 50, '总字节');
    eq(store.totalDurationMs, 500, '总时长');
    assert(existsSync(store.indexFile), '索引落盘');
    const first = store.list().at(-1);
    eq(first.id, b.id, '最新在前、最旧在后');

    const again = new chunksMod.Chunks({ dir, keep: 2 });
    eq(again.count, 2, '重载索引后的条数');
    eq(again.get(b.id)?.bytes, 20, '按 id 取回');
    assert(again.get(b.file), '按文件名取回');
    const d = again.add({ bytes: bytes(5), durationMs: 50, handle: 'log:d.wav' });
    eq(d.seq, 4, '重载后编号接着数');
    // keep=2：d 进来后 b 被裁掉（连同文件）
    assert(!existsSync(b.path), '重载后的新块也会触发裁剪');
    assert(again.remove(c.id) && again.count === 1, '删除生效');
    assert(!existsSync(c.path), '删除连文件一起');
    eq(again.clear(), 1, '清空返回删掉的条数');
    eq(again.count, 0, '清空后为空');
    eq(again.add({ bytes: bytes(5), durationMs: 50 }).seq, 1, '清空后编号从 1 重来');

    writeFileSync(join(dir, 'index.json'), '{oops');
    eq(new chunksMod.Chunks({ dir, keep: 2 }).count, 0, '坏索引应当当空');
  });

  // -------------------------------------------------------------------------
  console.log('World 整条链（假采集 / 假宿主 / 假时钟）');

  await checkAsync('工具形状与声明', async () => {
    const rig = makeWorld();
    const world = rig.world;
    const tools = world.tools();
    eq(tools.length, 3, '工具数量');
    const listen = toolOf(world, 'listen');
    const recent = toolOf(world, 'listen_recent');
    const status = toolOf(world, 'listen_status');
    assert(listen.tags.includes('act'), 'listen 是 act');
    assert(recent.tags.includes('read'), 'recent 是 read');
    assert(status.tags.includes('read'), 'status 是 read');
    eq(listen.parameters.required?.[0], 'action', 'listen required');
    const decl = world.webUi('zh');
    const ids = decl.panels.map((p) => p.id);
    assert(ids.includes('chunks') && ids.includes('status'), `面板缺：${ids.join(',')}`);
    assert(decl.config?.length === 1, '缺配置组');
    const doc = decl.promptDocs?.[0];
    eq(doc?.role, 'envPrompt', '提示词文档 role');
    assert(existsSync(doc.path), '环境提示词模板不在');
    eq(world.envPromptVars(), null, '没在听时不进前缀');
  });

  await checkAsync('开始听（系统）→ 喂一段话 → 事件带 WAV 附件与句柄', async () => {
    const rig = makeWorld();
    const { world } = rig;
    await world.start(rig.host);
    const start = await toolOf(world, 'listen').handler({ action: 'start' }, {});
    assert(!start.failed, `开始失败：${start.text}`);
    assert(start.text.includes('听觉打开了'), '开始回执');
    eq(rig.capture().target.source, 'system', '采集目标');
    eq(world.envPromptVars()?.['listen.target'], '系统声音', '前缀变量');

    await speakOnce(rig);
    const stop = await toolOf(world, 'listen').handler({ action: 'stop' }, {});
    assert(!stop.failed, `停止失败：${stop.text}`);
    assert(stop.text.includes('1 块'), `停止回执：${stop.text}`);

    eq(rig.events.length, 1, '一个事件');
    const { e, o } = rig.events[0];
    eq(e.type, 'listen.chunk', '事件类型');
    eq(e.source, 'listen', '事件来源');
    eq(e.senderKey, 'listen:system', 'senderKey');
    eq(o.deliver, true, '即时投递');
    eq(o.trigger, 'debounce', '合批方式');
    assert(e.text.includes('听到一段语音：'), `正文：${e.text}`);
    assert(e.text.includes('系统声音'), '正文带来源');
    // 16 静 + 12 响：开口在第 26 帧，保留 16 帧 preRoll + 2 响 + 30 静 = 48 帧。
    eq(e.meta.durationMs, 48 * 20, `meta 时长：${e.meta.durationMs}`);
    eq(e.meta.source, 'system', 'meta source');
    const bytes = Buffer.from(e.blobs[0].bytes);
    const info = wav.wavInfo(bytes);
    assert(info && Math.abs(info.seconds - e.meta.durationMs / 1000) < 0.001, '附件是能读的 WAV');
    eq(info.sampleRate, 16000, '附件采样率');
    eq(e.blobs[0].mime, 'audio/wav', 'mime');
    assert(/^listen-.*\.wav$/.test(e.blobs[0].name), `附件名：${e.blobs[0].name}`);
    assert(e.blobs[0].fallbackText.includes('秒'), 'fallbackText');

    const list = await world.invoke('chunks', 'list', [10]);
    eq(list.count, 1, '最近列表条数');
    eq(list.items[0].handle, 'log:test1.wav', '句柄记进列表');
    const recent = await toolOf(world, 'listen_recent').handler({ limit: 5 }, {});
    assert(recent.text.includes('log:test1.wav'), 'listen_recent 给出句柄');
    assert(recent.text.includes('stt_transcribe'), '引导交给 STT');
    const status = await toolOf(world, 'listen_status').handler({}, {});
    assert(status.text.includes('计数：1 块'), `状态回执：${status.text}`);
    await world.stop();
    eq(rig.timers.size, 0, '停止后定时器清掉');
  });

  await checkAsync('silero 整条链：配置路径模型 + 假 sherpa，段以事件送出', async () => {
    const fakeSherpa = makeFakeSherpa();
    const modelFile = join(scratch, 'chain-model.onnx');
    writeFileSync(modelFile, Buffer.alloc(2000));
    const rig = makeWorld(
      { vad: 'silero', sileroModel: modelFile, minUtteranceMs: 100 },
      { silero: { loadSherpa: () => fakeSherpa.module } },
    );
    const { world } = rig;
    await world.start(rig.host);
    const start = await toolOf(world, 'listen').handler({ action: 'start' }, {});
    assert(!start.failed, `开始失败：${start.text}`);
    eq(rig.capture().target.source, 'system', '采集目标');
    eq(world.envPromptVars()?.['listen.target'], '系统声音', '前缀变量');
    rig.feedFrames(-20, 12); // 第 5 帧时假 sherpa 排一段 400ms
    const stop = await toolOf(world, 'listen').handler({ action: 'stop' }, {});
    assert(!stop.failed, `停止失败：${stop.text}`);
    eq(rig.events.length, 2, `两个事件（400ms + 收尾 100ms）：${rig.events.length}`);
    const first = rig.events[0].e;
    eq(first.type, 'listen.chunk', '事件类型');
    eq(first.meta.source, 'system', 'meta source');
    const firstInfo = wav.wavInfo(Buffer.from(first.blobs[0].bytes));
    assert(Math.abs(firstInfo.seconds - 0.4) < 0.001, `第一块 0.4s：${firstInfo.seconds}`);
    assert(Math.abs(first.meta.durationMs - 400) < 1, `meta 时长：${first.meta.durationMs}`);
    const secondInfo = wav.wavInfo(Buffer.from(rig.events[1].e.blobs[0].bytes));
    assert(Math.abs(secondInfo.seconds - 0.1) < 0.001, `收尾块 0.1s：${secondInfo.seconds}`);
    const st = await world.invoke('status', 'model', []);
    eq(st.model.path, modelFile, '模型路径');
    eq(st.model.source, 'config', '模型来源');
    const fetched = await world.invoke('status', 'fetchModel', []);
    eq(fetched.model.path, modelFile, 'fetchModel 在已有配置路径上直接返回');
    const status = await toolOf(world, 'listen_status').handler({}, {});
    assert(status.text.includes('切分：silero'), `状态回执：${status.text}`);
    await world.stop();
  });

  await checkAsync('只归档模式：事件落库不唤醒', async () => {
    const rig = makeWorld({ wake: 'record' });
    const { world } = rig;
    await world.start(rig.host);
    await toolOf(world, 'listen').handler({ action: 'start' }, {});
    await speakOnce(rig);
    await toolOf(world, 'listen').handler({ action: 'stop' }, {});
    eq(rig.events.length, 1, '一个事件');
    eq(rig.events[0].o.deliver, false, '不唤醒');
    const list = await world.invoke('chunks', 'list', [10]);
    eq(list.state.archived, 1, '归档计数');
    eq(list.items[0].delivered, false, '列表里标只归档');
    await world.stop();
  });

  await checkAsync('限速：一分钟内超出上限的块只归档', async () => {
    const rig = makeWorld({ maxEventsPerMinute: 1 });
    const { world } = rig;
    await world.start(rig.host);
    await toolOf(world, 'listen').handler({ action: 'start' }, {});
    await speakOnce(rig);
    await speakOnce(rig);
    await toolOf(world, 'listen').handler({ action: 'stop' }, {});
    eq(rig.events.length, 2, '两个事件');
    eq(rig.events[0].o.deliver, true, '第一块送达');
    eq(rig.events[1].o.deliver, false, '第二块被限速');
    eq(rig.events[1].e.meta.throttled, true, 'meta 标注限速');
    const list = await world.invoke('chunks', 'list', [10]);
    eq(list.state.throttled, 1, '限速计数');
    await world.stop();
  });

  await checkAsync('control=console：桌宠不许开，但可以停', async () => {
    const rig = makeWorld({ control: 'console' });
    const { world } = rig;
    await world.start(rig.host);
    const refused = await toolOf(world, 'listen').handler({ action: 'start' }, {});
    assert(refused.failed, '应当被拒');
    assert(refused.text.includes('只允许使用者从控制台'), `拒绝文案：${refused.text}`);
    // 控制台能开
    const s = await world.invoke('status', 'start', ['system', '']);
    eq(s.ok, true, '控制台开始');
    eq(s.state.listening, true, '在听');
    const stopped = await toolOf(world, 'listen').handler({ action: 'stop' }, {});
    assert(!stopped.failed && stopped.text.includes('听觉关了'), '桌宠可以停');
    await world.stop();
  });

  await checkAsync('按应用：解析 PID、目标文案、senderKey', async () => {
    const rig = makeWorld({ source: 'app', app: 'chrome' });
    const { world } = rig;
    await world.start(rig.host);
    const start = await toolOf(world, 'listen').handler({ action: 'start', source: 'app', app: 'chrome' }, {});
    assert(!start.failed, `开始失败：${start.text}`);
    assert(start.text.includes('应用 chrome'), `目标文案：${start.text}`);
    eq(rig.capture().target.pid, 4242, 'PID 来自解析');
    await speakOnce(rig);
    await toolOf(world, 'listen').handler({ action: 'stop' }, {});
    eq(rig.events[0].e.senderKey, 'listen:app:chrome', 'senderKey 带应用');
    assert(rig.events[0].e.text.includes('应用 chrome'), '正文带应用');
    await world.stop();
  });

  await checkAsync('自动停止：到点自己关', async () => {
    const rig = makeWorld({ autoStopMinutes: 1 });
    const { world } = rig;
    await world.start(rig.host);
    await toolOf(world, 'listen').handler({ action: 'start' }, {});
    eq(world.webUi('zh').badges[0].value, '听着', '在听');
    rig.clock.advance(61_000);
    rig.timers.run();
    await flush();
    const s = await world.invoke('status', 'state', []);
    eq(s.listening, false, '到点应当停');
    await world.stop();
  });

  await checkAsync('试听：读仓库里那份文件（$file + sha256 + 与事件附件同字节）', async () => {
    const rig = makeWorld();
    const { world } = rig;
    await world.start(rig.host);
    await toolOf(world, 'listen').handler({ action: 'start' }, {});
    await speakOnce(rig);
    await toolOf(world, 'listen').handler({ action: 'stop' }, {});
    const list = await world.invoke('chunks', 'list', [10]);
    eq(list.count, 1, '一条记录');
    const item = list.items[0];
    assert(existsSync(item.path), '记录文件在磁盘上');
    const res = await world.invoke('chunks', 'preview', [item.id]);
    eq(res?.$file?.path, item.path, 'preview 给 $file 路径');
    eq(res.$file.bytes, item.bytes, '$file 字节数');
    const fileBytes = readFileSync(item.path);
    eq(res.$file.sha256, createHash('sha256').update(fileBytes).digest('hex'), 'sha256 对上');
    const eventBytes = Buffer.from(rig.events[0].e.blobs[0].bytes);
    assert(fileBytes.equals(eventBytes), '与事件附件同字节');
    await world.stop();
  });

  await checkAsync('记录跨重启：编号接着数、listen_recent 记得旧块', async () => {
    const dataDir = join(scratch, 'persist-data');
    const rig1 = makeWorld({}, { dataDir });
    await rig1.world.start(rig1.host);
    await toolOf(rig1.world, 'listen').handler({ action: 'start' }, {});
    await speakOnce(rig1);
    await toolOf(rig1.world, 'listen').handler({ action: 'stop' }, {});
    eq(rig1.events.length, 1, '第一程一块');
    await rig1.world.stop();

    // 新的世界实例（模拟重启应用）
    const rig2 = makeWorld({}, { dataDir });
    await rig2.world.start(rig2.host);
    const recent = await toolOf(rig2.world, 'listen_recent').handler({ limit: 5 }, {});
    assert(recent.text.includes('#1'), `旧块还在：${recent.text}`);
    await toolOf(rig2.world, 'listen').handler({ action: 'start' }, {});
    await speakOnce(rig2);
    await toolOf(rig2.world, 'listen').handler({ action: 'stop' }, {});
    const list = await rig2.world.invoke('chunks', 'list', [10]);
    eq(list.count, 2, '两程共两条');
    eq(list.items[0].seq, 2, '编号接着数');
    await rig2.world.stop();
  });

  await checkAsync('状态面板：apps 走注入的清单', async () => {
    const rig = makeWorld({}, { listApps: async () => [{ name: 'chrome', pid: 1, title: 'T' }] });
    const { world } = rig;
    const res = await world.invoke('status', 'apps', []);
    eq(res.apps.length, 1, '一条');
    eq(res.apps[0].name, 'chrome', '名字');
    const s = await world.invoke('status', 'state', []);
    eq(s.listening, false, '初始没在听');
    eq(s.vad.thresholdDb, -42, '门限');
    eq(s.vad.kind, 'energy', '默认切分方式');
    eq(s.model.exists, false, '模型默认没下载');
    eq(s.store.count, 0, '仓库初始为空');
    eq(s.store.keep, 200, '保留条数默认');
    assert(String(s.store.dir).endsWith('listen') || s.store.dir.includes('listen'), '记录目录在 listen 下');
    await world.stop();
  });

  await checkAsync('autoListen：挂载就开听', async () => {
    const rig = makeWorld({ autoListen: true });
    const { world } = rig;
    await world.start(rig.host);
    await flush();
    const s = await world.invoke('status', 'state', []);
    eq(s.listening, true, '挂载后应当听着');
    await world.stop();
  });

  // -------------------------------------------------------------------------
  console.log('WebUI bundle');

  check('纯 ESM：没有顶层 import', () => {
    const src = readFileSync(join(pkgDir, 'dist', 'webui.js'), 'utf8');
    assert(!/^\s*import\s/m.test(src), 'webui bundle 顶层不该有 import');
  });

  await checkAsync('panels 导出形状', async () => {
    const bundle = await import(pathToFileURL(join(pkgDir, 'dist', 'webui.js')).href);
    const panels = bundle.default?.panels ?? {};
    assert(typeof panels.chunks?.mount === 'function', '缺 chunks.mount');
    assert(typeof panels.status?.mount === 'function', '缺 status.mount');
  });
} catch (err) {
  bad(`未捕获的异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${warned} 个提醒，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
