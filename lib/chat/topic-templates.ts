/**
 * topic_templates — pure helpers
 *
 * Slice 7 sister file to lib/chat/quick-actions.ts. Both catalogs share the
 * same row shape (per 🔒 Principle of Flexibility) and the same primitive
 * vocabulary; only `surface` differs.
 *
 * - chat_quick_actions  → surface="portal_chat_message" (per-message dropdown)
 * - topic_templates     → surface="portal_chat_topic_create" (topic selector)
 *
 * Everything in this file is pure or a thin DB loader. Page-side dispatcher
 * lives in app/(dashboard)/portal-chats/page.tsx behind a feature flag.
 */

import type { CrmRole } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { type PrimitiveHandler, validatePrimitiveHandler, type OnSuccessConfig } from "@/lib/chat/handler-primitives"

// ── Types ──────────────────────────────────────────────────────────────────

export interface TopicTemplateMetadata {
  surface: string
  order: number
  icon: string
  color?: string
  permission?: { role_in?: CrmRole[] }
  requires_all?: string[]
  requires_any?: string[]
  handler: PrimitiveHandler
  on_success?: OnSuccessConfig
}

export interface TopicTemplate {
  slug: string
  display_name: string
  display_name_translations: Record<string, string>
  description: string | null
  metadata: TopicTemplateMetadata
}

export type TopicContext = Record<string, unknown>

// ── Pure helpers (unit-tested) ────────────────────────────────────────────

export function isAllowed(template: TopicTemplate, role: CrmRole): boolean {
  const allowed = template.metadata.permission?.role_in
  if (!allowed || allowed.length === 0) return true
  return allowed.includes(role)
}

export function satisfiesContext(template: TopicTemplate, ctx: TopicContext): boolean {
  const all = template.metadata.requires_all ?? []
  const any = template.metadata.requires_any ?? []

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
 * Filter + sort templates for rendering one surface's dropdown.
 * Server-side endpoint already RBAC-filtered; this is defense-in-depth.
 */
export function filterForSurfaceAndContext(
  templates: TopicTemplate[],
  surface: string,
  ctx: TopicContext,
): TopicTemplate[] {
  return templates
    .filter((t) => t.metadata.surface === surface)
    .filter((t) => satisfiesContext(t, ctx))
    .sort((x, y) => {
      const ox = x.metadata.order ?? 0
      const oy = y.metadata.order ?? 0
      if (ox !== oy) return ox - oy
      return x.slug.localeCompare(y.slug)
    })
}

/**
 * Validate a raw metadata object from the DB. Returns null if it doesn't
 * meet the shape. Renderer skips invalid rows (single bad row never crashes
 * the whole selector — same defense-in-depth pattern as chat_quick_actions).
 */
export function validateMetadata(raw: unknown): TopicTemplateMetadata | null {
  if (!raw || typeof raw !== "object") return null
  const m = raw as Record<string, unknown>

  if (typeof m.surface !== "string" || m.surface.length === 0) return null
  if (typeof m.order !== "number" || !Number.isFinite(m.order)) return null
  if (typeof m.icon !== "string" || m.icon.length === 0) return null

  const handler = validatePrimitiveHandler(m.handler)
  if (!handler) return null

  if (m.requires_all !== undefined && !isStringArray(m.requires_all)) return null
  if (m.requires_any !== undefined && !isStringArray(m.requires_any)) return null
  if (m.permission !== undefined) {
    const p = m.permission as Record<string, unknown> | null
    if (p && p.role_in !== undefined && !isStringArray(p.role_in)) return null
  }
  if (m.on_success !== undefined && (m.on_success === null || typeof m.on_success !== "object")) {
    return null
  }

  return { ...m, handler } as unknown as TopicTemplateMetadata
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

// ── Loader (integration-tested via GET endpoint) ─────────────────────────

export async function listTopicTemplates(): Promise<TopicTemplate[]> {
  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, display_name, display_name_translations, description, metadata")
    .eq("catalog_id", "topic_templates")
    .eq("status", "active")

  if (error) throw new Error(`listTopicTemplates: ${error.message}`)

  const rows = (data ?? []) as Array<{
    slug: string
    display_name: string
    display_name_translations: Record<string, string> | null
    description: string | null
    metadata: unknown
  }>

  const valid: TopicTemplate[] = []
  for (const row of rows) {
    const metadata = validateMetadata(row.metadata)
    if (!metadata) {
      console.warn(`[topic_templates] skipping row with invalid metadata: slug=${row.slug}`)
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
