// "New lead from a call" (2026-11-03, Antonio: "I want the option in leads to add a new one from a call").
// A call that was recorded for someone who is not in Leads yet (an unbooked call, a call on a Zoom link) has no
// lead attached. This picks the calls that can still become a lead and suggests the lead's name and email from
// the call. It only suggests what the call plainly shows (exactly one outside person with an email); everything
// else stays blank for the person to type. Pure: no database access.

import { isInternalEmail } from '@/lib/circleback/link-call'

export interface CallPickerRow {
  id: string
  meeting_name: string | null
  duration_seconds: number | null
  attendees: unknown
  created_at: string | null
  lead_id: string | null
  contact_id: string | null
  account_id: string | null
}

export interface Attendee { name: string | null; email: string | null }

export interface CallChoice {
  id: string
  title: string
  createdAt: string | null
  durationMinutes: number | null
  /** outside people on the call that have an email (internal addresses are left out) */
  outsiders: Attendee[]
}

/** A call can become a new lead only while nobody (lead, client contact or company) is attached to it. */
export function isCallFreeForNewLead(c: Pick<CallPickerRow, 'lead_id' | 'contact_id' | 'account_id'>): boolean {
  return !c.lead_id && !c.contact_id && !c.account_id
}

export function readAttendees(raw: unknown): Attendee[] {
  if (!Array.isArray(raw)) return []
  const out: Attendee[] = []
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null
    const email = typeof r.email === 'string' && r.email.trim() ? r.email.trim().toLowerCase() : null
    out.push({ name, email })
  }
  return out
}

export function toCallChoice(c: CallPickerRow): CallChoice {
  const outsiders = readAttendees(c.attendees).filter(a => a.email && !isInternalEmail(a.email))
  return {
    id: c.id,
    title: c.meeting_name?.trim() || 'Untitled call',
    createdAt: c.created_at,
    durationMinutes: c.duration_seconds ? Math.round(c.duration_seconds / 60) : null,
    outsiders,
  }
}

export interface SuggestedLead { full_name: string; email: string }

/** Name and email are suggested only when exactly one outside person with an email was on the call. */
export function suggestLeadFromCall(choice: CallChoice): SuggestedLead {
  if (choice.outsiders.length !== 1) return { full_name: '', email: '' }
  const only = choice.outsiders[0]
  return { full_name: only.name ?? '', email: only.email ?? '' }
}
