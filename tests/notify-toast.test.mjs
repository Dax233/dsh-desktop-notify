import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToastScript, DEFAULT_SOUND_FILE, DSH_AUMID, showToast } from "../toast.js";

function decodeBase64Text(script, marker) {
  const prefix = `${marker} = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('`;
  const start = script.indexOf(prefix);
  assert.ok(start >= 0, `missing base64 payload for ${marker}`);
  const from = start + prefix.length;
  const end = script.indexOf("'))", from);
  assert.ok(end > from, `malformed base64 payload for ${marker}`);
  return Buffer.from(script.slice(from, end), "base64").toString("utf8");
}

test("buildToastScript carries the title/body as base64 and the DSH AUMID", () => {
  const script = buildToastScript({ title: "Build done", body: "All tests green — 完成", sound: true });
  assert.equal(decodeBase64Text(script, "$title"), "Build done");
  assert.equal(decodeBase64Text(script, "$body"), "All tests green — 完成");
  assert.ok(script.includes(DSH_AUMID));
  assert.ok(script.includes("ToastNotificationManager"));
  assert.ok(script.includes("ToastGeneric"));
});

test("buildToastScript silences the toast's own system sound", () => {
  const script = buildToastScript({ title: "A", sound: true });
  assert.match(script, /audio silent=`"true`"/, "the WinRT toast must be silent so only our SoundPlayer audio plays");
  const silent = buildToastScript({ title: "A", sound: false });
  assert.match(silent, /audio silent=`"true`"/, "a silent notification must not fall back to the system sound");
});

test("buildToastScript plays the sound file only when sound is requested", () => {
  const withSound = buildToastScript({ title: "A", sound: true });
  assert.ok(withSound.includes("SoundPlayer"));
  assert.ok(withSound.includes(DEFAULT_SOUND_FILE));
  const silent = buildToastScript({ title: "A", sound: false });
  assert.equal(silent.includes("SoundPlayer"), false);
});

test("buildToastScript plays a custom wav path when given", () => {
  const script = buildToastScript({ title: "Custom", sound: true, soundFile: "D:\\\\sounds\\\\chime.wav" });
  assert.ok(script.includes("D:\\\\sounds\\\\chime.wav"));
});

test("buildToastScript escapes XML-sensitive text before interpolation", () => {
  const script = buildToastScript({ title: "<script>&", body: "a < b" });
  assert.ok(script.includes("[System.Security.SecurityElement]::Escape($title)"));
  assert.ok(script.includes("[System.Security.SecurityElement]::Escape($body)"));
});

test("showToast passes an -EncodedCommand that decodes back to the script", async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const listeners = {};
    return {
      once(event, callback) {
        listeners[event] = callback;
        if (event === "exit") setTimeout(() => callback(0), 0);
        return this;
      },
      kill() {},
    };
  };
  const result = await showToast({ title: "Hi", body: "There", sound: false, spawnImpl: fakeSpawn });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /powershell\.exe$/i);
  const encodedIndex = calls[0].args.indexOf("-EncodedCommand");
  assert.ok(encodedIndex >= 0, "must pass the script through -EncodedCommand");
  const decoded = Buffer.from(calls[0].args[encodedIndex + 1], "base64").toString("utf16le");
  assert.ok(decoded.includes("ToastNotificationManager"));
  assert.equal(decoded, buildToastScript({ title: "Hi", body: "There", sound: false }));
  assert.equal(calls[0].options.windowsHide, true);
});

test("showToast reports a non-zero exit as a failure", async () => {
  const fakeSpawn = () => {
    const listeners = {};
    return {
      once(event, callback) {
        listeners[event] = callback;
        if (event === "exit") setTimeout(() => callback(1), 0);
        return this;
      },
      kill() {},
    };
  };
  const result = await showToast({ title: "Hi", sound: false, spawnImpl: fakeSpawn });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
});

test("showToast reports a spawn error as a failure", async () => {
  const fakeSpawn = () => {
    const listeners = {};
    return {
      once(event, callback) {
        listeners[event] = callback;
        if (event === "error") setTimeout(() => callback(new Error("spawn ENOENT")), 0);
        return this;
      },
      kill() {},
    };
  };
  const result = await showToast({ title: "Hi", sound: false, spawnImpl: fakeSpawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});
