/**
 * "Addressed to" member resolution for Portal Chats — resolves a multi-member
 * account's real roster (the `members` table, canonical per Master Rules MM1
 * — NOT account_contacts) into addressable contacts, and picks a default
 * guess. Deliberately separate from lib/portal/admin-send-scope.ts: this is
 * a display/attribution label, never a visibility gate. See dev job
 * 08a8be62 and scripts/migrations/20260904-1900-portal-messages-addressed-to.sql.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findContactByEmailScopedToAccount } from "@/lib/members/resolve-signer"

export interface AddressedToOption {
  memberId: string
  name: string
  contactId: string | null
  isCompanyMember: boolean
  isPrimary: boolean
  /** false when the member can't be resolved to one contact (no contact_id,
   *  no email on file, or an ambiguous email match). The UI must render this
   *  as non-selectable, never silently no-op on tap (Erika Hall, council
   *  pass 2). */
  resolvable: boolean
}

type MemberRow = {
  id: string
  member_type: string
  full_name: string | null
  company_name: string | null
  contact_id: string | null
  representative_name: string | null
  representative_email: string | null
  email: string | null
  is_primary: boolean | null
}

/**
 * Resolve an account's real member roster into addressable options. Reads
 * ONLY the fields this picker needs — never ein/address/phone (bug-hunter
 * finding, council pass 2: those must not reach the browser for this
 * purpose) — and never writes anything.
 */
export async function resolveAccountMembersForChat(accountId: string): Promise<AddressedToOption[]> {
  const { data, error } = await supabaseAdmin
    .from("members")
    .select("id, member_type, full_name, company_name, contact_id, representative_name, representative_email, email, is_primary")
    .eq("account_id", accountId)
    .order("is_primary", { ascending: false })

  if (error || !data) return []

  const rows = data as MemberRow[]
  const options: AddressedToOption[] = []
  for (const m of rows) {
    const isCompanyMember = m.member_type === "company"
    const name = isCompanyMember
      ? (m.company_name || m.representative_name || "Unnamed company member")
      : (m.full_name || "Unnamed member")

    let contactId = m.contact_id ?? null
    let resolvable = true
    if (!contactId) {
      const fallbackEmail = isCompanyMember ? m.representative_email : m.email
      if (fallbackEmail) {
        const found = await findContactByEmailScopedToAccount(accountId, fallbackEmail)
        if (found.ambiguous) {
          resolvable = false
        } else {
          contactId = found.contactId
          resolvable = !!contactId
        }
      } else {
        resolvable = false
      }
    }
    options.push({ memberId: m.id, name, contactId, isCompanyMember, isPrimary: !!m.is_primary, resolvable })
  }
  return options
}

export interface AddressedToGuessInput {
  options: AddressedToOption[]
  /** contact_id of the message being replied to's author, when that message was from a client. */
  replyToContactId: string | null
  /** contact_id of the last client message in this account thread, if any. */
  lastClientContactId: string | null
}

/**
 * Pure decision: which resolvable option should be pre-filled as the guess?
 * Mirrors resolveAdminReplyContact's cascade (lib/portal/admin-send-scope.ts:
 * reply-to author -> last client sender -> primary -> first, stable) but
 * against the FULL members-resolved list, not just account_contacts-linked
 * contacts — covering exactly the members that cascade misses today. DB-free
 * so it's directly unit-testable, same shape as decideAdminSendScope.
 */
export function pickAddressedToGuess(input: AddressedToGuessInput): AddressedToOption | null {
  const resolvable = input.options.filter(o => o.resolvable && o.contactId)
  if (resolvable.length === 0) return null

  if (input.replyToContactId) {
    const match = resolvable.find(o => o.contactId === input.replyToContactId)
    if (match) return match
  }
  if (input.lastClientContactId) {
    const match = resolvable.find(o => o.contactId === input.lastClientContactId)
    if (match) return match
  }
  const primary = resolvable.find(o => o.isPrimary)
  if (primary) return primary

  return [...resolvable].sort((a, b) => (a.contactId! < b.contactId! ? -1 : a.contactId! > b.contactId! ? 1 : 0))[0]
}
