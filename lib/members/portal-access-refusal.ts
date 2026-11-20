/**
 * Who a staff-made portal login may be created for (dev job beb43385, delivery C).
 *
 * A person whose link to the company carries the "no portal access" mark (unticked in the form, or taken away by the team)
 * gets NO login made for that company — not by the staff "Create Portal Account" route, not by the MCP tool
 * `portal_create_user`. The team gives the access back first (company page → Give access), which also creates the login.
 *
 * With no person named, the first person who still has access is picked (a marked person is never picked for them).
 * Pure core + a default reader of the links, so the rules are unit-tested without a database.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export interface LoginTargetLink {
  contact_id: string
  access_revoked_at: string | null
}

export type ListLinks = (accountId: string) => Promise<LoginTargetLink[]>

const defaultListLinks: ListLinks = async (accountId) => {
  // portal-access-ok: this reads every link to decide who may be refused
  const { data } = await supabaseAdmin.from('account_contacts').select('contact_id, access_revoked_at').eq('account_id', accountId)
  return (data ?? []) as LoginTargetLink[]
}

export interface LoginTarget {
  /** The person the login is for (undefined when the company has nobody linked at all). */
  contactId?: string
  /** Plain-English reason the login must not be created; when set, stop. */
  refusal?: string
}

export const MARKED_MEMBER_REFUSAL =
  'This person has no portal access to this company (unticked in the form, or taken away by the team). They are still an owner. Give the access back first (company page, "Give access"), which also creates their login.'

export const EVERYONE_MARKED_REFUSAL =
  'Everyone linked to this company has no portal access, so there is nobody to create a login for. Give someone access first (company page, "Give access").'

export function pickLoginTarget(links: LoginTargetLink[], contactId?: string | null): LoginTarget {
  if (contactId) {
    const link = links.find((l) => l.contact_id === contactId)
    if (link?.access_revoked_at) return { contactId, refusal: MARKED_MEMBER_REFUSAL }
    return { contactId }
  }
  if (links.length === 0) return {}
  const open = links.find((l) => !l.access_revoked_at)
  if (!open) return { refusal: EVERYONE_MARKED_REFUSAL }
  return { contactId: open.contact_id }
}

export async function resolveLoginTarget(
  accountId: string,
  contactId?: string | null,
  listLinks: ListLinks = defaultListLinks,
): Promise<LoginTarget> {
  return pickLoginTarget(await listLinks(accountId), contactId)
}
