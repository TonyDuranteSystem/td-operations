/**
 * Job Handler: team_change_notice
 *
 * Sends ONE owner or member the email "someone was added to the team / was given more powers" (see lib/portal/team/notify.ts).
 * Payload: TeamNoticeJobPayload. Durable: a send that fails throws, and the worker retries it (up to max_attempts); after the
 * last try the failure is reported as a system error so it is not lost silently.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { PORTAL_BASE_URL } from '@/lib/config'
import { describeCapabilities, capabilityLabel, type NoticeLang } from '@/lib/portal/team/capability-labels'
import { buildTeamNoticeEmail, encodeSubject } from '@/lib/portal/team/notice-email'
import { normalizeCapabilities } from '@/lib/portal/team/capabilities'
import { isItalian } from '@/lib/locale'
import { reportSystemError } from '@/lib/system-errors'
import type { TeamNoticeJobPayload } from '@/lib/portal/team/notify'
import type { Job, JobResult } from '../queue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function handleTeamChangeNotice(job: Job): Promise<JobResult> {
  const ts = () => new Date().toISOString()
  const p = job.payload as unknown as TeamNoticeJobPayload
  if (!p?.recipient_contact_id || !p.team_member_id || !p.account_id) {
    return { steps: [{ name: 'validate', status: 'error', detail: 'missing recipient / member / account', timestamp: ts() }], summary: 'Bad payload', terminal: true }
  }

  const [recipient, member, account, actor] = await Promise.all([
    db.from('contacts').select('full_name, email, language').eq('id', p.recipient_contact_id).maybeSingle(),
    db.from('portal_team_members').select('display_name, capabilities').eq('id', p.team_member_id).maybeSingle(),
    db.from('accounts').select('company_name').eq('id', p.account_id).maybeSingle(),
    p.actor_contact_id ? db.from('contacts').select('full_name').eq('id', p.actor_contact_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const readError = recipient.error || member.error || account.error || actor.error
  if (readError) throw new Error(`could not read the facts: ${readError.message}`) // retried

  if (!recipient.data?.email) {
    return { steps: [{ name: 'check_email', status: 'skipped', detail: 'recipient has no email', timestamp: ts() }], summary: 'No email', terminal: true }
  }
  if (!member.data || !account.data) {
    return { steps: [{ name: 'load', status: 'skipped', detail: 'team member or company no longer exists', timestamp: ts() }], summary: 'Nothing to tell', terminal: true }
  }

  const lang: NoticeLang = isItalian(recipient.data.language) ? 'it' : 'en'
  const caps = normalizeCapabilities(member.data.capabilities)
  const email = buildTeamNoticeEmail({
    language: recipient.data.language,
    recipientFirstName: ((recipient.data.full_name as string | null) ?? '').trim().split(/\s+/)[0] || null,
    actorName: (actor.data?.full_name as string | null) || (lang === 'it' ? 'Un titolare' : 'An owner'),
    memberName: member.data.display_name as string,
    companyName: (account.data.company_name as string) || '',
    kind: p.kind === 'more' ? 'more' : 'added',
    powers: describeCapabilities(caps, lang),
    newPowers: (p.added_keys ?? []).map((k) => capabilityLabel(k, lang)),
    when: new Date(p.at),
    teamUrl: `${PORTAL_BASE_URL}/portal/team`,
  })

  try {
    const { gmailPost } = await import('@/lib/gmail')
    const boundary = `boundary_${Date.now()}`
    const raw = [
      'From: Tony Durante LLC <support@tonydurante.us>',
      `To: ${recipient.data.email}`,
      `Subject: ${encodeSubject(email.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(email.html).toString('base64'),
      `--${boundary}--`,
    ].join('\r\n')
    await gmailPost('/messages/send', { raw: Buffer.from(raw).toString('base64url') })
  } catch (err) {
    // The last allowed try: say so loudly (this email is the safety control for a grant of powers).
    if (job.attempts + 1 >= job.max_attempts) {
      await reportSystemError({
        source: 'server',
        message: `team_change_notice could not be sent to contact ${p.recipient_contact_id} after ${job.max_attempts} tries: ${err instanceof Error ? err.message : String(err)}`,
        route: 'job:team_change_notice',
      }).catch(() => undefined)
    }
    throw err
  }

  return { steps: [{ name: 'send_email', status: 'ok', detail: recipient.data.email as string, timestamp: ts() }], summary: 'Sent' }
}
