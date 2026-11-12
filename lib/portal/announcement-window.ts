// Portal announcements carry an optional start and end date (the CRM's Announcements form lets the team set them). The client home page used
// to ignore them, so a dated announcement only went away when somebody switched it off by hand. These two small pure functions decide whether
// one is showing today. Dates are plain calendar days ("YYYY-MM-DD", the database's `date` type); the end day is INCLUDED. "Today" is the
// company's own day (New York), not UTC, so an announcement that ends on the 15th stays up through the evening of the 15th.

export interface AnnouncementWindow {
  active_from?: string | null
  active_until?: string | null
}

/** Today's calendar day in New York as "YYYY-MM-DD". */
export function easternDateString(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** True when the announcement has started (or has no start) and has not ended (or has no end) on `today`. */
export function isAnnouncementLive(row: AnnouncementWindow, today: string): boolean {
  const from = row.active_from ? String(row.active_from).slice(0, 10) : null
  const until = row.active_until ? String(row.active_until).slice(0, 10) : null
  if (from && from > today) return false
  if (until && until < today) return false
  return true
}
