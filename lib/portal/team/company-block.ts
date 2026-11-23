/**
 * Team Powers (dev job e59dd470, 20 Nov bug hunt D#10) — "Block portal login" on a company also switches off the company's TEAM logins.
 *
 * The staff button "Block Portal Login" (client audit page) bans the sign-ins of the company's linked contacts (owners / members). A team login
 * is not a contact, so the button never saw it: a blocked company's team logins kept reading documents, invoices and chat, and with the owners
 * gone nobody on the client side could switch them off. Now the block ALSO switches off every active team login of THAT company — the same
 * reversible TD switch-off the Team card uses (silent, written to the team record with the staff login's email) — and "Restore" switches back on
 * ONLY the logins this block switched off.
 *
 * Which logins are touched:
 *   block   → logins that are ACTIVE. Skipped: a login an owner switched off (the owner's own choice stays; restoring must never switch it on),
 *             a login TD switched off for another reason, and a removed login. A login this block already switched off counts as "already blocked".
 *   restore → logins TD switched off with THIS block's reason. Everything else stays exactly as it is.
 *
 * Dependencies are passed in so the rules run without a database (tests); `companyBlockDeps()` wires the real ones.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { TeamActor } from '@/lib/portal/team/events'
import { TeamSwitchError } from '@/lib/portal/team/switch'
import { switchTeammateOff, switchTeammateOn } from '@/lib/portal/team/server'

/** The reason written on every switch-off this block makes (staff see it on the Team card; Restore finds its own logins by it). */
export const COMPANY_BLOCK_REASON = 'Company portal login blocked by TD'

export interface BlockLoginRow {
  id: string
  username: string | null
  status: string | null
  switched_off_at: string | null
  switched_off_by: string | null
  switched_off_reason: string | null
}

export interface CompanyBlockDeps {
  /** Every team login of the company. THROWS when the list cannot be read. */
  listLogins(accountId: string): Promise<BlockLoginRow[]>
  switchOff(id: string, accountId: string, actor: TeamActor, reason: string): Promise<void>
  switchOn(id: string, accountId: string, actor: TeamActor): Promise<void>
}

export interface CompanyBlockFailure {
  loginId: string
  username: string | null
  error: string
}

export interface CompanyBlockResult {
  /** Logins switched off (block) or switched back on (restore) by this call. */
  changed: number
  /** Block only: logins this block had already switched off earlier (a second press, or the "force" run). They are off. */
  alreadyBlocked: number
  /** Logins left exactly as they were because they are not this block's to touch (removed, owner-off, off for another reason). */
  skipped: number
  failed: CompanyBlockFailure[]
}

const isOff = (r: BlockLoginRow) => r.status !== 'active' && !!r.switched_off_at
const isOurs = (r: BlockLoginRow) => isOff(r) && r.switched_off_by === 'td' && r.switched_off_reason === COMPANY_BLOCK_REASON

function failure(r: BlockLoginRow, err: unknown): CompanyBlockFailure {
  return { loginId: r.id, username: r.username, error: err instanceof Error ? err.message : String(err) }
}

/** Block: switch off every ACTIVE team login of the company. One login failing never stops the others. THROWS only when the list cannot be read. */
export async function switchOffCompanyLogins(accountId: string, actor: TeamActor, deps: CompanyBlockDeps): Promise<CompanyBlockResult> {
  const rows = await deps.listLogins(accountId)
  const result: CompanyBlockResult = { changed: 0, alreadyBlocked: 0, skipped: 0, failed: [] }
  for (const r of rows) {
    if (isOurs(r)) { result.alreadyBlocked++; continue }
    if (r.status !== 'active') { result.skipped++; continue } // removed, or off for the owner's / another reason: not this block's to touch
    try {
      await deps.switchOff(r.id, accountId, actor, COMPANY_BLOCK_REASON)
      result.changed++
    } catch (err) {
      // Someone switched or removed the login a moment ago: nothing for this block to do.
      if (err instanceof TeamSwitchError && (err.code === 'already_off' || err.code === 'removed' || err.code === 'not_found')) result.skipped++
      else result.failed.push(failure(r, err))
    }
  }
  return result
}

/** Restore: switch back on ONLY the logins this block switched off. THROWS only when the list cannot be read. */
export async function switchOnCompanyLogins(accountId: string, actor: TeamActor, deps: CompanyBlockDeps): Promise<CompanyBlockResult> {
  const rows = await deps.listLogins(accountId)
  const result: CompanyBlockResult = { changed: 0, alreadyBlocked: 0, skipped: 0, failed: [] }
  for (const r of rows) {
    if (!isOurs(r)) { if (isOff(r)) result.skipped++; continue } // active logins are fine as they are; other switch-offs are not ours
    try {
      await deps.switchOn(r.id, accountId, actor)
      result.changed++
    } catch (err) {
      if (err instanceof TeamSwitchError && (err.code === 'not_off' || err.code === 'removed' || err.code === 'not_found')) result.skipped++
      else result.failed.push(failure(r, err))
    }
  }
  return result
}

/** The real wiring: reads the company's team logins and reuses the Team card's own switch-off / switch-on. */
export function companyBlockDeps(): CompanyBlockDeps {
  return {
    listLogins: async (accountId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabaseAdmin as any)
        .from('portal_team_members')
        .select('id, username, status, switched_off_at, switched_off_by, switched_off_reason')
        .eq('account_id', accountId)
      if (error) throw new Error(error.message)
      return (data ?? []) as BlockLoginRow[]
    },
    switchOff: async (id, accountId, actor, reason) => { await switchTeammateOff(id, accountId, actor, reason) },
    switchOn: async (id, accountId, actor) => { await switchTeammateOn(id, accountId, actor) },
  }
}

/** One plain sentence for the staff screen. */
export function describeCompanyBlock(action: 'deactivate' | 'activate', r: CompanyBlockResult | null, listError?: string): string {
  if (listError) return `The team logins could not be checked (${listError}). Switch them off or on from the company's Team card.`
  if (!r) return ''
  const n = action === 'deactivate' ? r.changed + r.alreadyBlocked : r.changed
  const parts: string[] = []
  if (n > 0) parts.push(`${n} team login${n === 1 ? '' : 's'} ${action === 'deactivate' ? 'switched off' : 'switched back on'}`)
  if (r.skipped > 0) parts.push(`${r.skipped} left as they were`)
  if (r.failed.length > 0) parts.push(`${r.failed.length} could not be ${action === 'deactivate' ? 'switched off' : 'switched on'} (${r.failed.map((f) => f.username ?? f.loginId).join(', ')}) — use the Team card`)
  return parts.join('; ')
}
