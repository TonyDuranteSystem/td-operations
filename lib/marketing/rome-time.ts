/**
 * TD Marketing — a day and time typed in a date field read as ROME time (pure; dev job 9aec66fa). Marketing screens now show each person's OWN zone (lib/marketing/zones.ts); this stays for the
 * places that still count in Rome days and for the tests that pin the old behaviour. No database here.
 */
import { ROME, localToIso } from "@/lib/marketing/zones"

/** "2026-10-27T11:00" (a datetime-local value, read as Rome wall-clock time) -> the real instant as an ISO string; null when it is not a valid date. */
export function romeLocalToIso(local: string): string | null {
  return localToIso(local, ROME)
}
