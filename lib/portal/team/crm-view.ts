/**
 * Team Powers step 5 — what TD staff see on a company's "Team" card in the CRM (read-only, pure).
 *
 * Takes the rows as they sit in the database and builds the plain table the card draws: who the person is, what they
 * may do, who added them and when, the notice the owner accepted (the saved words), the last sign-in, and the switch-off
 * state. No database access here, so the rules are unit-tested without one.
 *
 * Nothing in this file writes anything. The company's members list is never touched by any team code.
 */
import { describeCapabilities } from './capability-labels'
import { normalizeCapabilities } from './capabilities'
import { isSwitchedOff } from './switch'

export type CardState = 'active' | 'off_owner' | 'off_td' | 'removed'

export interface CardMemberRow {
  id: string
  auth_user_id?: string | null
  username: string | null
  display_name: string | null
  capabilities: unknown
  status: string | null
  created_at: string | null
  switched_off_by?: string | null
  switched_off_at?: string | null
  switched_off_reason?: string | null
  notice_version?: string | null
  notice_accepted_at?: string | null
  notice_accepted_ip?: string | null
}

export interface CardEventRow {
  team_member_id: string
  event: string
  actor_kind: string
  actor_contact_id: string | null
  actor_staff_email: string | null
  detail: Record<string, unknown> | null
  ip?: string | null
  created_at: string
}

export interface CardHistoryLine {
  event: string
  label: string
  when: string
  by: string
  reason: string | null
}

export interface CardMember {
  id: string
  username: string
  displayName: string
  state: CardState
  powers: string[]
  addedAt: string | null
  addedBy: string | null
  notice: { version: string | null; acceptedAt: string | null; ip: string | null; text: string | null } | null
  switchedOff: { by: 'owner' | 'td'; at: string | null; reason: string | null } | null
  lastSignIn: string | null
  history: CardHistoryLine[]
}

export const HISTORY_LIMIT = 8

const EVENT_LABELS: Record<string, string> = {
  added: 'Added',
  powers_changed: 'Powers changed',
  removed: 'Removed',
  switched_off: 'Switched off',
  switched_on: 'Switched on',
  password_reset: 'Password reset',
  notice_accepted: 'Notice accepted',
  migrated: 'Existing person recorded',
}

/** active / switched off by the owner / switched off by TD / removed for good — the same rule as the owner's screen. */
export function cardState(r: Pick<CardMemberRow, 'status' | 'switched_off_at' | 'switched_off_by'>): CardState {
  if (r.status === 'active') return 'active'
  if (isSwitchedOff({ status: r.status ?? '', switched_off_at: r.switched_off_at ?? null })) return r.switched_off_by === 'td' ? 'off_td' : 'off_owner'
  return 'removed'
}

const STATE_ORDER: Record<CardState, number> = { active: 0, off_owner: 1, off_td: 2, removed: 3 }

function whoActed(e: CardEventRow, names: Record<string, string>): string {
  if (e.actor_kind === 'td') return e.actor_staff_email ? `TD (${e.actor_staff_email})` : 'TD'
  if (e.actor_kind === 'owner') return (e.actor_contact_id && names[e.actor_contact_id]) || 'An owner'
  return 'The system'
}

/** The words of a history line. A 'powers_changed' line that is about an owner's personal documents says so (Team Powers step 7). */
function labelOf(e: CardEventRow): string {
  if (e.event === 'powers_changed' && typeof e.detail?.personal_documents === 'boolean') {
    return e.detail.personal_documents ? 'Shared their personal documents' : 'Stopped sharing their personal documents'
  }
  return EVENT_LABELS[e.event] ?? e.event
}

function reasonOf(e: CardEventRow): string | null {
  const r = e.detail?.reason
  return typeof r === 'string' && r.trim() ? r.trim() : null
}

export function buildTeamCard(input: {
  members: CardMemberRow[]
  events: CardEventRow[]
  /** contact id → full name, for the owners named in the record */
  names: Record<string, string>
  /** auth user id → last sign-in (ISO) */
  signIns: Record<string, string | null>
}): CardMember[] {
  const { members, events, names, signIns } = input
  const byMember = new Map<string, CardEventRow[]>()
  for (const e of events) {
    const list = byMember.get(e.team_member_id) ?? []
    list.push(e)
    byMember.set(e.team_member_id, list)
  }

  const out: CardMember[] = members.map((m) => {
    const evs = (byMember.get(m.id) ?? []).slice().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)) // newest first
    const added = evs.slice().reverse().find((e) => e.event === 'added') ?? null
    const withNotice = evs.find((e) => typeof e.detail?.notice_text === 'string' && (e.detail.notice_text as string).trim())
    const state = cardState(m)

    const notice = m.notice_version || withNotice
      ? {
          version: (typeof withNotice?.detail?.notice_version === 'string' ? (withNotice.detail.notice_version as string) : null) ?? m.notice_version ?? null,
          acceptedAt: m.notice_accepted_at ?? withNotice?.created_at ?? null,
          ip: m.notice_accepted_ip ?? withNotice?.ip ?? null,
          text: typeof withNotice?.detail?.notice_text === 'string' ? (withNotice.detail.notice_text as string) : null,
        }
      : null

    return {
      id: m.id,
      username: m.username ?? '',
      displayName: (m.display_name ?? '').trim() || m.username || 'Unnamed',
      state,
      powers: describeCapabilities(normalizeCapabilities(m.capabilities), 'en'),
      addedAt: added?.created_at ?? m.created_at ?? null,
      addedBy: added ? whoActed(added, names) : null,
      notice,
      switchedOff: state === 'off_owner' || state === 'off_td'
        ? { by: state === 'off_td' ? 'td' : 'owner', at: m.switched_off_at ?? null, reason: m.switched_off_reason?.trim() || null }
        : null,
      lastSignIn: (m.auth_user_id && signIns[m.auth_user_id]) || null,
      history: evs.slice(0, HISTORY_LIMIT).map((e) => ({
        event: e.event,
        label: labelOf(e),
        when: e.created_at,
        by: whoActed(e, names),
        reason: reasonOf(e),
      })),
    }
  })

  return out.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.addedAt ?? '').localeCompare(b.addedAt ?? ''))
}

export type TeamCardMode = 'hidden' | 'failed' | 'list'

/**
 * Pure: what the staff Team card draws. A company with no team logins draws nothing; a load that FAILED draws a notice (never the same as
 * "no team logins"); a list that loaded earlier and could not be refreshed stays on screen (the card then says it may be out of date).
 */
export function teamCardMode(input: { hasData: boolean; memberCount: number; failed: boolean }): TeamCardMode {
  if (!input.hasData) return input.failed ? 'failed' : 'hidden'
  return input.memberCount === 0 ? 'hidden' : 'list'
}
