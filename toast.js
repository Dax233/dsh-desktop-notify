/**
 * Windows toast transport: Windows PowerShell + WinRT.
 *
 * The renderer Web Notification path delivered nothing on this machine, while
 * WinRT toasts from Windows PowerShell do reach the Action Center. We pass the
 * full script through `-EncodedCommand` (base64 UTF-16LE) and every text field
 * through base64 → XML-escaped interpolation, so no user text can break the
 * command or the toast XML.
 */
import { spawn } from "node:child_process";

export const DSH_AUMID = "electron.app.DeepSeek Harness";
export const DEFAULT_SOUND_FILE = "C:\\Windows\\Media\\Windows Notify System Generic.wav";
export const POWERSHELL_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function base64Utf8(text) {
  return Buffer.from(String(text), "utf8").toString("base64");
}

/**
 * Build the PowerShell script that shows one toast (and optionally plays a wav).
 * @param {{title: string, body?: string, sound?: boolean, appId?: string, soundFile?: string}} input
 * @returns {string}
 */
export function buildToastScript(input) {
  const title = String(input.title ?? "");
  const body = String(input.body ?? "");
  const sound = input.sound !== false;
  const appId = String(input.appId ?? DSH_AUMID);
  const soundFile = String(input.soundFile ?? DEFAULT_SOUND_FILE);
  const urgency = String(input.urgency ?? "info");
  const toastAttributes = urgency === "blocked" ? ` scenario=\`"reminder\`" duration=\`"long\`"` : "";
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    `$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Utf8(title)}'))`,
    `$body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Utf8(body)}'))`,
    "$safeTitle = [System.Security.SecurityElement]::Escape($title)",
    "$safeBody = [System.Security.SecurityElement]::Escape($body)",
    '$template = "<toast$toastAttributes><visual><binding template=`"ToastGeneric`"><text>$safeTitle</text><text>$safeBody</text></binding></visual><audio silent=`"true`"/></toast>"',
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml($template)",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
  ];
  if (sound) {
    lines.push(`$wav = '${soundFile.replaceAll("'", "''")}'`);
    lines.push("if (Test-Path $wav) { $player = New-Object System.Media.SoundPlayer $wav; $player.PlaySync() }");
  }
  lines.push(`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId.replaceAll("'", "''")}').Show($toast)`);
  lines.push("Write-Output 'toast-sent'");
  return lines.join("\n");
}

/**
 * Show one native Windows toast.
 * @param {object} input title/body/sound + optional spawnImpl/appId/soundFile/timeoutMs
 * @returns {Promise<{ok: boolean, exitCode?: number|null, error?: string, timeout?: boolean, script: string}>}
 */
export function showToast(input) {
  const spawnImpl = input.spawnImpl ?? spawn;
  const script = buildToastScript(input);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const timeoutMs = input.timeoutMs ?? 15000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(input.powershellExe ?? POWERSHELL_EXE, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      finish({ ok: false, error: String(error && error.message ? error.message : error), script });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        // ignore
      }
      finish({ ok: true, timeout: true, script });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(error && error.message ? error.message : error), script });
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      finish({ ok: exitCode === 0, exitCode, script });
    });
  });
}
