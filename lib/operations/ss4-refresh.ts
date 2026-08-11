/**
 * SS-4 in-place refresh — the SINGLE implementation behind every "regenerate the
 * SS-4 from current account/member data" surface, and the auto-refresh hook that
 * fires when member data changes while an unsigned SS-4 exists.
 *
 * Why this exists (AI Venture Labs incident, 2026-07-02): the SS-4 row is a
 * frozen snapshot taken at generation time. Michele Cotti's SS-4 was generated
 * a day BEFORE the member form arrived, so it silently kept the wrong
 * responsible party — and the three CRM surfaces that looked like "regenerate"
 * either did nothing or hid the real refresh behind a failed generate. This
 * module gives all of them (CRM account dialog, flow workspace panel, member
 * write choke-points) one shared, audited refresh path.
 *
 * Rules:
 *  - Signed/submitted SS-4s are LOCKED — never rewritten (the client signed
 *    that exact document).
 *  - The refresh keeps token + access_code, so every link already sent stays
 *    valid; the SS-4 page and PDF render live from the row.
 *  - Status is never changed here. If the signer CHANGES while the record is
 *    already awaiting_signature, the new signer is notified via the standard
 *    action-required rail (dedup built in); drafts stay silent.
 *  - MMLLC with zero/multiple flagged signers → the row is NOT touched and the
 *    caller gets a staff-facing alert (same rule as generation, via
 *    decideSs4Signer — see lib/operations/ss4-signer.ts).
 *  - PICK WINS (Antonio, 2026-08-10): when the stamped responsible party is not
 *    one of the members (an explicit staff pick — the picker offers any linked
 *    contact), the refresh KEEPS the party and skips the member rules entirely:
 *    no re-derivation, no MMLLC block. Bookkeeping bends to the pick, never the
 *    reverse (currentPartyIsMember in ss4-signer.ts).
 *  - Missing RA county never blocks a refresh: the existing Line 6 value is
 *    kept (the send-for-signature gate still enforces it before the client
 *    signs).
 *
 * computeSs4RefreshUpdates is PURE (no DB) so the diff/decision logic is fully
 * unit-testable; refreshSS4 is the thin DB wrapper.
 */

import { randomBytes } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { formatCountyAndState } from "@/lib/addresses"
import { CLIENT_ADDRESS_FALLBACK } from "@/lib/td-address"
import {
  decideSs4Signer,
  ss4SignerAlertMessage,
  currentPartyIsMember,
  type Ss4SignerMember,
} from "@/lib/operations/ss4-signer"

const ENTITY_MAP: Record<string, string> = {
  "SINGLE MEMBER LLC": "SMLLC", "SMLLC": "SMLLC",
  "MULTI-MEMBER LLC": "MMLLC", "MULTI MEMBER LLC": "MMLLC", "MMLLC": "MMLLC",
  "CORPORATION": "Corporation", "CORP": "Corporation", "C-CORP": "Corporation",
}

const STATE_MAP: Record<string, string> = {
  "NEW MEXICO": "NM", "NM": "NM",
  "WYOMING": "WY", "WY": "WY",
  "FLORIDA": "FL", "FL": "FL",
  "DELAWARE": "DE", "DE": "DE",
}

const TD_FALLBACK_STREET = CLIENT_ADDRESS_FALLBACK.street
const TD_FALLBACK_CITY_STATE_ZIP = CLIENT_ADDRESS_FALLBACK.cityStateZip

/** The ss4_applications columns the refresh reads and may rewrite. */
export interface Ss4RowSnapshot {
  id: string
  token: string
  access_code: string
  status: string
  signed_at: string | null
  contact_id: string | null
  company_name: string | null
  entity_type: string | null
  state_of_formation: string | null
  formation_date: string | null
  member_count: number | null
  responsible_party_name: string | null
  responsible_party_itin: string | null
  responsible_party_phone: string | null
  responsible_party_title: string | null
  language: string | null
  county_and_state: string | null
  mailing_street: string | null
  mailing_city_state_zip: string | null
}

export interface Ss4AccountSnapshot {
  company_name: string
  entity_type: string | null
  state_of_formation: string | null
  formation_date: string | null
  physical_address: string | null
  /** Joined addresses row via business_mailing_address_id (nullable). */
  mailing_address: {
    address_line1: string | null
    address_line2: string | null
    city: string | null
    state: string | null
    zip: string | null
  } | null
}

export interface Ss4SignerContact {
  id: string
  full_name: string | null
  itin_number: string | null
  phone: string | null
  language: string | null
}

export type Ss4RefreshComputation =
  /** Recomputed values are identical to the stored row — nothing to write. */
  | { kind: "unchanged" }
  /** Something changed — `updates` is the exact patch to apply. */
  | { kind: "update"; updates: Record<string, unknown>; changed: string[]; signerChanged: boolean }

export function resolveEntityType(raw: string | null | undefined): string {
  return ENTITY_MAP[(raw || "").toUpperCase().trim()] || "SMLLC"
}

export function resolveStateCode(raw: string | null | undefined): string {
  const key = (raw || "").toUpperCase().trim()
  return STATE_MAP[key] || (raw || "")
}

export function resolveMailing(account: Ss4AccountSnapshot): { street: string; cityStateZip: string } {
  const ma = account.mailing_address
  if (ma && (ma.address_line1 || ma.city)) {
    return {
      street: [ma.address_line1, ma.address_line2].filter(Boolean).join(", "),
      cityStateZip: [ma.city, ma.state, ma.zip].filter(Boolean).join(", "),
    }
  }
  if (account.physical_address) {
    const raw = account.physical_address
    const commaIdx = raw.indexOf(",")
    if (commaIdx > -1) {
      return { street: raw.slice(0, commaIdx).trim(), cityStateZip: raw.slice(commaIdx + 1).trim() }
    }
    return { street: raw, cityStateZip: "" }
  }
  return { street: TD_FALLBACK_STREET, cityStateZip: TD_FALLBACK_CITY_STATE_ZIP }
}

/**
 * Build the in-place patch for an unsigned SS-4 from current account/member
 * data. Pure — the caller has already decided the signer and resolved their
 * contact. Pass `signerContact: null` to keep the row's existing responsible
 * party (used when the account has no members rows — never guess a signer).
 * `raCountyAndState: null` keeps the row's existing Line 6 value.
 */
export function computeSs4RefreshUpdates(args: {
  ss4: Ss4RowSnapshot
  account: Ss4AccountSnapshot
  memberCount: number
  signerContact: Ss4SignerContact | null
  raCountyAndState: string | null
}): Ss4RefreshComputation {
  const { ss4, account, memberCount, signerContact, raCountyAndState } = args

  const entityType = resolveEntityType(account.entity_type)
  const state = resolveStateCode(account.state_of_formation)
  const title = entityType === "SMLLC" ? "Owner" : entityType === "MMLLC" ? "Member" : "President"
  const mailing = resolveMailing(account)

  const target: Record<string, unknown> = {
    company_name: account.company_name,
    entity_type: entityType,
    state_of_formation: state,
    formation_date: account.formation_date || null,
    member_count: memberCount,
    // Never degrade Line 6: keep the stored value when the RA county is unknown.
    county_and_state: raCountyAndState ?? ss4.county_and_state,
    mailing_street: mailing.street,
    mailing_city_state_zip: mailing.cityStateZip,
  }

  if (signerContact) {
    target.contact_id = signerContact.id
    target.responsible_party_name = signerContact.full_name
    target.responsible_party_itin = signerContact.itin_number || null
    target.responsible_party_phone = signerContact.phone || null
    target.responsible_party_title = title
    target.language = signerContact.language === "Italian" ? "it" : "en"
  }

  const changed = Object.keys(target).filter(
    (k) => (target[k] ?? null) !== ((ss4 as unknown as Record<string, unknown>)[k] ?? null),
  )
  if (changed.length === 0) return { kind: "unchanged" }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const k of changed) updates[k] = target[k] ?? null

  return {
    kind: "update",
    updates,
    changed,
    signerChanged: changed.includes("contact_id"),
  }
}

export type Ss4RefreshOutcome =
  | "no_ss4"        // no SS-4 for the account — nothing to refresh
  | "locked"        // signed/submitted — must never be rewritten
  | "needs_signer"  // MMLLC with ≠1 flagged signer — row untouched, staff alert in `message`
  | "orphaned_signer" // party was member-derived but the member is gone/repointed — link revoked, staff alert in `message`
  | "no_signer_contact" // decided signer has no resolvable contact — row untouched
  | "unchanged"     // recomputed values identical — no write
  | "refreshed"     // row updated in place (same token/link)
  | "error"

export interface Ss4RefreshResult {
  ok: boolean
  outcome: Ss4RefreshOutcome
  /** Staff-facing detail (signer alert, block reason, error). */
  message?: string
  /** Column names that changed (refreshed only). */
  changed?: string[]
  /** True when the responsible party contact changed (refreshed only). */
  signerChanged?: boolean
  ss4?: {
    id: string
    token: string
    access_code: string
    status: string
    company_name: string | null
    entity_type: string | null
    responsible_party_name: string | null
  }
}

/**
 * Refresh the account's unsigned SS-4 in place from current account/member
 * data. Safe to fire-and-forget from member-data choke points: it never
 * throws, and every outcome that needs staff eyes is logged to action_log.
 *
 * `source` names the trigger for the audit trail (e.g. "member-info-form",
 * "crm-members-edit", "crm-regenerate", "flow-regenerate").
 */
export async function refreshSS4(args: {
  account_id: string
  source: string
  /** Notify the (new) signer when the signer changes on an awaiting_signature SS-4. Default true. */
  notify?: boolean
}): Promise<Ss4RefreshResult> {
  const { account_id, source, notify = true } = args
  try {
    // supabase-js RETURNS errors — distinguish "no row" from "read failed", or a
    // transient DB failure tells staff "No SS-4 exists — use Generate" (council
    // minor, 2026-08-11; same fix already applied in setSs4Signer).
    const { data: ss4, error: ss4ReadErr } = await supabaseAdmin
      .from("ss4_applications")
      .select(
        "id, token, access_code, status, signed_at, contact_id, company_name, entity_type, state_of_formation, formation_date, member_count, responsible_party_name, responsible_party_itin, responsible_party_phone, responsible_party_title, language, county_and_state, mailing_street, mailing_city_state_zip",
      )
      .eq("account_id", account_id)
      .maybeSingle()

    if (ss4ReadErr) {
      return { ok: false, outcome: "error", message: `Could not load the SS-4: ${ss4ReadErr.message}` }
    }
    if (!ss4) return { ok: true, outcome: "no_ss4" }

    const row = ss4 as unknown as Ss4RowSnapshot
    const unsigned = !row.signed_at && (row.status === "draft" || row.status === "awaiting_signature")
    if (!unsigned) {
      return {
        ok: false,
        outcome: "locked",
        message: `SS-4 ${row.token} is "${row.status}" — a signed or submitted SS-4 cannot be regenerated. Create the correction manually with support.`,
        ss4: identity(row),
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: account } = await (supabaseAdmin as any)
      .from("accounts")
      .select(
        "id, company_name, entity_type, state_of_formation, formation_date, physical_address, registered_agent_id, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)",
      )
      .eq("id", account_id)
      .single()

    if (!account) {
      return { ok: false, outcome: "error", message: "Account not found." }
    }

    const entityType = resolveEntityType(account.entity_type)

    const { data: membersRows } = await supabaseAdmin
      .from("members")
      .select(
        "id, member_type, full_name, company_name, contact_id, representative_name, representative_email, is_primary, is_signer",
      )
      .eq("account_id", account_id)
      .order("is_signer", { ascending: false })
      .order("is_primary", { ascending: false })

    const members = (membersRows ?? []) as Ss4SignerMember[]

    // ── Decide the signer (shared rule — same as generation) ──
    // PICK-WINS GUARD, refined (Antonio, 2026-08-10/11): when the stamped
    // responsible party is not MEMBER-DERIVED, it is either an EXPLICIT STAFF
    // PICK (keep it — never re-derive, never block on the MMLLC flag rules) or
    // an ORPHANED signer (a member who was deleted or whose contact was
    // repointed): "a deleted or repointed member on the form triggers a staff
    // alert and revokes their live link, never a silent keep labeled as a
    // choice."
    //
    // The two are distinguished by the PICK RECORD: setSs4Signer writes an
    // awaited action_log row with details.picked_contact_id at every explicit
    // pick. Party matches a pick record → keep. No pick record → orphaned →
    // rotate the access code (kills their live link), pull an awaiting record
    // back to draft, alert staff, and refuse the refresh until someone picks.
    //
    // "Member-derived" resolves COMPANY members through their representative:
    // a company-type member's rep contact counts as member-derived, so flag
    // changes keep propagating to it until someone actually picks (Antonio's
    // explicit rule — the rep was auto-derived at generation, not picked).
    //
    // Failure posture: if the pick-record READ fails, treat the party as
    // picked (keep). An infrastructure hiccup must never revoke a client's
    // signing link; the worst case of failing open here is one extra refresh
    // keeping the current name — visible, recoverable, never a silent swap.
    let signerContact: Ss4SignerContact | null = null
    let keptExplicitPick = false

    let partyIsMemberDerived = currentPartyIsMember(members, row.contact_id)
    if (!partyIsMemberDerived && row.contact_id && members.length > 0) {
      const repEmails = members
        .filter((m) => m.member_type === "company" && !m.contact_id && m.representative_email)
        .map((m) => m.representative_email as string)
      if (repEmails.length > 0) {
        const { data: repRows } = await supabaseAdmin
          .from("contacts")
          .select("id, email")
          .in("email", repEmails)
        if (repRows?.some((r) => r.id === row.contact_id)) partyIsMemberDerived = true
      }
    }

    if (members.length > 0 && !partyIsMemberDerived && row.contact_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pickRows, error: pickErr } = await (supabaseAdmin as any)
        .from("action_log")
        .select("id")
        .eq("table_name", "ss4_applications")
        .eq("record_id", row.id)
        .eq("details->>picked_contact_id", row.contact_id)
        .limit(1)

      const isExplicitPick = pickErr ? true : !!(pickRows && pickRows.length > 0)
      if (pickErr) {
        console.error("[refreshSS4] pick-record read failed — failing open (keeping party):", pickErr.message)
      }

      if (isExplicitPick) {
        keptExplicitPick = true
        // fall through with signerContact = null (keep party)
      } else {
        // ── ORPHANED SIGNER ──
        const revokedCode = randomBytes(4).toString("hex")
        const { error: revokeErr } = await supabaseAdmin
          .from("ss4_applications")
          .update({ access_code: revokedCode, status: "draft", updated_at: new Date().toISOString() })
          .eq("id", row.id)
          .in("status", ["draft", "awaiting_signature"])
          .is("signed_at", null)
        const who = row.responsible_party_name || "the previous signer"
        const message = [
          `The SS-4's responsible party (${who}) is no longer one of this company's members — the member was removed or their contact was changed.`,
          revokeErr
            ? `⚠️ Their signing link could NOT be revoked automatically (${revokeErr.message}) — revoke it by changing the signer now.`
            : `Their signing link has been revoked and the SS-4 returned to draft.`,
          `Pick the correct responsible party on the SS-4 card (any linked contact), or fix the Members section, then regenerate.`,
        ].join(" ")
        await logAction({
          action_type: "update",
          table_name: "ss4_applications",
          record_id: row.id,
          account_id,
          summary: `SS-4 refresh BLOCKED (${source}): responsible party (${who}) orphaned by a member change — link revoked, staff must pick a signer`,
        })
        return { ok: false, outcome: "orphaned_signer", message, ss4: { ...identity(row), status: revokeErr ? row.status : "draft", access_code: revokeErr ? row.access_code : revokedCode } }
      }
    } else {
    const decision = decideSs4Signer(members, entityType)

    if (decision.kind === "needs_signer") {
      const message = ss4SignerAlertMessage(members, decision.signerCount)
      await logAction({
        action_type: "update",
        table_name: "ss4_applications",
        record_id: row.id,
        account_id,
        summary: `SS-4 refresh SKIPPED (${source}): MMLLC has ${decision.signerCount} flagged signer(s) — fix the Members section`,
      })
      return { ok: false, outcome: "needs_signer", message, ss4: identity(row) }
    }

    if (decision.kind === "use_member") {
      const m = decision.member
      let signerContactId = m.contact_id ?? null
      if (!signerContactId && m.member_type === "company" && m.representative_email) {
        const { data: repC } = await supabaseAdmin
          .from("contacts")
          .select("id")
          .eq("email", m.representative_email)
          .maybeSingle()
        signerContactId = repC?.id ?? null
      }
      if (!signerContactId) {
        const who = m.member_type === "company" ? m.company_name || "the company member" : m.full_name || "the member"
        const message = `Cannot refresh the SS-4: the flagged signer (${who}) has no linked contact. Link a contact (or set the representative email to an existing contact) in the Members section, then retry.`
        await logAction({
          action_type: "update",
          table_name: "ss4_applications",
          record_id: row.id,
          account_id,
          summary: `SS-4 refresh SKIPPED (${source}): flagged signer has no resolvable contact`,
        })
        return { ok: false, outcome: "no_signer_contact", message, ss4: identity(row) }
      }
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name, itin_number, phone, language")
        .eq("id", signerContactId)
        .single()
      if (!contact) {
        return { ok: false, outcome: "no_signer_contact", message: `Signer contact ${signerContactId} not found.`, ss4: identity(row) }
      }
      signerContact = contact as Ss4SignerContact
    }
    // decision.kind === "no_members" → signerContact stays null: keep the row's
    // existing responsible party (never guess), refresh account fields only.
    }

    // ── Member count ──
    let memberCount: number
    if (entityType === "SMLLC") {
      memberCount = 1
    } else if (members.length > 0) {
      memberCount = Math.max(members.length, 2)
    } else {
      memberCount = Math.max(row.member_count ?? 2, 2)
    }

    // ── Line 6 from the Registered Agent (never blocks — keeps existing on miss) ──
    let raCountyAndState: string | null = null
    if (account.registered_agent_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: raAddress } = await (supabaseAdmin as any)
        .from("addresses")
        .select("county, state")
        .eq("id", account.registered_agent_id)
        .single()
      if (raAddress?.county) {
        raCountyAndState = formatCountyAndState(raAddress.county, raAddress.state)
      }
    }

    const computation = computeSs4RefreshUpdates({
      ss4: row,
      account: account as Ss4AccountSnapshot,
      memberCount,
      signerContact,
      raCountyAndState,
    })

    // Staff-facing note whenever an explicit pick was honoured — surfaced by
    // the members panels so a "Set as signer" click that DIDN'T move the SS-4
    // is never a silent no-op (council major, 2026-08-11).
    const keptPickMessage = keptExplicitPick
      ? `The SS-4's responsible party (${row.responsible_party_name || "the picked signer"}) was chosen explicitly and was kept — member flag changes don't affect it. Use the signer picker on the SS-4 card to change it.`
      : undefined

    if (computation.kind === "unchanged") {
      // No write → no audit row (the kept-pick note travels in the response).
      return { ok: true, outcome: "unchanged", message: keptPickMessage, ss4: identity(row) }
    }

    // TOCTOU guard: only rewrite while still unsigned (the client may have
    // signed between our read and this write).
    const { data: updatedRows, error: updErr } = await supabaseAdmin
      .from("ss4_applications")
      .update(computation.updates)
      .eq("id", row.id)
      .in("status", ["draft", "awaiting_signature"])
      .is("signed_at", null)
      .select("id")

    if (updErr) {
      return { ok: false, outcome: "error", message: `Refresh failed: ${updErr.message}` }
    }
    if (!updatedRows || updatedRows.length === 0) {
      return {
        ok: false,
        outcome: "locked",
        message: `SS-4 ${row.token} was signed while the refresh was running — left untouched.`,
        ss4: identity(row),
      }
    }

    await logAction({
      action_type: "update",
      table_name: "ss4_applications",
      record_id: row.id,
      account_id,
      summary: `Refreshed SS-4 for ${account.company_name} from account data (${source}) — fields: ${computation.changed.join(", ")}; same token, link unchanged${keptExplicitPick ? "; kept explicitly picked non-member responsible party — members flags not consulted" : ""}`,
    })

    // Signer changed while the client-facing invite is out → tell the NEW
    // signer (standard action-required rail; 10-min dedup lives inside).
    // Drafts stay silent — staff send them explicitly.
    if (notify && computation.signerChanged && row.status === "awaiting_signature") {
      try {
        const { notifySs4ReadyToSign } = await import("@/lib/portal/action-required")
        await notifySs4ReadyToSign({ ss4Id: row.id })
      } catch (notifyErr) {
        console.error("[refreshSS4] signer-change notification failed:", notifyErr)
      }
    }

    const refreshed = computation.updates as Record<string, unknown>
    return {
      ok: true,
      outcome: "refreshed",
      message: keptPickMessage,
      changed: computation.changed,
      signerChanged: computation.signerChanged,
      ss4: {
        id: row.id,
        token: row.token,
        access_code: row.access_code,
        status: row.status,
        company_name: (refreshed.company_name as string | undefined) ?? row.company_name,
        entity_type: (refreshed.entity_type as string | undefined) ?? row.entity_type,
        responsible_party_name:
          (refreshed.responsible_party_name as string | undefined) ?? row.responsible_party_name,
      },
    }
  } catch (err) {
    console.error("[refreshSS4] error:", err)
    return { ok: false, outcome: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

function identity(row: Ss4RowSnapshot) {
  return {
    id: row.id,
    token: row.token,
    access_code: row.access_code,
    status: row.status,
    company_name: row.company_name,
    entity_type: row.entity_type,
    responsible_party_name: row.responsible_party_name,
  }
}
