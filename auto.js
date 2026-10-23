/**
 * Automatic desktop notifications driven by DSH lifecycle events.
 *
 * Pure logic (no Cordis imports) so it is unit-testable:
 *  - agent/status running -> idle (turn finished, after a minimum duration)
 *  - user-questions/request (agent asks the user something)
 *  - approval/request (agent needs approval)
 *  - agent/error (turn failed)
 *
 * A short rate limit prevents notification storms (e.g. several subagents
 * finishing together), and a manual `notify` call suppresses the automatic
 * completion toast that would otherwise repeat the same information.
 */

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

function truncate(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * @param {object} options
 * @param {(input: {title: string, body?: string, sound?: boolean, urgency?: string}) => Promise<unknown>} options.showToast
 * @param {() => number} [options.now]
 * @param {number} [options.minTurnMs] notify only for turns at least this long
 * @param {number} [options.minIntervalMs] minimum gap between auto toasts
 * @param {boolean} [options.enabled]
 * @param {{turnEnd?: boolean, question?: boolean, approval?: boolean, error?: boolean}} [options.flags]
 * @param {boolean} [options.sound]
 * @param {(entry: object) => void} [options.onEvent]
 */
export function createAutoNotifier(options) {
  const showToast = options.showToast;
  const now = options.now ?? (() => Date.now());
  const minTurnMs = options.minTurnMs ?? 8000;
  const minIntervalMs = options.minIntervalMs ?? 5000;
  const enabled = options.enabled !== false;
  const flags = { turnEnd: true, question: true, approval: true, error: true, ...(options.flags ?? {}) };
  const sound = options.sound !== false;
  const onEvent = options.onEvent ?? (() => {});
  const manualSuppressMs = options.manualSuppressMs ?? 3000;

  /** Open sessions' turns: sessionId -> { startedAt, turn }. */
  const activeTurns = new Map();
  /** Per-session display data: title for the toast headline, last output for the summary. */
  const sessionInfo = new Map();
  let lastAutoAt = -Infinity;
  let lastManualAt = -Infinity;
  let lastAuto = null;

  /** Pull the plain text out of one assistant message's content blocks. */
  function extractAssistantText(message) {
    if (message === null || typeof message !== "object") return "";
    const content = message.content;
    if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      if (typeof block.text === "string" && (block.type === "text" || block.type === undefined)) parts.push(block.text);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function toast(kind, title, body, urgency, { respectManual = true } = {}) {
    const at = now();
    if (!enabled) return { shown: false, reason: "disabled" };
    if (respectManual && at - lastManualAt < manualSuppressMs) {
      const skipped = { at, kind, title, shown: false, reason: "manual-notify" };
      lastAuto = skipped;
      onEvent(skipped);
      return skipped;
    }
    if (at - lastAutoAt < minIntervalMs) {
      const skipped = { at, kind, title, shown: false, reason: "rate-limited" };
      lastAuto = skipped;
      onEvent(skipped);
      return skipped;
    }
    lastAutoAt = at;
    const entry = { at, kind, title, body, urgency, shown: true };
    lastAuto = entry;
    onEvent(entry);
    // Call synchronously (so it can never be lost) but never await it: a
    // toast must not delay the agent lifecycle.
    try {
      const pending = showToast({ title, body, sound, urgency });
      if (pending !== null && typeof pending === "object" && typeof pending.catch === "function") {
        pending.catch(() => {});
      }
    } catch {
      // Notification failures are non-fatal for the agent.
    }
    return entry;
  }

  return {
    /**
     * Track complete turns from the durable session feed: turn/start records
     * the start, turn/end closes it. This measures the whole turn (including
     * time spent waiting for a user answer), unlike agent/status, which flips
     * to idle while the agent waits for that answer.
     */
    handleSessionEvent(sessionId, event) {
      if (typeof sessionId !== "string" || event === null || typeof event !== "object") return;
      const at = now();
      const info = sessionInfo.get(sessionId) ?? { title: undefined, summary: undefined };
      if (event.type === "turn/start") {
        activeTurns.set(sessionId, { startedAt: at, turn: event.data?.turn });
        sessionInfo.set(sessionId, { ...info, summary: undefined });
        return;
      }
      if (event.type === "session/title") {
        const title = typeof event.data?.title === "string" ? event.data.title.trim() : "";
        if (title !== "") sessionInfo.set(sessionId, { ...info, title });
        return;
      }
      if (event.type === "assistant/message") {
        const text = extractAssistantText(event.data?.message);
        if (text !== "") sessionInfo.set(sessionId, { ...info, summary: text });
        return;
      }
      if (event.type !== "turn/end") return;
      const record = activeTurns.get(sessionId);
      activeTurns.delete(sessionId);
      // Another session (subagent/workflow child) is still inside its turn; the
      // overall task is not finished yet, so stay quiet.
      if (activeTurns.size > 0) return;
      if (record === undefined) return; // started before the plugin observed it
      const duration = at - record.startedAt;
      if (duration < minTurnMs) return;
      if (!flags.turnEnd) return;
      const kind = event.data?.reason?.kind ?? "completed";
      const fallbackTitle =
        kind === "completed" || kind === "max-tokens"
          ? "任务完成"
          : kind === "aborted" || kind === "interrupted"
            ? "任务中断"
            : "任务出错";
      const current = sessionInfo.get(sessionId) ?? info;
      const title = current.title !== undefined && current.title !== "" ? current.title : fallbackTitle;
      const body =
        current.summary !== undefined && current.summary !== ""
          ? truncate(current.summary, 160)
          : `用时 ${formatDuration(duration)}`;
      toast("turn-end", title, body, kind === "completed" ? "info" : "attention");
    },
    handleQuestion(request) {
      if (!flags.question) return;
      const questions = Array.isArray(request?.questions) ? request.questions : [];
      const first = questions[0] ?? {};
      const text = truncate(first.question ?? first.header ?? "Agent 有一个问题需要你回答", 160);
      const body = questions.length > 1 ? `${text}（共 ${questions.length} 个问题）` : text;
      toast("question", "需要你的回答", body, "attention", { respectManual: false });
    },
    handleApproval(request) {
      if (!flags.approval) return;
      const reason = request?.displayReason?.zh ?? request?.displayReason?.en ?? request?.reason;
      const body = request?.toolName ? `${request.toolName}${reason ? ` — ${reason}` : ""}` : (reason ?? "Agent 需要你批准一个操作");
      toast("approval", "需要你的批准", truncate(body, 160), "attention", { respectManual: false });
    },
    handleError(error) {
      if (!flags.error) return;
      const message = error instanceof Error ? error.message : String(error ?? "未知错误");
      toast("error", "任务出错", truncate(message, 160), "blocked");
    },
    noteManualNotify() {
      lastManualAt = now();
    },
    stats() {
      return { enabled, flags, minTurnMs, minIntervalMs, sound, lastAuto };
    },
  };
}
