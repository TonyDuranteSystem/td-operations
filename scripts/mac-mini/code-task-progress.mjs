/**
 * Code-task progress parser (Slack → Mac Mini rail).
 *
 * The runner invokes the headless session with `--output-format stream-json
 * --verbose`, which emits newline-delimited JSON events in real time. These pure
 * helpers turn that stream into (a) coarse, human-friendly progress milestones
 * the runner posts to the Slack thread as the work happens, and (b) the final
 * answer + error flag (read from the terminal `result` event, NOT raw stdout —
 * with stream-json stdout is the event stream, not the reply).
 *
 * Everything here is pure (no I/O, no Slack, no DB) so it's unit-tested directly
 * in tests/unit/code-task-progress.test.ts. The runner holds the streaming state
 * (line buffer + last-posted milestone key) and calls these per line.
 *
 * Verified event shapes against a real `claude --print --output-format
 * stream-json --verbose` run (2026-06-12):
 *   - { type: "assistant", message: { role, content: [ {type:"text"|"tool_use", ...} ], stop_reason } }
 *   - { type: "result", subtype: "success"|"error_max_turns"|"error_during_execution",
 *       is_error: bool, result: "<final text>", ... }
 *   - plus many { type: "system" } / "control_request" / "user" events we ignore.
 */

/**
 * Map a single tool-use (name + input) to a coarse progress milestone, or null
 * when the tool isn't worth surfacing to a watching human (generic shell, or a
 * git push the runner narrates itself). `key` is the dedup token; `text` is the
 * Slack line. Bash is sub-classified by the command so "building" / "running
 * tests" / "committing" read meaningfully instead of a generic "ran a command".
 */
export function toolUseMilestone(name, input) {
  const cmd = input && typeof input.command === "string" ? input.command : ""
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return { key: "editing", text: "✏️ Editing code…" }
    case "Task":
      return { key: "subagent", text: "🤖 Running a sub-agent…" }
    case "Read":
    case "Grep":
    case "Glob":
    case "LS":
      return { key: "investigating", text: "🔍 Reading the code…" }
    case "Bash": {
      // git push is narrated by the runner's own push phase — don't double-post.
      if (/\bgit\s+push\b/.test(cmd)) return null
      if (/\bgit\s+commit\b/.test(cmd)) return { key: "committing", text: "💾 Committing…" }
      if (/\b(npm\s+run\s+test|test:unit|test:e2e|vitest|jest|playwright)\b/.test(cmd)) {
        return { key: "testing", text: "🧪 Running tests…" }
      }
      if (/\b(npm\s+run\s+build|next\s+build|tsc)\b/.test(cmd)) {
        return { key: "building", text: "🔨 Building…" }
      }
      // Generic shell command — too noisy to surface.
      return null
    }
    default:
      return null
  }
}

/**
 * Parse one line of the stream-json output. Returns the parsed object, or null
 * for a blank line or a line that isn't valid JSON (the stream is NDJSON but may
 * carry stray blank lines / partial flushes — the caller buffers on newline).
 */
export function parseStreamLine(line) {
  const t = (line || "").trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

/**
 * Return the first meaningful milestone from an assistant event's tool_use
 * blocks, or null. Only `type:"assistant"` events carry tool calls; everything
 * else (system/result/user/control) yields null. Within one turn the FIRST
 * surfaced tool wins — good enough for a coarse "what's it doing now" signal.
 */
export function milestoneFromEvent(event) {
  if (!event || event.type !== "assistant") return null
  const content = event.message && event.message.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block && block.type === "tool_use") {
      const m = toolUseMilestone(block.name, block.input || {})
      if (m) return m
    }
  }
  return null
}

/**
 * Extract the final result from a terminal `result` event: { text, isError }.
 * Returns null for any non-result event. `is_error` is authoritative (a 401 can
 * arrive with subtype:"success" AND is_error:true), and any non-"success"
 * subtype (error_max_turns / error_during_execution) is also treated as an error.
 */
export function finalResultFromEvent(event) {
  if (!event || event.type !== "result") return null
  const text = typeof event.result === "string" ? event.result : ""
  const isError =
    event.is_error === true ||
    (typeof event.subtype === "string" && event.subtype !== "success")
  return { text, isError }
}

/**
 * Reduce a full list of stream-json lines to the ordered list of milestone texts
 * the runner would post — consecutive duplicates collapsed (so a burst of reads
 * or edits is one line), but a phase that recurs after another phase IS posted
 * again (e.g. edit → test → edit shows the retry loop). Mirrors the runner's
 * streaming dedup-by-last-key logic; exported so that logic is unit-tested.
 */
export function reduceMilestones(lines) {
  const out = []
  let lastKey = null
  for (const line of lines) {
    const ev = parseStreamLine(line)
    if (!ev) continue
    const m = milestoneFromEvent(ev)
    if (m && m.key !== lastKey) {
      out.push(m.text)
      lastKey = m.key
    }
  }
  return out
}

/**
 * Scan a full list of stream-json lines for the last `result` event and return
 * { text, isError }, or null if none was emitted (e.g. the session crashed
 * before finishing — the runner falls back to stderr in that case).
 */
export function extractFinal(lines) {
  let final = null
  for (const line of lines) {
    const ev = parseStreamLine(line)
    if (!ev) continue
    const f = finalResultFromEvent(ev)
    if (f) final = f
  }
  return final
}
