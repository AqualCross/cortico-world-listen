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
.li-record-row { display: flex; gap: 10px 14px; align-items: center; flex-wrap: wrap; }
.li-record-main { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; min-width: 0; }
.li-record-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto; }
.li-name { font-weight: 600; }
.li-sub { opacity: .65; font-size: 11px; word-break: break-all; }
.li-empty { padding: 22px 8px; text-align: center; opacity: .8; }
.li-narrow { max-width: 340px; }
.li-listen-controls { width: 100%; min-width: 0; margin-inline: 0; }
.li-src-list { display: flex; flex-direction: column; gap: 8px; margin: 18px 0 0; max-width: 720px; }
.li-src-row { display: grid; grid-template-columns: auto minmax(0, 1fr) 150px; gap: 10px; align-items: center; border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 8px 10px; }
.li-src-row > input { width: 18px; height: 18px; margin: 0; accent-color: currentColor; }
.li-src-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.li-src-name { font-weight: 600; overflow-wrap: anywhere; }
.li-src-row > select { height: 36px; width: 100%; box-sizing: border-box; }
.li-listen-controls .li-add-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; max-width: 720px; margin-top: 12px; }
.li-listen-controls .li-add-row > .li-control-field { display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; margin: 0; }
.li-listen-controls .li-add-row input { height: 40px; width: 100%; max-width: none; box-sizing: border-box; }
.li-listen-controls .li-add-row > .btn { height: 40px; }
.li-listen-controls > .msgline { margin-top: 16px; max-width: 720px; }
.li-listen-controls .li-apps-note { margin-top: 8px; max-width: 720px; }
.li-listen-controls .li-apps-note:empty { display: none; }
.li-heard-content > .rowbar.actionbar:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.li-listen-controls .msgline:empty { display: none; }
.li-tools { width: 100%; max-width: 900px; }
.li-tools .li-tools-toolbar { display: flex; gap: 10px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
.li-tools .li-tools-toolbar input { flex: 1 1 240px; min-width: 200px; height: 38px; box-sizing: border-box; }
.li-tools .li-tool-card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; margin-top: 10px; }
.li-tools .li-tool-summary { display: flex; gap: 8px; align-items: center; padding: 10px 12px; cursor: pointer; flex-wrap: wrap; }
.li-tools .li-tool-heading { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.li-tools .li-tool-name { font-family: monospace; font-weight: 600; }
.li-tools .li-tool-tag { border: 1px solid rgba(128,128,128,.4); border-radius: 6px; padding: 1px 6px; font-size: 11px; opacity: .8; }
.li-tools .li-tool-source { margin-left: auto; font-size: 11px; opacity: .65; }
.li-tools .li-tool-body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 12px; }
.li-tools .li-tool-field { display: flex; flex-direction: column; gap: 6px; }
.li-tools .li-tool-field > label { font-size: 12px; opacity: .8; }
.li-tools .li-tool-field textarea { width: 100%; box-sizing: border-box; resize: vertical; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit; }
.li-tools .li-tool-field-footer { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.li-tools .li-tool-default { font-size: 12px; opacity: .75; }
.li-tools .li-tool-default pre { white-space: pre-wrap; margin: 4px 0 0; font-size: 11px; }
.li-tools .li-tools-warnings { color: #c85; font-size: 12px; }
@media (max-width: 520px) {
  .li-src-row { grid-template-columns: auto minmax(0, 1fr); }
  .li-src-row > select { grid-column: 2; }
  .li-listen-controls .li-add-row { grid-template-columns: minmax(0, 1fr); }
  .li-listen-controls .li-add-row > .btn { justify-self: start; }
}
`;

const ZH = {
  listTitle: '记录',
  listDesc: '听觉切出来的语音块；可试听、复制附件句柄。要文字就把它交给语音转文本。',
  statusTitle: '来源',
  statusDesc: '勾选来源即开始监听，取消勾选即停止；每一路可以单独选切分方式。',
  refresh: '刷新',
  clearAll: '全部删除',
  clearAsk: '删除全部记录？',
  clearBody: '记录与听觉自己存的音频文件（记录目录里的那些）都会删掉；事件库与媒体库里的附件不动。',
  cleared: '已清空',
  play: '试听',
  playTitle: '试听这块',
  copyHandle: '复制句柄',
  copyFile: '复制路径',
  remove: '删除',
  removeAsk: '删掉这块语音？',
  removeBody: '记录与它那份音频文件都会删掉；事件库里的附件不动。',
  removed: '已删除',
  openFolder: '打开文件夹',
  openFolderBad: '打不开文件夹',
  forced: '被强切',
  archived: '只归档',
  deliveryFailed: '事件写入失败',
  empty: '还没有记录语音块。到「来源」页勾选一个来源，或者让桌宠调用 listen。',
  loadBad: '读不到语音块列表',
  busier: '处理中…',
  unknown: '未知',
  preparingModule: '正在准备 VAD，缺少的组件和模型将自动下载…',
  preparationStages: {
    'checking-runtime': '正在检查 VAD 运行组件…',
    'installing-runtime': '正在安装 VAD 运行组件…',
    'checking-model': '正在检查 VAD 模型…',
    'downloading-model': '正在下载 VAD 模型…',
    'saving-model': '正在保存 VAD 模型…',
    ready: 'VAD 已就绪，正在保存选择…',
  },
  moduleReady: '切分方式已更新',
  system: '系统声音',
  app: '应用',
  appField: '应用（进程名或 PID）',
  appAdd: '添加',
  appNone: '没有列出应用',
  appNotListed: '尚未建立音频会话',
  appExists: '已经在列表里',
  appsLoading: '应用列表加载中',
  live: (chunks, vad) => `${chunks} 块 · ${vad}`,
  target: '目标',
  none: '无',
  wake: '送达方式',
  wakeNotify: '即时送达',
  wakeRecord: '只归档',
  control: '谁能打开',
  keep: '保留条数',
  rate: '送达上限',
  rateUnit: '块/分（0=不限）',
  indexFile: '索引文件',
  vadName: '切分方式',
  vadEnergy: '能量门限',
  vadSilero: 'Silero VAD',
  vadFirered: 'FireRed VAD',
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
  toolsSave: '保存修改',
  toolsReset: '恢复默认',
  toolsSearch: '筛选工具名或说明',
  toolsDirty: '有未保存的工具说明',
  toolsSaved: '工具说明已保存。',
  toolsRestored: '已移除部署覆盖。',
  toolsResetTitle: '恢复全部工具说明？',
  toolsResetBody: '移除本部署的工具说明覆盖，并放弃未保存的修改。',
  toolsDefaultText: '默认文字',
  toolsNoDescription: '尚未声明说明',
  toolsToolDescription: '工具描述',
  toolsParametersDescription: '参数整体说明',
  toolsEmpty: '没有匹配的工具',
  toolsSourceDefault: '扩展默认',
  toolsSourcePackage: 'bot 包覆盖',
  toolsSourceDeployment: '部署覆盖',
  toolsInvalidFile: '覆盖文件无法读取，使用上层默认文字。',
  toolsStale: '以下覆盖字段已不存在，未应用：',
  toolsTitle: '标题',
  toolsDescription: '说明',
  tagRead: '读取',
  tagAct: '行动',
  tagWrite: '写入',
  tagSpeak: '发言',
  tagFlow: '流程',
  tagSnapshot: '快照',
};

const EN = {
  listTitle: 'Records',
  listDesc: 'Speech chunks cut out by Hearing; play them or copy the attachment handle.',
  statusTitle: 'Sources',
  statusDesc: 'Checking a source starts listening; unchecking stops it. Each lane picks its own segmentation.',
  refresh: 'Refresh',
  clearAll: 'Delete all',
  clearAsk: 'Delete all records?',
  clearBody: 'The records and their audio files (the ones in the records folder) are removed; the event store and media copies stay.',
  cleared: 'Cleared',
  play: 'Play',
  playTitle: 'Preview',
  copyHandle: 'Copy handle',
  copyFile: 'Copy path',
  remove: 'Delete',
  removeAsk: 'Delete this chunk?',
  removeBody: 'The record and its audio file are removed; the event store copy stays.',
  removed: 'Deleted',
  openFolder: 'Open folder',
  openFolderBad: 'Could not open the folder',
  forced: 'split',
  archived: 'archived only',
  deliveryFailed: 'Event write failed',
  empty: 'No speech chunks recorded yet. Check a source on the Sources panel, or ask the pet to call listen.',
  loadBad: 'Could not read the chunk list',
  busier: 'Working…',
  unknown: 'unknown',
  preparingModule: 'Preparing VAD; missing components and model will be downloaded…',
  preparationStages: {
    'checking-runtime': 'Checking VAD runtime…',
    'installing-runtime': 'Installing VAD runtime…',
    'checking-model': 'Checking VAD model…',
    'downloading-model': 'Downloading VAD model…',
    'saving-model': 'Saving VAD model…',
    ready: 'VAD ready; saving selection…',
  },
  moduleReady: 'Segmentation updated',
  system: 'System audio',
  app: 'Application',
  appField: 'Application (process name or PID)',
  appAdd: 'Add',
  appNone: 'No apps listed',
  appNotListed: 'No audio session yet',
  appExists: 'Already listed',
  appsLoading: 'Loading applications…',
  live: (chunks, vad) => `${chunks} chunks · ${vad}`,
  target: 'Target',
  none: 'none',
  wake: 'Delivery',
  wakeNotify: 'notify',
  wakeRecord: 'archive only',
  control: 'Who may start',
  keep: 'Records kept',
  rate: 'Rate cap',
  rateUnit: 'chunks/min (0 = off)',
  indexFile: 'Index file',
  vadName: 'Segmentation',
  vadEnergy: 'energy gate',
  vadSilero: 'Silero VAD',
  vadFirered: 'FireRed VAD',
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
  toolsSave: 'Save changes',
  toolsReset: 'Restore defaults',
  toolsSearch: 'Filter tool names or descriptions',
  toolsDirty: 'Unsaved tool text',
  toolsSaved: 'Tool text saved.',
  toolsRestored: 'Deployment overrides removed.',
  toolsResetTitle: 'Restore all tool text?',
  toolsResetBody: 'Remove this deployment\'s tool text overrides and discard unsaved changes.',
  toolsDefaultText: 'Default text',
  toolsNoDescription: 'No description declared',
  toolsToolDescription: 'Tool description',
  toolsParametersDescription: 'Description of all parameters',
  toolsEmpty: 'No matching tools',
  toolsSourceDefault: 'Extension default',
  toolsSourcePackage: 'Bot package override',
  toolsSourceDeployment: 'Deployment override',
  toolsInvalidFile: 'The override file cannot be read; inherited text is used.',
  toolsStale: 'These override fields no longer exist and are not applied:',
  toolsTitle: 'Title',
  toolsDescription: 'Description',
  tagRead: 'read',
  tagAct: 'act',
  tagWrite: 'write',
  tagSpeak: 'speak',
  tagFlow: 'flow',
  tagSnapshot: 'snapshot',
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

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

function chunksPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const body = ctx.ui.h('div', 'sheetbody li-heard-content');
  ctx.root.appendChild(body);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const list = ctx.ui.h('div', 'li-list');
  body.appendChild(list);

  let lastCount = -1;
  let seq = 0;

  const say = (line) => {
    note.textContent = line || '';
  };

  const render = (data) => {
    void ctx.refresh().catch(() => { /* Synchronize the host record-count badges. */ });
    const items = Array.isArray(data?.items) ? data.items : [];
    lastCount = typeof data?.count === 'number' ? data.count : items.length;
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(ctx.ui.h('div', 'li-empty', tx.empty));
      return;
    }
    for (const item of items) list.appendChild(card(item));
  };

  const card = (item) => {
    const el = ctx.ui.h('div', 'li-item');
    const row = ctx.ui.h('div', 'li-record-row');
    const main = ctx.ui.h('div', 'li-record-main');
    main.appendChild(ctx.ui.h('span', 'li-name', `#${item.seq}`));
    main.appendChild(ctx.ui.h('span', 'li-sub', [
      ctx.ui.fmt.clock(item.at),
      ctx.ui.fmt.duration(item.durationMs),
      item.app || item.target,
      ctx.ui.fmt.bytes(item.bytes),
      Number.isFinite(item.peakDb) ? `${item.peakDb} dBFS` : '',
      item.forced ? tx.forced : '',
    ].filter(Boolean).join(' · ')));
    if (item.deliveryError) main.appendChild(ctx.ui.pill(tx.deliveryFailed, 'off'));
    else if (!item.delivered) main.appendChild(ctx.ui.pill(tx.archived, 'off'));
    row.appendChild(main);

    const actions = ctx.ui.h('div', 'li-record-actions');
    actions.appendChild(ctx.ui.button(tx.play, { size: 'sm', onClick: () => { void play(item); } }));
    if (item.handle) actions.appendChild(ctx.ui.copyButton(item.handle, { label: tx.copyHandle }));
    actions.appendChild(ctx.ui.copyButton(item.path, { label: tx.copyFile }));
    actions.appendChild(ctx.ui.button(tx.remove, { variant: 'danger', size: 'sm', onClick: () => { void drop(item); } }));
    row.appendChild(actions);
    el.appendChild(row);
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
    ctx.ui.button(tx.openFolder, { size: 'sm', onClick: () => { void openFolder(); } }),
    ctx.ui.button(tx.clearAll, { variant: 'danger', size: 'sm', onClick: () => { void clearAll(); } }),
  );

  ctx.own(ctx.stream({
    message: (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      switch (frame.t) {
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
  let applying = false;
  let dirty = false;
  let hold = false;
  let appsLoaded = false;
  let savedVads = new Map();

  /** 第一行是系统声音；应用行按加入顺序排在后面。 */
  let rows = [];

  const list = ctx.ui.h('div', 'li-src-list');
  const appsNote = ctx.ui.h('div', 'li-sub li-apps-note', '');
  body.append(list, appsNote);

  const addRow = ctx.ui.h('div', 'li-add-row');
  const appInput = ctx.ui.input({ placeholder: 'chrome.exe / 1234', cls: 'mono' });
  appInput.classList.add('li-narrow');
  const addBtn = ctx.ui.button(tx.appAdd, { size: 'sm', onClick: () => { addManual(); } });
  const appField = ctx.ui.field(tx.appField, appInput);
  appField.classList.add('li-control-field');
  addRow.append(appField, addBtn);
  body.appendChild(addRow);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const validVad = (vad) => (vad === 'silero' || vad === 'firered' || vad === 'energy' ? vad : 'energy');
  const normApp = (value) => String(value ?? '').trim().toLowerCase().replace(/\.exe$/, '');
  const systemRow = () => rows.find((row) => row.source === 'system');

  const rowMatches = (row, target) => {
    if (row.source === 'system') return target.key === 'system';
    if (row.pid && target.pid === row.pid) return true;
    return normApp(row.app) === normApp(target.app);
  };

  const sameApp = (row, app) => {
    const wanted = normApp(app);
    if (!wanted) return false;
    if (row.pid && wanted === String(row.pid)) return true;
    return normApp(row.app) === wanted;
  };

  const syncControls = () => {
    const locked = pending || applying;
    appInput.disabled = locked;
    addBtn.disabled = locked;
  };

  const renderRows = () => {
    list.replaceChildren();
    for (const row of rows) {
      const el = ctx.ui.h('div', 'li-src-row');
      const check = ctx.ui.h('input');
      check.type = 'checkbox';
      check.checked = row.checked;
      check.disabled = pending;
      check.addEventListener('change', () => { toggle(row, check.checked); });
      el.appendChild(check);

      const main = ctx.ui.h('div', 'li-src-main');
      main.appendChild(ctx.ui.h('span', 'li-src-name', row.source === 'system' ? tx.system : row.app));
      const sub = row.source === 'system'
        ? (row.live ? tx.live(row.live.chunks, row.live.vad) : '')
        : [row.title, row.pid ? `PID ${row.pid}` : tx.appNotListed, row.live ? tx.live(row.live.chunks, row.live.vad) : '', row.error || '']
          .filter(Boolean).join(' · ');
      if (sub) main.appendChild(ctx.ui.h('span', 'li-sub', sub));
      el.appendChild(main);

      const select = ctx.ui.select({ options: [
        { value: 'energy', label: tx.vadEnergy },
        { value: 'silero', label: tx.vadSilero },
        { value: 'firered', label: tx.vadFirered },
      ] });
      select.value = row.vad;
      select.disabled = pending || applying;
      select.addEventListener('change', () => { void changeVad(row, select.value, select); });
      el.appendChild(select);

      list.appendChild(el);
    }
    syncControls();
  };

  const currentTargets = () => {
    const system = systemRow();
    if (system?.checked) return [{ source: 'system', vad: system.vad }];
    return rows.filter((row) => row.source === 'app' && row.checked)
      .map((row) => ({ source: 'app', app: row.pid ? String(row.pid) : row.app, vad: row.vad }));
  };

  /** 把当前选择写回配置；什么都没选时只保留默认切分方式。 */
  const persist = async () => {
    const system = systemRow();
    const apps = rows.filter((row) => row.source === 'app' && row.checked);
    const values = {};
    if (system) values['worlds.listen.vad'] = system.vad;
    if (system?.checked) {
      values['worlds.listen.source'] = 'system';
      values['worlds.listen.apps'] = '';
    } else if (apps.length) {
      values['worlds.listen.source'] = 'apps';
      values['worlds.listen.apps'] = apps.map((row) => `${row.app}=${row.vad}`).join(', ');
    }
    try {
      await ctx.setConfig('world:listen', values);
    } catch (err) {
      note.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const render = (s) => {
    listening = Boolean(s?.listening);
    const live = Array.isArray(s?.sources) ? s.sources : [];
    savedVads = new Map((s?.selection?.apps ?? []).map((item) => [normApp(item.app), validVad(item.vad)]));
    if (listening) {
      const wasLive = new Map(rows.map((row) => [row, row.live]));
      for (const row of rows) row.live = null;
      for (const source of live) {
        let row = rows.find((candidate) => rowMatches(candidate, source));
        if (!row) {
          row = {
            source: source.source,
            app: source.app,
            pid: source.pid,
            title: '',
            vad: source.vad,
            checked: true,
            live: null,
            error: '',
          };
          rows.push(row);
        }
        row.checked = true;
        row.vad = source.vad;
        row.live = source;
        row.pid = source.pid;
        row.error = source.lastError || '';
      }
      for (const row of rows) {
        if (row.live) continue;
        const expected = row.checked;
        row.checked = false;
        // 用户取消的那一行保留 PID；还在选着却不在采集里，是进程退出了，下次按应用名重新解析。
        if (expected && wasLive.get(row) && row.source === 'app') row.pid = 0;
      }
    } else {
      for (const row of rows) {
        if (!hold && !applying) {
          // 用户没取消却停了（进程退出、自动停止）：下次勾选按应用名重新解析。
          if (row.source === 'app' && row.checked && row.live) row.pid = 0;
          row.checked = false;
        }
        row.live = null;
        row.error = '';
      }
    }
    note.textContent = s?.lastError || '';
    renderRows();
    // The host owns the header badges; panel state updates do not repaint them.
    void ctx.refresh().catch(() => { /* Keep the controls usable if header refresh fails. */ });
  };

  const applyState = (res) => {
    if (res?.state) render(res.state);
  };

  /** 勾选变化后的启动/停止串行化；期间再改，就等这一轮跑完按最新选择再跑一次。 */
  const scheduler = async () => {
    if (applying || pending) return;
    applying = true;
    renderRows();
    try {
      do {
        dirty = false;
        const targets = currentTargets();
        try {
          if (!targets.length) {
            if (listening) applyState(await ctx.invoke('stop', []));
          } else {
            applyState(await ctx.invoke('start', [targets]));
          }
        } catch (err) {
          const detail = message(err);
          try {
            render(await ctx.invoke('state', []));
          } catch {
            /* 状态也读不到时按未在听处理 */
          }
          if (!listening) {
            for (const row of rows) row.checked = false;
          }
          note.textContent = detail;
          ctx.ui.toast(detail, 'bad');
        }
      } while (dirty);
    } finally {
      applying = false;
      hold = false;
      renderRows();
    }
  };

  const toggle = (row, checked) => {
    if (pending) return;
    row.checked = checked;
    if (checked) {
      const clash = row.source === 'system' ? 'app' : 'system';
      for (const other of rows) {
        if (other.source === clash) other.checked = false;
      }
    }
    renderRows();
    void persist();
    dirty = true;
    void scheduler();
  };

  const changeVad = async (row, next, select) => {
    if (pending || applying) { select.value = row.vad; return; }
    const prev = row.vad;
    const wasLive = row.checked && listening;
    const selected = rows.filter((candidate) => candidate.checked);
    pending = true;
    hold = true;
    renderRows();
    note.textContent = next === 'silero' || next === 'firered' ? tx.preparingModule : '';
    try {
      // 换切分方式要重建这一路：先停掉整轮采集，准备模型后再按原选择重启。
      if (wasLive) applyState(await ctx.invoke('stop', []));
      if (next === 'silero' || next === 'firered') await ctx.invoke('prepareModule', [next]);
      row.vad = next;
      if (row.source === 'system') {
        // 系统声音的选择同时是其他来源的默认切分方式。
        for (const other of rows) {
          if (other.source === 'app' && !other.checked) other.vad = next;
        }
      }
      note.textContent = tx.moduleReady;
    } catch (err) {
      select.value = prev;
      note.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      pending = false;
      for (const candidate of selected) candidate.checked = true;
      if (wasLive) {
        // hold 由 scheduler 收尾时放开，避免停止广播把勾选清掉。
        dirty = true;
        void persist();
        renderRows();
        void scheduler();
      } else {
        hold = false;
        renderRows();
        void persist();
      }
    }
  };

  const addManual = () => {
    const value = appInput.value.trim();
    if (!value || pending || applying) return;
    if (rows.some((row) => row.source === 'app' && sameApp(row, value))) {
      note.textContent = tx.appExists;
      return;
    }
    rows.push({
      source: 'app',
      app: value,
      pid: /^\d+$/.test(value) ? Number(value) : 0,
      title: '',
      vad: systemRow()?.vad || 'energy',
      checked: false,
      live: null,
      error: '',
    });
    appInput.value = '';
    renderRows();
  };

  /** 打开这一页时查一次有音频会话的应用；重新打开页面就是刷新。 */
  const refreshApps = async () => {
    if (pending || applying || appsLoaded) return;
    appsLoaded = true;
    appsNote.textContent = tx.appsLoading;
    try {
      const data = await ctx.invoke('apps', []);
      const apps = Array.isArray(data?.apps) ? data.apps : [];
      for (const app of apps) {
        const existing = rows.find((row) => row.source === 'app'
          && (row.pid ? row.pid === app.pid : normApp(row.app) === normApp(app.name)));
        if (existing) {
          existing.app = String(app.name ?? existing.app);
          existing.pid = Number(app.pid) || existing.pid;
          existing.title = String(app.title ?? '');
          continue;
        }
        rows.push({
          source: 'app',
          app: String(app.name ?? ''),
          pid: Number(app.pid) || 0,
          title: String(app.title ?? ''),
          vad: savedVads.get(normApp(app.name)) || systemRow()?.vad || 'energy',
          checked: false,
          live: null,
          error: '',
        });
      }
      // 已退出且没被选中的应用不再留在列表里；手动填的与已选中的保留。
      const known = new Set(apps.map((app) => Number(app.pid)));
      rows = rows.filter((row) => row.source === 'system' || !row.pid || row.checked || known.has(row.pid));
      appsNote.textContent = apps.length ? '' : tx.appNone;
    } catch (err) {
      appsNote.textContent = message(err);
    } finally {
      renderRows();
    }
  };

  const load = async (busy) => {
    const release = busy ? ctx.ui.busy(tx.busier, tx.statusTitle) : null;
    try {
      const s = await ctx.invoke('state', []);
      if (ctx.signal.aborted) return;
      pending = false;
      if (!systemRow()) {
        rows.unshift({
          source: 'system',
          app: '',
          pid: 0,
          title: '',
          vad: validVad(s?.selection?.vad),
          checked: false,
          live: null,
          error: '',
        });
      }
      render(s);
    } catch (err) {
      note.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      if (release) release.dispose();
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
      if (!frame?.t) return;
      if (frame.t === 'state' && frame.state) render(frame.state);
      if (frame.t === 'module-progress' && pending && tx.preparationStages[frame.stage]) {
        note.textContent = tx.preparationStages[frame.stage];
      }
    },
  }));

  void load(true).then(() => { void refreshApps(); });
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function toolsPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const root = ctx.ui.h('section', 'li-tools');
  ctx.root.appendChild(root);

  const toolbar = ctx.ui.h('div', 'li-tools-toolbar');
  const search = ctx.ui.h('input');
  search.type = 'search';
  search.placeholder = tx.toolsSearch;
  search.setAttribute('aria-label', tx.toolsSearch);
  const saveBtn = ctx.ui.button(tx.toolsSave, { size: 'sm', variant: 'primary', onClick: () => { void save(); } });
  const resetBtn = ctx.ui.button(tx.toolsReset, { size: 'sm', onClick: () => { void reset(); } });
  toolbar.append(search, saveBtn, resetBtn);
  const status = ctx.ui.h('div', 'li-sub', '');
  const warnings = ctx.ui.h('div', 'li-tools-warnings', '');
  const list = ctx.ui.h('div');
  const empty = ctx.ui.h('div', 'li-empty', tx.toolsEmpty);
  empty.hidden = true;
  root.append(toolbar, status, warnings, list, empty);

  const TAG_TEXT = {
    read: tx.tagRead,
    act: tx.tagAct,
    write: tx.tagWrite,
    speak: tx.tagSpeak,
    flow: tx.tagFlow,
    snapshot: tx.tagSnapshot,
  };
  let state = null;
  let busy = false;
  let entries = [];
  let cards = [];

  const say = (line, bad = false) => {
    status.textContent = line || '';
    status.classList.toggle('bad', bad);
  };
  const dirty = () => entries.some(({ input, field }) => input.value !== field.text);
  const update = () => {
    if (!state) {
      saveBtn.disabled = true;
      resetBtn.disabled = true;
      return;
    }
    saveBtn.disabled = busy || !dirty();
    resetBtn.disabled = busy || (!Object.keys(state.overrides).length
      && !(state.warnings ?? []).some((warning) => warning.layer === 'deployment' && warning.error));
    for (const entry of entries) entry.resetBtn.disabled = busy || entry.input.value === entry.field.inheritedText;
  };
  const filter = () => {
    const query = search.value.trim().toLocaleLowerCase();
    let shown = 0;
    for (const { card, text } of cards) {
      const match = !query || text().toLocaleLowerCase().includes(query);
      card.hidden = !match;
      if (match) shown += 1;
    }
    empty.hidden = shown > 0 || !state;
  };
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    update();
    try {
      await fn();
    } catch (err) {
      if (!ctx.signal.aborted) say(message(err), true);
    } finally {
      busy = false;
      if (!ctx.signal.aborted) update();
    }
  };
  const fieldLabel = (field) => {
    if (field.path === '/description') return tx.toolsToolDescription;
    if (field.path === '/parameters/description') return tx.toolsParametersDescription;
    return `${field.location} · ${field.keyword === 'title' ? tx.toolsTitle : tx.toolsDescription}`;
  };

  const render = () => {
    entries = [];
    cards = [];
    list.replaceChildren();
    warnings.replaceChildren();
    for (const warning of state.warnings ?? []) {
      warnings.appendChild(ctx.ui.h('p', '', `${warning.error ? tx.toolsInvalidFile : tx.toolsStale} ${warning.layer}: ${warning.error || `${warning.tool}${warning.path}`}`));
    }
    for (const tool of state.tools) {
      const card = ctx.ui.h('details', 'li-tool-card');
      const summary = ctx.ui.h('summary', 'li-tool-summary');
      const heading = ctx.ui.h('span', 'li-tool-heading');
      heading.appendChild(ctx.ui.h('code', 'li-tool-name', tool.name));
      for (const tag of tool.tags ?? []) heading.appendChild(ctx.ui.h('span', 'li-tool-tag', TAG_TEXT[tag] ?? tag));
      summary.appendChild(heading);
      summary.appendChild(ctx.ui.h('span', 'li-sub', typeof tool.summary === 'string'
        ? tool.summary
        : (tool.summary?.[ctx.language === 'en' ? 'en' : 'zh'] ?? '')));
      const source = ctx.ui.h('span', 'li-tool-source');
      summary.appendChild(source);
      card.appendChild(summary);

      const body = ctx.ui.h('div', 'li-tool-body');
      const fields = ctx.ui.h('div');
      const own = [];
      const cardInputs = [];
      const updateSource = () => {
        source.textContent = own.some((entry) => entry.input.value !== entry.field.inheritedText)
          ? tx.toolsSourceDeployment
          : tool.fields.some((field) => field.inheritedSource === 'package') ? tx.toolsSourcePackage : tx.toolsSourceDefault;
      };
      for (const field of tool.fields) {
        const wrap = ctx.ui.h('div', 'li-tool-field');
        const id = `${tool.name}-${entries.length}`;
        const label = ctx.ui.h('label', '', fieldLabel(field));
        label.htmlFor = id;
        const input = ctx.ui.h('textarea');
        input.id = id;
        input.rows = field.path === '/description' ? 4 : 2;
        input.spellcheck = false;
        input.value = field.text;
        input.placeholder = tx.toolsNoDescription;
        cardInputs.push(input);
        const footer = ctx.ui.h('div', 'li-tool-field-footer');
        const defaults = ctx.ui.h('details', 'li-tool-default');
        defaults.appendChild(ctx.ui.h('summary', '', tx.toolsDefaultText));
        defaults.appendChild(ctx.ui.h('pre', '', field.inheritedText || tx.toolsNoDescription));
        const resetField = ctx.ui.button(tx.toolsReset, {
          size: 'sm',
          onClick: () => {
            input.value = field.inheritedText;
            updateSource();
            update();
            say(dirty() ? tx.toolsDirty : '');
            filter();
          },
        });
        footer.append(defaults, resetField);
        wrap.append(label, input, footer);
        fields.appendChild(wrap);
        const entry = { input, field, tool: tool.name, resetBtn: resetField };
        entries.push(entry);
        own.push(entry);
        input.addEventListener('input', () => {
          updateSource();
          update();
          say(dirty() ? tx.toolsDirty : '');
          filter();
        });
      }
      updateSource();
      body.appendChild(fields);
      card.appendChild(body);
      list.appendChild(card);
      cards.push({
        card,
        text: () => `${tool.name} ${(tool.tags ?? []).join(' ')} ${summary.textContent} ${cardInputs.map((input) => input.value).join(' ')}`,
      });
    }
    filter();
    update();
  };

  const save = () => run(async () => {
    const overrides = structuredClone(state.overrides ?? {});
    for (const { input, field, tool } of entries) {
      overrides[tool] ??= {};
      if (input.value === field.inheritedText) delete overrides[tool][field.path];
      else overrides[tool][field.path] = input.value;
      if (!Object.keys(overrides[tool]).length) delete overrides[tool];
    }
    state = await ctx.invoke('save', [{ expectedRevision: state.revision, overrides }]);
    say(tx.toolsSaved);
    render();
  });

  const reset = () => run(async () => {
    const ok = await ctx.ui.confirm({ title: tx.toolsResetTitle, body: tx.toolsResetBody, danger: true });
    if (!ok) return;
    state = await ctx.invoke('reset', [{ expectedRevision: state.revision }]);
    say(tx.toolsRestored);
    render();
  });

  search.addEventListener('input', () => { filter(); });
  void run(async () => {
    state = await ctx.invoke('list', []);
    render();
  });
}

export default {
  panels: {
    chunks: { mount: chunksPanel },
    status: { mount: statusPanel },
    tools: { mount: toolsPanel },
  },
};
