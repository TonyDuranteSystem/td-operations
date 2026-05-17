/**
 * Generic `{token}` template interpolation — used wherever a catalog row
 * carries a template string to be filled at runtime from a context object.
 *
 * Originally lived inside `lib/chat/handler-primitives.ts` (chat-only consumer).
 * Extracted to a neutral location (Slice 8) when workflow handlers became a
 * second consumer for follow-up task title/description templates carried in
 * task_workflows.metadata.actions[].handler_params.followup_task.
 *
 * Supports two strictness modes:
 *   - `interpolateString` — lenient; missing tokens are LEFT AS-IS as literal
 *     `{token}` strings. Useful when partial interpolation is OK (e.g. body
 *     templates where the missing field is genuinely optional).
 *   - `interpolateStringStrict` — returns null if ANY referenced token is
 *     missing/null/empty. Use for URLs, task titles, and other fields where
 *     a literal `{token}` would produce visibly broken output.
 *
 * Token syntax: `{name}` — alphanumeric, underscore, dot. Dots traverse
 * nested objects (e.g. `{response.task_id}` resolves `response.task_id`).
 *
 * Pure functions. No I/O. Trivially unit-testable.
 */

const TOKEN_PATTERN = /\{([a-zA-Z0-9_.]+)\}/g

/**
 * Resolve a dot-path like "response.task_id" against an object.
 * Returns undefined for any missing segment or non-object intermediate.
 */
export function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".")
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * Lenient interpolation: tokens not present in context are LEFT AS-IS in the
 * output (the literal `{token}` substring remains). Callers that want a hard
 * failure on missing tokens should use `interpolateStringStrict`.
 */
export function interpolateString(template: string, context: Record<string, unknown>): string {
  return template.replace(TOKEN_PATTERN, (match, key) => {
    const value = resolvePath(context, key)
    if (value === undefined || value === null) return match
    return String(value)
  })
}

/**
 * Strict interpolation: returns null if ANY referenced token resolves to
 * undefined, null, or the empty string. Used at dispatch time for URLs,
 * task titles, and other fields where a literal `{token}` would be a bug.
 */
export function interpolateStringStrict(
  template: string,
  context: Record<string, unknown>,
): string | null {
  const tokens = Array.from(template.matchAll(TOKEN_PATTERN)).map((m) => m[1])
  for (const token of tokens) {
    const value = resolvePath(context, token)
    if (value === undefined || value === null || value === "") return null
  }
  return interpolateString(template, context)
}
