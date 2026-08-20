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
import { normalizeEmail, normalizePersonName, escapeLikePattern } from "@/lib/members/member-identity"
import { normalizeEIN } from "@/lib/jobs/validation"
import type { Database } from "@/lib/database.types"

// Legal suffixes stripped for near-duplicate company-name comparison only —
// never written to the database. Punctuation is already converted to spaces
// before this runs (see normalizeCompanyName), so "LLC"/"L.L.C."/"L L C" all
// collapse to the same "l l c" input — a separate "l.l.c" entry is not just
// redundant, it's actively wrong: unescaped periods in a RegExp mean "any
// character", so `\bl.l.c\b` also strips the middle of the ordinary word
// "lilac" (l-i-l-a-c), corrupting "Lilac Consulting LLC" into "consulting"
// and wrongly flagging it as a duplicate of any other "...Consulting LLC"
// (Senior Engineer review, 2026-08-19).
const COMPANY_SUFFIXES = [
  "l l c", "llc", "incorporated", "inc", "corporation", "corp", "ltd", "limited", "co",
]

/** Lowercase, strip punctuation + legal suffixes, collapse whitespace. */
function normalizeCompanyName(name: string): string {
  let n = name.normalize("NFC").toLowerCase().replace(/[.,]/g, " ")
  for (const suffix of COMPANY_SUFFIXES) {
    n = n.replace(new RegExp(`\\b${suffix.replace(/\s+/g, "\\s+")}\\b`, "g"), " ")
  }
  return n.replace(/\s+/g, " ").trim()
}

/** Lowercase + strip periods/commas + collapse whitespace — no suffix
 * stripping. Used as the exact-match fallback when a name normalizes to
 * nothing but a legal suffix (e.g. a company literally named "LLC"), so two
 * identical such names still count as a duplicate instead of silently
 * bypassing the guard. Periods/commas are REMOVED (not turned into spaces,
 * unlike normalizeCompanyName) specifically so "LLC" and "L.L.C." collapse
 * to the same string here — the periods-to-spaces approach would instead
 * split "L.L.C." into separate letters and never match plain "LLC" (found
 * via independent re-verification, 2026-08-19, dev_task 693273fd). */
function normalizeCompanyNameRaw(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim()
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
  if (na && nb) {
    if (na === nb) return true
    const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
    if (shorter.length >= 6 && longer.includes(shorter)) return true
  }
  // Either side normalized to nothing but a legal suffix (e.g. "LLC" alone) —
  // the suffix-stripped comparison above can't see these at all. Fall back
  // to an exact match on the raw (suffix-preserved) names so two literally
  // identical inputs are still caught.
  if (!na || !nb) return normalizeCompanyNameRaw(a) === normalizeCompanyNameRaw(b)
  return false
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

    // Same format check every other EIN write path already enforces
    // (updateAccountField) — an unnormalized/malformed value saved here
    // would violate what document generation and the EIN-received workflow
    // both assume.
    let normalizedEin: string | null = null
    if (params.ein_number && params.ein_number.trim()) {
      normalizedEin = normalizeEIN(params.ein_number)
      if (!normalizedEin) {
        return { success: false, outcome: "error", error: `Invalid EIN format: "${params.ein_number}". Expected 9 digits (e.g., 30-1482516).` }
      }
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
        ein_number: normalizedEin,
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
//
// Identity-matching design (rewritten 2026-08-19 — dev_task 693273fd — after
// the original version was found to have real failure modes in BOTH
// directions, confirmed against live production data, not hypothetical):
//   - Matching on email + FULL name (first+middle+last), the way
//     resolveMemberContactId already safely does it elsewhere (formation,
//     onboarding), is kept as the ONLY path that auto-links without asking a
//     human — an exact match on both signals together is unambiguous.
//   - A prior version of this function excluded the middle name from that
//     match "so a shorter-named existing contact is still recognized." That
//     was itself unsafe: two DIFFERENT real people can share one email (a
//     family LLC) with the same first+last name — confirmed live, 8 emails
//     in production today are shared by two distinct contacts, mostly
//     couples/family (e.g. Angelo Capalbo Ghelli / Patrizia Capalbo). Auto-
//     linking on a partial-name match could silently attach a new account to
//     the wrong person.
//   - So: same email, but the name doesn't match any contact on that email
//     exactly → do NOT guess either way (the same "never guess, ask a human"
//     rule this codebase just adopted for document-signer resolution, see
//     lib/members/resolve-signer.ts, dev_task 9ad76300 — a lease was signed
//     by the wrong person after a similar silent pick). Create a new contact
//     (the safe default — a recoverable duplicate, not a wrongly-merged
//     identity) and surface a non-blocking warning naming who's already on
//     that email and what they're linked to, so staff can decide.
//   - Separately — regardless of email — an EXACT name match against a
//     DIFFERENT contact (any email, or none) also produces a non-blocking
//     warning with that contact's companies/roles. This is what actually
//     answers "does the system recognize the same person across roles":
//     it surfaces the context to a human rather than having the algorithm
//     decide. Real example this was built against: Damiano Mocellin is on
//     file today as two separate contacts (one per email) — owner of his
//     own company, and a member of a second company (which his own company
//     also separately holds a stake in) — confirmed live, 2026-08-19.
//
// Name is split into parts rather than one free-text field: first/last name
// feed IRS forms, tax filings, and portal personalization elsewhere, and a
// naive space-split of one field mis-parsed multi-word names. Middle name
// has no dedicated column anywhere in the schema, so it's folded into the
// composed full name used for the stored record and any generated document.

const ADDRESS_COLUMNS = ["address_line1", "address_city", "address_state", "address_zip", "address_country"] as const
type AddressFields = Record<(typeof ADDRESS_COLUMNS)[number], string | null>

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
  /** Non-blocking — a possibly-related existing contact was found (same
   * email under a different name, or the same name under a different
   * email). The write already happened; this is only for staff review. */
  warning?: string
}

/** This contact's companies and roles, for a human-readable warning
 * ("already linked to: Orizzonti LLC (owner), Oh My Creatives LLC (Member)"). */
async function describeContactRoles(contactId: string): Promise<string> {
  const { data: links, error } = await supabaseAdmin
    .from("account_contacts")
    .select("role, accounts(company_name)")
    .eq("contact_id", contactId)
  if (error) {
    // A transient failure here must never read as "no company yet" — that
    // would understate a real collision to the human this warning exists
    // to inform (Bug Hunter review, 2026-08-19, dev_task 693273fd).
    console.error(`[createAndLinkContact] describeContactRoles failed for ${contactId}:`, error.message)
    return "unable to verify — lookup failed"
  }
  const roles = (links || [])
    .map((l) => {
      const companyName = (l as { accounts: { company_name: string } | null }).accounts?.company_name
      return companyName ? `${companyName} (${l.role || "linked"})` : null
    })
    .filter((s): s is string => !!s)
  return roles.length > 0 ? roles.join(", ") : "no company yet"
}

/** Only fill a field that's currently blank on the existing contact — never
 * overwrite real data (a prior version of this function unconditionally
 * overwrote, e.g. replacing an on-file address with whatever a new,
 * unrelated account's form happened to submit). */
function blankFieldsOnly(existing: Partial<AddressFields>, incoming: AddressFields): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const col of ADDRESS_COLUMNS) {
    // Trim before judging blankness — a whitespace-only existing value
    // (e.g. " ") is not real data and should still be refreshed (Senior
    // Engineer review, 2026-08-19, dev_task 693273fd).
    const incomingVal = (incoming[col] ?? "").trim()
    const existingVal = (existing[col] ?? "").trim()
    if (incomingVal && !existingVal) patch[col] = incomingVal
  }
  return patch
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
    const legalName = [firstName, middleName, lastName].filter(Boolean).join(" ")
    const normalizedLegalName = normalizePersonName(legalName)
    const email = normalizeEmail(params.email)
    const addressFields: AddressFields = {
      address_line1: params.address_line1 || null,
      address_city: params.address_city || null,
      address_state: params.address_state || null,
      address_zip: params.address_zip || null,
      address_country: params.address_country || null,
    }

    let resolvedContactId: string | null = null
    const warnings: string[] = []

    if (email) {
      const { data: sameEmailContacts } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name, email, address_line1, address_city, address_state, address_zip, address_country")
        .ilike("email", `%${escapeLikePattern(email)}%`)
        .is("merged_into", null)
      // The %-wrapped ilike can still over-match in principle (e.g. a longer
      // email containing this one as a substring); narrow to a real
      // case-insensitive equality check in JS, same discipline as
      // lib/operations/find-contact-by-email.ts.
      const candidates = (sameEmailContacts || []).filter((c) => (c.email || "").trim().toLowerCase() === email)

      const exactMatch = candidates.find((c) => normalizePersonName(c.full_name) === normalizedLegalName)
      if (exactMatch) {
        resolvedContactId = exactMatch.id
        const refresh = blankFieldsOnly(exactMatch, addressFields)
        if (Object.keys(refresh).length > 0) {
          refresh.updated_at = now
          // eslint-disable-next-line no-restricted-syntax -- operations-layer write on a protected table; not on dev_task 7ebb1e0c's list (new code path), tracked here instead
          await supabaseAdmin.from("contacts").update(refresh).eq("id", resolvedContactId)
        }
      } else if (candidates.length > 0) {
        // This email is already on file, but under a different name (or
        // names) — could be the same person entered inconsistently, or a
        // shared family/company inbox belonging to someone else entirely.
        // Never guess: create a new contact, and let a human decide.
        const others = await Promise.all(
          candidates.map(async (c) => `${c.full_name || "(no name)"} — ${await describeContactRoles(c.id)}`)
        )
        warnings.push(`This email is already on file for a different name: ${others.join("; ")}. Verify this isn't the same person before continuing.`)
      }
    }

    if (!resolvedContactId) {
      // No confident email+name match. Before creating, check for an exact
      // name match under a DIFFERENT email (or no email) — the Damiano
      // Mocellin case: same real person, different email per company role.
      // Runs independently of the email-based check above (not "else if") —
      // a bug in the first council pass made these mutually exclusive via an
      // `if (!warning)` guard, silently dropping the second warning whenever
      // the first one fired (Bug Hunter review, 2026-08-19, dev_task 693273fd).
      {
        // Collapse whitespace before building the search pattern — the
        // original code searched on the raw joined name while comparing
        // against the whitespace-collapsed `normalizedLegalName`, so stray
        // whitespace variance could silently defeat the match (Senior
        // Engineer review, same pass).
        const searchName = legalName.trim().replace(/\s+/g, " ")
        const { data: sameNameContacts } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, email")
          .ilike("full_name", `%${escapeLikePattern(searchName)}%`)
          .is("merged_into", null)
        const nameMatch = (sameNameContacts || []).find(
          (c) => normalizePersonName(c.full_name) === normalizedLegalName && (!email || normalizeEmail(c.email) !== email)
        )
        if (nameMatch) {
          warnings.push(`A contact named "${legalName}" already exists — linked to: ${await describeContactRoles(nameMatch.id)}. Verify this isn't the same person before continuing.`)
        }
      }

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

    const warning = warnings.length > 0 ? warnings.join(" | ") : undefined

    logAction({
      actor: params.actor || "system",
      action_type: "create",
      table_name: "account_contacts",
      record_id: resolvedContactId,
      account_id: params.account_id,
      contact_id: resolvedContactId,
      summary: `${existingLink ? "Linked existing contact" : "Added contact"}: ${legalName}`,
      details: { full_name: legalName, email: params.email, role: params.role || "owner", is_primary: params.is_primary ?? false, warning },
    })

    return {
      success: true,
      outcome: existingLink ? "already_linked" : "linked",
      contact_id: resolvedContactId,
      warning,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
