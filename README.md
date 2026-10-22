# 听觉 · cortico-world-listen

给 Coopanion 桌宠加一对耳朵：**监听系统声音，或只听某个应用（比如浏览器）的音频**，本地把语音一段段切出来，每块作为 `listen.chunk` 事件投进 cortico 事件流——正文说明时长与来源，附件是一段 16 kHz 单声道 WAV。接下来怎么用（比如把附件句柄交给 `stt_transcribe` 转写成文字）由 agent 决定。

这是一个 `cortico` 的 **World 扩展**（`kind: world`，`api: 6`），只补一个 `listen` 世界。采集走 `loopback-capture`（Windows WASAPI 的系统环回 / 进程树 loopback），切分可用包内的**能量门限**（默认，零依赖）或可选的 **Silero VAD**（`worlds.listen.vad: silero`，人声/音乐分得开）。

> **它不转写、不出声、不落盘。** 这里没有 ASR、没有密钥、不联网；音频要么进事件库当附件，要么（太短、太吵）丢掉。
> 「听」和「说」是别的工具的事：要文字就交给 [cortico-world-stt](https://github.com/AqualCross/cortico-world-stt)，要出声是 TTS 世界的事。

## 它做了什么

「状态 → 应用 → 刷新应用列表」仅列出有 Windows 音频会话的应用（包括暂时未播放的会话），不会混入其他运行中的应用。音频会话不代表当前正在发声；查询失败时会明确报错。尚未建立音频会话的软件可以手动填写进程名或 PID 提前监听。选择项使用具体 PID，同名子进程合并到其根进程，不同独立实例分别保留；应用重启后需刷新重新选择。刷新列表不会覆盖手动填写或已选的目标。

装好并启用之后，桌宠会多出两个工具：

| 工具 | 标签 | 作用 |
| --- | --- | --- |
| `listen_act` | `act` | `action: start / stop`；启动时可选 `source`（system / app）、`app`（进程名或 PID 字符串）、`minutes`（自动停止） |
| `listen_read` | `read` | `action: source_list / status / recent`；分别查询音频会话应用、监听状态、最近语音块；`limit` 仅用于 recent |

先调用 `listen_read {"action":"source_list"}` 获取目标 PID，再调用 `listen_act {"action":"start","source":"app","app":"30064"}` 开始监听。查看语音块用 `listen_read {"action":"recent","limit":5}`，停止用 `listen_act {"action":"stop"}`。两个工具都必须传入 action；只读入口不会启动或停止采集。

听着的每一块语音变成一个事件：

```
type: listen.chunk
text: 听到一段语音：3.4 秒（系统声音）
meta: { source, app, pid, durationMs, startedAt, peakDb, forced, seq, throttled }
blobs: [{ mime: audio/wav, name: listen-<时间>.wav, bytes: 16kHz 单声道 WAV }]
```

Core 会把附件落进 `data/media/` 并给出 `log:` 句柄，模型看到的正文后跟着一行：

```
[blob log:xxxxxxxxxxxxxxxxxxxx.wav audio/wav listen-20261016-140322.wav] 一段 3.4 秒的语音（系统声音）
```

于是接力就成立了——把句柄交给语音转文本世界：

```json
{ "audio": "log:xxxxxxxxxxxxxxxxxxxx.wav", "note": "会议里的一段" }
```

`stt_transcribe` 本来就把 `log:` 句柄当音频输入，不用改任何东西。**要不要转、转哪几块，由桌宠自己判断**：这是刻意不做自动转写的原因——省掉一份重复的 ASR，也让"听"这件事保持离线、免费、零密钥。

### 两种送达方式（`worlds.listen.wake`）

- `notify`（默认）：每块即时投递。事件总线本来就会按停顿合批（默认安静 2.5 秒后成批送达），所以一段连续的说话不会一块一轮地刷屏。
- `record`：只落事件库、不唤醒。适合"先录着，等我要的时候再说"——桌宠用 `listen_read action=recent` 取最近的块，或者到事件库里翻。

另外有 **每 60 秒送达上限**（`maxEventsPerMinute`）：超出的块照常落库，只是不投递——看视频、放音乐时对话不会被刷穿。

## 安装

包目录就是你现在看的这个目录。和别的扩展不同，这个包有运行时依赖（`loopback-capture`，N-API 预编译的原生件；Silero 切分还会用到可选的 `sherpa-onnx-node`），装法三步：

**1. 装依赖**（在包目录里，一次性）：

```powershell
cd D:\path\to\cortico-world-listen
pnpm install      # 或 npm install；原生件都是预编译的，不需要编译器
```

`loopback-capture` 管采集，必须装好；`sherpa-onnx-node` 是**可选依赖**——只用能量门限（默认）时它可有可无，装不上也照常跑；选 `vad: silero` 时需要它（约 24MB，含 onnxruntime）。

**2. 让应用认识它**（三种选一种）：

- **控制台里装（推荐）**：设置 → 扩展 → 安装本地扩展，把本目录选给它；
- **命令行装**：在 `data/extensions` 目录里执行
  ```powershell
  pnpm add "D:\path\to\cortico-world-listen" --ignore-workspace
  ```
- **手工连**：把 `data/extensions/node_modules/cortico-world-listen` 做成指向本目录的目录联接，并在 `extensions/package.json` 里加 `"cortico-world-listen": "link:D:\\path\\to\\cortico-world-listen"`。

**3. 重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后在 `config.json` 的 `worlds.listen.enabled` 上打开（控制台里也有这个开关），`listen_*` 才会挂给桌宠。

> 原生件是进程内加载的：**改了包里的代码或重装依赖都要重启应用**。单平台注意事项：目前只支持 Windows（`preflight` 会在别的系统上拒绝激活）。

### 一份能用的 `worlds.listen` 长什么样

`<安装目录>\data\home\<bot 目录>\config.json` 里，最小可用的一段（听系统声音）：

```json
{
  "worlds": {
    "listen": {
      "enabled": true,
      "source": "system"
    }
  }
}
```

只听浏览器（Edge，含它的子进程）：

```json
{
  "worlds": {
    "listen": {
      "enabled": true,
      "source": "app",
      "app": "msedge.exe"
    }
  }
}
```

改之前建议先备份 `config.json`（例如存成 `config.json.bak-listen-<时间戳>`）。

## 配置

都在 `worlds.listen` 段，控制台「听觉 → 状态」里改了就地生效，不用重启：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否把 `listen_*` 挂给桌宠 |
| `source` | `system` | `system` = 整个系统的输出（WASAPI 环回）；`app` = 某个应用 |
| `app` | 空 | `source: app` 时用：进程名（如 `chrome.exe`）或 PID |
| `control` | `console-and-agent` | 谁能开听：`console-and-agent` 或 `console`（只许使用者从控制台开；桌宠仍可停）。挂载不会自动开听，要用控制台按钮或桌宠调用 `listen_act` |
| `wake` | `notify` | `notify` = 即时投递；`record` = 只归档不唤醒 |
| `autoStopMinutes` | `15` | 打开后过多少分钟自动停；`0` = 不自动停 |
| `vad` | `energy` | 切分方式：`energy`（能量门限，零依赖）或 `silero`（Silero VAD，需模型）；切换在下次开始监听时生效 |
| `thresholdDb` | `-42` | 语音门限（dBFS）：RMS 低于它算安静；仅能量模式 |
| `minSpeechMs` | `400` | 连续越过门限这么久才算开口；咳嗽、键盘、提示音挡在这；silero 下是它的最短语音时长 |
| `silenceMs` | `600` | 安静这么久算一块说完；silero 下也是它的静音结束时长 |
| `maxUtteranceMs` | `15000` | 单块最长；到点强切，接着收下一段；silero 下是它的最长语音段 |
| `preRollMs` | `320` | 开口之前再多带一段（第一个字总在电平越线之前）；仅能量模式 |
| `minUtteranceMs` | `1000` | 短于这个的碎片直接丢 |
| `sileroThreshold` | `0.4` | Silero 的语音概率门限（0.1–0.9）：越高越严格；仅 silero |
| `sileroModel` | 空 | Silero 模型路径；留空 = 数据目录里的缓存（控制台可一键获取），或指本地的 `silero_vad.onnx` |
| `maxEventsPerMinute` | `30` | 每 60 秒最多即时投递多少块，超出只归档；`0` = 不限 |
| `saveDir` | 空 | 记录目录：留空 = 插件数据目录下的 `listen/`；每块一个 WAV 文件 + 一份 `index.json` |
| `keep` | `200` | 保留条数：超出删最旧的记录（连同它那份音频文件）；事件库里的附件不动；`0` = 不清理 |
| `pushToConsole` | `true` | 新块实时推到控制台「听到的」页 |

### 切分：能量门限 vs Silero

| | `energy`（默认） | `silero` |
| --- | --- | --- |
| 判据 | RMS 电平越过门限 + 起说/收尾时长 | 神经网络语音概率（silero-vad） |
| 依赖 | 无 | `sherpa-onnx-node` + 模型（约 0.6MB，一次） |
| 音乐/提示音 | 会被当人声（能量上它们"一直在响"） | 基本不出块（实测 440Hz 正弦 0 段，真语音按停顿成段） |
| 调参 | `thresholdDb`、`preRollMs` 等 | `sileroThreshold`；起说/静音/最长段仍共用 |

选 `silero` 的模型来路（按优先级）：`sileroModel` 指本地文件 → 数据目录缓存（`<bot 数据目录>/listen/silero_vad.onnx`）→ 包内 `assets/silero_vad.onnx` → 自动下载（GitHub 发布资产，原子写）。在「状态 → 听觉模块」选择 Silero 时会自动准备缺少的模型与运行组件；组件安装在数据目录的 `listen/runtime`，不修改扩展安装目录。准备成功才保存选择，失败保留原配置；模型下载一次后离线可用。

切换方式：配置组里把 `vad` 改成 `silero`，**下次开始监听**生效；门限等 silero 参数是热改（切分器就地重建）。

### 门限怎么调

- 房间安静但一直误触发：把 `thresholdDb` 下调（例如 `-48`），或把 `minSpeechMs` 调大。
- 说话小声听不到：上调 `thresholdDb`（例如 `-38`）——但底噪也会跟着进来。
- 一句话被切碎：调大 `silenceMs`（800–1200）。
- 界面提示音、键盘声老成块：调大 `minUtteranceMs`。
- 放音乐/看视频被刷屏：对路的办法是把 `vad` 换成 `silero`（人声/音乐分得开）；能量模式下的替代是 `source: app` 只听需要那个应用、`record` 先归档、或调低 `maxEventsPerMinute`。

## 控制台页

- **听到的**：听觉存下来的语音块（时间、时长、目标、大小、峰值、附件句柄），**重启也在**；可试听（读记录目录里那份文件）、复制句柄/路径、删除（连文件）、清空、打开文件夹、复制目录；页面顶部一行显示记录目录；听着的电平条实时走。
- **状态**：单按钮开始/停止监听，选择系统声音或某个应用，以及「听觉模块」（能量门限 / Silero，和配置页的切分方式同步）。选择 Silero 自动准备模型与运行组件，监听期间禁止切换；错误就地显示。参数、目录、保留条数与限速统一在配置页查看。

「状态」页的开关是**即时控制**；长期默认值在页面下方的配置组里。

## 采集的两条路

- **系统声音**：WASAPI 环回，抓默认播放设备上的一切（和 OBS 的桌面音频同一条路）。任何 Windows 版本都可用。
- **按应用**：进程树 loopback（`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`）。官方文档要求 Windows 10 build 20348（Server 2022 / Windows 11），社区实测 **Windows 10 2004+** 可用；更老的系统上会直接报错。浏览器要整个进程树一起抓（`getRoot` 会自动挑根进程），单个标签页的声音就是它某个子进程放的。

两个实话：

- **系统环回会把桌宠自己的声音也听进去**（TTS、提示音从同一个设备放）。不想让它听见自己：优先用 `source: app` 把桌宠排除在外，或者听的时候别让它出声。
- 安静期间**没有数据**：原生件在声音低于 -70 dBFS 时根本不回调（这是它的省电策略），所以"说完没有"靠墙上时钟判断，不靠静音帧——本包的 VAD 就是这么做的。

## 自检

离线检查（不联网、不碰安装目录、不加载原生件，纯逻辑 + 假采集走全链路）：

```powershell
node tools/check.mjs
```

重新生成 `describe.json`（改了工具或事件声明后）：

```powershell
node tools/describe.mjs
```

用**这套安装里的框架判据**真跑一遍装配检查（manifest 解析、dry-mount、工具名冲突、配置路径）：

```powershell
$env:COOPANION_APP_ROOT = "D:\program\Coopanion\resources\app"
node --experimental-transform-types tools/drymount.mts
```

真机冒烟（真开采集）：

```powershell
node tools/smoke.mjs --seconds 8 --play          # 系统声音，自动放一段系统示例音
node tools/smoke.mjs --source app --app msedge.exe --seconds 10
node tools/smoke.mjs --vad silero --model scratch\silero_vad.onnx --play scratch\speech16k.wav
```

退出码：`0` = 听到音频；`1` = 一帧都没来（没在放声音 / 静音 / 目标不对）；`2` = 有音频但没切出块（门限问题）。

## 目录结构

```
cortico-world-listen/
├─ package.json        # cortico: { kind: world, api: 6, displayName: 听觉, webUiClient, describe }
├─ describe.json       # 自描述：工具与事件（node tools/describe.mjs 生成）
├─ CHANGELOG.md        # 每个版本一节，扩展市场按版本显示更新说明
├─ README.md
├─ src/
│  ├─ index.js         # 入口：default 导出 WorldDefinition
│  ├─ definition.js    # id/label/defaults/preflight/create/describe
│  ├─ config.js        # worlds.listen 默认值、中英文案、配置组 schema
│  ├─ world.js         # ListenWorld：采集生命周期、事件送达、工具、WebUI 面板、限速
│  ├─ capture.js       # loopback-capture 包装：48k 立体声 → 16k 单声道 → 20ms 帧
│  ├─ vad.js           # 能量门限切分：preRoll、起说、收尾、强切、墙上时钟收尾
│  ├─ silero.js        # Silero 切分（可选）：模型解析/下载 + sherpa Vad 包装
│  ├─ chunks.js        # 语音块仓库：目录 + index.json，每块一个 WAV（编号、裁剪、删除）
│  ├─ apps.js          # 进程名/PID → 目标进程（PowerShell 进程表 + 纯函数挑根）
│  ├─ wav.js           # PCM16 → WAV 编码、WAV 头读取、文案
├─ dist/webui.js       # 浏览器侧面板 bundle（export default { panels }）
└─ tools/
   ├─ check.mjs        # 离线检查
   ├─ describe.mjs     # 生成 describe.json
   ├─ drymount.mts     # 用框架自带判据跑 dry-mount
   └─ smoke.mjs        # 真机采集冒烟
```

## 启用之后

- 让桌宠开听：`{"action":"start"}`（`control: console-and-agent` 时）；或者你到控制台「听觉 → 状态」点「开始监听」。
- 听一段会议/视频后问它"刚才说了什么"：它会用 `listen_read action=recent` 找到块，把句柄交给 `stt_transcribe`，再回答你。
- 只想录不想被打扰：`wake: record`，事后用 `listen_read action=recent`。

## 已知限制

- **能量模式分不出音乐**：默认的 `vad: energy` 把音乐/音效也当语音（能量上它们确实"一直在响"）；换 `vad: silero` 即可分开（需要一次模型获取）。这是两种切的唯一大差别。
- **silero 也有它的边界**：远场、强烈混响、多人同时说话时漏检会多起来；`sileroThreshold` 往下调能挽回一些，代价是杂音变多。
- **两份音频，各管各的**：事件附件在 `data/media/`（`log:` 句柄那一条线，`stt_transcribe` 读它）；记录目录里还有听觉自己存的副本（面板试听读它）。清「媒体库」会丢 `log:` 那份（转写会报"附件已不在"）；「听到的」里删记录只丢自己那份，事件库不动。
- **不做流式、不做实时字幕**：一次一块，几秒级延迟；实时对话该走桌宠自己的麦克风链路。
- **只抓默认播放设备**（系统模式）；换输出设备（比如切到蓝牙）后要重新开始监听。
- **不区分说话人**：一块里可能是几个人。
- **系统模式会听到桌宠自己**；按应用模式只抓目标进程树。
- 非 Windows 目前不可用（`preflight` 直接拒绝）。

## 致谢

面板骨架、自检骨架与 package 结构沿用 [cortico-world-stt](https://github.com/AqualCross/cortico-world-stt)（MIT）的做法；切分参数布局参考了 Coopanion 自带桌宠世界的经验（不复制其代码，其许可为 AGPL-3.0）；采集用的 [loopback-capture](https://github.com/WerdoxDev/loopback-capture)（MIT）基于微软的 Windows 经典示例；Silero 切分用的 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）与 [Silero VAD](https://github.com/snakers4/silero-vad) 模型（MIT）。在此致谢。

## 许可

MIT，见 [LICENSE](LICENSE)。
