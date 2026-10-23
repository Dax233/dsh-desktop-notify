import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutoNotifier, formatDuration } from "../auto.js";

function makeHarness(options = {}) {
  let clock = options.startAt ?? 1_000_000;
  const toasts = [];
  const events = [];
  const auto = createAutoNotifier({
    showToast: async (input) => {
      toasts.push(input);
      return { ok: true };
    },
    now: () => clock,
    minTurnMs: options.minTurnMs ?? 8000,
    minIntervalMs: options.minIntervalMs ?? 5000,
    enabled: options.enabled ?? true,
    flags: options.flags,
    sound: options.sound,
    onEvent: (entry) => events.push(entry),
  });
  return {
    auto,
    toasts,
    events,
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
  };
}

function status(agentId, status) {
  return { agent: { id: agentId }, status };
}

function turnStart(turn = 1) {
  return { type: "turn/start", data: { turn } };
}
function turnEnd(turn = 1, kind = "completed") {
  return { type: "turn/end", data: { turn, reason: { kind } } };
}

test("notifies with the full turn duration when a turn ends", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(175_000);
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "任务完成");
  assert.match(h.toasts[0].body, /2 分 55 秒/);
  assert.equal(h.events.at(-1).kind, "turn-end");
});

test("turn/end without a tracked turn/start is ignored", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 0);
});

test("aborted turns get an interruption title instead of completion", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(20_000);
  h.auto.handleSessionEvent("s1", turnEnd(1, "aborted"));
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "任务中断");
});
test("short turns are not announced", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(2_000);
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 0);
});

test("a subagent turn ending while the main turn is open stays quiet", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("main", turnStart());
  h.auto.handleSessionEvent("sub", turnStart());
  h.advance(9_000);
  h.auto.handleSessionEvent("sub", turnEnd());
  assert.equal(h.toasts.length, 0, "the main turn is still open");
  h.advance(1_000);
  h.auto.handleSessionEvent("main", turnEnd());
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "任务完成");
});
test("completion uses the session title and a truncated assistant summary", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", { type: "session/title", data: { title: "插件开发", source: { kind: "fallback" }, messageSeqs: [] } });
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(30_000);
  h.auto.handleSessionEvent("s1", {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "已完成 ciallo 音效替换与静音修复。" }] }, stream: [] },
  });
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "插件开发");
  assert.equal(h.toasts[0].body, "已完成 ciallo 音效替换与静音修复。");
});

test("the last assistant message wins and long output is truncated", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(20_000);
  const long = "长".repeat(300);
  h.auto.handleSessionEvent("s1", {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "first" }] }, stream: [] },
  });
  h.auto.handleSessionEvent("s1", {
    type: "assistant/message",
    data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: long }] }, stream: [] },
  });
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].body.endsWith("…"), true);
  assert.ok(h.toasts[0].body.length <= 161);
  assert.equal(h.toasts[0].title, "任务完成", "no session title is available");
});

test("completion falls back to the duration when there is no assistant text", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(65_000);
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].body, /用时 1 分 5 秒/);
});
test("notifies when the agent asks a question, before waiting for the answer", () => {
  const h = makeHarness();
  h.auto.handleQuestion({ questions: [{ id: "q1", question: "要不要继续？" }] });
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "需要你的回答");
  assert.match(h.toasts[0].body, /要不要继续/);
  assert.equal(h.toasts[0].urgency, "attention");
});

test("question notification summarises multiple questions", () => {
  const h = makeHarness();
  h.auto.handleQuestion({ questions: [{ id: "q1", question: "A?" }, { id: "q2", question: "B?" }] });
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].body, /共 2 个问题/);
});

test("notifies when an approval is requested", () => {
  const h = makeHarness();
  h.auto.handleApproval({ toolName: "bash", reason: "run a command" });
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "需要你的批准");
  assert.match(h.toasts[0].body, /bash/);
});

test("notifies when a turn errors", () => {
  const h = makeHarness();
  h.auto.handleError(new Error("upstream 500"));
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "任务出错");
  assert.match(h.toasts[0].body, /upstream 500/);
});

test("rate limits auto notifications", () => {
  const h = makeHarness({ minIntervalMs: 15_000 });
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(9_000);
  h.auto.handleSessionEvent("s1", turnEnd());
  h.advance(1_000);
  h.auto.handleSessionEvent("s2", turnStart());
  h.advance(9_000);
  h.auto.handleSessionEvent("s2", turnEnd());
  assert.equal(h.toasts.length, 1, "the second completion within the interval must be throttled");
});

test("a manual notify suppresses the auto completion toast shortly after", () => {
  const h = makeHarness();
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(9_000);
  h.auto.noteManualNotify();
  h.advance(500);
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 0);
});

test("disabled auto notifier never toasts", () => {
  const h = makeHarness({ enabled: false });
  h.auto.handleQuestion({ questions: [{ id: "q1", question: "hi?" }] });
  assert.equal(h.toasts.length, 0);
});

test("flags can disable individual auto notifications", () => {
  const h = makeHarness({ flags: { turnEnd: false } });
  h.auto.handleSessionEvent("s1", turnStart());
  h.advance(10_000);
  h.auto.handleSessionEvent("s1", turnEnd());
  assert.equal(h.toasts.length, 0);
  h.auto.handleQuestion({ questions: [{ id: "q1", question: "still?" }] });
  assert.equal(h.toasts.length, 1);
});

test("formatDuration is human readable", () => {
  assert.equal(formatDuration(4_500), "5 秒");
  assert.equal(formatDuration(65_000), "1 分 5 秒");
  assert.equal(formatDuration(125_000), "2 分 5 秒");
});
