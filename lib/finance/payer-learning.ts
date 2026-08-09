/**
 * Payer learning — reading and writing the taught link between a payer and a client.
 *
 * Dev jobs `ae8b8bb1` / `c0a61e44`. The rules live next door in `payer-learning-rules.ts`
 * (pure, unit-tested); this file is the thin data layer around them.
 *
 * INVARIANTS, each one load-bearing:
 *  - A mapping exists ONLY because a person clicked. There is no automatic writer, and
 *    `taught_by` has no system value to fall back on.
 *  - Teaching a payer for one client says NOTHING about any other client. A payer may map to
 *    several clients, each its own row and its own confirmation (real case: one descriptor pays
 *    both its own company and a client owned by someone else).
 *  - IDENTIFY, NEVER SETTLE. A taught payer tells the router "this is a client's money" and
 *    scopes the candidates. It never picks an invoice and never moves money.
 *  - The rail guard is re-applied AT LOOKUP, not just at teach time, so adding a processor to
 *    the list also disarms mappings that were taught before it was added.
 *  - Removal is a soft delete and NEVER re-files history: past transactions stay where they
 *    are and move only through triage.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  evaluateTeachEligibility,
  isProcessorOnlyDescriptor,
  resolvePayerKey,
  type PayerKey,
  type TeachRefusal,
  type TeachableFeed,
} from "@/lib/finance/payer-learning-rules"

/** The table is not in the generated Supabase types (same escape as `payment_applications`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
const db = () => supabaseAdmin as any

const TABLE = "payer_client_map"

export interface PayerMapping {
  id: string
  source: string
  key_type: PayerKey["key_type"]
  key_value: string
  display_payer: string | null
  account_id: string | null
  contact_id: string | null
  taught_by: string
  taught_at: string
  taught_via: string | null
  notes: string | null
}

/** Which client a mapping points at. Exactly one is set. */
export interface PayerSubject {
  accountId?: string | null
  contactId?: string | null
}

function normaliseSubject(subject: PayerSubject): { accountId: string | null; contactId: string | null } | null {
  const accountId = subject.accountId ?? null
  const contactId = subject.contactId ?? null
  if (accountId && contactId) return null // ambiguous — the table's CHECK would reject it anyway
  if (!accountId && !contactId) return null
  return { accountId, contactId }
}

export interface TeachResult {
  ok: boolean
  /** False when an identical live mapping already existed — a re-click is harmless. */
  created?: boolean
  mappingId?: string
  refusal?: TeachRefusal | "no_subject" | "write_failed"
  detail?: string
  /** Other clients already taught for this same payer — shown, never blocking. */
  alsoTaughtFor?: PayerMapping[]
}

/**
 * Remember that this payer pays for this client.
 *
 * Idempotent on (payer, client): clicking twice returns the existing mapping rather than
 * creating a second one.
 *
 * ⛔ INSERTS A FRESH ROW RATHER THAN REVIVING A TOMBSTONE, on purpose. If a mapping was removed
 * and is now taught again, reviving the old row would erase who removed it and when — which is
 * exactly the audit trail you need when a mapping turns out to have been wrong twice. The
 * unique indexes are PARTIAL (`WHERE removed_at IS NULL`), so a tombstoned row is not in the
 * index and cannot collide with the new one. That is the edge case that would otherwise bite in
 * production: a wrong mapping is removed, corrected, and the correction fails on a constraint
 * against a row nobody can see.
 */
export async function teachPayerClient(params: {
  feed: TeachableFeed & { source?: string | null }
  subject: PayerSubject
  taughtBy: string
  taughtVia?: string
  notes?: string
}): Promise<TeachResult> {
  const subject = normaliseSubject(params.subject)
  if (!subject) {
    return {
      ok: false,
      refusal: "no_subject",
      detail: "Pick exactly one client — a company or a person — for this payer.",
    }
  }

  const eligibility = evaluateTeachEligibility(params.feed)
  if (!eligibility.ok || !eligibility.key) {
    return { ok: false, refusal: eligibility.refusal, detail: eligibility.detail }
  }

  const key = eligibility.key
  const source = params.feed.source ?? "manual"

  // Everything already taught for this payer. Shown to the person clicking so a second client
  // is a visible, deliberate addition rather than a silent surprise.
  const alsoTaughtFor = await listMappingsForKey(source, key)

  const existing = alsoTaughtFor.find((m) =>
    subject.accountId ? m.account_id === subject.accountId : m.contact_id === subject.contactId,
  )
  if (existing) {
    return { ok: true, created: false, mappingId: existing.id, alsoTaughtFor }
  }

  const { data, error } = await db()
    .from(TABLE)
    .insert({
      source,
      key_type: key.key_type,
      key_value: key.key_value,
      display_payer: key.display_payer,
      account_id: subject.accountId,
      contact_id: subject.contactId,
      taught_by: params.taughtBy,
      taught_via: params.taughtVia ?? null,
      notes: params.notes ?? null,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) {
    return {
      ok: false,
      refusal: "write_failed",
      detail: `Could not remember this payer: ${error?.message ?? "unknown error"}`,
      alsoTaughtFor,
    }
  }

  return { ok: true, created: true, mappingId: data.id as string, alsoTaughtFor }
}

/**
 * Forget a mapping. Soft delete, TOCTOU-guarded so two clicks cannot both claim to have removed
 * it, and deliberately WITHOUT any effect on past transactions.
 */
export async function removePayerMapping(
  mappingId: string,
  removedBy: string,
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const now = new Date().toISOString()
  const { data, error } = await db()
    .from(TABLE)
    .update({ removed_at: now, removed_by: removedBy, updated_at: now })
    .eq("id", mappingId)
    .is("removed_at", null)
    .select("id")

  if (error) return { ok: false, removed: false, error: error.message }
  return { ok: true, removed: (data ?? []).length > 0 }
}

/** Every live mapping for one payer key. */
export async function listMappingsForKey(source: string, key: PayerKey): Promise<PayerMapping[]> {
  const { data } = await db()
    .from(TABLE)
    .select("id, source, key_type, key_value, display_payer, account_id, contact_id, taught_by, taught_at, taught_via, notes")
    .eq("source", source)
    .eq("key_type", key.key_type)
    .eq("key_value", key.key_value)
    .is("removed_at", null)
    .order("taught_at", { ascending: true })

  return (data ?? []) as PayerMapping[]
}

/** Every live mapping taught for one client — the reverse view a staff screen needs. */
export async function listMappingsForSubject(subject: PayerSubject): Promise<PayerMapping[]> {
  const s = normaliseSubject(subject)
  if (!s) return []
  const q = db()
    .from(TABLE)
    .select("id, source, key_type, key_value, display_payer, account_id, contact_id, taught_by, taught_at, taught_via, notes")
    .is("removed_at", null)
  const { data } = await (s.accountId ? q.eq("account_id", s.accountId) : q.eq("contact_id", s.contactId))
  return (data ?? []) as PayerMapping[]
}

/** A company the same owner also has, offered as a one-click extension. */
export interface SameOwnerCompany {
  accountId: string
  companyName: string
  ownerName: string | null
  /** True when this payer is ALREADY taught for that company — so the UI can show it as done. */
  alreadyTaught: boolean
}

/**
 * The other companies belonging to the owner of this one.
 *
 * Offered as a CONVENIENCE, never applied: extending a payer to a second company is still one
 * deliberate click per company (Antonio's rule — same-owner is not a licence to infer). Real
 * shape it serves: Rodrigo owns two companies and one wire of his settled an invoice for each.
 *
 * ⛔ ROLE MATCHING IS CASE-INSENSITIVE, and that is not fussiness. The role column really holds
 * 'owner', 'Owner', 'member', 'Member' and 'Sole Member', and an exact-case match on this exact
 * column is what broke invoice sending for ADWise in June. Measured: 22 people hold an owner
 * role on more than one company at any status, 12 on more than one that is still live.
 *
 * Cancelled and closed companies are excluded: offering to teach a payer for a dead company is
 * noise on a screen someone is trying to work through quickly.
 */
export async function listSameOwnerCompanies(params: {
  accountId: string
  source: string
  key: PayerKey
}): Promise<SameOwnerCompany[]> {
  const { data: owners } = await db()
    .from("account_contacts")
    .select("contact_id, role, contacts(full_name)")
    .eq("account_id", params.accountId)

  const ownerIds = (owners ?? [])
    .filter((r: { role?: string | null }) => (r.role ?? "").toLowerCase().includes("owner"))
    .map((r: { contact_id: string }) => r.contact_id)

  if (ownerIds.length === 0) return []

  const { data: siblings } = await db()
    .from("account_contacts")
    .select("account_id, contact_id, role, accounts(company_name, status), contacts(full_name)")
    .in("contact_id", ownerIds)

  const alreadyTaught = new Set(
    (await listMappingsForKey(params.source, params.key)).map((m) => m.account_id).filter(Boolean),
  )

  const LIVE = new Set(["Active", "Pending Formation"])
  const out = new Map<string, SameOwnerCompany>()

  for (const row of (siblings ?? []) as Array<{
    account_id: string
    role?: string | null
    accounts?: { company_name?: string | null; status?: string | null } | null
    contacts?: { full_name?: string | null } | null
  }>) {
    if (row.account_id === params.accountId) continue
    if (!(row.role ?? "").toLowerCase().includes("owner")) continue
    const status = row.accounts?.status ?? ""
    if (!LIVE.has(status)) continue
    const name = row.accounts?.company_name
    if (!name) continue
    out.set(row.account_id, {
      accountId: row.account_id,
      companyName: name,
      ownerName: row.contacts?.full_name ?? null,
      alreadyTaught: alreadyTaught.has(row.account_id),
    })
  }

  return Array.from(out.values()).sort((a, b) => a.companyName.localeCompare(b.companyName))
}

export interface TaughtPayerLookup {
  /** Clients a human has taught for this payer. Empty when nothing is known. */
  mappings: PayerMapping[]
  /** The payer identity that was looked up, for logging and display. */
  key: PayerKey | null
  /**
   * Set when live mappings exist but were IGNORED because the payer is now recognised as a
   * payment rail. Surfaced rather than swallowed: it means someone taught something that has
   * since been reclassified, and they should be told.
   */
  suppressedAsProcessor?: boolean
}

/**
 * Who has this payer been taught to pay for?
 *
 * The rail guard runs again HERE, not only at teach time (Antonio's explicit condition): with
 * per-client confirmation replacing the multi-client block, the processor list is the only
 * protection that fires by itself, so adding a rail to it must also disarm mappings taught
 * before that addition.
 */
export async function lookupTaughtClientsForFeed(
  feed: TeachableFeed & { source?: string | null },
): Promise<TaughtPayerLookup> {
  if (feed.status === "outgoing") return { mappings: [], key: null }

  const key = resolvePayerKey(feed)
  if (!key) return { mappings: [], key: null }

  const mappings = await listMappingsForKey(feed.source ?? "manual", key)
  if (mappings.length === 0) return { mappings: [], key }

  if (key.key_type === "descriptor" && isProcessorOnlyDescriptor(feed.sender_name)) {
    return { mappings: [], key, suppressedAsProcessor: true }
  }

  return { mappings, key }
}
