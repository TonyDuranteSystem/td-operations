/**
 * Server side: save "How they became our client" on an account — either a CHANGE (a person picks Formed by us / Onboarded after the
 * pop-up asked them to check the dates) or a CONFIRM (a person presses "It's correct" on the guess). Both stamp who and when, so
 * "To check" (checked_at empty) always means nobody has looked at it yet. Every save is written to the audit log.
 *
 * The write is matched on the `updated_at` the person saw, so two people cannot overwrite each other. The database also guards the two
 * allowed values (trigger trg_accounts_became_client_how_guard). The database client is passed in so this can be tested without one.
 * Nothing in billing reads these columns yet.
 */
import { BECAME_CLIENT_LABEL, becameClientLabel, isBecameClientHow, type BecameClientHow } from '@/lib/accounts/became-client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any }

// one flat shape: this project compiles with strict off, so a success/failure union would not narrow on `success`
export interface BecameClientWrite {
  success: boolean
  value?: BecameClientHow
  error?: string
  warning?: string
}

const STALE = 'This company was updated since the page loaded. Refresh the page and try again.'

export async function writeBecameClientHow(
  db: Db,
  input: { accountId: string; mode: 'change' | 'confirm'; value?: string | null; expectedUpdatedAt: string | null; actor: string },
): Promise<BecameClientWrite> {
  const read = await db
    .from('accounts')
    .select('id, company_name, became_client_how, updated_at')
    .eq('id', input.accountId)
    .maybeSingle()
  if (read.error) return { success: false, error: `Could not read the company: ${read.error.message}` }
  const account = read.data as { id: string; company_name: string | null; became_client_how: string | null; updated_at: string | null } | null
  if (!account) return { success: false, error: 'This company was not found.' }

  const before = isBecameClientHow(account.became_client_how) ? account.became_client_how : null
  let next: BecameClientHow
  if (input.mode === 'confirm') {
    if (!before) return { success: false, error: `Choose ${BECAME_CLIENT_LABEL.formed_by_us} or ${BECAME_CLIENT_LABEL.onboarded} first.` }
    next = before
  } else {
    if (!isBecameClientHow(input.value)) return { success: false, error: `Choose ${BECAME_CLIENT_LABEL.formed_by_us} or ${BECAME_CLIENT_LABEL.onboarded}.` }
    next = input.value
  }

  const now = new Date().toISOString()
  let q = db
    .from('accounts')
    .update({ became_client_how: next, became_client_how_checked_at: now, became_client_how_checked_by: input.actor })
    .eq('id', input.accountId)
  q = input.expectedUpdatedAt == null ? q.is('updated_at', null) : q.eq('updated_at', input.expectedUpdatedAt)
  const res = await q.select('id')
  if (res.error) return { success: false, error: `Could not save: ${res.error.message}` }
  if (!res.data || res.data.length === 0) return { success: false, error: STALE }

  const confirmed = input.mode === 'confirm'
  const log = await db.from('action_log').insert({
    actor: input.actor,
    action_type: confirmed ? 'account_became_client_how_confirmed' : 'account_became_client_how_set',
    table_name: 'accounts',
    record_id: input.accountId,
    account_id: input.accountId,
    summary: confirmed
      ? `How ${account.company_name ?? 'the company'} became our client confirmed: ${becameClientLabel(next)}`
      : `How ${account.company_name ?? 'the company'} became our client changed: ${becameClientLabel(before)} -> ${becameClientLabel(next)}`,
    details: { from: before, to: next, mode: input.mode, by: input.actor },
  })
  if (log.error) {
    console.error('[became-client] the audit log row could not be written:', log.error.message, JSON.stringify({ accountId: input.accountId, from: before, to: next, by: input.actor }))
    return { success: true, value: next, warning: 'Saved, but the history line could not be written.' }
  }
  return { success: true, value: next }
}
