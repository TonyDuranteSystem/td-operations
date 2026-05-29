/**
 * Portal Team Access — account admin ("main person") resolver.
 *
 * The account admin is the ONLY person who may manage a company's portal team
 * (invite/edit/revoke). Precedence:
 *   1. persisted override  (accounts.portal_admin_contact_id, set via CRM)
 *   2. MMLLC → the SS-4 signer's contact (members.is_signer → contact_id),
 *      else the signer matched by name to a linked contact
 *   3. the owner-role contact (account_contacts.role ~ 'owner')
 *   4. the sole linked contact (if exactly one)
 *   5. null (no admin resolvable — Team tab hidden; fix via CRM)
 *
 * The pure picker is unit-tested; the DB wrapper just gathers inputs.
 * Design: sysdoc 'portal-team-access-design' §16.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export interface AdminInputs {
  persistedAdminId: string | null
  isMMLLC: boolean
  signerContactId: string | null
  signerNameMatchContactId: string | null
  ownerContactId: string | null
  soleContactId: string | null
}

/** Pure precedence logic — no I/O. */
export function pickAccountAdminContactId(i: AdminInputs): string | null {
  if (i.persistedAdminId) return i.persistedAdminId
  if (i.isMMLLC) {
    return i.signerContactId ?? i.signerNameMatchContactId ?? i.ownerContactId ?? i.soleContactId ?? null
  }
  return i.ownerContactId ?? i.soleContactId ?? null
}

export interface AccountAdminDeps {
  gatherAdminInputs: (accountId: string) => Promise<AdminInputs>
}

const defaultDeps: AccountAdminDeps = {
  gatherAdminInputs: async (accountId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as any

    const [{ data: account }, { data: links }, { data: members }] = await Promise.all([
      sb.from('accounts').select('entity_type, portal_admin_contact_id').eq('id', accountId).maybeSingle(),
      sb.from('account_contacts').select('contact_id, role, contacts:contact_id(full_name)').eq('account_id', accountId),
      sb.from('members').select('contact_id, is_signer, full_name').eq('account_id', accountId),
    ])

    const linkRows: Array<{ contact_id: string; role: string | null; contacts: { full_name: string | null } | null }> = links ?? []
    const memberRows: Array<{ contact_id: string | null; is_signer: boolean | null; full_name: string | null }> = members ?? []

    const ownerLink = linkRows.find((l) => (l.role ?? '').toLowerCase() === 'owner')
    const soleContactId = linkRows.length === 1 ? linkRows[0].contact_id : null

    const signer = memberRows.find((m) => m.is_signer)
    const signerContactId = signer?.contact_id ?? null
    // Signer with no contact_id: match the signer's name to a linked contact.
    let signerNameMatchContactId: string | null = null
    if (signer && !signerContactId && signer.full_name) {
      const target = signer.full_name.trim().toLowerCase()
      const match = linkRows.find((l) => (l.contacts?.full_name ?? '').trim().toLowerCase() === target)
      signerNameMatchContactId = match?.contact_id ?? null
    }

    return {
      persistedAdminId: (account?.portal_admin_contact_id as string | null) ?? null,
      isMMLLC: account?.entity_type === 'Multi Member LLC',
      signerContactId,
      signerNameMatchContactId,
      ownerContactId: ownerLink?.contact_id ?? null,
      soleContactId,
    }
  },
}

/** Resolve the account admin's contact id (or null). */
export async function resolveAccountAdminContactId(
  accountId: string,
  deps: AccountAdminDeps = defaultDeps,
): Promise<string | null> {
  const inputs = await deps.gatherAdminInputs(accountId)
  return pickAccountAdminContactId(inputs)
}

/** True if the given contact is the account admin for the account. */
export async function isAccountAdmin(
  contactId: string,
  accountId: string,
  deps: AccountAdminDeps = defaultDeps,
): Promise<boolean> {
  if (!contactId) return false
  const adminId = await resolveAccountAdminContactId(accountId, deps)
  return adminId !== null && adminId === contactId
}
