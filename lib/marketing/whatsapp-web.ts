/**
 * WhatsApp Web, the stop-gap (pure; TD Marketing, dev job 9aec66fa): WhatsApp does not allow its page inside ours, so each person keeps WhatsApp Web open in its OWN window, linked once
 * to his phone. The system sends nothing and keeps no chat: it only writes "opened" and "sent" notes on the lead, and counts them for the person's own day.
 */
import { romeDayKey } from "@/lib/marketing/calendar"

/** The browser window every WhatsApp Web link opens in (the same name again reuses that one window instead of piling up tabs). */
export const WA_WINDOW_NAME = "tdm-whatsapp"
export const WA_WINDOW_FEATURES = "popup=yes,width=1100,height=800"
export const WA_WEB_HOME = "https://web.whatsapp.com/"

interface WaEvent { lead_id: string; kind: string; actor: string; created_at: string; data?: Record<string, unknown> | null }

/** One person's WhatsApp day (Rome time): the leads he opened in WhatsApp Web, and of those how many he confirmed sent. A lead counts once however often he opened it; "View as" rows never count. */
export function whatsappDay(events: readonly WaEvent[], me: string, now: Date): { opened: number; sent: number } {
  const today = romeDayKey(now)
  const opened = new Set<string>(), sent = new Set<string>()
  for (const e of events) {
    if (e.kind !== "whatsapp" || e.actor !== me || e.data?.via_view_as === true) continue
    if (romeDayKey(new Date(e.created_at)) !== today) continue
    if (e.data?.state === "opened") opened.add(e.lead_id)
    else if (e.data?.state === "sent") sent.add(e.lead_id)
  }
  return { opened: opened.size, sent: Array.from(sent).filter(id => opened.has(id)).length }
}
