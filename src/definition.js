/**
 * WorldDefinition：装配层在构造所有可用定义时也会跑 create()，
 * 所以构造函数必须是纯的（不加载原生件、不发请求、不建目录）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, EVENT_TYPE, ID, LABEL } from './config.js';
import { LISTEN_TOOL_DECLS, ListenWorld } from './world.js';

/** 自描述里每个工具配一句给人看的话，按工具名。 */
const TOOL_SUMMARIES = {
  listen: {
    zh: '打开或关掉听觉：开始/停止监听系统声音或某个应用的音频。',
    en: 'Turn hearing on or off: start/stop listening to system audio or one application.',
  },
  listen_recent: {
    zh: '看最近听到的语音块及其附件句柄。',
    en: 'List the most recently heard speech chunks and their attachment handles.',
  },
  listen_status: {
    zh: '听觉的状态：是否在听、目标、计数与最近错误。',
    en: 'Hearing status: listening, target, counters and the last error.',
  },
};

/** 与框架 `describeTools()` 相同的拼法：取发给模型的字段，再加一句 summary。 */
function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: TOOL_SUMMARIES[name],
  }));
}

export const listenDefinition = {
  id: ID,
  label: LABEL,
  /** `worlds.listen` 段的默认值；启用与否由部署决定，定义里恒为 false。 */
  defaults: () => structuredClone(DEFAULTS),
  preflight: () => {
    if (process.platform !== 'win32') {
      throw new Error('听觉目前只在 Windows 上可用：采集走 WASAPI（系统环回 / 按应用）。');
    }
    try {
      createRequire(import.meta.url).resolve('loopback-capture');
    } catch {
      throw new Error('找不到 loopback-capture：先在扩展目录里安装依赖（pnpm install），再重启应用。');
    }
  },
  create: (ctx) => new ListenWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    // 本扩展包自己的根目录。宿主递来的 ctx.packageDir 是 bot 的代码包目录，
    // 不是本扩展的；拼自己的文件（包内 Silero 资产）要以本文件为准。
    packageDir: fileURLToPath(new URL('..', import.meta.url)),
  }),
  /** 自描述：可能出现的全部工具与事件，不进提示词。`describe:extension` 把它导出成 describe.json。 */
  describe: {
    tools: describeTools(LISTEN_TOOL_DECLS),
    events: [{
      type: EVENT_TYPE,
      description: {
        zh: '听到一段语音：正文说明时长与来源，附件是一段 WAV 音频块，可直接交给 stt_transcribe 转写。',
        en: 'A speech chunk was heard: the text carries duration and source; the attachment is a WAV chunk that can be handed to stt_transcribe.',
      },
      trigger: 'debounce',
    }],
  },
};

export default listenDefinition;
