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
.li-listen-controls { width: 100%; min-width: 0; margin-inline: 0; }
.li-listen-controls .li-source-row { margin: 20px 0 16px; }
.li-listen-controls .li-app-row,
.li-listen-controls .li-run-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; max-width: 480px; }
.li-listen-controls .li-app-row { margin-bottom: 16px; }
.li-listen-controls .li-control-field { display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; margin: 0; }
.li-listen-controls .li-control-field > input,
.li-listen-controls .li-control-field > select { width: 100%; max-width: none; box-sizing: border-box; }
.li-listen-controls .li-app-row > .btn,
.li-listen-controls .li-run-action > .btn,
.li-listen-controls .li-control-field > input,
.li-listen-controls .li-control-field > select { height: 40px; }
.li-listen-controls .li-run-action { display: flex; align-items: center; gap: 12px; min-height: 40px; }
.li-listen-controls .li-run-action > .btn { min-width: 104px; white-space: nowrap; flex-shrink: 0; }
.li-listen-controls .li-run-action > .msgline { margin: 0; max-width: 180px; overflow-wrap: anywhere; }
.li-listen-controls .li-run-row { grid-template-columns: minmax(0, 364px) 104px minmax(0, 1fr); max-width: none; }
.li-listen-controls .li-run-action { display: contents; }
.li-listen-controls .li-run-action > .msgline { align-self: center; margin-top: 24px; }
@media (max-width: 520px) {
  .li-listen-controls .li-run-row { grid-template-columns: minmax(0, 1fr) 104px; }
  .li-listen-controls .li-run-action > .msgline { grid-column: 2; margin-top: 0; }
}
.li-listen-controls .li-app-row > select { grid-column: 1 / -1; width: 100%; }
.li-listen-controls .msgline:empty { display: none; }
@media (max-width: 380px) {
  .li-listen-controls .li-app-row { grid-template-columns: minmax(0, 1fr); }
  .li-listen-controls .li-app-row > .btn { justify-self: start; }
}
`;

const ZH = {
  listTitle: '听到的',
  listDesc: '听觉切出来的语音块；可试听、复制附件句柄。要文字就把它交给语音转文本。',
  statusTitle: '状态',
  statusDesc: '监听开关、声音来源与听觉模块。',
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
  deliveryFailed: '事件写入失败',
  empty: '还没有听到语音块。到「状态」页打开听觉，或者让桌宠调用 listen。',
  connecting: '实时推送未连接',
  connected: '实时推送中',
  loadBad: '读不到语音块列表',
  busier: '处理中…',
  unknown: '未知',
  ctlTitle: '监听',
  hearingModule: '听觉模块',
  preparingModule: '正在准备 Silero，缺少的组件和模型将自动下载…',
  preparationStages: {
    'checking-runtime': '正在检查 Silero 运行组件…',
    'installing-runtime': '正在安装 Silero 运行组件…',
    'checking-model': '正在检查 Silero 模型…',
    'downloading-model': '正在下载 Silero 模型…',
    'saving-model': '正在保存 Silero 模型…',
    ready: 'Silero 已就绪，正在保存选择…',
  },
  moduleReady: '听觉模块已更新',
  system: '系统声音',
  app: '应用',
  appField: '应用（进程名或 PID）',
  appPick: '刷新应用列表',
  appChoose: '请选择应用',
  appAudio: '有音频会话',
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
  deliveryFailed: 'Event write failed',
  empty: 'No speech chunks yet. Start Hearing on the Status panel, or ask the pet to call listen.',
  connecting: 'Live feed disconnected',
  connected: 'Live feed connected',
  loadBad: 'Could not read the chunk list',
  busier: 'Working…',
  unknown: 'unknown',
  ctlTitle: 'Listening',
  hearingModule: 'Hearing module',
  preparingModule: 'Preparing Silero; missing components and model will be downloaded…',
  preparationStages: {
    'checking-runtime': 'Checking Silero runtime…',
    'installing-runtime': 'Installing Silero runtime…',
    'checking-model': 'Checking Silero model…',
    'downloading-model': 'Downloading Silero model…',
    'saving-model': 'Saving Silero model…',
    ready: 'Silero ready; saving selection…',
  },
  moduleReady: 'Hearing module updated',
  system: 'System audio',
  app: 'Application',
  appField: 'Application (process name or PID)',
  appPick: 'Refresh apps',
  appChoose: 'Choose an application',
  appAudio: 'Audio sessions',
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

  const body = ctx.ui.h('div', 'sheetbody li-heard-content');
  ctx.root.appendChild(body);

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
    void ctx.refresh().catch(() => { /* Synchronize the host record-count badges. */ });
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
    if (item.deliveryError) bar.appendChild(ctx.ui.pill(tx.deliveryFailed, 'off'));
    else if (!item.delivered) bar.appendChild(ctx.ui.pill(tx.archived, 'off'));
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
          void ctx.refresh().catch(() => {});
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

  // Keep the panel at the host content's left edge rather than centering a narrow root.
  ctx.root.style.width = '100%';
  ctx.root.style.maxWidth = 'none';
  ctx.root.style.marginInline = '0';

  const body = ctx.ui.h('div', 'li-listen-controls');
  ctx.root.appendChild(body);
  let listening = false;
  let pending = true;
  let selectedModule = 'energy';

  const ctl = ctx.ui.h('div', 'li-listen-form');
  const syncAppRow = () => {
    appRow.style.display = srcSegment.value === 'app' ? '' : 'none';
  };
  const sourceRow = ctx.ui.h('div', 'li-ctl li-source-row');
  const srcSegment = ctx.ui.segmented([
    { value: 'system', label: tx.system },
    { value: 'app', label: tx.app },
  ], { size: 'md', value: 'system', onSelect: () => syncAppRow() });
  sourceRow.appendChild(srcSegment.el);

  const appRow = ctx.ui.h('div', 'li-app-row');
  const appInput = ctx.ui.input({ placeholder: 'chrome.exe / 1234', cls: 'mono' });
  appInput.classList.add('li-narrow');
  const appBtn = ctx.ui.button(tx.appPick, { size: 'sm', onClick: () => { void pickApp(); } });
  const appSelect = ctx.ui.select({ options: [] });
  appSelect.style.display = 'none';
  const appField = ctx.ui.field(tx.appField, appInput);
  appField.classList.add('li-control-field');
  appRow.append(appField, appBtn, appSelect);

  const runRow = ctx.ui.h('div', 'li-run-row');
  const toggleBtn = ctx.ui.button(tx.start, { variant: 'primary', size: 'md', onClick: () => { if (!pending) void (listening ? stop() : start()); } });
  toggleBtn.disabled = true;
  const moduleSelect = ctx.ui.select({ options: [
    { value: 'energy', label: tx.vadEnergy },
    { value: 'silero', label: tx.vadSilero },
  ] });
  moduleSelect.disabled = true;
  const moduleField = ctx.ui.field(tx.hearingModule, moduleSelect);
  moduleField.classList.add('li-control-field');
  const runAction = ctx.ui.h('div', 'li-run-action');
  runAction.appendChild(toggleBtn);
  runRow.append(moduleField, runAction);
  moduleSelect.addEventListener('change', () => { void changeModule(); });
  ctl.append(runRow, sourceRow, appRow);

  const ctlNote = ctx.ui.msgline('');
  runAction.appendChild(ctlNote);
  body.appendChild(ctl);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const syncControls = () => {
    toggleBtn.textContent = pending ? tx.busier : (listening ? tx.stop : tx.start);
    toggleBtn.disabled = pending;
    moduleSelect.disabled = pending || listening;
    appInput.disabled = pending || listening;
    appBtn.disabled = pending || listening;
    appSelect.disabled = pending || listening;
    srcSegment.el.style.pointerEvents = pending || listening ? 'none' : '';
    srcSegment.el.inert = pending || listening;
  };
  const render = (s) => {
    listening = Boolean(s?.listening);
    selectedModule = s?.vad?.kind === 'silero' ? 'silero' : 'energy';
    moduleSelect.value = selectedModule;
    if (s?.source === 'system' || s?.source === 'app') srcSegment.setValue(s.source);
    if (s?.app && !appInput.value) appInput.value = s.app;
    note.textContent = s?.lastError || '';
    syncAppRow();
    syncControls();
    // The host owns the header badges; panel state updates do not repaint them.
    void ctx.refresh().catch(() => { /* Keep the controls usable if header refresh fails. */ });
  };

  const load = async (busy) => {
    const release = busy ? ctx.ui.busy(tx.busier, tx.statusTitle) : null;
    try {
      const s = await ctx.invoke('state', []);
      if (ctx.signal.aborted) return;
      pending = false;
      render(s);
    } catch (err) {
      note.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const changeModule = async () => {
    const next = moduleSelect.value;
    if (pending || listening) { moduleSelect.value = selectedModule; return; }
    pending = true;
    syncControls();
    ctlNote.textContent = next === 'silero' ? tx.preparingModule : '';
    try {
      await ctx.invoke('prepareModule', [next]);
      if (ctx.signal.aborted) return;
      await ctx.setConfig('world:listen', { 'worlds.listen.vad': next });
      selectedModule = next;
      ctlNote.textContent = tx.moduleReady;
      await load(false);
    } catch (err) {
      moduleSelect.value = selectedModule;
      ctlNote.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      pending = false;
      syncControls();
    }
  };

  const pickApp = async () => {
    if (pending || listening) return;
    pending = true;
    syncControls();
    const release = ctx.ui.busy(tx.busier, tx.appPick);
    try {
      const data = await ctx.invoke('apps', []);
      const apps = Array.isArray(data?.apps) ? data.apps : [];
      const current = appInput.value.trim();
      appSelect.replaceChildren();
      appSelect.style.display = apps.length ? '' : 'none';
      if (!apps.length) {
        ctlNote.textContent = tx.appNone;
        return;
      }
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = tx.appChoose;
      appSelect.appendChild(placeholder);
      const groups = new Map();
      for (const app of apps) {
        const label = tx.appAudio;
        if (!groups.has(label)) {
          const group = document.createElement('optgroup');
          group.label = label;
          groups.set(label, group);
          appSelect.appendChild(group);
        }
        const opt = document.createElement('option');
        opt.value = String(app.pid);
        opt.textContent = `${app.name} · ${app.title || ''} (PID ${app.pid})`;
        groups.get(label).appendChild(opt);
      }
      appSelect.value = apps.some((app) => String(app.pid) === current) ? current : '';
      ctlNote.textContent = tx.appPicked;
    } catch (err) {
      appSelect.replaceChildren();
      appSelect.style.display = 'none';
      ctlNote.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      pending = false;
      syncControls();
      release.dispose();
    }
  };
  appSelect.addEventListener('change', () => { if (appSelect.value) appInput.value = appSelect.value; });
  appInput.addEventListener('input', () => { appSelect.value = appInput.value.trim(); });

  const start = async () => {
    const source = srcSegment.value;
    const app = source === 'app' ? appInput.value.trim() : '';
    pending = true;
    syncControls();
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
      pending = false;
      syncControls();
      release.dispose();
    }
  };

  const stop = async () => {
    pending = true;
    syncControls();
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
      pending = false;
      syncControls();
      release.dispose();
    }
  };

  ctx.own(ctx.stream({
    message: (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (frame?.t === 'state' && frame.state) render(frame.state);
      if (frame?.t === 'module-progress' && pending && tx.preparationStages[frame.stage]) {
        ctlNote.textContent = tx.preparationStages[frame.stage];
      }
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
