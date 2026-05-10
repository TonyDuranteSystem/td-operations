/**
 * Catalog framework — Phase 1 generic API.
 *
 * Reusable infrastructure for managing every enumerated business concept
 * (Services, SD types, Pipeline Stages, Doc Types, …). Each catalog lives
 * in `catalog_definitions`; its rows in `catalog_entries`. Every mutation
 * writes a `catalog_decision_log` row. Unrecognized external values land
 * in `catalog_pending_review`.
 *
 * Spec: sysdoc `ops-2026-05-09-catalog-framework-spec`.
 */

import type { Database } from "@/lib/database.types"
import { supabaseAdmin } from "@/lib/supabase-admin"

type CatalogEntryInsert = Database["public"]["Tables"]["catalog_entries"]["Insert"]
type CatalogDecisionLogInsert = Database["public"]["Tables"]["catalog_decision_log"]["Insert"]
type CatalogPendingReviewInsert = Database["public"]["Tables"]["catalog_pending_review"]["Insert"]

// ── Types ─────────────────────────────────────────────────────────────────

export type ActorKind = "chat" | "ui" | "migration" | "admin_api"

export type EntryStatus = "active" | "deprecated" | "exception_only"

export type CatalogAction =
  | "added"
  | "renamed"
  | "deprecated"
  | "restored"
  | "tagged"
  | "metadata_changed"
  | "translation_added"
  | "translation_changed"

export type PendingReviewSource =
  | "whop_webhook"
  | "stripe_webhook"
  | "plaid_webhook"
  | "manual_form"
  | "admin_input"
  | "mcp_tool"

export type PendingReviewStatus =
  | "pending"
  | "approved_added"
  | "approved_aliased"
  | "rejected"

export interface Actor {
  kind: ActorKind
  userId?: string | null
}

export interface CatalogDefinition {
  id: string
  display_name: string
  display_name_translations: Record<string, string>
  description: string | null
  admin_can_add_rows: boolean
  tags_schema: unknown
  created_at: string
  updated_at: string
}

export interface CatalogEntry {
  id: string
  catalog_id: string
  slug: string
  display_name: string
  display_name_translations: Record<string, string>
  description: string | null
  description_translations: Record<string, string>
  status: EntryStatus
  tags: string[]
  capabilities: Record<string, unknown>
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface CatalogDecisionLog {
  id: string
  catalog_entry_id: string | null
  catalog_id: string
  action: CatalogAction
  actor_kind: ActorKind
  actor_user_id: string | null
  reason: string
  before_state: Record<string, unknown> | null
  after_state: Record<string, unknown> | null
  created_at: string
}

export interface CatalogPendingReview {
  id: string
  catalog_id: string
  submitted_value: string
  source: PendingReviewSource
  source_metadata: Record<string, unknown>
  status: PendingReviewStatus
  resolved_at: string | null
  resolved_by: string | null
  resolved_to_entry_id: string | null
  created_at: string
}

export interface NewEntryInput {
  slug: string
  display_name: string
  status?: EntryStatus
  description?: string | null
  tags?: string[]
  capabilities?: Record<string, unknown>
  metadata?: Record<string, unknown>
  display_name_translations?: Record<string, string>
  description_translations?: Record<string, string>
}

export interface ListEntriesOptions {
  status?: EntryStatus
  tags?: string[]
  includeDeprecated?: boolean
}

export type ResolveExternalResult =
  | { matched: true; entry: CatalogEntry }
  | { matched: false; pendingReview: CatalogPendingReview }

// ── Read helpers ──────────────────────────────────────────────────────────

export async function getCatalog(id: string): Promise<CatalogDefinition | null> {
  const { data, error } = await supabaseAdmin
    .from("catalog_definitions")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`getCatalog(${id}): ${error.message}`)
  return (data as CatalogDefinition | null) ?? null
}

export async function listEntries(
  catalogId: string,
  opts: ListEntriesOptions = {},
): Promise<CatalogEntry[]> {
  let query = supabaseAdmin.from("catalog_entries").select("*").eq("catalog_id", catalogId)

  if (opts.status) {
    query = query.eq("status", opts.status)
  } else if (!opts.includeDeprecated) {
    query = query.neq("status", "deprecated")
  }

  if (opts.tags && opts.tags.length > 0) {
    query = query.contains("tags", opts.tags)
  }

  const { data, error } = await query.order("slug", { ascending: true })
  if (error) throw new Error(`listEntries(${catalogId}): ${error.message}`)
  return (data ?? []) as CatalogEntry[]
}

export async function getEntry(catalogId: string, slug: string): Promise<CatalogEntry | null> {
  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("*")
    .eq("catalog_id", catalogId)
    .eq("slug", slug)
    .maybeSingle()
  if (error) throw new Error(`getEntry(${catalogId}, ${slug}): ${error.message}`)
  return (data as CatalogEntry | null) ?? null
}

export async function getEntryById(id: string): Promise<CatalogEntry | null> {
  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`getEntryById(${id}): ${error.message}`)
  return (data as CatalogEntry | null) ?? null
}

// ── Decision-log helper ──────────────────────────────────────────────────

interface DecisionLogArgs {
  catalog_entry_id: string | null
  catalog_id: string
  action: CatalogAction
  actor: Actor
  reason: string
  before_state: Record<string, unknown> | null
  after_state: Record<string, unknown> | null
}

async function writeDecisionLog(args: DecisionLogArgs): Promise<void> {
  const row: CatalogDecisionLogInsert = {
    catalog_entry_id: args.catalog_entry_id,
    catalog_id: args.catalog_id,
    action: args.action,
    actor_kind: args.actor.kind,
    actor_user_id: args.actor.userId ?? null,
    reason: args.reason,
    before_state: args.before_state as CatalogDecisionLogInsert["before_state"],
    after_state: args.after_state as CatalogDecisionLogInsert["after_state"],
  }
  const { error } = await supabaseAdmin.from("catalog_decision_log").insert(row)
  if (error) throw new Error(`writeDecisionLog(${args.action}): ${error.message}`)
}

function entrySnapshot(e: CatalogEntry): Record<string, unknown> {
  return {
    id: e.id,
    slug: e.slug,
    display_name: e.display_name,
    status: e.status,
    tags: e.tags,
    display_name_translations: e.display_name_translations,
    description_translations: e.description_translations,
  }
}

function requireReason(fn: string, reason: string): void {
  if (!reason || !reason.trim()) {
    throw new Error(`${fn}: a non-empty reason is required for decision-log audit`)
  }
}

// ── Mutation helpers (each writes a decision_log row) ─────────────────────

export async function addEntry(
  catalogId: string,
  data: NewEntryInput,
  reason: string,
  actor: Actor,
): Promise<CatalogEntry> {
  requireReason("addEntry", reason)

  const insertRow: CatalogEntryInsert = {
    catalog_id: catalogId,
    slug: data.slug,
    display_name: data.display_name,
    status: data.status ?? "active",
    description: data.description ?? null,
    tags: (data.tags ?? []) as CatalogEntryInsert["tags"],
    capabilities: (data.capabilities ?? {}) as CatalogEntryInsert["capabilities"],
    metadata: (data.metadata ?? {}) as CatalogEntryInsert["metadata"],
    display_name_translations: (data.display_name_translations ??
      {}) as CatalogEntryInsert["display_name_translations"],
    description_translations: (data.description_translations ??
      {}) as CatalogEntryInsert["description_translations"],
    created_by: actor.userId ?? null,
    updated_by: actor.userId ?? null,
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("catalog_entries")
    .insert(insertRow)
    .select()
    .single()

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `addEntry: catalog entry already exists for (${catalogId}, ${data.slug}) — slugs are unique within a catalog`,
      )
    }
    throw new Error(`addEntry(${catalogId}, ${data.slug}): ${error.message}`)
  }

  const entry = inserted as CatalogEntry

  try {
    await writeDecisionLog({
      catalog_entry_id: entry.id,
      catalog_id: catalogId,
      action: "added",
      actor,
      reason,
      before_state: null,
      after_state: entrySnapshot(entry),
    })
  } catch (logErr) {
    // Best-effort rollback: delete the orphan entry so we never leave a row
    // without a corresponding audit log. No cross-table tx available via the
    // supabase-js client.
    await supabaseAdmin.from("catalog_entries").delete().eq("id", entry.id)
    throw logErr
  }

  return entry
}

export async function renameEntry(
  entryId: string,
  newDisplayName: string,
  reason: string,
  actor: Actor,
): Promise<CatalogEntry> {
  requireReason("renameEntry", reason)
  const before = await getEntryById(entryId)
  if (!before) throw new Error(`renameEntry: entry not found: ${entryId}`)

  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .update({ display_name: newDisplayName, updated_by: actor.userId ?? null })
    .eq("id", entryId)
    .select()
    .single()
  if (error) throw new Error(`renameEntry(${entryId}): ${error.message}`)
  const after = data as CatalogEntry

  await writeDecisionLog({
    catalog_entry_id: entryId,
    catalog_id: before.catalog_id,
    action: "renamed",
    actor,
    reason,
    before_state: { display_name: before.display_name },
    after_state: { display_name: after.display_name },
  })

  return after
}

export async function deprecateEntry(
  entryId: string,
  reason: string,
  actor: Actor,
): Promise<CatalogEntry> {
  requireReason("deprecateEntry", reason)
  const before = await getEntryById(entryId)
  if (!before) throw new Error(`deprecateEntry: entry not found: ${entryId}`)

  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .update({ status: "deprecated", updated_by: actor.userId ?? null })
    .eq("id", entryId)
    .select()
    .single()
  if (error) throw new Error(`deprecateEntry(${entryId}): ${error.message}`)
  const after = data as CatalogEntry

  await writeDecisionLog({
    catalog_entry_id: entryId,
    catalog_id: before.catalog_id,
    action: "deprecated",
    actor,
    reason,
    before_state: { status: before.status },
    after_state: { status: after.status },
  })

  return after
}

export async function restoreEntry(
  entryId: string,
  reason: string,
  actor: Actor,
): Promise<CatalogEntry> {
  requireReason("restoreEntry", reason)
  const before = await getEntryById(entryId)
  if (!before) throw new Error(`restoreEntry: entry not found: ${entryId}`)

  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .update({ status: "active", updated_by: actor.userId ?? null })
    .eq("id", entryId)
    .select()
    .single()
  if (error) throw new Error(`restoreEntry(${entryId}): ${error.message}`)
  const after = data as CatalogEntry

  await writeDecisionLog({
    catalog_entry_id: entryId,
    catalog_id: before.catalog_id,
    action: "restored",
    actor,
    reason,
    before_state: { status: before.status },
    after_state: { status: after.status },
  })

  return after
}

export async function tagEntry(
  entryId: string,
  tags: string[],
  reason: string,
  actor: Actor,
): Promise<CatalogEntry> {
  requireReason("tagEntry", reason)
  const before = await getEntryById(entryId)
  if (!before) throw new Error(`tagEntry: entry not found: ${entryId}`)

  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .update({ tags, updated_by: actor.userId ?? null })
    .eq("id", entryId)
    .select()
    .single()
  if (error) throw new Error(`tagEntry(${entryId}): ${error.message}`)
  const after = data as CatalogEntry

  await writeDecisionLog({
    catalog_entry_id: entryId,
    catalog_id: before.catalog_id,
    action: "tagged",
    actor,
    reason,
    before_state: { tags: before.tags },
    after_state: { tags: after.tags },
  })

  return after
}

export async function addTranslation(
  entryId: string,
  lang: string,
  displayName: string,
  description: string | null | undefined,
  reason: string,
  actor: Actor,
): Promise<CatalogEntry> {
  requireReason("addTranslation", reason)
  if (!lang || !lang.trim()) throw new Error("addTranslation: lang is required")
  const before = await getEntryById(entryId)
  if (!before) throw new Error(`addTranslation: entry not found: ${entryId}`)

  const hadTranslation = Boolean(before.display_name_translations?.[lang])
  const action: CatalogAction = hadTranslation ? "translation_changed" : "translation_added"

  const newDisplayTranslations = {
    ...(before.display_name_translations ?? {}),
    [lang]: displayName,
  }
  const newDescriptionTranslations = {
    ...(before.description_translations ?? {}),
    ...(description !== undefined && description !== null ? { [lang]: description } : {}),
  }

  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .update({
      display_name_translations: newDisplayTranslations,
      description_translations: newDescriptionTranslations,
      updated_by: actor.userId ?? null,
    })
    .eq("id", entryId)
    .select()
    .single()
  if (error) throw new Error(`addTranslation(${entryId}, ${lang}): ${error.message}`)
  const after = data as CatalogEntry

  await writeDecisionLog({
    catalog_entry_id: entryId,
    catalog_id: before.catalog_id,
    action,
    actor,
    reason,
    before_state: {
      lang,
      display_name_translations: before.display_name_translations,
      description_translations: before.description_translations,
    },
    after_state: {
      lang,
      display_name_translations: after.display_name_translations,
      description_translations: after.description_translations,
    },
  })

  return after
}

// ── Label / slug helpers ─────────────────────────────────────────────────

export function labelFor(entry: CatalogEntry, lang: string = "en"): string {
  if (lang && lang !== "en") {
    const translated = entry.display_name_translations?.[lang]
    if (translated && translated.trim()) return translated
  }
  return entry.display_name
}

export function slugFor(entry: CatalogEntry): string {
  return entry.slug
}

// ── External-value resolution (anti-corruption) ──────────────────────────

export async function resolveExternalValue(
  catalogId: string,
  externalValue: string,
  source: PendingReviewSource,
  metadata: Record<string, unknown> = {},
): Promise<ResolveExternalResult> {
  const trimmed = (externalValue ?? "").trim()
  if (!trimmed) {
    const pending = await recordPendingReview(catalogId, externalValue ?? "", source, metadata)
    return { matched: false, pendingReview: pending }
  }

  // 1. Exact slug match
  const bySlug = await getEntry(catalogId, trimmed)
  if (bySlug) return { matched: true, entry: bySlug }

  // 2 & 3. Display-name and translation matches.
  // Catalogs are small (≤ a few hundred rows) so we filter in memory rather
  // than crafting a complex JSONB containment query for every language.
  const all = await listEntries(catalogId, { includeDeprecated: true })

  const byDisplay = all.find((e) => e.display_name === trimmed)
  if (byDisplay) return { matched: true, entry: byDisplay }

  const byTranslation = all.find((e) =>
    Object.values(e.display_name_translations ?? {}).some((v) => v === trimmed),
  )
  if (byTranslation) return { matched: true, entry: byTranslation }

  // No match — record for later review.
  const pending = await recordPendingReview(catalogId, trimmed, source, metadata)
  return { matched: false, pendingReview: pending }
}

async function recordPendingReview(
  catalogId: string,
  submittedValue: string,
  source: PendingReviewSource,
  metadata: Record<string, unknown>,
): Promise<CatalogPendingReview> {
  // Dedupe: if a pending row already exists for this (catalog, value) pair,
  // return it instead of inserting a duplicate. Webhook retries are common.
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("catalog_pending_review")
    .select("*")
    .eq("catalog_id", catalogId)
    .eq("submitted_value", submittedValue)
    .eq("status", "pending")
    .maybeSingle()
  if (lookupError) {
    throw new Error(`recordPendingReview lookup: ${lookupError.message}`)
  }
  if (existing) return existing as CatalogPendingReview

  const insertRow: CatalogPendingReviewInsert = {
    catalog_id: catalogId,
    submitted_value: submittedValue,
    source,
    source_metadata: metadata as CatalogPendingReviewInsert["source_metadata"],
    status: "pending",
  }
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("catalog_pending_review")
    .insert(insertRow)
    .select()
    .single()
  if (insertError) {
    throw new Error(`recordPendingReview insert: ${insertError.message}`)
  }
  return inserted as CatalogPendingReview
}

// ── Pending-review governance ────────────────────────────────────────────

export interface ListPendingReviewOptions {
  catalogId?: string
  status?: PendingReviewStatus | "all"
}

export async function listPendingReview(
  opts: ListPendingReviewOptions = {},
): Promise<CatalogPendingReview[]> {
  let query = supabaseAdmin.from("catalog_pending_review").select("*")
  if (opts.catalogId) query = query.eq("catalog_id", opts.catalogId)
  // Default to status='pending' so callers see the active queue. Pass
  // status:'all' to dump every row regardless of resolution state.
  const status = opts.status ?? "pending"
  if (status !== "all") query = query.eq("status", status)
  const { data, error } = await query.order("created_at", { ascending: false })
  if (error) throw new Error(`listPendingReview: ${error.message}`)
  return (data ?? []) as CatalogPendingReview[]
}

export type PendingResolution = "approved_added" | "approved_aliased" | "rejected"

/**
 * Single canonical write-path for resolving a pending_review row. Both the
 * MCP catalog_pending tool and the admin UI server action call this so that
 * the DB state ends up identical regardless of which surface drove the
 * resolution.
 *
 * The reason / actor metadata is appended to source_metadata.resolution
 * because catalog_pending_review has no dedicated reason column and the
 * catalog_decision_log action enum does not include a "pending_resolved"
 * value (would require a migration). The pending_review row itself is the
 * audit record.
 */
export async function resolvePendingReview(
  pendingId: string,
  status: PendingResolution,
  resolvedToEntryId: string | null,
  reason: string,
  actor: Actor,
): Promise<CatalogPendingReview> {
  requireReason("resolvePendingReview", reason)

  if (status === "rejected" && resolvedToEntryId) {
    throw new Error(
      "resolvePendingReview: resolvedToEntryId must be null when status='rejected'",
    )
  }
  if (status !== "rejected" && !resolvedToEntryId) {
    throw new Error(
      `resolvePendingReview: resolvedToEntryId is required when status='${status}'`,
    )
  }

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("catalog_pending_review")
    .select("*")
    .eq("id", pendingId)
    .maybeSingle()
  if (fetchError) throw new Error(`resolvePendingReview lookup: ${fetchError.message}`)
  if (!existing) throw new Error(`resolvePendingReview: pending row not found: ${pendingId}`)
  const before = existing as CatalogPendingReview
  if (before.status !== "pending") {
    throw new Error(
      `resolvePendingReview: row ${pendingId} already resolved (status=${before.status})`,
    )
  }

  if (resolvedToEntryId) {
    const target = await getEntryById(resolvedToEntryId)
    if (!target) {
      throw new Error(`resolvePendingReview: target entry not found: ${resolvedToEntryId}`)
    }
    if (target.catalog_id !== before.catalog_id) {
      throw new Error(
        `resolvePendingReview: target entry belongs to catalog '${target.catalog_id}', expected '${before.catalog_id}'`,
      )
    }
  }

  const now = new Date().toISOString()
  const newSourceMetadata = {
    ...(before.source_metadata ?? {}),
    resolution: {
      reason,
      actor_kind: actor.kind,
      actor_user_id: actor.userId ?? null,
      at: now,
    },
  }

  const { data, error } = await supabaseAdmin
    .from("catalog_pending_review")
    .update({
      status,
      resolved_at: now,
      resolved_by: actor.userId ?? null,
      resolved_to_entry_id: resolvedToEntryId,
      source_metadata: newSourceMetadata as CatalogPendingReviewInsert["source_metadata"],
    })
    .eq("id", pendingId)
    .select()
    .single()
  if (error) throw new Error(`resolvePendingReview(${pendingId}): ${error.message}`)
  return data as CatalogPendingReview
}
