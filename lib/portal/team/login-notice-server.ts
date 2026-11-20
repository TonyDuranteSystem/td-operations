/**
 * Team Powers step 6 — database wiring for the team login's own notice (the rules live in login-notice-accept.ts).
 * Server only. Used by the portal layout (to draw the banner) and POST /api/portal/team/accept-notice.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { recordTeamEvent, recordTeamEventBestEffort } from '@/lib/portal/team/events'
import { normalizeCapabilities } from '@/lib/portal/team/capabilities'
import type { NoticeLang } from '@/lib/portal/team/capability-labels'
import { buildTeamLoginNotice, type TeamLoginNotice } from '@/lib/portal/team/login-notice'
import { isNoticeWaiting, type AcceptDeps, type AcceptRow } from '@/lib/portal/team/login-notice-accept'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = () => supabaseAdmin as any

const ROW_COLUMNS = 'id, account_id, display_name, status, notice_version, capabilities, created_at'

async function fetchRowByAuthId(authUserId: string): Promise<AcceptRow | null> {
  const { data } = await sb().from('portal_team_members').select(ROW_COLUMNS).eq('auth_user_id', authUserId).maybeSingle()
  return (data as AcceptRow | null) ?? null
}

async function companyNameOf(accountId: string): Promise<string> {
  const { data } = await sb().from('accounts').select('company_name').eq('id', accountId).maybeSingle()
  return typeof data?.company_name === 'string' ? data.company_name : ''
}

export function acceptNoticeDeps(): AcceptDeps {
  return {
    fetchRow: fetchRowByAuthId,
    companyName: companyNameOf,
    markAccepted: async (teamMemberId, patch) => {
      const { data, error } = await sb()
        .from('portal_team_members')
        .update(patch)
        .eq('id', teamMemberId)
        .is('notice_version', null) // only while still waiting: a second window changes nothing
        .select('id')
      if (error) throw new Error(error.message)
      return Array.isArray(data) && data.length > 0
    },
    unmark: async (teamMemberId) => {
      await sb()
        .from('portal_team_members')
        .update({ notice_version: null, notice_accepted_at: null, notice_accepted_ip: null })
        .eq('id', teamMemberId)
    },
    recordEvent: (input) => recordTeamEvent(sb(), input),
    recordEventBestEffort: (input) => recordTeamEventBestEffort(sb(), input),
  }
}

/**
 * For the portal layout: when this team login is waiting for its notice, the notice to show (in the person's own language,
 * with their REAL powers — the identity the rest of the portal sees has them held back until they accept). null = nothing to show.
 */
export async function getWaitingNotice(authUserId: string, lang: NoticeLang): Promise<TeamLoginNotice | null> {
  const row = await fetchRowByAuthId(authUserId)
  if (!isNoticeWaiting(row) || !row) return null
  const company = await companyNameOf(row.account_id)
  return buildTeamLoginNotice({ lang, memberName: row.display_name, companyName: company, caps: normalizeCapabilities(row.capabilities) })
}
