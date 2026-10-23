import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DSH_DESKTOP_NOTIFY_DRY_RUN = "1";
process.env.DSH_DESKTOP_NOTIFY_STATE = join(mkdtempSync(join(tmpdir(), "dsh-notify-host-")), "state.json");

const plugin = await import("../index.js");
const { SOUND_ALIASES, resolveSoundFile } = plugin;

function makeContext() {
  const tools = [];
  const disposers = [];
  const listeners = [];
  const ctx = {
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    on(event, handler) {
      listeners.push({ event, handler });
      return () => {};
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
  };
  return {
    ctx,
    tools,
    listeners,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

test("host apply() is synchronous and registers the notify tool", () => {
  const harness = makeContext();
  assert.equal(plugin.apply(harness.ctx), undefined);
  assert.equal(harness.tools.length, 1);
  assert.equal(harness.tools[0].name, "notify");
  harness.disposeAll();
});

test("DS COMPAT: notify parameters are an object-rooted JSON Schema", () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const tool = harness.tools[0];
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["title"]);
  for (const [name, property] of Object.entries(tool.parameters.properties)) {
    assert.notEqual(property.required, true, `parameter "${name}" must not carry the dialect required flag`);
  }
  assert.equal(tool.output.schema.type, "object");
  assert.deepEqual(tool.output.schema.required, ["text"]);
  harness.disposeAll();
});

test("status reports the toast transport", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const status = JSON.parse((await harness.tools[0].execute({ action: "status" })).text);
    assert.equal(status.platform, "win32");
    assert.equal(typeof status.powershellAvailable, "boolean");
    assert.match(status.appId, /DeepSeek Harness/);
    assert.match(status.defaultSoundFile, /ciallo\.wav$/i, "the bundled ciallo sound must be the default");
    assert.equal(status.dryRun, true);
  } finally {
    harness.disposeAll();
  }
});

test("an empty title is rejected", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    await assert.rejects(() => harness.tools[0].execute({ title: "   " }), /title/);
  } finally {
    harness.disposeAll();
  }
});

test("send reports success (dry run) and echoes urgency/sound", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const result = await harness.tools[0].execute({
      title: "Work finished",
      body: "The task is done",
      sound: true,
      urgency: "attention",
    });
    assert.match(result.text, /notification/);
    assert.match(result.text, /with system sound/i);
    assert.match(result.text, /attention/);
    const silent = await harness.tools[0].execute({ title: "Quiet", sound: false, urgency: "blocked" });
    assert.match(silent.text, /silent/);
    assert.match(silent.text, /blocked/);
  } finally {
    harness.disposeAll();
  }
});

function makeWavFixture(name = "custom.wav") {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notify-audio-"));
  const file = join(dir, name);
  writeFileSync(file, Buffer.from("RIFF0000WAVEfmt "));
  return file;
}

test("resolveSoundFile accepts an existing .wav path", () => {
  const file = makeWavFixture();
  assert.equal(resolveSoundFile(file), file);
});

test("resolveSoundFile rejects a missing file", () => {
  assert.throws(() => resolveSoundFile("C:\\\\nope\\\\missing.wav"), /not found/i);
});

test("resolveSoundFile rejects a non-wav file", () => {
  const file = makeWavFixture("sound.mp3");
  assert.throws(() => resolveSoundFile(file), /wav/i);
});

test("resolveSoundFile maps built-in aliases to Windows Media wav files", () => {
  for (const alias of Object.keys(SOUND_ALIASES)) {
    const resolved = resolveSoundFile(alias);
    assert.match(resolved, /\.wav$/i);
    assert.equal(resolved, SOUND_ALIASES[alias]);
  }
  assert.match(SOUND_ALIASES.mail, /Windows Notify Email\.wav$/);
  assert.match(SOUND_ALIASES.default, /Windows Notify System Generic\.wav$/);
  assert.match(SOUND_ALIASES.ciallo, /sounds[\\\\/]ciallo\.wav$/i);
});

test("send with a custom soundFile mentions it in the result", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const file = makeWavFixture();
    const result = await harness.tools[0].execute({ title: "Custom sound", soundFile: file });
    assert.match(result.text, /custom\.wav/);
    await assert.rejects(() => harness.tools[0].execute({ title: "Bad", soundFile: "C:\\\\nope.wav" }), /not found/i);
    await assert.rejects(() => harness.tools[0].execute({ title: "Bad", soundFile: makeWavFixture("x.mp3") }), /wav/i);
  } finally {
    harness.disposeAll();
  }
});
test("the bundled ciallo sound is a real WAV shipped inside the plugin", () => {
  const wavPath = SOUND_ALIASES.ciallo;
  assert.match(wavPath, /sounds[\\/]ciallo\.wav$/i);
  const bytes = readFileSync(wavPath);
  assert.ok(bytes.length > 10_000, "the bundled clip should not be an empty placeholder");
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("latin1"), "WAVE");
  // 16-bit PCM (fmt chunk at offset 20 is audio format 1).
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(34), 16);
});

test("host subscribes to lifecycle events for automatic notifications", () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const names = harness.listeners.map((listener) => listener.event);
  for (const event of ["session/event", "user-questions/request", "approval/request", "agent/error"]) {
    assert.ok(names.includes(event), `expected a listener for ${event}`);
  }
  harness.disposeAll();
});
