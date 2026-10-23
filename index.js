/**
 * Desktop notifications — Windows toast transport through Windows PowerShell.
 *
 * Why Host-side: the renderer Web Notification path delivered nothing on the
 * target machine (not even to the Action Center), while a WinRT toast from
 * Windows PowerShell reaches the Action Center and can be branded with the DSH
 * AppUserModelID. Sound is played explicitly with System.Media.SoundPlayer so a
 * muted notification-sound setting does not silence the alert.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAutoNotifier } from "./auto.js";
import { DEFAULT_SOUND_FILE, DSH_AUMID, POWERSHELL_EXE, showToast } from "./toast.js";

export const name = "desktop-notify";
export const inject = ["tools"];

const DRY_RUN = process.env.DSH_DESKTOP_NOTIFY_DRY_RUN === "1";
const URGENCIES = ["info", "attention", "blocked"];
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.DSH_DESKTOP_NOTIFY_STATE ?? join(tmpdir(), "dsh-desktop-notify-state.json");
const AUTO_ENABLED = process.env.DSH_DESKTOP_NOTIFY_AUTO !== "0";
const AUTO_FLAGS = {
  turnEnd: process.env.DSH_DESKTOP_NOTIFY_AUTO_TURN_END !== "0",
  question: process.env.DSH_DESKTOP_NOTIFY_AUTO_QUESTION !== "0",
  approval: process.env.DSH_DESKTOP_NOTIFY_AUTO_APPROVAL !== "0",
  error: process.env.DSH_DESKTOP_NOTIFY_AUTO_ERROR !== "0",
};
const MIN_TURN_MS = Number(process.env.DSH_DESKTOP_NOTIFY_MIN_TURN_MS ?? 5000);
const MIN_INTERVAL_MS = Number(process.env.DSH_DESKTOP_NOTIFY_MIN_INTERVAL_MS ?? 5000);
const AUTO_SOUND = process.env.DSH_DESKTOP_NOTIFY_AUTO_SOUND !== "0";
/** Bundled ciallo notification clip (1.24 s, 48 kHz stereo). */
const BUNDLED_CIALLO = join(PLUGIN_DIR, "sounds", "ciallo.wav");

/** Built-in sound aliases: the bundled ciallo clip plus Windows' own notification WAVs. */
export const SOUND_ALIASES = Object.freeze({
  ciallo: BUNDLED_CIALLO,
  default: "C:\\Windows\\Media\\Windows Notify System Generic.wav",
  notify: "C:\\Windows\\Media\\Windows Notify.wav",
  mail: "C:\\Windows\\Media\\Windows Notify Email.wav",
  calendar: "C:\\Windows\\Media\\Windows Notify Calendar.wav",
  messaging: "C:\\Windows\\Media\\Windows Notify Messaging.wav",
  windows: "C:\\Windows\\Media\\Windows Default.wav",
});

/**
 * Resolve a sound selector: a built-in alias or an absolute .wav path.
 * @param {string} raw alias or path
 * @returns {string} absolute wav path that exists
 */
export function resolveSoundFile(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") throw new Error("notify: soundFile must not be empty");
  const file = SOUND_ALIASES[value.toLowerCase()] ?? value;
  if (!existsSync(file)) throw new Error(`notify: soundFile not found: ${file}`);
  if (!/\.wav$/i.test(file)) {
    throw new Error(`notify: soundFile must be a .wav file (Windows SoundPlayer supports WAV): ${file}`);
  }
  return file;
}

function defaultSoundFile() {
  const fromEnv = process.env.DSH_DESKTOP_NOTIFY_SOUND_FILE;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    try {
      return resolveSoundFile(fromEnv);
    } catch {
      // Fall through to the bundled sound.
    }
  }
  if (existsSync(BUNDLED_CIALLO)) return BUNDLED_CIALLO;
  return DEFAULT_SOUND_FILE;
}

const DESCRIPTION =
  "Show a native Windows notification (with sound) to the user. Use it when a long task finishes, when you need the user's attention, when you are blocked on a question/approval, or when the user asked to be pinged. " +
  "title: short headline; body: one or two lines of context (what finished / what you need); sound: false for a silent toast; urgency: info (finished), attention (wants a look), blocked (waiting on the user; long duration + reminder scenario). " +
  "soundFile: optional custom audio — an absolute .wav path or a built-in alias (ciallo, default, notify, mail, calendar, messaging, windows). The default sound is the bundled ciallo clip. " +
  "Do not spam: one notification per meaningful state change.";

export function apply(ctx) {
  const eventLogFile = STATE_FILE.replace(/\.json$/u, "-events.log");
  const appendLog = (entry) => {
    try {
      appendFileSync(eventLogFile, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
    } catch {
      // best effort
    }
  };
  const writeState = (entry) => {
    try {
      writeFileSync(STATE_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2));
    } catch {
      // Diagnostics are best-effort.
    }
  };
  const auto = createAutoNotifier({
    showToast: (input) => {
      if (DRY_RUN) return Promise.resolve({ ok: true, dryRun: true });
      const pending = showToast({ ...input, soundFile: defaultSoundFile() });
      pending.then((result) => appendLog({ phase: "toast-result", title: input.title, result })).catch((error) => appendLog({ phase: "toast-error", title: input.title, error: String(error?.message ?? error) }));
      return pending;
    },
    enabled: AUTO_ENABLED,
    flags: AUTO_FLAGS,
    minTurnMs: MIN_TURN_MS,
    minIntervalMs: MIN_INTERVAL_MS,
    sound: AUTO_SOUND,
    onEvent: (entry) => {
      appendLog({ phase: "auto", ...entry });
      writeState({ lastAuto: entry });
    },
  });
  writeState({ phase: "apply", hasOn: typeof ctx.on === "function", autoEnabled: AUTO_ENABLED });
  if (typeof ctx.on === "function") {
    ctx.effect(() => {
      // Scoped Host events need { global: true } to be observed from a root
      // plugin context; without it DSH scope filtering can skip the listener.
      const globalOptions = { global: true };
      // Waterfall events are claimed by the remote answerer (client UI); a
      // prepended listener runs before it, otherwise the chain stops first.
      const waterfallOptions = { global: true, prepend: true };
      const disposers = [
        ctx.on("session/event", (session, event) => {
          if (event?.type === "turn/start" || event?.type === "turn/end") {
            appendLog({ phase: "turn", type: event.type, turn: event.data?.turn, reason: event.data?.reason?.kind });
          }
          auto.handleSessionEvent(session?.id, event);
        }, globalOptions),
        ctx.on("user-questions/request", (request, next) => {
          appendLog({ phase: "listener", name: "user-questions/request", count: request?.questions?.length });
          auto.handleQuestion(request);
          return next();
        }, waterfallOptions),
        ctx.on("approval/request", (request, next) => {
          appendLog({ phase: "listener", name: "approval/request" });
          auto.handleApproval(request);
          return next();
        }, waterfallOptions),
        ctx.on("agent/error", (payload) => {
          appendLog({ phase: "listener", name: "agent/error" });
          auto.handleError(payload?.error ?? payload);
        }, globalOptions),      ];
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            // ignore
          }
        }
      };
    }, "desktop-notify.auto");
  }
  ctx.effect(
    () =>
      ctx.tools.register({
        name: "notify",
        description: DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["send", "status"],
              description: "send (default) shows a notification; status reports the transport.",
            },
            title: { type: "string", description: "Short notification headline." },
            body: { type: "string", description: "One or two lines of context." },
            sound: { type: "boolean", description: "Play the system notification sound (default true)." },
            soundFile: {
              type: "string",
              description: "Custom audio: absolute .wav path or alias (default/notify/mail/calendar/messaging/windows).",
            },
            urgency: { type: "string", enum: URGENCIES, description: "info (default), attention, or blocked." },
          },
          required: ["title"],
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          render: (_args, value) => [{ type: "text", text: value.text }],
        },
        async execute(args) {
          const action = String(args.action ?? "send");
          if (action === "status") {
            return {
              text: JSON.stringify(
                {
                  platform: process.platform,
                  powershellAvailable: existsSync(POWERSHELL_EXE),
                  appId: DSH_AUMID,
                  defaultSoundFile: defaultSoundFile(),
                  soundAliases: Object.keys(SOUND_ALIASES),
                  auto: auto.stats(),
                  dryRun: DRY_RUN,
                },
                null,
                2,
              ),
            };
          }
          if (action !== "send") throw new Error(`notify: unknown action "${action}"`);
          const title = typeof args.title === "string" ? args.title.trim() : "";
          if (title === "") throw new Error("notify: title is required");
          if (process.platform !== "win32") {
            return { text: "notify: native toasts are only implemented for Windows on this machine" };
          }
          if (!existsSync(POWERSHELL_EXE)) {
            return { text: `notify: Windows PowerShell was not found at ${POWERSHELL_EXE}` };
          }
          const sound = args.sound !== false;
          const urgency = URGENCIES.includes(args.urgency) ? args.urgency : "info";
          const body = typeof args.body === "string" && args.body !== "" ? args.body : undefined;
          let soundFile;
          if (sound) {
            const requested = typeof args.soundFile === "string" && args.soundFile !== "" ? args.soundFile : undefined;
            soundFile = requested !== undefined ? resolveSoundFile(requested) : defaultSoundFile();
          }
          const result = DRY_RUN
            ? { ok: true, dryRun: true }
            : await showToast({ title, body, sound, urgency, soundFile });
          if (!result.ok) {
            return { text: `notify failed: ${String(result.error ?? `PowerShell exited with code ${result.exitCode}`)}` };
          }
          auto.noteManualNotify();
          return {
            text: `notification sent: ${JSON.stringify(title)}${
              sound ? ` (with system sound: ${basename(soundFile)})` : " (silent)"
            }${urgency !== "info" ? ` [${urgency}]` : ""}${result.dryRun ? " [dry run]" : ""}${
              result.timeout === true ? " (PowerShell timed out, but the toast may already be visible)" : ""
            }`,
          };
        },
      }),
    "desktop-notify.tool",
  );
}
