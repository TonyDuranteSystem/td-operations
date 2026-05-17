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
 *  new primitive ships in its own slice. */
export const IMPLEMENTED_PRIMITIVES: ReadonlySet<PrimitiveKind> = new Set<PrimitiveKind>([
  "open_modal",
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
