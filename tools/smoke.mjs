#!/usr/bin/env node
/**
 * 真机冒烟：真的开一次采集（系统环回或按应用），按 World 的切分参数切一块出来看看。
 * 跑法（Windows，包里已装依赖）：
 *
 *   node tools/smoke.mjs --seconds 8 --play          # 系统声音 + 自动放一段系统示例音
 *   node tools/smoke.mjs --source app --app chrome.exe --seconds 10
 *   node tools/smoke.mjs --vad silero --model scratch\silero_vad.onnx --play scratch\speech16k.wav
 *   node tools/smoke.mjs --out D:\tmp\chunk.wav
 *
 * 退出码：0 = 听到音频；1 = 一帧都没来（没在放声音 / 设备静音 / 目标不对）；
 * 2 = 有音频但没有切出语音块（门限之类，检查 --seconds 与声音大小）。
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Capturer } from '../src/capture.js';
import { resolveApp } from '../src/apps.js';
import { DEFAULTS, FRAME_MS, SAMPLE_RATE } from '../src/config.js';
import { SileroSegmenter, ensureSileroModel } from '../src/silero.js';
import { Segmenter } from '../src/vad.js';
import { encodeWav } from '../src/wav.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : 'auto';
}

const seconds = Math.max(1, Number(argOf('seconds', '8')) || 8);
const source = argOf('source', DEFAULTS.source) === 'app' ? 'app' : 'system';
const app = argOf('app', DEFAULTS.app);
const out = argOf('out', '');
const playArg = process.argv.includes('--play') ? argOf('play', 'auto') : '';

if (process.platform !== 'win32') {
  console.error('这个冒烟工具只在 Windows 上有意义（WASAPI）。');
  process.exit(1);
}

const vadCfg = {
  thresholdDb: DEFAULTS.thresholdDb,
  minSpeechMs: DEFAULTS.minSpeechMs,
  silenceMs: DEFAULTS.silenceMs,
  maxUtteranceMs: DEFAULTS.maxUtteranceMs,
  preRollMs: DEFAULTS.preRollMs,
  minUtteranceMs: DEFAULTS.minUtteranceMs,
};

const vadKind = argOf('vad', 'energy') === 'silero' ? 'silero' : 'energy';
let segmenter;
if (vadKind === 'silero') {
  const model = await ensureSileroModel({
    cfgPath: argOf('model', ''),
    dataDir: join(pkgDir, 'scratch', 'data'),
    packageDir: pkgDir,
    botDir: pkgDir,
  });
  segmenter = new SileroSegmenter({
    modelPath: model.path,
    sampleRate: SAMPLE_RATE,
    frameMs: FRAME_MS,
    now: () => Date.now(),
    threshold: DEFAULTS.sileroThreshold,
    minSpeechMs: DEFAULTS.minSpeechMs,
    silenceMs: DEFAULTS.silenceMs,
    maxUtteranceMs: DEFAULTS.maxUtteranceMs,
    minUtteranceMs: DEFAULTS.minUtteranceMs,
  });
  console.log(`切分：silero（模型 ${model.path}，来源 ${model.source}）`);
} else {
  segmenter = new Segmenter(vadCfg, FRAME_MS);
  console.log('切分：energy（能量门限）');
}

let target = { source: 'system' };
if (source === 'app') {
  if (!app) {
    console.error('--source app 需要 --app <进程名或 PID>');
    process.exit(1);
  }
  target = { source: 'app', pid: Number(app) };
  if (!Number.isInteger(target.pid)) {
    const info = await resolveApp(app);
    target.pid = info.pid;
    console.log(`应用「${app}」→ PID ${info.pid}${info.title ? `（${info.title}）` : ''}`);
  }
}

const chunks = [];
let frames = 0;
let started = 0;
let quietTicks = 0;

const capture = new Capturer({
  onFrame: (frame) => {
    frames += 1;
    for (const u of segmenter.push(frame, Date.now())) chunks.push(u);
    if (frames % 250 === 0) {
      process.stdout.write(`\r收了 ${(frames * FRAME_MS / 1000).toFixed(1)}s · 电平 ${segmenter.level.toFixed(1)}dB · 语音块 ${chunks.length}   `);
    }
  },
  onStatus: (event) => console.log(`\n[采集] ${event.type}${event.detail ? `：${event.detail}` : ''}`),
});

const player = (() => {
  if (!playArg) return null;
  const file = playArg === 'auto' ? 'C:\\Windows\\Media\\Alarm01.wav' : playArg;
  if (!existsSync(file)) {
    console.log(`要播的示例音不在：${file}`);
    return null;
  }
  console.log(`示例音：${file}`);
  return spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync(); Start-Sleep -Seconds 600`], { stdio: 'ignore' });
})();

started = Date.now();
try {
  capture.start(target);
  console.log(`开始采集：${source === 'app' ? `应用 PID ${target.pid}` : '系统声音'}（${seconds} 秒）`);
} catch (err) {
  console.error(`采集起不来：${err instanceof Error ? err.message : err}`);
  player?.kill();
  process.exit(1);
}

const ticker = setInterval(() => {
  quietTicks += 1;
  const now = Date.now();
  const done = segmenter.tick(now);
  for (const u of done) chunks.push(u);
  if (quietTicks % 2 === 0 && segmenter.active === false && frames > 0) {
    process.stdout.write(`\r收了 ${(frames * FRAME_MS / 1000).toFixed(1)}s · 电平 ${segmenter.level.toFixed(1)}dB · 语音块 ${chunks.length}   `);
  }
}, 250);

setTimeout(() => {
  clearInterval(ticker);
  const tails = segmenter.flush();
  for (const u of Array.isArray(tails) ? tails : (tails ? [tails] : [])) chunks.push(u);
  capture.stop();
  player?.kill();
  console.log('\n');
  console.log(`结束：帧 ${frames}（${(frames * FRAME_MS / 1000).toFixed(1)}s）· 语音块 ${chunks.length}${segmenter.dropped ? ` · 碎片丢掉 ${segmenter.dropped}` : ''}`);

  if (out && chunks.length) {
    chunks.forEach((u, i) => {
      const file = chunks.length === 1 ? out : out.replace(/\.wav$/i, '') + `-${i + 1}.wav`;
      writeFileSync(file, encodeWav(u.pcm, SAMPLE_RATE));
      console.log(`写了一块：${file}`);
    });
  }
  for (const [i, u] of chunks.entries()) {
    console.log(`  #${i + 1} ${(u.durationMs / 1000).toFixed(1)}s 峰值 ${u.peakDb.toFixed(1)}dB${u.forced ? '（强切）' : ''}`);
  }
  if (!frames) {
    console.log('一帧都没来：确认在放声音、系统音量不为零，按应用时确认那个进程真的在出声。');
    process.exit(1);
  }
  if (!chunks.length) {
    console.log('有音频但没切出语音块：多半是电平没到门限（DEFAULTS.thresholdDb=-42），试试放得更响或调门限。');
    process.exit(2);
  }
  process.exit(0);
}, seconds * 1000);
