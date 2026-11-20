/**
 * Team Powers — checks the owner's confirmation that arrives WITH a request to give someone access or more access.
 *
 * Builds the notice the server expects from the same facts the screen used (company, person, powers, the owner's language),
 * requires the owner to have accepted exactly that text, and requires their password — in the same request.
 */
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getLocale } from '@/lib/portal/i18n'
import { normalizeCapabilities } from './capabilities'
import { buildNotice, type NoticeMode } from './notice'
import { checkNoticeAcceptance, verifyOwnerPassword, type CheckResult, type Confirmation } from './confirm'

export interface ConfirmGrantInput {
  user: User
  accountId: string
  /** The person receiving the access (as the owner typed or sees it). */
  memberName: string
  /** The powers the person will have AFTER this request. */
  caps: unknown
  mode: NoticeMode
  body: { notice_accepted?: unknown; notice_version?: unknown; notice_text?: unknown; owner_password?: unknown }
  ip: string | null
}

/** The notice language follows the owner's portal language. */
export function ownerNoticeLang(user: User): 'en' | 'it' {
  return getLocale(user) === 'it' ? 'it' : 'en'
}

export async function confirmGrant(i: ConfirmGrantInput): Promise<CheckResult<{ confirmation: Confirmation }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account, error } = await (supabaseAdmin as any).from('accounts').select('company_name').eq('id', i.accountId).maybeSingle()
  if (error || !account) return { ok: false, status: 404, error: 'Company not found.' }

  const expected = buildNotice({
    lang: ownerNoticeLang(i.user),
    mode: i.mode,
    memberName: i.memberName,
    companyName: account.company_name as string,
    caps: normalizeCapabilities(i.caps),
  })
  const accepted = checkNoticeAcceptance(i.body, expected, i.ip)
  if (accepted.ok === false) return accepted
  const pw = await verifyOwnerPassword({ userId: i.user.id, email: i.user.email, password: i.body.owner_password })
  if (pw.ok === false) return pw
  return accepted
}
