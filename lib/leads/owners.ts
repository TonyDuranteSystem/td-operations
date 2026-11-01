// Who can own a lead, and the follow-up date rules (dev job 6fc63c52, phase D). Pure.
// The owner list is deliberately short and lives here, in one place — the Leads window and its edit
// route both read it. (Tasks use only Antonio / Luca; TD Marketing adds Rocco and Ale.)

export const LEAD_OWNERS = ['Antonio', 'Luca', 'Rocco', 'Ale'] as const
export type LeadOwner = (typeof LEAD_OWNERS)[number]

/** One shape for both outcomes (this project's TypeScript does not narrow a union on `ok`). */
export interface Parsed { ok: boolean; value: string | null; message: string }

export function parseOwner(v: unknown): Parsed {
  if (v === null || v === '') return { ok: true, value: null, message: '' }
  if (typeof v === 'string' && (LEAD_OWNERS as readonly string[]).includes(v)) return { ok: true, value: v, message: '' }
  return { ok: false, value: null, message: `The owner must be one of ${LEAD_OWNERS.join(', ')}.` }
}

/** A real calendar date as YYYY-MM-DD, or null to clear. */
export function parseFollowUpDate(v: unknown): Parsed {
  if (v === null || v === '') return { ok: true, value: null, message: '' }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, value: null, message: 'The follow-up date must look like 2026-11-04.' }
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return { ok: false, value: null, message: 'That is not a real calendar date.' }
  return { ok: true, value: v, message: '' }
}

/** Default follow-up when none is set: 3 days after a call, 5 days after an offer was sent (Antonio's numbers to confirm). */
export const FOLLOW_UP_DAYS_AFTER_CALL = 3
export const FOLLOW_UP_DAYS_AFTER_OFFER = 5

export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
