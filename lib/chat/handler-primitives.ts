/**
 * chat handler primitives — runtime registry for chat_quick_actions
 *
 * Implements the Principle of Flexibility (master plan sysdoc
 * 'workflows-system-master-plan' → "🔒 Principle of Flexibility", locked
 * 2026-05-16): catalog rows speak in primitive verbs + params instead of
 * fixed handler slugs.
 *
 * The four primitive verbs the catalog can reference (canonical vocabulary):
 *   1. open_modal     — mount a React component from MODAL_REGISTRY
 *   2. api_call       — server HTTP request with context interpolation
 *   3. navigate       — client-side router push (or new tab)
 *   4. client_action  — browser API (copy_to_clipboard, open_url, …)
 *
 * STAGED-IMPLEMENTATION POLICY (recorded in master plan §Principle):
 *   Only primitives with an actual catalog-row consumer are IMPLEMENTED here.
 *   Documented but-unimplemented primitives reject at validation time so a
 *   catalog row referencing them never reaches the UI in a broken state.
 *
 *   Current state:
 *     open_modal     ✅ IMPLEMENTED (3 chat_quick_actions rows use it today)
 *     api_call       ⏸ pending first consumer
 *     navigate       ⏸ pending first consumer
 *     client_action  ⏸ pending first consumer
 *
 *   When a new primitive is first needed, the slice that adds its first
 *   catalog row also implements its handler in this file (~30 LOC) + tests
 *   (~5). Small focused commit per primitive; daily-driver reliability over
 *   speculative ready-but-untested code.
 *
 * What this file does NOT contain:
 *   - The page-side dispatcher that wires a click → executePrimitive call.
 *     That lives in the consumer page (Slice 6b will add it to
 *     app/(dashboard)/portal-chats/page.tsx).
 *   - The MODAL_REGISTRY's actual React components. Those are imported and
 *     registered in the page-side dispatcher because component imports
 *     bring tree-shaking concerns into this otherwise pure module.
 */

// ── Primitive verb registry ────────────────────────────────────────────────

/** Canonical primitive verbs. Adding a 5th requires extending this union, the
 *  PRIMITIVE_KINDS list, and the validation in validatePrimitiveHandler. */
export const PRIMITIVE_KINDS = [
  "open_modal",
  "api_call",
  "navigate",
  "client_action",
] as const

export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number]

/** Which primitives are implemented today (gating set). Updated when a
 *  new primitive ships in its own slice.
 *  - open_modal      : Slice 6a-followup (chat_quick_actions Create section)
 *  - api_call        : Slice 7 (topic_templates first consumer)
 *  - navigate        : not yet implemented — ship on first consumer
 *  - client_action   : not yet implemented — ship on first consumer
 */
export const IMPLEMENTED_PRIMITIVES: ReadonlySet<PrimitiveKind> = new Set<PrimitiveKind>([
  "open_modal",
  "api_call",
])

// ── Discriminated-union shape for the `metadata.handler` field ────────────

export interface OpenModalHandler {
  kind: "open_modal"
  /** Lookup key into MODAL_REGISTRY (defined by the page-side dispatcher). */
  modal_id: string
  /** Props passed to the modal component on mount. Free-form, modal-specific. */
  modal_params?: Record<string, unknown>
}

export interface ApiCallHandler {
  kind: "api_call"
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT"
  /** URL template with {token} placeholders interpolated from ChatContext. */
  url_template: string
  /** Body template; values can be {token} strings interpolated from ChatContext. */
  body_template?: Record<string, unknown>
}

export interface NavigateHandler {
  kind: "navigate"
  /** URL template with {token} placeholders interpolated from ChatContext. */
  url_template: string
  target?: "_self" | "_blank"
}

export interface ClientActionHandler {
  kind: "client_action"
  /** Lookup key into CLIENT_ACTION_REGISTRY (defined by the page-side dispatcher). */
  action: string
  /** Free-form params, action-specific (often a value_template with {tokens}). */
  params?: Record<string, unknown>
}

export type PrimitiveHandler =
  | OpenModalHandler
  | ApiCallHandler
  | NavigateHandler
  | ClientActionHandler

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Validate a raw handler object from the DB. Returns the typed handler if it
 * matches a known primitive shape; null otherwise. Used by validateMetadata
 * in lib/chat/quick-actions.ts.
 *
 * Reject criteria:
 *   - not an object
 *   - missing/unknown `kind`
 *   - `kind` is a known primitive but NOT in IMPLEMENTED_PRIMITIVES (the row
 *     references a documented-but-not-yet-shipped primitive)
 *   - per-kind required fields missing or wrong type
 */
export function validatePrimitiveHandler(raw: unknown): PrimitiveHandler | null {
  if (!raw || typeof raw !== "object") return null
  const h = raw as Record<string, unknown>

  if (typeof h.kind !== "string") return null
  const kind = h.kind as PrimitiveKind
  if (!PRIMITIVE_KINDS.includes(kind)) return null
  if (!IMPLEMENTED_PRIMITIVES.has(kind)) return null

  switch (kind) {
    case "open_modal":
      if (typeof h.modal_id !== "string" || h.modal_id.length === 0) return null
      if (h.modal_params !== undefined && (h.modal_params === null || typeof h.modal_params !== "object")) {
        return null
      }
      return h as unknown as OpenModalHandler

    case "api_call":
      if (typeof h.method !== "string" || !["GET", "POST", "PATCH", "DELETE", "PUT"].includes(h.method as string)) {
        return null
      }
      if (typeof h.url_template !== "string" || h.url_template.length === 0) return null
      if (h.body_template !== undefined && (h.body_template === null || typeof h.body_template !== "object")) {
        return null
      }
      return h as unknown as ApiCallHandler

    case "navigate":
      if (typeof h.url_template !== "string" || h.url_template.length === 0) return null
      if (h.target !== undefined && h.target !== "_self" && h.target !== "_blank") return null
      return h as unknown as NavigateHandler

    case "client_action":
      if (typeof h.action !== "string" || h.action.length === 0) return null
      if (h.params !== undefined && (h.params === null || typeof h.params !== "object")) {
        return null
      }
      return h as unknown as ClientActionHandler

    default: {
      // Exhaustiveness guard — if PRIMITIVE_KINDS grows, this triggers a TS
      // error until the new kind is handled above.
      const _exhaustive: never = kind
      void _exhaustive
      return null
    }
  }
}

// ── Template interpolation (used by api_call / navigate / client_action) ──

/**
 * Interpolate `{token}` placeholders in a string from the context map.
 * Tokens not present in context are LEFT AS-IS (defense-in-depth: caller
 * decides whether missing tokens are fatal — see `interpolateStringStrict`).
 *
 * Supported syntax: `{name}` — alphanumeric, underscore, dot (for nested
 * paths in response interpolation, e.g. `{response.task_id}`).
 */
export function interpolateString(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key) => {
    const value = resolvePath(context, key)
    if (value === undefined || value === null) return match
    return String(value)
  })
}

/**
 * Strict variant: returns null if ANY referenced token is missing or null.
 * Used at api_call dispatch time so we never send a request with literal
 * `{account_id}` in the URL or body.
 */
export function interpolateStringStrict(
  template: string,
  context: Record<string, unknown>,
): string | null {
  const tokens = Array.from(template.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)).map((m) => m[1])
  for (const token of tokens) {
    const value = resolvePath(context, token)
    if (value === undefined || value === null || value === "") return null
  }
  return interpolateString(template, context)
}

/**
 * Interpolate all string-typed leaf values in a record. Non-string leaves
 * (numbers, booleans, arrays, nested objects) pass through unchanged.
 * Missing tokens leave the placeholder as-is (non-strict variant).
 */
export function interpolateRecord(
  obj: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out[k] = interpolateString(v, context)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Strict record interpolation: returns null if ANY referenced token in ANY
 * string leaf is missing. Used by api_call to refuse dispatch when context
 * is incomplete (defense in depth — the action shouldn't even render in the
 * menu if requires_all/requires_any fails, but we guard anyway).
 */
export function interpolateRecordStrict(
  obj: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      const interp = interpolateStringStrict(v, context)
      if (interp === null) return null
      out[k] = interp
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Body-template interpolation with NULL PASS-THROUGH.
 *
 * Distinguishes between two string-leaf shapes:
 *
 *  1. Single-token wrap (e.g. `"{account_id}"`): the leaf is replaced with
 *     the TYPED value from context — including `null` or `undefined`.
 *     The result keeps the typed value (not a string), so an endpoint
 *     receiving `{ account_id: null }` sees a real null, not the literal
 *     string `"null"` or the placeholder `"{account_id}"`.
 *
 *  2. Multi-token / partial-token strings (e.g. `"Hello {name}!"` or `"foo"`):
 *     uses non-strict `interpolateString` — missing tokens leave placeholders.
 *     This is the right behavior for human-readable copy where a missing name
 *     should fall back to the placeholder text rather than fail the dispatch.
 *
 * Non-string leaves (numbers, booleans, arrays, nested objects) pass through.
 *
 * Use this for api_call body_template. Use `interpolateStringStrict` for
 * url_template (URLs cannot have null path segments).
 */
export function interpolateBodyTemplate(
  obj: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string") {
      out[k] = v
      continue
    }
    // Single-token wrap: e.g. "{account_id}" — preserve typed value.
    const singleToken = v.match(/^\{([a-zA-Z0-9_.]+)\}$/)
    if (singleToken) {
      const value = resolvePath(context, singleToken[1])
      out[k] = value ?? null
      continue
    }
    // Multi-token / partial: non-strict string interpolation.
    out[k] = interpolateString(v, context)
  }
  return out
}

/** Resolve a dot-path like "response.task_id" against an object. */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".")
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

// ── on_success post-action behavior shape ────────────────────────────────

/**
 * Optional behavior to run after a primitive's main effect succeeds.
 * Surface-specific consumers interpret these fields; unknown fields are
 * ignored.
 *
 * - toast: string to show in a success toast
 * - navigate_url_template: URL to push (client-side router) after success
 * - close_menu: collapse the dropdown that fired the action
 * - set_active_topic: chat-specific — after a topic_templates api_call
 *   succeeds, switch the page's adminActiveTopic to the response.topic_name
 *
 * Adding a new on_success behavior = one new field here + handle it in the
 * consumer page. Keep this list small and grounded in real consumers.
 */
export interface OnSuccessConfig {
  toast?: string
  navigate_url_template?: string
  close_menu?: boolean
  set_active_topic?: boolean
}
