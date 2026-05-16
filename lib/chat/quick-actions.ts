/**
 * chat_quick_actions — pure helpers
 *
 * Slice 6a (foundation, no UI consumer yet). Loaders, filters, and grouping
 * for the `chat_quick_actions` catalog used by portal-chats dropdown menus.
 *
 * Design notes (see sysdoc workflows-system-master-plan §Slice 6):
 *   - The row-shape vocabulary mirrors task_workflows actions (permission,
 *     handler, handler_params) so admins learn one model.
 *   - Chat-specific fields: surface, order, requires_all, requires_any.
 *   - Context tokens are FREE-FORM strings supplied by the page's
 *     context-builder (e.g. account_id, contact_id, member_id, deal_id).
 *     Adding a new dimension = one line in the page's context object;
 *     after that, any catalog row can reference it via pure SQL.
 *
 * Everything in this file is a pure function except `listQuickActions`,
 * which reads via supabaseAdmin. Pure helpers are unit-tested; the loader
 * is integration-tested via the GET endpoint.
 */

import type { CrmRole } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ── Types ──────────────────────────────────────────────────────────────────

export interface QuickActionMetadata {
  /** Where this item renders. Free-form so future surfaces can be added by catalog edit only. */
  surface: string
  /** Sort order within a surface. Ties broken by slug ASC for determinism. */
  order: number
  /** Lucide icon component name resolved by the client renderer. */
  icon: string
  /** Visual hint. Falsy or 'default' = normal; 'destructive' = red treatment. */
  color?: string
  /** RBAC. Defaults to allowing both roles when missing. */
  permission?: { role_in?: CrmRole[] }
  /** ALL listed context tokens must be present (AND). Defaults to []. */
  requires_all?: string[]
  /** At least ONE listed token must be present (OR). Defaults to []. */
  requires_any?: string[]
  /** Slug of the client-side handler. */
  handler: string
  /** Free-form params passed to the handler. */
  handler_params?: Record<string, unknown>
}

export interface QuickAction {
  slug: string
  display_name: string
  display_name_translations: Record<string, string>
  description: string | null
  metadata: QuickActionMetadata
}

/** Free-form context object built by the page from current React state. */
export type ChatContext = Record<string, unknown>

// ── Pure helpers (unit-tested) ────────────────────────────────────────────

/**
 * Returns true if the user is allowed to see this action. Permissive default:
 * a row with no `permission.role_in` is visible to both admin and team.
 */
export function isAllowed(action: QuickAction, role: CrmRole): boolean {
  const allowed = action.metadata.permission?.role_in
  if (!allowed || allowed.length === 0) return true
  return allowed.includes(role)
}

/**
 * Returns true if the current ChatContext satisfies the action's
 * requires_all + requires_any conditions.
 *
 *   requires_all: every listed token must have a non-null value in ctx
 *   requires_any: at least one listed token must have a non-null value
 *
 * Empty lists mean "no requirement of that kind". Both empty = always
 * satisfied (always-visible item).
 */
export function satisfiesContext(action: QuickAction, ctx: ChatContext): boolean {
  const all = action.metadata.requires_all ?? []
  const any = action.metadata.requires_any ?? []

  const present = (token: string): boolean => {
    const v = ctx[token]
    return v !== undefined && v !== null && v !== ""
  }

  for (const token of all) {
    if (!present(token)) return false
  }
  if (any.length > 0 && !any.some(present)) return false

  return true
}

/**
 * Filter + group + sort a list of actions for rendering.
 *
 * Order:
 *   1. RBAC filter (server-side filter SHOULD have run first; this is
 *      defense-in-depth on the client).
 *   2. Context filter (using the live ChatContext).
 *   3. Group by surface.
 *   4. Within each group, sort by metadata.order ASC, then slug ASC for
 *      deterministic tie-break.
 */
export function groupForRender(
  actions: QuickAction[],
  role: CrmRole,
  ctx: ChatContext,
): Record<string, QuickAction[]> {
  const visible = actions
    .filter((a) => isAllowed(a, role))
    .filter((a) => satisfiesContext(a, ctx))

  const grouped: Record<string, QuickAction[]> = {}
  for (const a of visible) {
    const surface = a.metadata.surface
    if (!grouped[surface]) grouped[surface] = []
    grouped[surface].push(a)
  }

  for (const surface of Object.keys(grouped)) {
    grouped[surface].sort((x, y) => {
      const ox = x.metadata.order ?? 0
      const oy = y.metadata.order ?? 0
      if (ox !== oy) return ox - oy
      return x.slug.localeCompare(y.slug)
    })
  }

  return grouped
}

/**
 * Validate a raw metadata object from the DB. Returns null if it does not
 * meet the minimum required shape. Slice 6b's renderer skips invalid rows
 * (defense in depth — a single malformed row never crashes the whole menu).
 *
 * Required keys: surface (string), order (number), icon (string),
 * handler (string).
 */
export function validateMetadata(raw: unknown): QuickActionMetadata | null {
  if (!raw || typeof raw !== "object") return null
  const m = raw as Record<string, unknown>

  if (typeof m.surface !== "string" || m.surface.length === 0) return null
  if (typeof m.order !== "number" || !Number.isFinite(m.order)) return null
  if (typeof m.icon !== "string" || m.icon.length === 0) return null
  if (typeof m.handler !== "string" || m.handler.length === 0) return null

  // Optional fields — only validate when present.
  if (m.requires_all !== undefined && !isStringArray(m.requires_all)) return null
  if (m.requires_any !== undefined && !isStringArray(m.requires_any)) return null
  if (m.permission !== undefined) {
    const p = m.permission as Record<string, unknown> | null
    if (p && p.role_in !== undefined && !isStringArray(p.role_in)) return null
  }
  if (m.handler_params !== undefined && (m.handler_params === null || typeof m.handler_params !== "object")) {
    return null
  }

  return m as unknown as QuickActionMetadata
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

// ── Loader (integration-tested via GET endpoint) ─────────────────────────

/**
 * Load all active chat_quick_actions rows from the DB, validate metadata,
 * and return only the well-formed ones. Skipped rows are logged.
 */
export async function listQuickActions(): Promise<QuickAction[]> {
  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, display_name, display_name_translations, description, metadata")
    .eq("catalog_id", "chat_quick_actions")
    .eq("status", "active")

  if (error) throw new Error(`listQuickActions: ${error.message}`)

  const rows = (data ?? []) as Array<{
    slug: string
    display_name: string
    display_name_translations: Record<string, string> | null
    description: string | null
    metadata: unknown
  }>

  const valid: QuickAction[] = []
  for (const row of rows) {
    const metadata = validateMetadata(row.metadata)
    if (!metadata) {
      console.warn(
        `[chat_quick_actions] skipping row with invalid metadata: slug=${row.slug}`,
      )
      continue
    }
    valid.push({
      slug: row.slug,
      display_name: row.display_name,
      display_name_translations: row.display_name_translations ?? {},
      description: row.description,
      metadata,
    })
  }

  return valid
}
