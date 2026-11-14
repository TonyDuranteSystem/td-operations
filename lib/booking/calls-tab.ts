/**
 * Calendar tab "Calls to check" — what the Calendar page needs, read in one place (server only). The Calendar's own files stay free of database writes and
 * fetches (a test pins that), so the read lives here and the answering UI lives in components/calls-to-check.
 *
 * The tab is visible while the Booking page is switched on (`booking` = page or live) OR while cards are still waiting (so switching it off never hides a card).
 * `count`/`cards` are null when the read failed: the tab then says so — never "nothing needs you".
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { readBookingMode } from "@/lib/booking-links/switch"
import { loadOpenChecks, type CardDto } from "@/lib/booking/checks"

export interface CallsTabData {
  visible: boolean
  cards: CardDto[] | null
  count: number | null
}

export async function loadCallsTab(now: Date): Promise<CallsTabData> {
  const [mode, checks] = await Promise.all([readBookingMode(supabaseAdmin), loadOpenChecks(supabaseAdmin, now)])
  if (!checks.ok) return { visible: mode !== "off", cards: null, count: null }
  return { visible: mode !== "off" || checks.count > 0, cards: checks.cards, count: checks.count }
}
