/**
 * SS-4 signer switch — the SINGLE implementation behind "change who signs this
 * SS-4", used by the flow workspace SS-4 card's signer picker.
 *
 * Why this exists (ACE Marketing Group LLC, 2026-08-10): the responsible party on
 * an SS-4 is chosen automatically at creation, and before this change nothing let
 * staff correct it from the workspace. The automatic default is now role-aware
 * (`pickDefaultSs4SignerLink`) but it is still only a DEFAULT — Antonio's ruling:
 *
 *   "The SS-4 responsible party is DECOUPLED FROM OWNERSHIP by design. An SMLLC's
 *    signer can be someone with no ownership at all. Roles are a hint for a
 *    default, never a constraint."
 *
 * So the picker offers EVERY contact linked to the account, whatever their role,
 * and staff may change the signer at any moment before signing — including
 * mid-flow, because clients change their mind mid-job.
 *
 * WHAT A SWITCH DOES (all of it, or none of it):
 *   1. Rewrites the responsible party as a SET — contact_id + name + ITIN + phone.
 *      Never a bare contact_id write: those five values are correlated and the
 *      filled IRS PDF renders the name and tax ID, so a partial write would print
 *      the PREVIOUS person's tax ID under the new person's name.
 *   2. Resets `awaiting_signature` → `draft` (same semantics as the ss4_update MCP
 *      tool), so the client re-reads the corrected form before signing.
 *   3. ROTATES `access_code`, which is what actually retires the link the old
 *      signer already holds. The status reset alone does NOT: the client page
 *      used to promote a draft straight back to awaiting_signature on view, and
 *      nothing refused a signature on a draft. Both are fixed alongside this
 *      (app/ss4/[token]/[code]/page.tsx), and all three are needed together.
 *   4. Repoints the internal SS-4 `documents` row, which is stamped with
 *      contact_id at creation and was never updated — the form would otherwise
 *      stay filed under the wrong contact in the CRM.
 *   5. Keeps `members.is_signer` in step when the picked signer IS a member
 *      (set-true first, then clear others — never a zero-flag state). A
 *      NON-member pick leaves the flags untouched: `refreshSS4` keeps a
 *      non-member party via the `currentPartyIsMember` pick-wins guard, so the
 *      flags are simply not consulted while a non-member is the signer.
 *   6. Clears the old signer's leftovers — the portal chat message (soft-delete,
 *      R100) and the bell alert (marked read; that table has no soft-delete).
 *      Emails already sent cannot be recalled — accepted, out of scope.
 *
 * SIGNED/SUBMITTED SS-4s ARE IMMUTABLE — the client signed that exact document.
 *
 * NOT DONE HERE, deliberately: single-member LLCs still get NO `members` rows
 * (Antonio rejected creating them — SMLLC clients must not see a Members section
 * in the portal). Never "fix" this by materializing SMLLC member rows.
 *
 * `computeSs4SignerSwitch` is PURE so the decision + patch are fully unit-testable;
 * `setSs4Signer` is the DB wrapper.
 */

import { randomBytes } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"

/** The ss4_applications columns the switch reads and may rewrite. */
export interface Ss4SignerSwitchRow {
  id: string
  token: string
  access_code: string
  status: string
  signed_at: string | null
  contact_id: string | null
  company_name: string | null
}

export interface Ss4SwitchContact {
  id: string
  full_name: string | null
  itin_number: string | null
  phone: string | null
}

export type Ss4SignerSwitchDecision =
  /** Signed/submitted — never rewritten. */
  | { kind: "locked"; message: string }
  /** The chosen contact is already the responsible party — nothing to write. */
  | { kind: "unchanged" }
  /** Apply `updates` to the row. */
  | {
      kind: "switch"
      updates: Record<string, unknown>
      /** True when the row was awaiting_signature and is being pulled back to draft. */
      statusReset: boolean
      /** The freshly rotated access code (the old link stops working). */
      newAccessCode: string
      previousContactId: string | null
    }

/** Statuses that still allow a signer change. Anything else is immutable. */
const MUTABLE_STATUSES = new Set(["draft", "awaiting_signature"])

/**
 * Decide the patch for a signer switch. Pure — the caller has already loaded the
 * row and resolved the chosen contact, and is responsible for having verified the
 * contact is linked to the account.
 *
 * `newAccessCode` is injected rather than generated here so the function stays
 * deterministic and testable.
 */
export function computeSs4SignerSwitch(args: {
  ss4: Ss4SignerSwitchRow
  contact: Ss4SwitchContact
  newAccessCode: string
}): Ss4SignerSwitchDecision {
  const { ss4, contact, newAccessCode } = args

  // Signed is signed — check signed_at as well as status, because either alone
  // can lag the other.
  if (ss4.signed_at || !MUTABLE_STATUSES.has(ss4.status)) {
    return {
      kind: "locked",
      message: `The SS-4 for ${ss4.company_name ?? "this company"} is "${ss4.status}" — a signed or submitted SS-4 cannot have its responsible party changed. Create the correction with support.`,
    }
  }

  if (ss4.contact_id === contact.id) return { kind: "unchanged" }

  const statusReset = ss4.status === "awaiting_signature"

  const updates: Record<string, unknown> = {
    contact_id: contact.id,
    responsible_party_name: contact.full_name,
    responsible_party_itin: contact.itin_number || null,
    responsible_party_phone: contact.phone || null,
    // Rotating the code is what retires the link the previous signer holds.
    access_code: newAccessCode,
    updated_at: new Date().toISOString(),
  }
  // Pull an already-sent form back to draft so the client re-reads it. Drafts
  // stay drafts — never silently promote.
  if (statusReset) updates.status = "draft"

  return {
    kind: "switch",
    updates,
    statusReset,
    newAccessCode,
    previousContactId: ss4.contact_id,
  }
}

export type Ss4SetSignerOutcome =
  | "no_ss4"
  | "locked"
  | "not_linked"
  | "no_contact"
  | "unchanged"
  | "switched"
  | "error"

export interface Ss4SetSignerResult {
  ok: boolean
  outcome: Ss4SetSignerOutcome
  message?: string
  ss4?: {
    id: string
    token: string
    access_code: string
    status: string
    responsible_party_name: string | null
    contact_id: string | null
  }
  /** True when an awaiting_signature record was pulled back to draft. */
  statusReset?: boolean
}

/**
 * Change the responsible party on an account's unsigned SS-4.
 *
 * `source` names the trigger for the audit trail (e.g. "flow-ss4-picker").
 */
export async function setSs4Signer(args: {
  account_id: string
  contact_id: string
  source: string
}): Promise<Ss4SetSignerResult> {
  const { account_id, contact_id, source } = args
  try {
    // supabase-js RETURNS errors — distinguish "no row" from "read failed", or a
    // DB hiccup gets reported to staff as the confidently-wrong "No SS-4 exists".
    const { data: ss4Row, error: ss4ReadErr } = await supabaseAdmin
      .from("ss4_applications")
      .select("id, token, access_code, status, signed_at, contact_id, company_name")
      .eq("account_id", account_id)
      .maybeSingle()

    if (ss4ReadErr) {
      return { ok: false, outcome: "error", message: `Could not load the SS-4: ${ss4ReadErr.message}` }
    }
    if (!ss4Row) {
      return { ok: false, outcome: "no_ss4", message: "No SS-4 exists for this account yet." }
    }
    const ss4 = ss4Row as unknown as Ss4SignerSwitchRow

    // The chosen contact MUST be linked to this account. The picker is populated
    // from these same links, so a mismatch means a stale page or a hand-made
    // request — never stamp an unrelated person on a federal filing.
    const { data: link, error: linkReadErr } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", account_id)
      .eq("contact_id", contact_id)
      .maybeSingle()
    if (linkReadErr) {
      return { ok: false, outcome: "error", message: `Could not verify the contact link: ${linkReadErr.message}` }
    }
    if (!link) {
      return {
        ok: false,
        outcome: "not_linked",
        message: "That person is not linked to this company. Refresh the page and try again.",
      }
    }

    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, itin_number, phone")
      .eq("id", contact_id)
      .maybeSingle()
    if (!contact) {
      return { ok: false, outcome: "no_contact", message: "Contact not found." }
    }

    const decision = computeSs4SignerSwitch({
      ss4,
      contact: contact as Ss4SwitchContact,
      newAccessCode: randomBytes(4).toString("hex"),
    })

    if (decision.kind === "locked") {
      return { ok: false, outcome: "locked", message: decision.message, ss4: identity(ss4) }
    }
    if (decision.kind === "unchanged") {
      return { ok: true, outcome: "unchanged", ss4: identity(ss4) }
    }

    // TOCTOU guard: only rewrite while still unsigned — the client may have
    // signed between our read and this write.
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("ss4_applications")
      .update(decision.updates)
      .eq("id", ss4.id)
      .in("status", ["draft", "awaiting_signature"])
      .is("signed_at", null)
      .select("id, token, access_code, status, responsible_party_name, contact_id")

    if (updErr) {
      return { ok: false, outcome: "error", message: `Could not change the signer: ${updErr.message}` }
    }
    if (!updated || updated.length === 0) {
      return {
        ok: false,
        outcome: "locked",
        message: "The SS-4 was signed while the change was being applied — it was left untouched.",
        ss4: identity(ss4),
      }
    }

    // ── Keep members.is_signer in step (accounts that HAVE member rows). ──
    // PICK-WINS SEMANTICS (Antonio, 2026-08-10, council fix): the flag is only
    // meaningful when the picked signer IS a member. Picking a member flips the
    // flag to them (set-true FIRST, then clear the others — a concurrent refresh
    // in the gap sees a transient two-flag state, which BLOCKS rather than
    // silently reverting; never a zero-flag state). Picking a NON-member leaves
    // every flag untouched: refreshSS4's currentPartyIsMember guard now keeps a
    // non-member party without consulting the flags, so clearing them would only
    // destroy information and (on a transient error) recreate the zero-flag
    // livelock. supabase-js RETURNS errors rather than throwing — check them
    // explicitly; a silent sync failure here is how a pick gets undone later.
    const { data: memberRows, error: memberReadErr } = await supabaseAdmin
      .from("members")
      .select("id, contact_id")
      .eq("account_id", account_id)
    if (memberReadErr) {
      console.error("[setSs4Signer] members read failed (sync skipped):", memberReadErr.message)
    } else if (memberRows && memberRows.length > 0) {
      const match = memberRows.find((m) => m.contact_id === contact_id)
      if (match) {
        const { error: setErr } = await supabaseAdmin
          .from("members")
          .update({ is_signer: true, updated_at: new Date().toISOString() })
          .eq("id", match.id)
        if (setErr) {
          console.error("[setSs4Signer] members is_signer set failed:", setErr.message)
        } else {
          const { error: clearErr } = await supabaseAdmin
            .from("members")
            .update({ is_signer: false, updated_at: new Date().toISOString() })
            .eq("account_id", account_id)
            .neq("id", match.id)
          if (clearErr) console.error("[setSs4Signer] members is_signer clear failed:", clearErr.message)
        }
      }
      // No match → non-member pick → flags deliberately untouched.
    }

    // ── Repoint the internal SS-4 documents row at the new signer. ──
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: docErr } = await (supabaseAdmin as any)
        .from("documents")
        .update({ contact_id })
        .eq("account_id", account_id)
        .eq("document_type_name", "SS-4")
      if (docErr) console.error("[setSs4Signer] documents contact repoint failed (non-fatal):", docErr.message)
    }

    // ── Clear the previous signer's leftovers — THIS ACCOUNT ONLY. ──
    // The chat message is soft-deleted (R100 — client-visible content is never
    // hard-deleted); the bell alert is marked read, since portal_notifications
    // has no soft-delete column. Emails already sent cannot be recalled.
    // Scoped by account_id AND (for chat) sender_type='admin': the sign link is
    // the same string for every company, so an unscoped sweep would hide a
    // serial founder's still-valid prompt for their OTHER company — and without
    // the sender filter it would even delete the client's own message quoting
    // the link ("this link errors for me").
    if (decision.previousContactId && decision.previousContactId !== contact_id) {
      const nowIso = new Date().toISOString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: msgErr } = await (supabaseAdmin as any)
        .from("portal_messages")
        .update({ deleted_at: nowIso })
        .eq("account_id", account_id)
        .eq("contact_id", decision.previousContactId)
        .eq("sender_type", "admin")
        .is("deleted_at", null)
        .like("message", "%/portal/sign/ss4%")
      if (msgErr) console.error("[setSs4Signer] old-signer chat cleanup failed (non-fatal):", msgErr.message)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: notifErr } = await (supabaseAdmin as any)
        .from("portal_notifications")
        .update({ read_at: nowIso })
        .eq("account_id", account_id)
        .eq("contact_id", decision.previousContactId)
        .eq("link", "/portal/sign/ss4")
        .is("read_at", null)
      if (notifErr) console.error("[setSs4Signer] old-signer bell cleanup failed (non-fatal):", notifErr.message)
    }

    const row = updated[0]
    // ── THE PICK RECORD — awaited and error-checked, never fire-and-forget. ──
    // refreshSS4 distinguishes an explicit pick from an ORPHANED signer by this
    // row (details.picked_contact_id): if it were lost, the next refresh would
    // treat a legitimate pick as orphaned and revoke the client's signing link.
    // A failed insert is surfaced in the log; the degraded mode is exactly that
    // orphan alert — visible and recoverable via re-picking, never a silent
    // wrong signer.
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: pickLogErr } = await (supabaseAdmin as any).from("action_log").insert({
        actor: "system",
        action_type: "update",
        table_name: "ss4_applications",
        record_id: ss4.id,
        account_id,
        summary:
          `SS-4 responsible party changed to ${row.responsible_party_name ?? contact_id} (${source})` +
          `${decision.statusReset ? " — reset to draft, previous signing link revoked" : " — signing link revoked"}`,
        details: { picked_contact_id: contact_id, source },
      })
      if (pickLogErr) {
        console.error(
          "[setSs4Signer] PICK RECORD insert failed — the next refresh may treat this pick as orphaned (alert+revoke, recoverable):",
          pickLogErr.message,
        )
      }
    }

    return {
      ok: true,
      outcome: "switched",
      statusReset: decision.statusReset,
      ss4: {
        id: row.id,
        token: row.token,
        access_code: row.access_code,
        status: row.status,
        responsible_party_name: row.responsible_party_name,
        contact_id: row.contact_id,
      },
    }
  } catch (err) {
    console.error("[setSs4Signer] error:", err)
    return { ok: false, outcome: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

function identity(row: Ss4SignerSwitchRow) {
  return {
    id: row.id,
    token: row.token,
    access_code: row.access_code,
    status: row.status,
    responsible_party_name: null,
    contact_id: row.contact_id,
  }
}
