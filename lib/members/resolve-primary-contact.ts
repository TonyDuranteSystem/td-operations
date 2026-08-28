/**
 * Resolve the ONE contact who is this account's primary/main point of
 * contact — for display and diagnostic purposes (portal tier, offer lookup,
 * lead/activation matching), NOT for "who signs documents" (that is a
 * deliberately separate flag — see resolveAccountSigner in resolve-signer.ts;
 * `members.is_primary` and `members.is_signer` are independent columns and
 * can be different people on the same account).
 *
 * Why this exists (2026-08-27, dev job bb48eba1): every consumer that needed
 * "the primary contact" on an account used to hand-roll its own guess over
 * `account_contacts.is_primary` — a column that is reliably set for only a
 * fraction of Multi-Member LLCs (confirmed live: 45 of 50 accounts that HAVE
 * a `members` row have it correctly flagged there; `account_contacts` itself
 * is essentially never populated for these). The real, current answer for a
 * multi-member account lives on the `members` table, kept up to date by the
 * Members panel — the same source `resolveAccountSigner` already trusts for
 * "who signs". This resolver checks THAT first, and only falls back to the
 * old `account_contacts` guess for accounts with no `members` rows at all
 * (overwhelmingly Single-Member LLCs, where the ambiguity this exists to fix
 * rarely arises since there is usually exactly one contact anyway).
 *
 * Confirmed real-world case: Digital Fastlane LLC (Angelo Capalbo Ghelli,
 * correctly flagged `members.is_primary=true`; Patrizia Capalbo, a co-member,
 * is not) — the old guess picked Patrizia via alphabetical tiebreak on
 * `account_contacts`, producing false "no portal access" warnings for a
 * client who has always had it.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { findContactByEmailScopedToAccount } from "@/lib/members/resolve-signer"

export interface ResolvedPrimaryContact {
  id: string
  full_name: string
  email: string | null
  portal_tier: string | null
  portal_role: string | null
}

export type ResolvePrimaryContactResult =
  | { outcome: "resolved"; contact: ResolvedPrimaryContact; source: "members" | "account_contacts" }
  | { outcome: "not_found" }

async function fetchContact(contactId: string): Promise<ResolvedPrimaryContact | null> {
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, email, portal_tier, portal_role")
    .eq("id", contactId)
    .maybeSingle()
  return (data as ResolvedPrimaryContact | null) ?? null
}

/** Same tiebreak diagnose-account already used, lifted here as the fallback
 *  for accounts with no `members` rows (mostly Single-Member LLCs, where
 *  there is normally only one contact and this rarely matters): is_primary
 *  flag → owner-ish role text → stable contact_id order. */
async function resolveViaAccountContactsFallback(
  accountId: string,
): Promise<ResolvedPrimaryContact | null> {
  const { data: accountContacts } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role, is_primary, contacts(id, full_name, email, portal_tier, portal_role)")
    .eq("account_id", accountId)

  const ownerish = (r: string | null) => /owner|sole member/i.test(r || "")
  const sorted = [...(accountContacts || [])].sort((a, b) => {
    const ap = a.is_primary ? 0 : 1
    const bp = b.is_primary ? 0 : 1
    if (ap !== bp) return ap - bp
    const ao = ownerish(a.role) ? 0 : 1
    const bo = ownerish(b.role) ? 0 : 1
    if (ao !== bo) return ao - bo
    return String(a.contact_id).localeCompare(String(b.contact_id))
  })
  return (sorted[0]?.contacts as unknown as ResolvedPrimaryContact | undefined) ?? null
}

export async function resolvePrimaryContact(accountId: string): Promise<ResolvePrimaryContactResult> {
  const { data: memberRows } = await supabaseAdmin
    .from("members")
    .select("contact_id, full_name, member_type, representative_email, email, is_primary")
    .eq("account_id", accountId)
    .order("is_primary", { ascending: false })
    .order("contact_id", { ascending: true })

  const primaryMember = (memberRows ?? []).find((m) => m.is_primary === true)

  if (primaryMember) {
    let contactId = primaryMember.contact_id as string | null
    if (!contactId) {
      const fallbackEmail = primaryMember.member_type === "company"
        ? (primaryMember.representative_email as string | null)
        : (primaryMember.email as string | null)
      if (fallbackEmail) {
        const found = await findContactByEmailScopedToAccount(accountId, fallbackEmail)
        contactId = found.ambiguous ? null : found.contactId
      }
    }
    if (contactId) {
      const contact = await fetchContact(contactId)
      if (contact) return { outcome: "resolved", contact, source: "members" }
    }
    // A members row is flagged primary but resolves to nobody real (no
    // contact_id, no matching email, or an ambiguous email) — fall through
    // to the account_contacts guess rather than reporting "not found" on an
    // account that clearly has real people on it.
  }

  const fallback = await resolveViaAccountContactsFallback(accountId)
  if (fallback) return { outcome: "resolved", contact: fallback, source: "account_contacts" }
  return { outcome: "not_found" }
}
