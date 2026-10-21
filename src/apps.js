/**
 * 按应用的采集要找进程：把「chrome.exe」这样的名字换成 PID（含进程树的根）。
 *
 * 走 PowerShell 的进程表（Get-Process / Win32_Process），只在 Windows 上有意义；
 * 名字里只允许字母数字和 . _ - 空格，拼进脚本前先挡一道。
 *
 * 选择根进程的判据是可测的纯函数 `chooseRoot`：优先「没有同名父进程」的根，
 * 根里再优先有窗口标题的（浏览器的主进程通常挂着窗口），最后退到最小 PID。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NAME_OK = /^[A-Za-z0-9._ -]+$/;

const sessionSource = fileURLToPath(new URL('./audio-sessions.cs', import.meta.url)).replace(/'/g, "''");
const LIST_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  '$OutputEncoding=[System.Text.Encoding]::UTF8',
  '$ErrorActionPreference="Stop"',
  `$audioIds = @(); $audioError = ''; try { Add-Type -Path '${sessionSource}'; $audioIds = @([ListenAudioSessions]::Read()) } catch { $audioError = $_.Exception.Message }`,
  '$titles = @{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $titles[[int]$_.Id] = [string]$_.MainWindowTitle }',
  '$items = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ name=([string]$_.Name -replace "\\.exe$", ""); pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; title=[string]$titles[[int]$_.ProcessId]; audio=($audioIds -contains [uint32]$_.ProcessId) } })',
  '[pscustomobject]@{ processes=$items; audioError=$audioError } | ConvertTo-Json -Compress -Depth 4',
].join('; ');

/** 查一个进程名的全部实例（PID、父 PID、窗口标题）。 */
function resolveScript(name) {
  const exe = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
  const short = exe.replace(/\.exe$/i, '');
  return [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    '$OutputEncoding=[System.Text.Encoding]::UTF8',
    `$name='${exe}'`,
    `$short='${short}'`,
    '$ps = @(Get-Process -Name $short -ErrorAction SilentlyContinue)',
    'if ($ps.Count -eq 0) { "[]" } else {',
    '  $titles = @{}; $ps | ForEach-Object { $titles[[int]$_.Id] = [string]$_.MainWindowTitle }',
    '  $cim = @(Get-CimInstance Win32_Process -Filter "Name=\'$name\'" -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)',
    '  $rows = $cim | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; title=[string]$titles[[int]$_.ProcessId] } }',
    '  @($rows) | ConvertTo-Json -Compress',
    '}',
  ].join('; ');
}

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`进程表读不出来：${(stderr || err.message || '').trim().slice(0, 300)}`));
        return;
      }
      resolve(String(stdout ?? '').trim());
    });
  });
}

function parseJson(text) {
  if (!text || text === 'null') return [];
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value;
    return value && typeof value === 'object' ? [value] : [];
  } catch {
    return [];
  }
}

/**
 * Only apps with audio sessions. Same-name
 * descendants map to their root so process-tree capture includes browser audio.
 */
export async function listApps({ timeoutMs = 20000 } = {}) {
  const [snapshot] = parseJson(await runPowerShell(LIST_SCRIPT, timeoutMs));
  if (!Array.isArray(snapshot?.processes)) throw new Error('应用列表返回了无效数据。');
  return buildAppList(snapshot.processes, snapshot.audioError || '');
}

export function buildAppList(rows, audioError = '') {
  if (audioError) throw new Error(`音频会话查询失败：${audioError}`);
  const processes = new Map();
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    const pid = Number(row?.pid);
    if (!name || !Number.isInteger(pid) || pid <= 0) continue;
    processes.set(pid, { name, pid, parent: Number(row.parent), title: typeof row?.title === 'string' ? row.title : '', audio: Boolean(row.audio) });
  }
  const roots = new Map();
  for (const process of processes.values()) {
    let root = process;
    const visited = new Set([root.pid]);
    while (true) {
      const parent = processes.get(root.parent);
      if (!parent || parent.name.toLowerCase() !== root.name.toLowerCase() || visited.has(parent.pid)) break;
      visited.add(parent.pid);
      root = parent;
    }
    const app = roots.get(root.pid) || { name: root.name, pid: root.pid, title: root.title, audio: false };
    app.audio ||= process.audio;
    if (!app.title && process.title) app.title = process.title;
    roots.set(root.pid, app);
  }
  const apps = [...roots.values()].filter((app) => app.audio);
  apps.sort((a, b) => Number(b.audio) - Number(a.audio) || Number(Boolean(b.title)) - Number(Boolean(a.title)) || a.name.localeCompare(b.name, 'en') || a.pid - b.pid);
  return apps;
}

/**
 * 纯函数：从同名进程表里挑根进程。
 * @param {Array<{pid: number, parent: number, title?: string}>} rows
 */
export function chooseRoot(rows) {
  const list = (rows ?? []).filter((r) => Number.isInteger(r?.pid) && r.pid > 0);
  if (!list.length) return null;
  const ids = new Set(list.map((r) => r.pid));
  const roots = list.filter((r) => !ids.has(Number(r.parent)));
  const withTitle = (rs) => rs.filter((r) => r.title && String(r.title).trim());
  const pick = withTitle(roots)[0] ?? roots[0] ?? withTitle(list)[0] ?? list[0];
  return pick;
}

/**
 * 把「进程名或 PID」解成目标进程。
 *
 * - 纯数字：当作 PID 直接用（标 `numeric`）。
 * - 名字：查它的实例并挑根（浏览器的子进程都在根下面）。
 *
 * @param {string} target
 * @returns {Promise<{pid: number, name: string, title: string, numeric: boolean}>}
 */
export async function resolveApp(target, { timeoutMs = 20000 } = {}) {
  const raw = typeof target === 'string' ? target.trim().replace(/^["']|["']$/g, '') : '';
  if (!raw) throw new Error('应用是空的：填进程名（如 chrome.exe）或 PID。');
  if (/^\d+$/.test(raw)) {
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error(`PID「${raw}」不合形状。`);
    return { pid, name: `pid:${pid}`, title: '', numeric: true };
  }
  if (!NAME_OK.test(raw)) throw new Error(`应用名「${raw}」里有不认识的字符：只接受字母、数字、空格、. _ -。`);
  const rows = parseJson(await runPowerShell(resolveScript(raw), timeoutMs));
  const root = chooseRoot(rows);
  if (!root) throw new Error(`找不到应用「${raw}」的进程：确认它正在运行，或直接填 PID。`);
  const name = raw.toLowerCase().endsWith('.exe') ? raw : `${raw}.exe`;
  return {
    pid: Number(root.pid),
    name,
    title: typeof root.title === 'string' ? root.title : '',
    numeric: false,
  };
}

export const __test = { chooseRoot, parseJson };
