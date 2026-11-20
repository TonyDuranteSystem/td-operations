/**
 * Team Powers — telling every owner and member when someone is added to the team or given more powers.
 *
 * One background job PER RECIPIENT (so a failed send is retried for that person alone and nobody gets two copies);
 * the job queue retries a failed job up to `max_attempts`. This email is the control that lets another owner notice a
 * grant they did not expect, so enqueueing is STRICT: if no one can be told, the caller undoes the grant.
 * Tony Durante LLC is never a recipient.
 */
import { enqueueJobs } from '@/lib/jobs/queue'
import { listTeamManagers, type ManagerContact } from './may-manage'

export const TEAM_NOTICE_JOB = 'team_change_notice'
export const TEAM_NOTICE_MAX_ATTEMPTS = 8

export interface TeamNoticeJobPayload {
  recipient_contact_id: string
  team_member_id: string
  account_id: string
  kind: 'added' | 'more'
  actor_contact_id: string
  /** For kind 'more': the keys of the powers just added. */
  added_keys: string[]
  /** ISO time of the change. */
  at: string
  [key: string]: unknown
}

export interface NotifyDeps {
  listManagers: (accountId: string) => Promise<ManagerContact[]>
  enqueue: (jobs: Array<{ job_type: string; payload: TeamNoticeJobPayload; priority: number; max_attempts: number; account_id: string; related_entity_type: string; related_entity_id: string; created_by: string }>) => Promise<unknown>
  now?: () => Date
}

const defaultDeps: NotifyDeps = { listManagers: listTeamManagers, enqueue: (jobs) => enqueueJobs(jobs) }

/** Returns how many people will be told. Throws when nobody can be told (no owner or member has an email address). */
export async function enqueueTeamNotices(
  args: { accountId: string; teamMemberId: string; kind: 'added' | 'more'; actorContactId: string; addedKeys?: string[] },
  deps: NotifyDeps = defaultDeps,
): Promise<number> {
  const managers = await deps.listManagers(args.accountId)
  const withEmail = managers.filter((m) => !!m.email && m.email.includes('@'))
  if (withEmail.length === 0) {
    throw new Error('No owner or member of this company has an email address, so nobody could be told about this change.')
  }
  const at = (deps.now?.() ?? new Date()).toISOString()
  await deps.enqueue(
    withEmail.map((m) => ({
      job_type: TEAM_NOTICE_JOB,
      payload: {
        recipient_contact_id: m.contactId,
        team_member_id: args.teamMemberId,
        account_id: args.accountId,
        kind: args.kind,
        actor_contact_id: args.actorContactId,
        added_keys: args.addedKeys ?? [],
        at,
      },
      priority: 3,
      max_attempts: TEAM_NOTICE_MAX_ATTEMPTS,
      account_id: args.accountId,
      related_entity_type: 'portal_team_member',
      related_entity_id: args.teamMemberId,
      created_by: 'team-notice',
    })),
  )
  return withEmail.length
}
