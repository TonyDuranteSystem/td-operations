/**
 * The staff reminder "Create portal accounts for MMLLC members after LLC confirmation"
 * (onboarding setup job). Dev job beb43385 (member portal access tick).
 *
 * A member whose "portal access" tick was UNTICKED in the form (`member_portal_access === false`) gets the
 * no-portal-access mark on their company link (see `lib/members/apply-form-portal-access.ts`). They are still
 * an owner, but they are not meant to get a portal account for this company — so the reminder to create
 * portal accounts must not list them. They are named in a separate "left out" note so the person doing the
 * work sees why, instead of wondering.
 *
 * No answer (null: an older form, or the switch was off) and ticked (true) both stay on the reminder, exactly
 * as before.
 */
import type { NormalizedMember } from '@/lib/utils/wizard-members'

export interface PortalInviteReminder {
  /** Names of the members the reminder is for (fallback names use the member's position in the form). */
  includedNames: string[]
  /** Names of the members left out because their tick was unticked. */
  leftOutNames: string[]
  /** The task description, or null when nobody needs a portal account (everyone unticked). */
  description: string | null
}

function displayName(m: NormalizedMember, index: number): string {
  if (m.member_type === 'company') return m.member_company_name ?? `Company Member ${index + 1}`
  return [m.member_first_name, m.member_last_name].filter(Boolean).join(' ') || `Member ${index + 1}`
}

function reminderLine(m: NormalizedMember): string {
  if (m.member_type === 'company') return `• ${m.member_company_name ?? 'Company'} (rep: ${m.member_rep_email ?? 'no email'})`
  return `• ${[m.member_first_name, m.member_last_name].filter(Boolean).join(' ')} — ${m.member_email ?? 'no email'}`
}

/** " (left out, portal access unticked in the form: A, B)" — or "" when nobody was left out. Used in the job's step texts. */
export function leftOutNote(r: PortalInviteReminder): string {
  return r.leftOutNames.length > 0 ? ` (left out, portal access unticked in the form: ${r.leftOutNames.join(', ')})` : ''
}

/**
 * The job step for the moment the to-do is saved. A failed save must read as an ERROR in the step list (staff look there),
 * never as "created": the to-do — and the "left out" note on it — is then the only place Luca would have learned who needs
 * a portal account, so a silent failure means nobody is reminded.
 */
export function reminderInsertOutcome(insertError: string | null | undefined, r: PortalInviteReminder): { status: 'ok' | 'error'; detail: string } {
  const names = r.includedNames.join(', ')
  if (insertError) {
    return { status: 'error', detail: `The to-do "Create portal accounts…" could NOT be created (${insertError}) — nobody was reminded to create the portal accounts for: ${names}${leftOutNote(r)}` }
  }
  return { status: 'ok', detail: `Portal invite reminder created for ${r.includedNames.length} member(s): ${names}${leftOutNote(r)}` }
}

export function buildPortalInviteReminder(members: NormalizedMember[]): PortalInviteReminder {
  const included: Array<{ m: NormalizedMember; i: number }> = []
  const leftOut: Array<{ m: NormalizedMember; i: number }> = []
  members.forEach((m, i) => (m.member_portal_access === false ? leftOut : included).push({ m, i }))

  const includedNames = included.map(({ m, i }) => displayName(m, i))
  const leftOutNames = leftOut.map(({ m, i }) => displayName(m, i))

  if (included.length === 0) return { includedNames, leftOutNames, description: null }

  let description = `Create portal accounts for:\n${included.map(({ m }) => reminderLine(m)).join('\n')}`
  if (leftOut.length > 0) {
    description += `\n\nNot on this list — "portal access" was unticked in the form (still an owner, no portal account for this company):\n${leftOut.map(({ m }) => reminderLine(m)).join('\n')}`
  }
  return { includedNames, leftOutNames, description }
}
