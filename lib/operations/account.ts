/**
 * P3.4 #7 — Account operation authority layer
 *
 * Single-entry account-update path for status / tier / notes / any
 * field write. Callers:
 *   - Dashboard server actions (app/(dashboard)/accounts/actions.ts
 *     updateAccountField / addAccountNote / changeAccountStatus)
 *   - MCP portal tool (lib/mcp/tools/portal.ts — portal user creation
 *     + legacy transition)
 *   - CRM admin-actions routes (app/api/portal/admin/transition)
 *   - Future: MCP crm_update_record, other API routes.
 *
 * Why: before this, ~7 different call sites did raw
 * `supabaseAdmin.from("accounts").update(...)`. Each had its own
 * logging discipline (some logged, some didn't), some used optimistic
 * locking, some didn't. This function is the single guarded surface.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { resolveMemberContactId } from "@/lib/members/resolve-member-contact"
import { normalizeEmail, matchContactByName } from "@/lib/members/member-identity"
import type { Database } from "@/lib/database.types"

// Legal suffixes stripped for near-duplicate company-name comparison only —
// never written to the database. Longest-first so "l.l.c" doesn't leave a
// stray "l.c" behind when "llc" alone would have matched.
const COMPANY_SUFFIXES = [
  "l l c", "llc", "l.l.c", "incorporated", "inc", "corporation", "corp", "ltd", "limited", "co",
]

/** Lowercase, strip punctuation + legal suffixes, collapse whitespace. */
function normalizeCompanyName(name: string): string {
  let n = name.normalize("NFC").toLowerCase().replace(/[.,]/g, " ")
  for (const suffix of COMPANY_SUFFIXES) {
    n = n.replace(new RegExp(`\\b${suffix.replace(/\s+/g, "\\s+")}\\b`, "g"), " ")
  }
  return n.replace(/\s+/g, " ").trim()
}

/**
 * True when two company names are the same after normalization, or one is
 * contained in the other (e.g. "Adact Studio" vs "Adact Studio International
 * LLC" — the exact miss that let a real client get a confusing near-duplicate
 * account in production, 2026-08-19). The containment check requires the
 * shorter fragment to be at least 6 characters — caught in testing this same
 * session: a 4-character generic word ("Test", an existing fixture account)
 * matched as a substring of an unrelated new name that happened to contain
 * the word "test". Exact matches (after normalization) are always caught
 * regardless of length — only the loose containment check is gated.
 */
export function isNearDuplicateCompanyName(a: string, b: string): boolean {
  const na = normalizeCompanyName(a)
  const nb = normalizeCompanyName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  if (shorter.length < 6) return false
  return longer.includes(shorter)
}

// ─── Types ──────────────────────────────────────────────────

type AccountUpdate = Database["public"]["Tables"]["accounts"]["Update"]

export interface UpdateAccountParams {
  id: string
  patch: AccountUpdate
  /**
   * Optional optimistic-lock sentinel. When provided, the update only
   * succeeds if the row's current updated_at matches. If the row was
   * modified between read and write, the call returns
   * { outcome: "stale" }.
   */
  expected_updated_at?: string
  /**
   * Logged to action_log.actor. Defaults to "system" — callers should
   * pass e.g. "dashboard:antonio", "claude.ai", "crm-admin".
   */
  actor?: string
  /**
   * Short human-readable summary for the action_log. Defaults to a
   * generic "Account updated" label.
   */
  summary?: string
  /**
   * Free-form details dict logged to action_log.details. Defaults to
   * the list of changed field names.
   */
  details?: Record<string, unknown>
}

export interface UpdateAccountResult {
  success: boolean
  outcome: "updated" | "stale" | "not_found" | "error"
  account_id?: string
  updated_at?: string
  error?: string
}

export interface AppendAccountNoteParams {
  id: string
  note: string
  /** When provided, enables optimistic-lock on the read-before-append. */
  expected_updated_at?: string
  /** Defaults to today (YYYY-MM-DD). */
  date?: string
  actor?: string
}

export interface AppendAccountNoteResult {
  success: boolean
  outcome: "appended" | "stale" | "not_found" | "error" | "empty_note"
  account_id?: string
  error?: string
}

// ─── updateAccount ──────────────────────────────────────────

export async function updateAccount(
  params: UpdateAccountParams
): Promise<UpdateAccountResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }

    const nowIso = new Date().toISOString()
    const updates: AccountUpdate = { ...params.patch, updated_at: nowIso }

    // Build the update query. Add the optimistic-lock filter when a
    // sentinel is supplied. Select id + updated_at back so callers can
    // detect the stale-row case (0 rows matched).
    let query = supabaseAdmin
      .from("accounts")
      .update(updates)
      .eq("id", params.id)

    if (params.expected_updated_at) {
      query = query.eq("updated_at", params.expected_updated_at)
    }

    const { data, error } = await query.select("id, updated_at")

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    if (!data || data.length === 0) {
      // Distinguish stale-lock miss from genuine not_found by re-reading.
      const { data: exists } = await supabaseAdmin
        .from("accounts")
        .select("id")
        .eq("id", params.id)
        .maybeSingle()
      return {
        success: false,
        outcome: exists ? "stale" : "not_found",
        error: exists
          ? "Row was modified since it was read (optimistic lock)"
          : `Account ${params.id} not found`,
      }
    }

    const changedFields = Object.keys(params.patch)
    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: "accounts",
      record_id: params.id,
      account_id: params.id,
      summary: params.summary || `Account updated (${changedFields.join(", ")})`,
      details: params.details || { fields: changedFields, patch: params.patch },
    })

    return {
      success: true,
      outcome: "updated",
      account_id: data[0].id,
      updated_at: data[0].updated_at ?? nowIso,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── appendAccountNote ──────────────────────────────────────

/**
 * Prepend a dated note entry to accounts.notes. Format:
 *   "YYYY-MM-DD: <note text>"
 * Newer entries appear first (matches existing dashboard behavior).
 */
export async function appendAccountNote(
  params: AppendAccountNoteParams
): Promise<AppendAccountNoteResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    const trimmed = (params.note || "").trim()
    if (!trimmed) {
      return { success: false, outcome: "empty_note", error: "Note cannot be empty" }
    }

    const { data: account, error: readErr } = await supabaseAdmin
      .from("accounts")
      .select("id, notes, updated_at")
      .eq("id", params.id)
      .maybeSingle()

    if (readErr) {
      return { success: false, outcome: "error", error: readErr.message }
    }
    if (!account) {
      return { success: false, outcome: "not_found", error: `Account ${params.id} not found` }
    }

    const dateStr = params.date || new Date().toISOString().split("T")[0]
    const newEntry = `${dateStr}: ${trimmed}`
    const existing = (account.notes ?? "").trim()
    const combined = existing ? `${newEntry}\n${existing}` : newEntry

    const result = await updateAccount({
      id: params.id,
      patch: { notes: combined },
      expected_updated_at: params.expected_updated_at ?? account.updated_at ?? undefined,
      actor: params.actor,
      summary: "Note added",
      details: { note: trimmed },
    })

    if (!result.success) {
      return {
        success: false,
        outcome: result.outcome === "stale" ? "stale" : "error",
        account_id: params.id,
        error: result.error,
      }
    }

    return { success: true, outcome: "appended", account_id: params.id }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── createAccount ──────────────────────────────────────────
//
// accounts has staff-facing RLS policies for SELECT only (no INSERT) —
// see dev_task 7ebb1e0c pragma #1. This is the operations-layer home
// for the raw admin-client insert, matching every other account write
// in this file.

export interface CreateAccountParams {
  company_name: string
  entity_type?: Database["public"]["Tables"]["accounts"]["Row"]["entity_type"]
  member_structure?: string | null
  state_of_formation?: string | null
  status?: Database["public"]["Tables"]["accounts"]["Row"]["status"]
  ein_number?: string | null
  notes?: string | null
  /** Defaults to "Client" — the manual-creation dialog has no field for this yet. */
  account_type?: string
  actor?: string
}

export interface CreateAccountResult {
  success: boolean
  outcome: "created" | "duplicate" | "error"
  account_id?: string
  error?: string
}

export async function createAccount(
  params: CreateAccountParams
): Promise<CreateAccountResult> {
  try {
    const companyName = (params.company_name || "").trim()
    if (!companyName) {
      return { success: false, outcome: "error", error: "company_name is required" }
    }

    // Near-duplicate guard — this insert had zero successful executions
    // before the RLS fix, so this path has never been exercised against
    // TD's known duplicate-account history. Not a hard unique constraint
    // (company names aren't guaranteed unique); catches "Adact Studio" vs
    // an existing "Adact Studio International LLC", not just exact matches.
    // 333 accounts total (2026-08-19) — a full id+name scan is cheap for an
    // admin-only, low-frequency action; revisit if that count grows a lot.
    const { data: allAccounts } = await supabaseAdmin.from("accounts").select("id, company_name")
    const match = (allAccounts || []).find((a) => isNearDuplicateCompanyName(a.company_name, companyName))
    if (match) {
      return {
        success: false,
        outcome: "duplicate",
        account_id: match.id,
        error: `An account with a very similar name already exists: "${match.company_name}"`,
      }
    }

    const now = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from("accounts")
      .insert({
        company_name: companyName,
        entity_type: params.entity_type ?? null,
        member_structure: params.member_structure ?? null,
        state_of_formation: params.state_of_formation ?? null,
        status: params.status ?? "Pending Formation",
        ein_number: params.ein_number ?? null,
        notes: params.notes ?? null,
        account_type: params.account_type ?? "Client",
        // DB default is 'active' — wrong for a brand-new account (grants
        // full portal access before the company is even formed, and
        // stalls the later syncTier('formation') downgrade guard). The
        // one other working create path (createOneTimeCustomer) makes
        // the same override for the same reason.
        portal_tier: null,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single()

    if (error || !data) {
      return { success: false, outcome: "error", error: error?.message || "Insert failed" }
    }

    logAction({
      actor: params.actor || "system",
      action_type: "create",
      table_name: "accounts",
      record_id: data.id,
      account_id: data.id,
      summary: `Created: ${companyName}`,
      details: {
        company_name: companyName,
        entity_type: params.entity_type,
        member_structure: params.member_structure,
        account_type: params.account_type ?? "Client",
      },
    })

    return { success: true, outcome: "created", account_id: data.id }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── createAndLinkContact ───────────────────────────────────
//
// contacts has the identical staff-facing RLS gap as accounts (SELECT
// only, no INSERT) — same dev_task 7ebb1e0c pragma, different table.
// Reuses resolveMemberContactId (the same find-or-create-by-email+name
// identity match the formation/onboarding paths use) instead of a blind
// insert, so re-adding an already-known person doesn't fork a duplicate
// contact record.
//
// Name is split into parts rather than one free-text field: first/last name
// feed IRS forms, tax filings, and portal personalization elsewhere, and a
// naive space-split of one field mis-parsed multi-word names. Middle name
// has no dedicated column anywhere in the schema, so it's folded into the
// composed full name (for documents) but deliberately EXCLUDED from the
// identity-matching name (see below) — matching on the full name including
// a middle name would miss an existing contact on file as "John Smith" when
// this call provides "John Michael Smith", forking a duplicate.

export interface CreateAndLinkContactParams {
  account_id: string
  first_name: string
  middle_name?: string | null
  last_name: string
  email?: string | null
  address_line1?: string | null
  address_city?: string | null
  address_state?: string | null
  address_zip?: string | null
  address_country?: string | null
  role?: string
  is_primary?: boolean
  actor?: string
}

export interface CreateAndLinkContactResult {
  success: boolean
  outcome: "linked" | "already_linked" | "error"
  contact_id?: string
  error?: string
}

export async function createAndLinkContact(
  params: CreateAndLinkContactParams
): Promise<CreateAndLinkContactResult> {
  try {
    const firstName = (params.first_name || "").trim()
    const middleName = (params.middle_name || "").trim()
    const lastName = (params.last_name || "").trim()
    if (!params.account_id) {
      return { success: false, outcome: "error", error: "account_id is required" }
    }
    if (!firstName) {
      return { success: false, outcome: "error", error: "first_name is required" }
    }
    // last_name may be blank here (the account-detail "Add Contact" panel
    // still allows a single-word name) — the New Account dialog enforces
    // both being present at its own Zod-schema layer instead.

    const now = new Date().toISOString()
    // Used ONLY for identity matching — never stored, never shown.
    const matchingName = [firstName, lastName].filter(Boolean).join(" ")
    // Used for the stored record and any documents generated from it.
    const legalName = [firstName, middleName, lastName].filter(Boolean).join(" ")
    const email = normalizeEmail(params.email)
    const addressFields = {
      address_line1: params.address_line1 || null,
      address_city: params.address_city || null,
      address_state: params.address_state || null,
      address_zip: params.address_zip || null,
      address_country: params.address_country || null,
    }

    // Pre-check with the middle name excluded, so an existing contact on
    // file under a shorter name is still recognized. Only fill address
    // fields that are currently blank — never overwrite what's on file.
    let resolvedContactId: string | null = null
    if (email) {
      const { data: sameEmailContacts } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name")
        .ilike("email", email)
      resolvedContactId = matchContactByName(sameEmailContacts || [], matchingName)
      if (resolvedContactId) {
        const refresh: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(addressFields)) {
          if (v) refresh[k] = v
        }
        if (Object.keys(refresh).length > 0) {
          refresh.updated_at = now
          // eslint-disable-next-line no-restricted-syntax -- operations-layer write on a protected table; not on dev_task 7ebb1e0c's list (new code path), tracked here instead
          await supabaseAdmin.from("contacts").update(refresh).eq("id", resolvedContactId)
        }
      }
    }

    if (!resolvedContactId) {
      resolvedContactId = await resolveMemberContactId({
        email: params.email ?? null,
        name: legalName,
        first_name: firstName,
        last_name: lastName,
        refresh: addressFields,
        now,
      })
    }

    // No email (or contact creation failed) — fall back to a plain
    // insert so the contact isn't silently dropped; resolveMemberContactId
    // only returns null when it can't identity-match or create one.
    if (!resolvedContactId) {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("contacts")
        .insert({
          full_name: legalName,
          first_name: firstName,
          last_name: lastName,
          email: params.email || null,
          status: "active",
          ...addressFields,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .single()
      if (createErr || !created) {
        return { success: false, outcome: "error", error: createErr?.message || "Failed to create contact" }
      }
      resolvedContactId = created.id
    }

    const { data: existingLink } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id")
      .eq("account_id", params.account_id)
      .eq("contact_id", resolvedContactId)
      .maybeSingle()

    if (!existingLink) {
      const { error: linkErr } = await supabaseAdmin
        .from("account_contacts")
        .insert({
          account_id: params.account_id,
          contact_id: resolvedContactId,
          role: params.role || "owner",
          is_primary: params.is_primary ?? false,
        })
      if (linkErr) {
        return { success: false, outcome: "error", error: linkErr.message }
      }
    }

    logAction({
      actor: params.actor || "system",
      action_type: "create",
      table_name: "account_contacts",
      record_id: resolvedContactId,
      account_id: params.account_id,
      contact_id: resolvedContactId,
      summary: `${existingLink ? "Linked existing contact" : "Added contact"}: ${legalName}`,
      details: { full_name: legalName, email: params.email, role: params.role || "owner", is_primary: params.is_primary ?? false },
    })

    return {
      success: true,
      outcome: existingLink ? "already_linked" : "linked",
      contact_id: resolvedContactId,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
