/**
 * Company suites — the ONE place application code talks to the suite lock.
 *
 * Rules (Antonio 2026-09-30, enforced by the DATABASE in
 * scripts/migrations/20260930-2000-suite-lock.sql — this file is only the client):
 *  - A suite belongs to a COMPANY (never a person): one company = one suite, one suite = one company.
 *  - Format "3D-NNN": "3D" is our Largo office, NNN is the client's space.
 *  - It is issued ONCE, at the start of formation (payment confirmed) / onboarding, by the allocator
 *    (next free number, under a lock) — nothing else creates a number.
 *  - Once assigned it is locked. The only way to change it or to delete a lease is the logged admin
 *    functions below.
 *
 * Every read of "what is this company's suite" goes through getCompanySuite(); every lease,
 * renewal, SS-4, Operating Agreement, invoice, portal page and CRM screen shows THAT value.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

/** Our Largo office street line (the suite is appended). */
export const TD_LARGO_STREET = "10225 Ulmerton Rd"
export const TD_LARGO_CITY_STATE_ZIP = "Largo, FL 33771"

/**
 * Canonical form of a suite typed by staff: "3D-318". Accepts "3d318", "3D 318",
 * "Suite 3D-318"; returns null for anything else (the caller rejects it).
 */
export function normalizeSuiteNumber(input: string | null | undefined): string | null {
  const m = /^\s*(?:suite\s*)?3D\s*-?\s*(\d{2,4})\s*$/i.exec(input ?? "")
  return m ? `3D-${parseInt(m[1], 10).toString().padStart(3, "0")}` : null
}

/** "3D-318" -> 318. Anything not shaped like a numbered TD suite -> null. */
export function suiteNumericPart(suite: string | null | undefined): number | null {
  const m = /^\s*3D-(\d+)\s*$/i.exec(suite ?? "")
  return m ? parseInt(m[1], 10) : null
}

/** "10225 Ulmerton Rd, Suite 3D-318, Largo, FL 33771" */
export function largoAddressForSuite(suite: string): string {
  return `${TD_LARGO_STREET}, Suite ${suite}, ${TD_LARGO_CITY_STATE_ZIP}`
}

// ─── database function calls ────────────────────────────────────────────────

type RpcResult = { data: unknown; error: { message: string } | null }
type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>

function rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  return (supabaseAdmin as unknown as { rpc: RpcFn }).rpc(fn, args)
}

/** Turn a database lock message into something staff can read (drop the driver prefix). */
function cleanMessage(msg: string): string {
  return msg.replace(/^[\s\S]*?(Suite |This |The |A |Lease |Invalid |account )/, "$1").trim()
}

/** The company's suite (accounts.suite_number), or null if it has none yet. */
export async function getCompanySuite(accountId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("suite_number")
    .eq("id", accountId)
    .maybeSingle()
  if (error) throw new Error(`Could not read the company's suite: ${error.message}`)
  return normalizeSuiteNumber((data as { suite_number?: string | null } | null)?.suite_number) ?? null
}

/**
 * Issue (or return) the company's suite. Idempotent: a company that already has one gets it back.
 * With only a deliveryId (a formation with no company row yet) the suite is RESERVED on the
 * delivery and moved onto the company when it is created. Throws on any failure — a failed
 * allocation must never look like "no suite needed".
 */
export async function allocateCompanySuite(opts: {
  accountId?: string | null
  deliveryId?: string | null
  actor?: string
}): Promise<string> {
  if (!opts.accountId && !opts.deliveryId) {
    throw new Error("allocateCompanySuite needs an accountId or a deliveryId")
  }
  const { data, error } = await rpc("allocate_company_suite", {
    p_account_id: opts.accountId ?? null,
    p_delivery_id: opts.deliveryId ?? null,
    p_actor: opts.actor ?? "system",
  })
  if (error || typeof data !== "string") {
    throw new Error(`Could not issue a suite: ${cleanMessage(error?.message ?? "no suite returned")}`)
  }
  return data
}

/** A delivery that never produced a company (cancelled): free its reserved suite (never reused). */
export async function releaseSuiteReservation(deliveryId: string, actor = "system"): Promise<string | null> {
  const { data, error } = await rpc("release_suite_reservation", { p_delivery_id: deliveryId, p_actor: actor })
  if (error) throw new Error(`Could not release the reserved suite: ${cleanMessage(error.message)}`)
  return typeof data === "string" ? data : null
}

/**
 * Place an EXISTING client that already has a known suite (explicit, logged). The database refuses
 * a suite that belongs to another company, or a company that already has a different suite.
 */
export async function assignSpecificCompanySuite(accountId: string, suite: string, actor = "system"): Promise<string> {
  const normalized = normalizeSuiteNumber(suite)
  if (!normalized) throw new Error(`"${suite}" is not a valid suite — it must look like 3D-318.`)
  const { data, error } = await rpc("assign_specific_company_suite", {
    p_account_id: accountId,
    p_suite: normalized,
    p_actor: actor,
  })
  if (error || typeof data !== "string") {
    throw new Error(cleanMessage(error?.message ?? "Could not assign the suite"))
  }
  return data
}

export interface AdminChangeResult {
  changed: boolean
  old?: string | null
  new?: string | null
  suite?: string | null
  unsigned_leases_moved?: number
  signed_leases_to_replace?: number
}

/**
 * The ONLY way to change or remove a company's suite once assigned (admin, logged, reason required).
 * newSuite = null takes the suite off the company (released, never reused). Unsigned leases follow
 * the new suite; SIGNED leases are left alone and counted in signed_leases_to_replace so the caller
 * deletes + reissues them with adminDeleteLease.
 */
export async function adminChangeCompanySuite(opts: {
  accountId: string
  newSuite: string | null
  reason: string
  actor: string
}): Promise<AdminChangeResult> {
  const normalized = opts.newSuite === null ? null : normalizeSuiteNumber(opts.newSuite)
  if (opts.newSuite !== null && !normalized) {
    throw new Error(`"${opts.newSuite}" is not a valid suite — it must look like 3D-318.`)
  }
  const { data, error } = await rpc("admin_change_company_suite", {
    p_account_id: opts.accountId,
    p_new_suite: normalized,
    p_reason: opts.reason,
    p_actor: opts.actor,
  })
  if (error || !data) throw new Error(cleanMessage(error?.message ?? "Could not change the suite"))
  return data as AdminChangeResult
}

export interface AdminDeleteLeaseResult {
  deleted: boolean
  status: string
  suite: string | null
  account_id: string
  token: string
}

/** Delete a lease of any status (admin, logged, reason required); a full copy is kept in the audit log. */
export async function adminDeleteLease(opts: { leaseId: string; reason: string; actor: string }): Promise<AdminDeleteLeaseResult> {
  const { data, error } = await rpc("admin_delete_lease", {
    p_lease_id: opts.leaseId,
    p_reason: opts.reason,
    p_actor: opts.actor,
  })
  if (error || !data) throw new Error(cleanMessage(error?.message ?? "Could not delete the lease"))
  return data as AdminDeleteLeaseResult
}

/**
 * Keep accounts.physical_address (what the Operating Agreement prints) in step with the company's
 * suite. Only writes when the address is empty or is one our own lease flow wrote before
 * ("10225 Ulmerton Rd…") — a manually entered address is never clobbered. Best-effort: never throws.
 */
export async function syncPhysicalAddressToSuite(accountId: string, suite: string): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("accounts")
      .select("physical_address")
      .eq("id", accountId)
      .maybeSingle()
    const current = ((data as { physical_address?: string | null } | null)?.physical_address ?? "").trim()
    if (current === "" || current.toLowerCase().startsWith(TD_LARGO_STREET.toLowerCase())) {
      await supabaseAdmin
        .from("accounts")
        .update({ physical_address: largoAddressForSuite(suite) })
        .eq("id", accountId)
    }
  } catch {
    // best-effort
  }
}
