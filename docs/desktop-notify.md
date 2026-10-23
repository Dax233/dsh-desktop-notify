# 桌面通知插件（desktop-notify）

给 Agent 用的 **Windows 原生系统通知**（带系统提示音），用于：
工作完成、需要用户注意、被阻塞等待确认、或用户要求提醒时。

## 为什么这样实现（2026-10-22 调研）

- DSH 本身**没有对插件开放的通知 API**：只有桌面主进程为「强制更新」用过
  Electron `Notification`，且没有暴露给 Host/Client 插件；Electron 主进程模块在
  插件里不可达。
- 现有开源「agent 通知」项目都是 CLI hook 脚本，不是 DSH 插件：
  - `claude-code-notify`（macOS osascript，Windows 不可用）；
  - `salvanya/claude-code-windows-notifications`（PowerShell WinRT，无 license，不可复用）；
  - `Oo0Leo0oO/claude-code-windows-toast-focus`（MIT，BurntToast + 点击聚焦，可借鉴思路）；
  - `node-notifier` 11（MIT，但 Windows 后端是 SnoreToast **LGPL-3** 二进制，解包 5.7MB，
    需要 asarUnpack；对一个 Electron 应用来说太重）；
  - BurntToast 需要 `Install-Module`，v1.0 后不能自定义 AppId。
- **采用方案（v0.2，真机验证后调整）**：Host 半直接调用 **Windows PowerShell + WinRT
  `ToastNotificationManager`** 发送 toast，AUMID 用 DSH 安装时注册的
  `electron.app.DeepSeek Harness`（从开始菜单快捷方式读出）→ 通知署名 DeepSeek Harness；
  声音用 `System.Media.SoundPlayer` 显式播放系统 WAV，避免“通知声音”被系统静音时完全无声。
  不再使用 renderer 的 Web Notification：本机实测它**连通知中心都送不到**，而 WinRT 能到达。
  零第三方依赖、零额外二进制（仅调用系统自带 powershell.exe）。

## 结构

- `index.js`：Host 半，注册 `notify` 工具 + loopback 桥（127.0.0.1:47836，`bridge.js` 与
  sidebar-browser-control 共用同一实现）。
- `client.js`：Client 半，连桥、展示通知、处理权限与点击聚焦；`apply()` 同步返回，
  后台循环 fire-and-forget（符合 boot 契约）。
- 工具参数：`title`（必填）、`body`、`sound`（默认 true）、`urgency`
  （`info` / `attention` / `blocked`；blocked 使用 `requireInteraction` 常驻到用户关闭）、
  `tag`（同 tag 新通知替换旧通知）、`action=status`。

## 验证记录

- 单测 10 项（`tests/notify-*.test.mjs`）：boot 契约、权限 granted/request/denied 三条路径、
  silent 标志、host schema（wire-ready JSON Schema）、空标题拒绝、fake client 往返。
- 真机：`notify` 工具调用成功（PowerShell 退出码 0，toast 进入 Windows 通知中心）；`notify status`
  显示 `platform: win32, powershellAvailable: true, appId: electron.app.DeepSeek Harness, dryRun: false`。
- 自定义音频已验证：`soundFile:"mail"` → `(with system sound: Windows Notify Email.wav)`；
  自定义 WAV → 文件名回显；不存在的路径直接报错（不会静默回退默认音）。
- 横幅/声音的最终可见性取决于上面的系统设置（勿扰、横幅开关、默认音频设备）；用户已确认能听到提示音。
- **系统层面诊断（2026-10-22 实测）**：通知只出现在通知中心列表、不弹横幅、且无声音；
  两条路径（renderer / WinRT）结果一致 → 属于 Windows 通知设置，而非代码问题。常见原因：
  1. **勿扰/专注（Do Not Disturb）开启**——Windows 11 在全屏应用（如全屏看视频）时会自动开启，
     此时通知只进列表、横幅与声音都被抑制；
  2. 通知设置里 “显示通知横幅 / 播放声音” 被关闭（含按应用 “DeepSeek Harness” 的设置）；
  3. 默认音频输出设备不是实际在用的音箱/耳机（本机同时存在 HECATE G30、NVIDIA HDMI、
     Steam Streaming、ToDesk 虚拟声卡等多个活动设备），系统音量/设备不对则听不到提示音。
  排查：设置 → 系统 → 通知（打开通知、横幅、声音；关闭勿扰；逐应用检查 DeepSeek Harness），
  并确认右下角音量输出设备正确。
- 已知限制：Windows 通知权限来自 DSH 应用（系统设置里关掉会返回 denied）；
  声音只能选「静音/默认」两种；免打扰/Focus Assist 由 Windows 决定。

## 默认音效与自定义音频

- **默认音效**：插件内置 `sounds/ciallo.wav`（1.24 秒，48 kHz 立体声）。可用 `soundFile` 换成任意 WAV（见下）。
- 每次调用可传 `soundFile`：绝对路径的 `.wav` 文件，或内置别名
  `ciallo` / `default` / `notify` / `mail` / `calendar` / `messaging` / `windows`
  （除 `ciallo` 外分别对应 `C:\Windows\Media` 下的系统通知 WAV）。
- 也可用环境变量 `DSH_DESKTOP_NOTIFY_SOUND_FILE` 设置默认音效（绝对路径或别名）。
- 只支持 WAV（`System.Media.SoundPlayer` 的限制）；文件不存在或非 `.wav` 会直接报错，
  不会静默变成默认音。
- **系统通知音已关闭**：toast XML 带 `<audio silent="true"/>`，系统不再播放默认提示音，
  声音完全由 SoundPlayer 播放我们指定的 WAV（ciallo）。这也意味着 `sound:false` 是真正静音。
- 示例：`notify {title:"完成", body:"…", soundFile:"ciallo"}` 或
  `soundFile:"D:\\sounds\\my-chime.wav"`。

## 自动通知（2026-10-23 新增）

除 Agent 主动调用 `notify` 外，插件现在订阅 DSH 生命周期事件，自动提醒：

| 事件 | 触发 | 通知 |
|---|---|---|
| `session/event` 的 `turn/start`→`turn/end` | 一轮结束（且本轮 ≥ 5 秒） | **标题 = 会话标题**，正文 = 最后一条助手输出截断到 160 字；没有标题/输出时退回「任务完成 · 用时 X」（aborted/interrupted 标题不变但正文仍用输出） |
| `user-questions/request` | Agent 提问等待回答 | 「需要你的回答 · 问题文本」 |
| `approval/request` | 需要批准操作 | 「需要你的批准 · 工具名/原因」 |
| `agent/error` | 一轮出错 | 「任务出错 · 错误信息」 |

- 完成通知的内容：`session/title` 事件提供会话标题；`assistant/message` 事件记录本轮最后一条助手消息的纯文本作为摘要（截断 160 字）。
- 子 agent（subagent/workflow 子任务）完成时，如果主 agent 还在跑，**不会**弹「任务完成」，
  避免并行子任务造成刷屏；只有全部 agent 空闲才提示。
- 手动调用过 `notify` 后 3 秒内的自动「任务完成」会被抑制，避免重复。
- 自动通知有 5 秒最小间隔限流。
- 环境变量（重启 App 生效）：
  - `DSH_DESKTOP_NOTIFY_AUTO=0` 关闭全部自动通知
  - `DSH_DESKTOP_NOTIFY_AUTO_TURN_END=0` / `_AUTO_QUESTION=0` / `_AUTO_APPROVAL=0` / `_AUTO_ERROR=0` 单独关闭
  - `DSH_DESKTOP_NOTIFY_MIN_TURN_MS=5000` 完成通知的最短轮次时长
  - `DSH_DESKTOP_NOTIFY_MIN_INTERVAL_MS=5000` 自动通知最小间隔
  - `DSH_DESKTOP_NOTIFY_AUTO_SOUND=0` 自动通知静音
- 诊断：每次自动通知（含被抑制的）写入 `%TEMP%\\dsh-desktop-notify-state.json` 的 `lastAuto`；
  监听/弹窗明细追加到 `%TEMP%\\dsh-desktop-notify-state-events.log`。
- 实现注意（DSH 事件机制）：`agent/status`、`user-questions/request` 等是 **scope-filtered** 事件，
  根插件订阅要传 `{ global: true }`；`user-questions/request` / `approval/request` 是 waterfall，
  client 的远程答题器注册更早并会直接认领请求，因此我们的监听必须 `{ prepend: true }` 才能先执行
  （否则永远收不到——这是首次真机测试无反应的根因）。

## 使用建议

- 长任务结束时调用一次（`urgency: info`），不要每个步骤都发；
- 需要用户回答/批准时用 `urgency: blocked`（通知常驻）；
- 用户在场时可以不发；用户离开/长时间任务时更有价值。
