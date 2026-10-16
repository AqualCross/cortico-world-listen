/**
 * 听觉的 WebUI 面板（浏览器侧 bundle）。
 *
 * 宿主按 `/assets/extensions/<包>/<版本>/dist/webui.js` 取这个文件，
 * 直接 `import()` 它的 default 导出；所以它是纯浏览器 ES 模块：
 * 不 import 任何东西（`cortico/*` 在这里只允许 `import type`），只用 ctx.ui。
 */

const STYLE = `
.li-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.li-item { border: 1px solid rgba(128,128,128,.35); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.li-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.li-name { font-weight: 600; }
.li-sub { opacity: .65; font-size: 11px; word-break: break-all; }
.li-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 2px; }
.li-empty { padding: 22px 8px; text-align: center; opacity: .8; }
.li-conn { display: flex; gap: 6px; align-items: center; }
.li-meter { min-width: 180px; flex: 0 1 320px; }
.li-meter[hidden] { display: none; }
.li-ctl { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.li-narrow { max-width: 340px; }
`;

const ZH = {
  listTitle: '听到的',
  listDesc: '听觉切出来的语音块；可试听、复制附件句柄。要文字就把它交给语音转文本。',
  statusTitle: '状态',
  statusDesc: '开关、监听目标与语音切分参数。',
  state: '听觉',
  on: '听着',
  off: '停着',
  chunks: '语音块',
  duration: '合计时长',
  bytes: '合计大小',
  level: '电平',
  refresh: '刷新',
  clearAll: '清空列表',
  clearAsk: '清空「听到的」列表？',
  clearBody: '记录与听觉自己存的音频文件（记录目录里的那些）都会删掉；事件库与媒体库里的附件不动。',
  cleared: '已清空',
  play: '试听',
  playTitle: '试听这块',
  copyHandle: '复制句柄',
  copyFile: '复制路径',
  copyDir: '复制目录',
  remove: '删除',
  removeAsk: '删掉这块语音？',
  removeBody: '记录与它那份音频文件都会删掉；事件库里的附件不动。',
  removed: '已删除',
  openFolder: '打开文件夹',
  openFolderBad: '打不开文件夹',
  noHandle: '（没有附件句柄）',
  forced: '被强切',
  archived: '只归档',
  empty: '还没有听到语音块。到「状态」页打开听觉，或者让桌宠调用 listen。',
  connecting: '实时推送未连接',
  connected: '实时推送中',
  loadBad: '读不到语音块列表',
  busier: '处理中…',
  unknown: '未知',
  ctlTitle: '监听',
  ctlDesc: '立即开始/停止；长期默认值在下面的配置组里。',
  system: '系统声音',
  app: '应用',
  appField: '应用（进程名或 PID）',
  appPick: '列出有声应用',
  appPicked: '已列出，选一个',
  appNone: '没有列出应用',
  start: '开始监听',
  stop: '停止监听',
  started: '已开始监听',
  stopped: '已停止',
  target: '目标',
  none: '无',
  wake: '送达方式',
  wakeNotify: '即时送达',
  wakeRecord: '只归档',
  control: '谁能打开',
  keep: '保留条数',
  rate: '送达上限',
  rateUnit: '块/分（0=不限）',
  dir: '记录目录',
  indexFile: '索引文件',
  vadName: '切分方式',
  vadEnergy: '能量门限',
  vadSilero: 'Silero VAD',
  sileroThreshold: 'Silero 门限',
  model: 'Silero 模型',
  modelMissing: '未下载',
  fetchModel: '获取 Silero 模型',
  fetched: '模型就绪',
  threshold: '门限',
  minSpeech: '起说',
  silence: '收尾静音',
  maxUtt: '单块上限',
  preRoll: '起说前带',
  minUtt: '最短块',
  dropped: '碎片丢掉',
  archivedCount: '只归档',
  module: '采集模块',
  moduleOk: '可用（loopback-capture）',
  moduleOff: '不可用',
  lastChunk: '最近一块',
  lastError: '最近错误',
  runtime: '运行时',
  autoStop: '自动停止',
  startedAt: '开始于',
};

const EN = {
  listTitle: 'Heard',
  listDesc: 'Speech chunks cut out by Hearing; play them or copy the attachment handle.',
  statusTitle: 'Status',
  statusDesc: 'On/off, target and segmentation settings.',
  state: 'Hearing',
  on: 'listening',
  off: 'idle',
  chunks: 'Chunks',
  duration: 'Total length',
  bytes: 'Total size',
  level: 'Level',
  refresh: 'Refresh',
  clearAll: 'Clear list',
  clearAsk: 'Clear the Heard list?',
  clearBody: 'The records and their audio files (the ones in the records folder) are removed; the event store and media copies stay.',
  cleared: 'Cleared',
  play: 'Play',
  playTitle: 'Preview',
  copyHandle: 'Copy handle',
  copyFile: 'Copy path',
  copyDir: 'Copy folder',
  remove: 'Delete',
  removeAsk: 'Delete this chunk?',
  removeBody: 'The record and its audio file are removed; the event store copy stays.',
  removed: 'Deleted',
  openFolder: 'Open folder',
  openFolderBad: 'Could not open the folder',
  noHandle: '(no attachment handle)',
  forced: 'split',
  archived: 'archived only',
  empty: 'No speech chunks yet. Start Hearing on the Status panel, or ask the pet to call listen.',
  connecting: 'Live feed disconnected',
  connected: 'Live feed connected',
  loadBad: 'Could not read the chunk list',
  busier: 'Working…',
  unknown: 'unknown',
  ctlTitle: 'Listening',
  ctlDesc: 'Start/stop right away; long-term defaults live in the config group below.',
  system: 'System audio',
  app: 'Application',
  appField: 'Application (process name or PID)',
  appPick: 'List windowed apps',
  appPicked: 'Listed; pick one',
  appNone: 'No apps listed',
  start: 'Start listening',
  stop: 'Stop listening',
  started: 'Listening',
  stopped: 'Stopped',
  target: 'Target',
  none: 'none',
  wake: 'Delivery',
  wakeNotify: 'notify',
  wakeRecord: 'archive only',
  control: 'Who may start',
  keep: 'Records kept',
  rate: 'Rate cap',
  rateUnit: 'chunks/min (0 = off)',
  dir: 'Records folder',
  indexFile: 'Index file',
  vadName: 'Segmentation',
  vadEnergy: 'energy gate',
  vadSilero: 'Silero VAD',
  sileroThreshold: 'Silero threshold',
  model: 'Silero model',
  modelMissing: 'not downloaded',
  fetchModel: 'Fetch Silero model',
  fetched: 'Model ready',
  threshold: 'Threshold',
  minSpeech: 'Onset',
  silence: 'Trailing silence',
  maxUtt: 'Max length',
  preRoll: 'Pre-roll',
  minUtt: 'Min length',
  dropped: 'Fragments dropped',
  archivedCount: 'Archived',
  module: 'Capture module',
  moduleOk: 'available (loopback-capture)',
  moduleOff: 'unavailable',
  lastChunk: 'Last chunk',
  lastError: 'Last error',
  runtime: 'Runtime',
  autoStop: 'Auto stop',
  startedAt: 'Started',
};

const text = (language) => (language === 'en' ? EN : ZH);

/** 异常一律收敛成一行字。 */
function message(err) {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

function injectStyle(ctx) {
  const el = ctx.ui.h('style');
  el.textContent = STYLE;
  ctx.root.appendChild(el);
}

/** dBFS → 0..1 的条（-70 以下当 0）。 */
function dbPercent(db) {
  const n = Number(db);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, (n + 70) / 70));
}

// ---------------------------------------------------------------------------
// 听到的
// ---------------------------------------------------------------------------

function chunksPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.listTitle, en: 'Heard', desc: tx.listDesc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  body.appendChild(stats);

  const rowbar = ctx.ui.rowbar();
  const connBox = ctx.ui.h('div', 'li-conn');
  const meter = ctx.ui.progress({ label: tx.level, tone: 'accent', value: 0 });
  meter.el.classList.add('li-meter');
  meter.el.hidden = true;
  rowbar.appendChild(connBox);
  rowbar.appendChild(ctx.ui.h('span', 'grow'));
  rowbar.appendChild(meter.el);
  body.appendChild(rowbar);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const dirLine = ctx.ui.h('div', 'li-sub', '');
  body.appendChild(dirLine);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const list = ctx.ui.h('div', 'li-list');
  body.appendChild(list);

  let lastCount = -1;
  let seq = 0;
  let currentDir = '';

  const setConn = (label, tone) => {
    connBox.replaceChildren(ctx.ui.pill(label, tone));
  };
  const say = (line) => {
    note.textContent = line || '';
  };

  const render = (data) => {
    const items = Array.isArray(data?.items) ? data.items : [];
    const s = data?.state ?? {};
    lastCount = typeof data?.count === 'number' ? data.count : items.length;
    currentDir = String(data?.dir ?? '');
    dirLine.textContent = currentDir ? `${tx.dir}：${currentDir}` : '';
    stats.replaceChildren(
      ctx.ui.stat({ k: tx.state, v: s.listening ? tx.on : tx.off }),
      ctx.ui.stat({ k: tx.chunks, v: String(lastCount) }),
      ctx.ui.stat({ k: tx.duration, v: ctx.ui.fmt.duration(data?.totalDurationMs ?? 0) }),
      ctx.ui.stat({ k: tx.bytes, v: ctx.ui.fmt.bytes(data?.totalBytes ?? 0) }),
    );
    meter.el.hidden = !s.listening;
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(ctx.ui.h('div', 'li-empty', tx.empty));
      return;
    }
    for (const item of items) list.appendChild(card(item));
  };

  const card = (item) => {
    const el = ctx.ui.h('div', 'li-item');
    const head = ctx.ui.h('div', 'li-head');
    head.appendChild(ctx.ui.h('span', 'li-name', `#${item.seq}`));
    head.appendChild(ctx.ui.h('span', 'li-sub', [
      ctx.ui.fmt.clock(item.at),
      ctx.ui.fmt.duration(item.durationMs),
      item.target,
      item.forced ? tx.forced : '',
    ].filter(Boolean).join(' · ')));
    el.appendChild(head);

    el.appendChild(ctx.ui.h('div', 'li-sub', [
      item.handle || tx.noHandle,
      ctx.ui.fmt.bytes(item.bytes),
      Number.isFinite(item.peakDb) ? `${item.peakDb} dBFS` : '',
    ].filter(Boolean).join(' · ')));

    const bar = ctx.ui.h('div', 'li-row');
    bar.appendChild(ctx.ui.button(tx.play, { size: 'sm', onClick: () => { void play(item); } }));
    if (item.handle) bar.appendChild(ctx.ui.copyButton(item.handle, { label: tx.copyHandle }));
    bar.appendChild(ctx.ui.copyButton(item.path, { label: tx.copyFile }));
    bar.appendChild(ctx.ui.button(tx.remove, { variant: 'danger', size: 'sm', onClick: () => { void drop(item); } }));
    if (!item.delivered) bar.appendChild(ctx.ui.pill(tx.archived, 'off'));
    el.appendChild(bar);
    return el;
  };

  const reload = async (busy) => {
    const mine = ++seq;
    const release = busy ? ctx.ui.busy(tx.busier, tx.refresh) : null;
    try {
      const data = await ctx.invoke('list', [120]);
      if (mine !== seq || ctx.signal.aborted) return;
      render(data);
      say('');
    } catch (err) {
      if (mine !== seq) return;
      say(`${tx.loadBad}：${message(err)}`);
      ctx.ui.toast(`${tx.loadBad}：${message(err)}`, 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const play = async (item) => {
    try {
      const blob = await ctx.invokeBinary('preview', [item.id]);
      const url = URL.createObjectURL(blob);
      ctx.own({ dispose: () => URL.revokeObjectURL(url) });
      const audio = ctx.ui.h('audio');
      audio.controls = true;
      audio.autoplay = true;
      audio.src = url;
      const box = ctx.ui.h('div');
      box.appendChild(ctx.ui.h('div', 'li-sub', `${ctx.ui.fmt.clock(item.at)} · ${item.target}`));
      box.appendChild(audio);
      ctx.ui.drawer(`${tx.playTitle} · #${item.seq}`, box);
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const drop = async (item) => {
    const ok = await ctx.ui.confirm({ title: tx.removeAsk, body: `${tx.removeBody}\n${item.file}`, danger: true });
    if (!ok) return;
    try {
      await ctx.invoke('remove', [item.id]);
      await reload(false);
      ctx.ui.toast(tx.removed, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const openFolder = async () => {
    try {
      const res = await ctx.invoke('openFolder', []);
      if (!res?.ok) ctx.ui.toast(res?.detail || tx.openFolderBad, 'bad');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const clearAll = async () => {
    const ok = await ctx.ui.confirm({ title: tx.clearAsk, body: tx.clearBody, danger: true });
    if (!ok) return;
    try {
      await ctx.invoke('clear', []);
      await reload(false);
      ctx.ui.toast(tx.cleared, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  actions.append(
    ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void reload(true); } }),
    ctx.ui.button(tx.openFolder, { size: 'sm', onClick: () => { void openFolder(); } }),
    ctx.ui.copyButton(() => currentDir, { label: tx.copyDir }),
    ctx.ui.button(tx.clearAll, { variant: 'danger', size: 'sm', onClick: () => { void clearAll(); } }),
  );

  setConn(tx.connecting, 'plain');
  ctx.own(ctx.stream({
    open: () => setConn(tx.connected, 'on'),
    close: () => setConn(tx.connecting, 'off'),
    message: (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      switch (frame.t) {
        case 'ready':
          setConn(`${tx.connected} · ${frame.count ?? 0}`, 'on');
          break;
        case 'level':
          meter.setValue(dbPercent(frame.db));
          break;
        case 'chunk': {
          const line = frame.chunk
            ? `#${frame.chunk.seq} · ${ctx.ui.fmt.duration(frame.chunk.durationMs)} · ${frame.chunk.target}`
            : '';
          say(line);
          void reload(false);
          break;
        }
        case 'state':
          meter.el.hidden = !frame.state?.listening;
          break;
        case 'cleared':
          void reload(false);
          break;
        case 'error':
          ctx.ui.toast(frame.message || tx.unknown, 'bad');
          break;
        default:
          break;
      }
    },
  }));

  // 推送关掉时页面也能自己追上：只在条数变了以后重建。
  ctx.interval(() => {
    ctx.invoke('list', [1])
      .then((data) => {
        if (typeof data?.count === 'number' && data.count !== lastCount) void reload(false);
      })
      .catch(() => { /* 面板自己会显示错误，这里别刷屏 */ });
  }, 30000);

  void reload(true);
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

function statusPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.statusTitle, en: 'Status', desc: tx.statusDesc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  body.appendChild(stats);

  const ctl = ctx.ui.section(tx.ctlTitle, tx.ctlDesc);
  const syncAppRow = () => {
    appRow.style.display = srcSegment.value === 'app' ? '' : 'none';
  };
  const sourceRow = ctx.ui.h('div', 'li-ctl');
  const srcSegment = ctx.ui.segmented([
    { value: 'system', label: tx.system },
    { value: 'app', label: tx.app },
  ], { size: 'md', value: 'system', onSelect: () => syncAppRow() });
  sourceRow.appendChild(srcSegment.el);
  ctl.appendChild(sourceRow);

  const appRow = ctx.ui.h('div', 'li-ctl');
  const appInput = ctx.ui.input({ placeholder: 'chrome.exe / 1234', cls: 'mono' });
  appInput.classList.add('li-narrow');
  const appBtn = ctx.ui.button(tx.appPick, { size: 'sm', onClick: () => { void pickApp(); } });
  const appSelect = ctx.ui.select({ options: [] });
  appSelect.style.display = 'none';
  appRow.append(ctx.ui.field(tx.appField, appInput), appBtn, appSelect);
  ctl.appendChild(appRow);

  const runRow = ctx.ui.h('div', 'li-ctl');
  const startBtn = ctx.ui.button(tx.start, { variant: 'primary', size: 'md', onClick: () => { void start(); } });
  const stopBtn = ctx.ui.button(tx.stop, { variant: 'danger', size: 'md', onClick: () => { void stop(); } });
  const fetchBtn = ctx.ui.button(tx.fetchModel, { size: 'md', onClick: () => { void fetchModel(); } });
  runRow.append(startBtn, stopBtn, fetchBtn);
  ctl.appendChild(runRow);

  const ctlNote = ctx.ui.msgline('');
  ctl.appendChild(ctlNote);
  body.appendChild(ctl);

  const kvBox = ctx.ui.h('div');
  body.appendChild(kvBox);

  const vadBox = ctx.ui.h('div');
  body.appendChild(vadBox);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const render = (s) => {
    const listening = Boolean(s?.listening);
    stats.replaceChildren(
      ctx.ui.stat({ k: tx.state, v: ctx.ui.pill(listening ? tx.on : tx.off, listening ? 'on' : 'off') }),
      ctx.ui.stat({ k: tx.chunks, v: String(s?.chunks ?? 0) }),
      ctx.ui.stat({ k: tx.target, v: s?.target || '—' }),
      ctx.ui.stat({ k: tx.runtime, v: `${s?.node ?? '?'} · ${s?.platform ?? '?'}` }),
    );
    startBtn.disabled = listening;
    stopBtn.disabled = !listening;
    if (!listening && (s?.source === 'system' || s?.source === 'app')) srcSegment.setValue(s.source);
    if (s?.app && !appInput.value) appInput.value = s.app;
    syncAppRow();

    vadBox.replaceChildren(ctx.ui.kv([
      { k: tx.vadName, v: s?.vad?.kind === 'silero' ? tx.vadSilero : tx.vadEnergy },
      { k: tx.sileroThreshold, v: String(s?.vad?.sileroThreshold ?? '—') },
      { k: tx.threshold, v: `${s?.vad?.thresholdDb ?? '—'} dBFS` },
      { k: tx.minSpeech, v: `${s?.vad?.minSpeechMs ?? '—'} ms` },
      { k: tx.silence, v: `${s?.vad?.silenceMs ?? '—'} ms` },
      { k: tx.maxUtt, v: `${s?.vad?.maxUtteranceMs ?? '—'} ms` },
      { k: tx.preRoll, v: `${s?.vad?.preRollMs ?? '—'} ms` },
      { k: tx.minUtt, v: `${s?.vad?.minUtteranceMs ?? '—'} ms` },
      { k: tx.dropped, v: String(s?.dropped ?? 0) },
    ]));

    kvBox.replaceChildren(ctx.ui.kv([
      { k: tx.wake, v: s?.wake === 'record' ? tx.wakeRecord : tx.wakeNotify },
      { k: tx.control, v: s?.control ?? '—' },
      { k: tx.dir, v: s?.store?.dir || '—' },
      { k: tx.indexFile, v: s?.store?.indexFile || '—' },
      { k: tx.keep, v: String(s?.store?.keep ?? '—') },
      { k: tx.rate, v: `${s?.maxEventsPerMinute ?? 0} ${tx.rateUnit}` },
      { k: tx.module, v: s?.module?.ok ? tx.moduleOk : `${tx.moduleOff}：${s?.module?.error ?? ''}` },
      { k: tx.model, v: modelText(s) },
      { k: tx.startedAt, v: s?.startedAt || tx.none },
      { k: tx.autoStop, v: s?.autoStopAt || tx.none },
      { k: tx.lastChunk, v: s?.lastChunkAt || tx.none },
      { k: tx.archivedCount, v: String(s?.archived ?? 0) },
      { k: tx.lastError, v: s?.lastError || tx.none },
    ]));
  };

  const load = async (busy) => {
    const release = busy ? ctx.ui.busy(tx.busier, tx.statusTitle) : null;
    try {
      const s = await ctx.invoke('state', []);
      if (ctx.signal.aborted) return;
      render(s);
    } catch (err) {
      note.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  /** 模型那行的文案：有路径没文件标「未下载」。 */
  const modelText = (s) => {
    const model = s?.model ?? {};
    if (!model.path) return tx.none;
    return model.exists
      ? `${ctx.ui.fmt.bytes(model.sizeBytes)} · ${model.path}`
      : `${tx.modelMissing} · ${model.path}`;
  };

  const fetchModel = async () => {
    const release = ctx.ui.busy(tx.busier, tx.fetchModel);
    try {
      const res = await ctx.invoke('fetchModel', []);
      ctlNote.textContent = `${tx.fetched}：${res?.model?.path ?? ''}`;
      ctx.ui.toast(tx.fetched, 'ok');
      await load(false);
    } catch (err) {
      ctlNote.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      release.dispose();
    }
  };

  const pickApp = async () => {
    const release = ctx.ui.busy(tx.busier, tx.appPick);
    try {
      const data = await ctx.invoke('apps', []);
      const apps = Array.isArray(data?.apps) ? data.apps : [];
      if (!apps.length) {
        ctlNote.textContent = tx.appNone;
        return;
      }
      appSelect.replaceChildren();
      for (const app of apps) {
        const opt = document.createElement('option');
        opt.value = app.name;
        opt.textContent = `${app.name} · ${app.title || app.pid}`;
        appSelect.appendChild(opt);
      }
      appSelect.style.display = '';
      appInput.value = apps[0].name;
      ctlNote.textContent = tx.appPicked;
    } catch (err) {
      ctlNote.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      release.dispose();
    }
  };
  appSelect.addEventListener('change', () => { appInput.value = appSelect.value; });

  const start = async () => {
    const source = srcSegment.value;
    const app = source === 'app' ? appInput.value.trim() : '';
    const release = ctx.ui.busy(tx.busier, tx.start);
    try {
      const res = await ctx.invoke('start', [source, app]);
      render(res?.state ?? {});
      ctlNote.textContent = tx.started;
      ctx.ui.toast(tx.started, 'ok');
    } catch (err) {
      ctlNote.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      release.dispose();
    }
  };

  const stop = async () => {
    const release = ctx.ui.busy(tx.busier, tx.stop);
    try {
      const res = await ctx.invoke('stop', []);
      render(res?.state ?? {});
      ctlNote.textContent = tx.stopped;
      ctx.ui.toast(tx.stopped, 'ok');
    } catch (err) {
      ctlNote.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      release.dispose();
    }
  };

  actions.append(
    ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void load(true); } }),
  );

  ctx.own(ctx.stream({
    message: (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (frame?.t === 'state' && frame.state) render(frame.state);
    },
  }));

  void load(true);
}

export default {
  panels: {
    chunks: { mount: chunksPanel },
    status: { mount: statusPanel },
  },
};
