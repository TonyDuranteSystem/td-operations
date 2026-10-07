// What the WhatsApp thread draws under a message (dev job 5962e46d, Release 1c). Pure — no React, no I/O.
//
// A message's reactions array holds two kinds of element:
//   • staff marks made in the CRM   (reactor_type 'staff', or no type at all on old rows) — clickable, saved only in the CRM for now
//   • what the PHONE reported        (reactor_type 'client' = the customer, 'line' = our business phone) — display only, not clickable
// Removals reported by the phone stay behind as an empty-emoji "tombstone" (it stops an old add from coming back);
// a tombstone is never drawn.

export interface RawReaction {
  emoji?: unknown
  reactor_id?: unknown
  reactor_type?: unknown
  reactor_name?: unknown
}

export interface StaffReactionPill {
  emoji: string
  count: number
  names: string[]
  /** True when the viewer made one of these marks (the pill then toggles it off). */
  mine: boolean
}

export interface PhoneReactionPill {
  emoji: string
  side: 'client' | 'line'
}

export interface ReactionsView {
  staff: StaffReactionPill[]
  phone: PhoneReactionPill[]
}

const isPhoneSide = (t: unknown): t is 'client' | 'line' => t === 'client' || t === 'line'

export function splitReactions(reactions: unknown, viewerId?: string | null): ReactionsView {
  const staff: StaffReactionPill[] = []
  const phone: PhoneReactionPill[] = []
  if (!Array.isArray(reactions)) return { staff, phone }

  for (const raw of reactions as RawReaction[]) {
    if (typeof raw !== 'object' || raw === null) continue
    if (typeof raw.emoji !== 'string' || raw.emoji === '') continue // junk or a tombstone — never drawn
    if (isPhoneSide(raw.reactor_type)) {
      // one slot per side; the CRM already guarantees it, this just keeps a bad row from drawing twice
      if (!phone.some((p) => p.side === raw.reactor_type)) phone.push({ emoji: raw.emoji, side: raw.reactor_type })
      continue
    }
    let pill = staff.find((s) => s.emoji === raw.emoji)
    if (!pill) { pill = { emoji: raw.emoji, count: 0, names: [], mine: false }; staff.push(pill) }
    pill.count += 1
    if (typeof raw.reactor_name === 'string' && raw.reactor_name.trim()) pill.names.push(raw.reactor_name.trim())
    if (viewerId && raw.reactor_id === viewerId) pill.mine = true
  }
  return { staff, phone }
}

export const PHONE_SIDE_LABEL: Record<'client' | 'line', string> = {
  client: 'The customer reacted on WhatsApp',
  line: 'Reacted from the business phone',
}
