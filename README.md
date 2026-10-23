# dsh-desktop-notify

Windows 原生通知插件：任务完成 / 需要提问 / 出错时弹 toast，并播放内置 ciallo 提示音。

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-desktop-notify
```

安装后重启 DSH Desktop；通知样式与声音受 Windows 通知设置影响。

---

# @local/dsh-desktop-notify

Native Windows system notifications for the DSH agent, with the system sound.

## How it works

- **Host half** (`index.js` + `toast.js`): registers the `notify` tool and sends the
  toast directly through Windows PowerShell + WinRT (`ToastNotificationManager`),
  using the DSH AppUserModelID `electron.app.DeepSeek Harness` read from the installed
  Start-Menu shortcut, so toasts are branded **DeepSeek Harness**. Sound is played
  explicitly with `System.Media.SoundPlayer` (system WAV), so a muted
  notification-sound setting does not silence the alert.
- Why not the renderer Web Notification API: on the target machine it delivered
  nothing at all (not even to the Action Center), while WinRT toasts do reach the
  Action Center. No `node-notifier`/SnoreToast (LGPL) dependency either.

Research note (2026-10-22): DSH exposes no plugin-level notification API (only the
desktop main process uses Electron `Notification` for mandatory updates), and the
main-process module is not reachable from a plugin. Existing open-source agent
notification tools are CLI hook scripts (macOS `osascript`, PowerShell WinRT, or
`node-notifier` + SnoreToast); none is a DSH plugin. The renderer Web Notification
path is the zero-dependency fit here.

## Tool surface

`notify({ title, body?, sound?, urgency?, tag?, action? })`

| field | meaning |
|---|---|
| `title` | short headline (required) |
| `body` | one or two lines of context |
| `sound` | default `true`; `false` sends a silent toast |
| `urgency` | `info` (default) / `attention` / `blocked` (blocked uses `requireInteraction`, stays until dismissed) |
| `tag` | a newer toast with the same tag replaces the older one |
| `action` | `send` (default) or `status` |

Usage guidance given to the model: one notification per meaningful state change —
task finished, blocked on the user, or the user asked to be pinged.

## Tests

```powershell
cd <repo>
node --test tests/notify-client.test.mjs tests/notify-host.test.mjs
```

Client tests execute the real `client.js` in a Node VM with a mocked
`Notification` class (grant / request-permission / denial paths, silent flag,
round-trip result). Host tests cover the tool schema (wire-ready JSON Schema),
status, empty-title rejection and a fake-client round-trip.

## Requirements / limitations

- Windows toast permission comes from the DSH desktop app; if Windows notification
  settings disable the app, the tool reports `permission is denied`.
- Desktop-only (needs the DSH desktop renderer and its Web Notification support).
- Sound volume/focus-assist is controlled by Windows; the plugin can only choose
  silent vs default sound.
