/**
 * Resolve the ONE contact authorized to sign a single-signer document
 * (Lease, SS-4, OA header fields) for an account.
 *
 * Reuses the SS-4 responsible-party rules (lib/operations/ss4-signer.ts) —
 * the same members.is_signer flag, decoupled from ownership %, decides who
 * signs. Antonio confirmed this equivalence live to a client (Prowave LLC,
 * 2026-08-17 portal chat): "non sono le percentuali che definiscno il potere
 * di firma. tu sei censito come signer della Prowave, anche l'EIN è a tuo
 * nome." ("Ownership % doesn't decide signing power. You're recorded as
 * signer, and the EIN is in your name too.")
 *
 * Why this exists (dev job 9ad76300-6181-4250-a1de-c77f37933f82, 2026-08-18): lib/operations/lease.ts's
 * createLease() picked the tenant contact via an UNORDERED
 * account_contacts.limit(1) query — the same defect class already fixed for
 * SS-4 (ACE Marketing Group / AI Venture Labs incidents) — and put a
 * company-member's representative (Marco Pasetto, 99% via Indaco LTD) on a
 * signed Prowave LLC lease instead of its flagged individual signer (Matteo
 * Mangili, 1%, also the EIN responsible party). Council review found the
 * SAME broken pick independently duplicated at more lease- and OA-creation
 * call sites, so this is a single shared primitive rather than a patch
 * inside one of them — every call site that wants "who signs for this
 * company" imports THIS.
 *
 * Deliberately NOT merged into app/api/crm/admin-actions/generate-document.ts
 * ::fetchAccountAndContact — that helper is also used by generateOA, and for
 * an SMLLC its first linked contact is the OA's legally-named sole Member; a
 * role-aware change there would silently rename the OA member (2026-08-10
 * council fix note). This module only ever supplies the signer.
 *
 * 2026-08-19 fixes, found by a pre-ship Bug-Hunter + QA-Tester pass
 * (Antonio's explicit "fix everything before shipping" call):
 *   - An individual member flagged as signer with no `contact_id` but a real
 *     `email` on the member row used to block instead of resolving — the
 *     representative-email fallback below was gated to company members only,
 *     but `members.email` is a real column on individual rows too
 *     (formation-materialize.ts writes it unconditionally). 6 real, active
 *     accounts hit this today. Fixed: the fallback now applies to ANY member
 *     type once contact_id is absent, keyed on whichever email field that
 *     member actually has (representative_email for a company, email for an
 *     individual).
 *   - `entityType` was decided from `entity_type` text alone. The portal's
 *     own OA route additionally treats `member_structure === 'multi_member'`
 *     as multi-member (catches non-LLC multi-owner shapes like a C-Corp
 *     Elected with several owners — 5 real accounts). This resolver now uses
 *     the same two-part test, so it can never disagree with the screen that
 *     already relies on it.
 *   - The account-scoped and unscoped email lookups discarded their Supabase
 *     error, so two contacts sharing one email (a real, if latent, data
 *     shape — 8 emails/16 rows in production) silently read as "no match"
 *     instead of "ambiguous." Now a real lookup error blocks with a message
 *     that names the problem, instead of falling through to a misleading
 *     "no contact on file."
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { normalizeEntityType, isMultiMemberEntity } from "@/lib/portal/entity-type"
import {
  decideSs4Signer,
  pickDefaultSs4SignerLink,
  type Ss4SignerMember,
  type Ss4SignerLink,
} from "@/lib/operations/ss4-signer"

export interface ResolvedSignerContact {
  id: string
  full_name: string
  email: string | null
  phone?: string | null
  residency?: string | null
  language?: string | null
  itin_number?: string | null
}

export type ResolveAccountSignerResult =
  /** A definite signer contact was found. */
  | { outcome: "resolved"; contact: ResolvedSignerContact }
  /**
   * A Multi-Member LLC has zero or more than one member flagged is_signer,
   * the flagged member has no resolvable contact, or a lookup came back
   * ambiguous (two contacts share one email). Mirrors decideSs4Signer's
   * "needs_signer" block — never guess.
   */
  | { outcome: "blocked"; message: string }
  /** No linked contact at all (nobody to name). */
  | { outcome: "not_found"; message: string }

type MemberRow = Ss4SignerMember & { email?: string | null }

/** Escape LIKE/ILIKE wildcards so a raw email can't be misread as a pattern. */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`)
}

/**
 * Look up a contact by email, preferring one already linked to THIS account
 * via account_contacts. An email is sometimes shared across more than one
 * client relationship (e.g. a CPA/registered-agent contact, or a duplicate
 * contact record for the same real person); an unscoped match could resolve
 * to a different client's contact, and either query could come back
 * ambiguous (2+ rows) rather than empty. Both are surfaced as errors, never
 * silently swallowed into "no match" — an ambiguous lookup must block, not
 * guess which of two contacts is the real one.
 *
 * Matches after trim + lowercase on BOTH sides (dev job 9ad76300-6181-4250-a1de-c77f37933f82, second
 * pass): a real active account (Diendei LLC) has a leading space on its
 * members.email row (" art@diendei.com" vs the contact's clean
 * "art@diendei.com") and a plain .eq() silently reads that as "no match" —
 * exactly the "misleading no-contact-on-file" failure this resolver exists
 * to prevent. .ilike() with an escaped, %-wrapped pattern finds candidates
 * regardless of surrounding whitespace/case; the real equality check (and
 * the ambiguity count) still happens in JS after normalizing both sides, so
 * this can only ever narrow correctly, never fuzzy-match a different email.
 */
async function findContactByEmailScopedToAccount(
  accountId: string,
  email: string,
): Promise<{ contactId: string | null; ambiguous?: boolean }> {
  const target = email.trim().toLowerCase()
  const pattern = `%${escapeLikePattern(target)}%`

  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id")
    .eq("account_id", accountId)

  const linkedIds = (links ?? []).map((l) => l.contact_id as string)
  if (linkedIds.length > 0) {
    const { data: scoped, error: scopedErr } = await supabaseAdmin
      .from("contacts")
      .select("id, email")
      .in("id", linkedIds)
      .ilike("email", pattern)
    if (scopedErr) return { contactId: null, ambiguous: true }
    const scopedMatches = (scoped ?? []).filter((c) => c.email?.trim().toLowerCase() === target)
    if (scopedMatches.length > 1) return { contactId: null, ambiguous: true }
    if (scopedMatches.length === 1) return { contactId: scopedMatches[0].id }
  }

  const { data: unscoped, error: unscopedErr } = await supabaseAdmin
    .from("contacts")
    .select("id, email")
    .ilike("email", pattern)
  if (unscopedErr) return { contactId: null, ambiguous: true }
  const unscopedMatches = (unscoped ?? []).filter((c) => c.email?.trim().toLowerCase() === target)
  if (unscopedMatches.length > 1) return { contactId: null, ambiguous: true }
  return { contactId: unscopedMatches[0]?.id ?? null }
}

async function fetchFullContact(contactId: string): Promise<ResolvedSignerContact | null> {
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, email, phone, residency, language, itin_number")
    .eq("id", contactId)
    .maybeSingle()
  return data ?? null
}

export async function resolveAccountSigner(accountId: string): Promise<ResolveAccountSignerResult> {
  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, entity_type, member_structure")
    .eq("id", accountId)
    .maybeSingle()
  if (accErr) return { outcome: "not_found", message: accErr.message }
  if (!account) return { outcome: "not_found", message: `Account ${accountId} not found` }

  // Shared classification (lib/portal/entity-type.ts::isMultiMemberEntity) —
  // catches a multi-owner shape (e.g. a multi-member C-Corp election) that
  // the raw entity_type text alone would normalize away from MMLLC. Every
  // OTHER call site that decides "build a member roster" must use the SAME
  // function, or the signer resolves correctly while the document itself
  // still gets built as single-member (dev job 9ad76300-6181-4250-a1de-c77f37933f82, second pass).
  const entityType = isMultiMemberEntity(account.entity_type, account.member_structure)
    ? "MMLLC"
    : normalizeEntityType(account.entity_type)

  const { data: membersRows, error: membersErr } = await supabaseAdmin
    .from("members")
    .select("member_type, full_name, company_name, contact_id, representative_name, representative_email, email, is_primary, is_signer")
    .eq("account_id", accountId)
    .order("is_signer", { ascending: false })
    .order("is_primary", { ascending: false })
  // A discarded error here reads identically to "genuinely zero member
  // rows" (decideSs4Signer's no_members branch), which for a REAL
  // Multi-Member LLC would bypass the MMLLC blocking rule entirely and pick
  // a signer from account_contacts instead — never guess on a DB failure
  // (Bug-Hunter, dev job 9ad76300-6181-4250-a1de-c77f37933f82, third pass).
  if (membersErr) {
    return { outcome: "blocked", message: `Cannot determine who signs for ${account.company_name}: could not read the Members section (${membersErr.message}). Try again.` }
  }

  const decision = decideSs4Signer(membersRows as MemberRow[] | null, entityType)

  if (decision.kind === "needs_signer") {
    const flagged = decision.signerCount === 0 ? "no" : `${decision.signerCount}`
    return {
      outcome: "blocked",
      message: `Cannot determine who signs for ${account.company_name}: this is a Multi-Member LLC with ${decision.memberCount} members and ${flagged} signer${decision.signerCount === 1 ? "" : "s"} flagged. Flag exactly one member as the signer in the Members section, then try again.`,
    }
  }

  if (decision.kind === "use_member") {
    const m = decision.member as MemberRow
    let contactId = m.contact_id ?? null
    if (!contactId) {
      const fallbackEmail = m.member_type === "company" ? m.representative_email : m.email
      if (fallbackEmail) {
        const found = await findContactByEmailScopedToAccount(accountId, fallbackEmail)
        if (found.ambiguous) {
          return {
            outcome: "blocked",
            message: `Cannot determine who signs for ${account.company_name}: more than one contact shares the email on file for the flagged signer. Resolve the duplicate contact before generating.`,
          }
        }
        contactId = found.contactId
      }
    }
    if (!contactId) {
      const who = m.member_type === "company" ? (m.company_name || "the company member") : (m.full_name || "the flagged member")
      return {
        outcome: "blocked",
        message: `Cannot determine who signs for ${account.company_name}: ${who} has no linked contact or representative on file.`,
      }
    }
    const contact = await fetchFullContact(contactId)
    if (!contact) {
      return { outcome: "blocked", message: `Cannot determine who signs for ${account.company_name}: resolved contact ${contactId} was not found.` }
    }
    return { outcome: "resolved", contact }
  }

  // decision.kind === "no_members" — SMLLC / legacy: role-aware default over
  // account_contacts, same as SS-4's default pick. Never blocks.
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role")
    .eq("account_id", accountId)

  const picked = pickDefaultSs4SignerLink(links as Ss4SignerLink[] | null)
  if (!picked) {
    return { outcome: "not_found", message: `No contact linked to account ${account.company_name}. Link a contact first.` }
  }

  const contact = await fetchFullContact(picked.contact_id)
  if (!contact) {
    return { outcome: "not_found", message: `Contact ${picked.contact_id} not found` }
  }
  return { outcome: "resolved", contact }
}
