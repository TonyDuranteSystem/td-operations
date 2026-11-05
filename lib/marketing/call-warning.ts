/**
 * The warning on a lead's result buttons while a call is still ahead (TD Marketing; dev job 9aec66fa, 4 Nov 2026). The decisions are here, apart from the screen, so they can be tested.
 * The call the screen believes stands comes from the page (`callAt`); the server's refusal or the person's own cancel can OVERRIDE it, but an override only counts for the page it was made on:
 * when the page shows a different call (it was moved, cancelled or booked from the call box above, or in another tab), the page wins again.
 */
import { localeFor } from "@/lib/marketing/i18n"
import type { Lang } from "@/lib/marketing/templates"

export interface StandingOverride { /** the page's call when the override was made */ forPage: string | null; /** what the server or the person's cancel said stands: a time, or null for "no call" */ callAt: string | null }

export const resolveStanding = (pageCallAt: string | null, override: StandingOverride | null): string | null =>
  override && override.forPage === pageCallAt ? override.callAt : pageCallAt

/** a call "stands ahead" only while its time is in the future (a call that has passed does not stop a result) */
export const callIsAhead = (standing: string | null, nowMs: number): boolean => standing !== null && Date.parse(standing) > nowMs

/** the call's day and time in the viewer's zone and language, never failing the screen (a bad zone falls back to the time in UTC) */
export function formatCallTime(iso: string, zone: string, lang: Lang): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }
  try { return new Intl.DateTimeFormat(localeFor(lang), { ...opts, timeZone: zone }).format(new Date(iso)) } catch { /* an invalid zone */ }
  try { return new Intl.DateTimeFormat(localeFor(lang), { ...opts, timeZone: "UTC" }).format(new Date(iso)) + " UTC" } catch { return iso }
}
