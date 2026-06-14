/**
 * Pure helpers for the INTERACTIVE (live, stream-json) code-task session (item 3).
 *
 * The runner runs the session with `--input-format stream-json --output-format
 * stream-json`, keeps stdin open, writes the admin's typed turns as user messages,
 * persists every output event to `code_task_events`, and ends the session (EOF on
 * stdin → push branch) when the admin sends the END sentinel or the session goes
 * idle. These helpers are pure (no I/O) — unit-tested in
 * tests/unit/code-task-stream.test.ts.
 */

/** Sentinel an admin input carries to end the interactive session (model B). */
export const END_SENTINEL = "__END_SESSION__"

/** NDJSON user-message line for `claude --input-format stream-json` stdin. */
export function formatUserMessage(text) {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: String(text ?? "") }] },
    }) + "\n"
  )
}

/** True if an admin input is the "end session" sentinel. */
export function isEndSignal(text) {
  return String(text ?? "").trim() === END_SENTINEL
}

/**
 * Map one parsed stream-json event to a persisted row {event_type, payload}, or
 * null to skip noise we don't store (rate-limit pings, control frames). Kept:
 * assistant turns (text + tool_use), tool results, the per-turn result, and the
 * system init (carries session_id).
 */
export function eventToRow(ev) {
  if (!ev || typeof ev !== "object") return null
  const t = ev.type
  if (t === "assistant") {
    const content = ev.message && ev.message.content
    if (!Array.isArray(content)) return null
    return { event_type: "assistant", payload: { content } }
  }
  if (t === "user") {
    // tool_result blocks come back as a `user` event in stream-json.
    const content = ev.message && ev.message.content
    if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
      return { event_type: "tool_result", payload: { content } }
    }
    return null
  }
  if (t === "result") {
    return {
      event_type: "result",
      payload: {
        subtype: ev.subtype ?? null,
        is_error: ev.is_error === true,
        result: typeof ev.result === "string" ? ev.result : "",
      },
    }
  }
  if (t === "system") {
    return { event_type: "system", payload: { subtype: ev.subtype ?? null, session_id: ev.session_id ?? null } }
  }
  return null
}

/** Extract session_id from any event that carries it (null if absent). */
export function sessionIdFromEvent(ev) {
  return ev && typeof ev === "object" && typeof ev.session_id === "string" ? ev.session_id : null
}
