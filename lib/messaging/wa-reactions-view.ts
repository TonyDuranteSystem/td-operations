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
  /** unique per pill: the side in a one-to-one chat, "wa-client:<member>" for each member of a group */
  key: string
  /** a group member's name when the CRM knows it (null otherwise) */
  name: string | null
  /** true for one member of a group (their own reaction) */
  member: boolean
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
      // A group member has their OWN reaction (reactor_id "wa-client:<member>"); in a one-to-one chat there is one slot per side.
      // The CRM already guarantees both; this just keeps a bad row from drawing twice.
      const memberId = typeof raw.reactor_id === 'string' && raw.reactor_id.startsWith('wa-client:') ? raw.reactor_id : null
      const key = memberId ?? raw.reactor_type
      if (!phone.some((p) => p.key === key)) {
        const name = memberId && typeof raw.reactor_name === 'string' && raw.reactor_name.trim() ? raw.reactor_name.trim() : null
        phone.push({ emoji: raw.emoji, side: raw.reactor_type, key, name, member: !!memberId })
      }
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
