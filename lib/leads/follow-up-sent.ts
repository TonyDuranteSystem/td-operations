// "Follow-up sent" mark of a lead (dev job 6fc63c52, Antonio 2026-11-02): when a follow-up leaves the Leads window, the
// lead keeps WHEN and ON WHICH CHANNEL, so the Leads table and the window can say so. Pure.

import { nyDate } from '@/lib/leads/ny-date'

export const FOLLOW_UP_CHANNELS = ['whatsapp', 'email'] as const
export type FollowUpChannel = (typeof FOLLOW_UP_CHANNELS)[number]

export function parseFollowUpChannel(v: unknown): FollowUpChannel | null {
  return typeof v === 'string' && (FOLLOW_UP_CHANNELS as readonly string[]).includes(v) ? (v as FollowUpChannel) : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "1 Nov" — the New York calendar day of the send. Empty when the time is missing or not a real time. */
export function followUpDayLabel(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return ''
  const [, m, d] = nyDate(iso).split('-').map(Number)
  return `${d} ${MONTHS[(m || 1) - 1]}`
}

/** The tag text, e.g. "Follow-up sent · WhatsApp · 1 Nov"; null when nothing was sent. An unknown channel is left out, never guessed. */
export function followUpTagText(iso: string | null | undefined, channel: string | null | undefined): string | null {
  const day = followUpDayLabel(iso)
  if (!day) return null
  const ch = parseFollowUpChannel(channel)
  return ['Follow-up sent', ch === 'whatsapp' ? 'WhatsApp' : ch === 'email' ? 'Email' : null, day].filter(Boolean).join(' · ')
}
